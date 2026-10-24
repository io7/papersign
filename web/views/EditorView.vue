<script setup lang="ts">
import EmailPreview from "../components/EmailPreview.vue";
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Download,
  PenLine,
  Plus,
  Trash2,
  Mail,
  Link,
  X,
  Check,
  Users,
  RefreshCw,
  SlidersHorizontal,
  Type,
} from "@lucide/vue";
import PdfStage from "../components/PdfStage.vue";
import OwnerReviewDialog from "../components/OwnerReviewDialog.vue";
import PlacementBox from "../components/PlacementBox.vue";
import SignatureComposer from "../components/SignatureComposer.vue";
import CopyField from "../components/CopyField.vue";
import { api, json, errorMessage, newId, formatDate } from "../api";
import { fitPdfText, normalizePdfText } from "../../shared/pdf-text";
import type {
  DocumentInfo,
  Signature,
  Placement,
  SigningField,
  Invitation,
  ExportInfo,
  TextPlacement,
  RecipientTextField,
} from "../../shared/types";
const route = useRoute(),
  router = useRouter(),
  id = String(route.params.id),
  doc = ref<DocumentInfo>(),
  signatures = ref<Signature[]>([]),
  placements = ref<Placement[]>([]),
  loading = ref(true),
  error = ref(""),
  notice = ref(""),
  busy = ref(false);
const savedPlacements = ref("[]"),
  placementSnapshot = computed(() => json(placements.value)),
  dirty = computed(() => placementSnapshot.value !== savedPlacements.value),
  saving = ref(false),
  saveError = ref("");
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: Promise<void> | undefined;
const pageIndex = ref(0),
  selectedSignature = ref(""),
  active = ref(""),
  creating = ref(false),
  rasterize = ref(false),
  pdfStage = ref<InstanceType<typeof PdfStage>>(),
  advancedDialog = ref<HTMLDialogElement>(),
  advancedOpen = ref(false),
  advancedError = ref(""),
  exportJob = ref<ExportInfo>(),
  tab = ref<"own" | "text" | "invite">("own"),
  textToAdd = ref(""),
  textSize = ref(12);
const textSizes = [6, 8, 10, 12, 14, 16, 18, 24, 36];
const recipientName = ref(""),
  recipientEmail = ref(""),
  staged = ref<
    Array<{
      name: string;
      email: string;
      field: SigningField;
      textFields: RecipientTextField[];
    }>
  >([]),
  emailPreview = ref<any>(),
  emailEnabled = ref(false);
const certificateSealingEnabled = ref(false);
const ownerReviewDialog = ref<InstanceType<typeof OwnerReviewDialog>>();
const termsLocked = ref(false);
const completedRecord = ref<{
  state: string;
  error?: string;
  message?: string;
  evidenceComplete?: boolean;
  receipt?: { manifestSha256: string; finalPdfSha256: string };
  timestamp?: { state: string };
}>();
let recordTimer: ReturnType<typeof setTimeout> | undefined;
async function loadRecord() {
  if (!["completed", "cancelled"].includes(doc.value?.status ?? "")) return;
  try {
    completedRecord.value = await api(`/documents/${id}/record`);
    if (
      ["queued", "working"].includes(completedRecord.value!.state) ||
      completedRecord.value?.timestamp?.state === "pending"
    )
      recordTimer = setTimeout(loadRecord, 1500);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
let timer: ReturnType<typeof setTimeout> | undefined;
let downloadTrigger: HTMLElement | undefined;
const editable = computed(() => doc.value?.status === "draft");
const unfinishedRecipient = computed(() =>
  Boolean(recipientName.value.trim() || recipientEmail.value.trim()),
);
const unsavedChanges = computed(
  () =>
    dirty.value ||
    saving.value ||
    staged.value.length > 0 ||
    unfinishedRecipient.value,
);
const invitations = computed(() =>
  [...(doc.value?.invitations ?? [])].sort(
    (a, b) => a.signingOrder - b.signingOrder,
  ),
);
const signedCount = computed(
  () =>
    invitations.value.filter((invitation) => invitation.state === "signed")
      .length,
);
const activeCount = computed(
  () =>
    invitations.value.filter((invitation) => invitation.state !== "revoked")
      .length,
);
const currentSigner = computed(() =>
  invitations.value.find((invitation) => invitation.canSign),
);
const expiredSigner = computed(() =>
  invitations.value.find(
    (invitation) => invitation.signingStatus === "expired",
  ),
);
const activePlacement = computed(
  () =>
    placements.value.find((p) => p.id === active.value) ??
    staged.value.find((r) => r.field.id === active.value)?.field ??
    staged.value
      .flatMap((r) => r.textFields)
      .find((f) => f.id === active.value),
);
const activeText = computed(() =>
  placements.value.find(
    (p): p is TextPlacement => p.id === active.value && p.kind === "text",
  ),
);
const activeRecipientText = computed(() =>
  staged.value.flatMap((r) => r.textFields).find((f) => f.id === active.value),
);
function textProblem(field: TextPlacement) {
  if (!doc.value) return "";
  const page = doc.value.pages[field.pageIndex];
  try {
    fitPdfText(
      field.text,
      field.fontSize,
      field.width * page.width,
      field.height * page.height,
    );
    return "";
  } catch (e) {
    return errorMessage(e);
  }
}
async function reload() {
  doc.value = await api(`/documents/${id}`);
  placements.value = doc.value!.placements.map((placement) => ({
    ...placement,
  }));
  savedPlacements.value = placementSnapshot.value;
  saveError.value = "";
  if (recordTimer) clearTimeout(recordTimer);
  await loadRecord();
}
onMounted(async () => {
  window.addEventListener("beforeunload", warnBeforeUnload);
  window.addEventListener("keydown", deleteSelected);
  window.addEventListener("pointerdown", deselectOutside, true);
  window.addEventListener("focusin", deselectOutside);
  try {
    const [, sigs, cfg] = await Promise.all([
      reload(),
      api<Signature[]>("/signatures"),
      api("/config"),
    ]);
    signatures.value = sigs;
    selectedSignature.value = sigs[0]?.id ?? "";
    emailEnabled.value = cfg.emailEnabled;
    certificateSealingEnabled.value = cfg.certificateSealingEnabled === true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  if (recordTimer) clearTimeout(recordTimer);
  clearTimeout(timer);
  clearTimeout(saveTimer);
  window.removeEventListener("beforeunload", warnBeforeUnload);
  window.removeEventListener("keydown", deleteSelected);
  window.removeEventListener("pointerdown", deselectOutside, true);
  window.removeEventListener("focusin", deselectOutside);
});
onBeforeRouteLeave(async () => {
  try {
    await save();
  } catch {
    return window.confirm(
      "Your latest changes could not be saved. Leave anyway? Unsaved changes and any unshared signer list will be lost.",
    );
  }
  return (
    !(staged.value.length || unfinishedRecipient.value) ||
    window.confirm(
      "Leave without creating signing links? Your page edits are saved, but the unshared signer list will be lost.",
    )
  );
});
watch(placementSnapshot, () => {
  clearTimeout(saveTimer);
  saveError.value = "";
  if (dirty.value && editable.value)
    saveTimer = setTimeout(() => {
      void retrySave();
    }, 600);
});
function deselectOutside(event: Event) {
  if (!active.value || !(event.target instanceof Element)) return;
  const field = event.target.closest("[data-placement-id]");
  if (field?.getAttribute("data-placement-id") === active.value) return;
  active.value = "";
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest("[data-placement-id]"))
    focused.blur();
}
function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (!unsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = "";
}
function jumpToPage(index: number) {
  pageIndex.value = index;
  pdfStage.value?.scrollToPage(index);
}
function selectPlacement(field: SigningField) {
  active.value = field.id;
  if (activeText.value) tab.value = "text";
  else if (activeRecipientText.value) tab.value = "invite";
}
async function revealPlacement(field: SigningField) {
  await nextTick();
  const element = document.querySelector<HTMLElement>(
    `.placement[data-placement-id="${field.id}"]`,
  );
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  element?.focus({ preventScroll: true });
}
function deleteSelected(event: KeyboardEvent) {
  if (
    event.key !== "Delete" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !editable.value ||
    busy.value ||
    !activePlacement.value ||
    advancedOpen.value ||
    emailPreview.value
  )
    return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest(
        "input, textarea, select, [contenteditable], [role='textbox'], dialog, [role='dialog'], .composer",
      ))
  )
    return;
  event.preventDefault();
  removeActive();
}
async function openAdvancedDownload(event: MouseEvent) {
  if (busy.value || doc.value?.status === "awaiting") return;
  downloadTrigger = event.currentTarget as HTMLElement;
  advancedError.value = "";
  advancedOpen.value = true;
  await nextTick();
  advancedDialog.value?.showModal();
}
function closeAdvancedDownload() {
  advancedDialog.value?.close();
}
function advancedClosed() {
  advancedOpen.value = false;
  if (downloadTrigger?.isConnected && !downloadTrigger.matches(":disabled"))
    downloadTrigger.focus();
}
async function refreshStatus() {
  busy.value = true;
  error.value = "";
  try {
    await reload();
    notice.value = "Signing status updated.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function addSignature() {
  const sig = signatures.value.find((s) => s.id === selectedSignature.value);
  if (!sig || !doc.value) return;
  const page = doc.value.pages[pageIndex.value],
    width = Math.min(
      0.28,
      (((0.2 * page.height) / page.width) * sig.width) / sig.height,
    ),
    height = (((width * page.width) / page.height) * sig.height) / sig.width;
  const placement = {
    id: newId(),
    signatureId: sig.id,
    pageIndex: pageIndex.value,
    x: 0.35,
    y: 0.7,
    width,
    height,
  };
  placements.value.push(placement);
  active.value = placement.id;
  void revealPlacement(placement);
}
function textGeometry() {
  const page = doc.value!.pages[pageIndex.value];
  return {
    id: newId(),
    pageIndex: pageIndex.value,
    x: 0.35,
    y: 0.8,
    width: 0.4,
    height: Math.min(0.15, Math.max(0.025, 22 / page.height)),
  };
}
function addText() {
  if (!doc.value || !editable.value || busy.value) return;
  const placement: TextPlacement = {
    ...textGeometry(),
    kind: "text",
    text: textToAdd.value.trim(),
    fontSize: textSize.value,
  };
  error.value = textProblem(placement);
  if (error.value) return;
  placements.value.push(placement);
  active.value = placement.id;
  textToAdd.value = "";
  void revealPlacement(placement);
}
function addRecipientText(recipient: (typeof staged.value)[number]) {
  if (!doc.value || busy.value || recipient.textFields.length >= 10) return;
  const field: RecipientTextField = {
    ...textGeometry(),
    label: "Place / date",
    fontSize: 12,
  };
  recipient.textFields.push(field);
  active.value = field.id;
  void revealPlacement(field);
}
function update(field: SigningField) {
  const index = placements.value.findIndex((p) => p.id === field.id);
  if (index >= 0) {
    placements.value[index] = { ...placements.value[index], ...field };
  } else {
    const recipient = staged.value.find((r) => r.field.id === field.id);
    if (recipient) recipient.field = field;
    else
      for (const signer of staged.value) {
        const textIndex = signer.textFields.findIndex((f) => f.id === field.id);
        if (textIndex >= 0) {
          signer.textFields[textIndex] = {
            ...signer.textFields[textIndex],
            ...field,
          };
          break;
        }
      }
  }
}
function removeActive() {
  if (!editable.value || busy.value) return;
  if (placements.value.some((p) => p.id === active.value)) {
    placements.value = placements.value.filter((p) => p.id !== active.value);
  }
  staged.value = staged.value.filter((r) => r.field.id !== active.value);
  for (const recipient of staged.value)
    recipient.textFields = recipient.textFields.filter(
      (f) => f.id !== active.value,
    );
  active.value = "";
}
async function save() {
  clearTimeout(saveTimer);
  if (pendingSave) return pendingSave;
  if (!dirty.value || !editable.value) return;
  saving.value = true;
  saveError.value = "";
  pendingSave = (async () => {
    // Serialize writes and keep editing responsive while each snapshot saves.
    // A response advances the revision, but must never replace newer local edits.
    while (dirty.value && editable.value) {
      for (const placement of placements.value) {
        if (placement.kind !== "text") continue;
        const problem = textProblem(placement);
        if (problem) throw new Error(problem);
      }
      const snapshot = placementSnapshot.value,
        revision = doc.value!.revision;
      let result: DocumentInfo;
      try {
        result = await api<DocumentInfo>(`/documents/${id}/placements`, {
          method: "PUT",
          body: json({ revision, placements: JSON.parse(snapshot) }),
        });
      } catch (failure) {
        // A lost response may hide a committed save. Acknowledge only the exact
        // expected revision and content; never overwrite another editor's work.
        const remote = await api<DocumentInfo>(`/documents/${id}`).catch(
          () => undefined,
        );
        if (
          !remote ||
          remote.status !== "draft" ||
          remote.revision !== revision + 1 ||
          comparablePlacements(remote.placements) !==
            comparablePlacements(JSON.parse(snapshot))
        )
          throw failure;
        result = remote;
      }
      doc.value = { ...doc.value!, ...result };
      savedPlacements.value = snapshot;
    }
  })();
  try {
    await pendingSave;
  } catch (e) {
    // Even when the user reverted while saving, the failed request's outcome
    // may be unknown. Keep Retry available until the latest state is confirmed.
    savedPlacements.value = "";
    saveError.value = errorMessage(e);
    throw e;
  } finally {
    pendingSave = undefined;
    saving.value = false;
  }
}
function comparablePlacements(value: Placement[]) {
  // PostgreSQL JSONB can return object keys in a different order.
  return json(
    value.map((placement) =>
      Object.fromEntries(
        Object.entries(
          placement.kind === "text"
            ? { ...placement, text: normalizePdfText(placement.text) }
            : placement,
        ).sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  );
}
async function retrySave() {
  try {
    await save();
  } catch {
    /* The persistent save status provides the error and retry action. */
  }
}
async function savedSignature(sig: Signature) {
  signatures.value = await api("/signatures");
  selectedSignature.value = sig.id;
  creating.value = false;
  notice.value = "Signature saved to your account.";
}
async function startExport(rasterized = false) {
  if (busy.value || doc.value?.status === "awaiting") return;
  busy.value = true;
  error.value = "";
  advancedError.value = "";
  exportJob.value = undefined;
  try {
    await save();
    if (
      doc.value?.status === "draft" &&
      placements.value.some((placement) => placement.kind !== "text")
    ) {
      if (advancedOpen.value) closeAdvancedDownload();
      const review = await ownerReviewDialog.value?.open(doc.value.revision);
      if (!review) {
        busy.value = false;
        return;
      }
      await api(`/documents/${id}/finalize`, {
        method: "POST",
        body: json({
          revision: review.revision,
          reviewId: review.reviewId,
          consent: true,
          consentVersion: review.consent.version,
        }),
      });
      await reload();
    }
    exportJob.value = await api(`/documents/${id}/exports`, {
      method: "POST",
      body: json({ rasterize: rasterized, revision: doc.value!.revision }),
    });
    if (advancedOpen.value) closeAdvancedDownload();
    await pollExport();
  } catch (e) {
    error.value = errorMessage(e);
    if (advancedOpen.value) advancedError.value = errorMessage(e);
    busy.value = false;
  }
}
async function pollExport() {
  if (!exportJob.value) return;
  try {
    exportJob.value = await api<ExportInfo>(`/exports/${exportJob.value.id}`);
    if (exportJob.value.state === "ready") {
      busy.value = false;
      notice.value = exportJob.value.seal
        ? "Your PDF is ready with a verified certificate seal and trusted timestamp."
        : "Your signed PDF is ready to download.";
    } else if (exportJob.value.state === "failed") {
      busy.value = false;
      error.value =
        exportJob.value.error ?? "The PDF could not be prepared. Try again.";
    } else timer = setTimeout(pollExport, 1200);
  } catch (e) {
    busy.value = false;
    error.value = errorMessage(e);
  }
}
function addRecipient() {
  if (!doc.value || busy.value || staged.value.length >= 10) return;
  error.value = "";
  const email = recipientEmail.value.trim();
  if (
    staged.value.some(
      (recipient) => recipient.email.toLowerCase() === email.toLowerCase(),
    )
  ) {
    error.value =
      "This email is already in the signer list. Each person needs only one signing link.";
    return;
  }
  const field = {
    id: newId(),
    pageIndex: pageIndex.value,
    x: 0.35,
    y: 0.75,
    width: 0.3,
    height: 0.075,
  };
  staged.value.push({
    name: recipientName.value.trim(),
    email,
    field,
    textFields: [],
  });
  active.value = field.id;
  recipientName.value = "";
  recipientEmail.value = "";
  void revealPlacement(field);
}
function moveRecipient(index: number, direction: -1 | 1) {
  const destination = index + direction;
  if (busy.value || destination < 0 || destination >= staged.value.length)
    return;
  const recipient = staged.value.splice(index, 1)[0];
  staged.value.splice(destination, 0, recipient);
}
function removeRecipient(fieldId: string) {
  const removed = staged.value.find((r) => r.field.id === fieldId);
  staged.value = staged.value.filter(
    (recipient) => recipient.field.id !== fieldId,
  );
  if (
    active.value === fieldId ||
    removed?.textFields.some((f) => f.id === active.value)
  )
    active.value = "";
}
function signingStatus(invitation: Invitation) {
  return {
    ready: "Ready to sign",
    waiting: "Waiting for previous signer",
    signed: "Signed",
    revoked: "Revoked",
    expired: "Expired",
  }[invitation.signingStatus];
}
async function createInvitations() {
  if (!staged.value.length || unfinishedRecipient.value || !termsLocked.value)
    return;
  busy.value = true;
  error.value = "";
  try {
    if (staged.value.some((r) => r.textFields.some((f) => !f.label.trim())))
      throw new Error(
        "Give every text field a label so the signer knows what to enter.",
      );
    await save();
    const review = placements.value.some(
      (placement) => placement.kind !== "text",
    )
      ? await ownerReviewDialog.value?.open(doc.value!.revision)
      : undefined;
    if (
      placements.value.some((placement) => placement.kind !== "text") &&
      !review
    )
      return;
    await api(`/documents/${id}/invitations`, {
      method: "POST",
      body: json({
        revision: doc.value!.revision,
        recipients: staged.value,
        termsLocked: termsLocked.value,
        ownerReviewId: review?.reviewId,
        ownerConsentVersion: review?.consent.version,
      }),
    });
    staged.value = [];
    await reload();
    notice.value =
      "Signing links created. Share each private link with its signer; people sign in the listed order.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function reissue(invitation: Invitation) {
  if (
    !window.confirm(
      `Replace ${invitation.name}'s old link with a new seven-day signing link?`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/documents/${id}/invitations/${invitation.id}/reissue`, {
      method: "POST",
      body: json({ revision: doc.value!.revision }),
    });
    await reload();
    notice.value = "New signing link created. The old link no longer works.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function cancelSigning() {
  const reason = window.prompt(
    "Why are you cancelling this signing request? Signed records will be retained.",
  );
  if (!reason?.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/documents/${id}/cancel`, {
      method: "POST",
      body: json({ revision: doc.value!.revision, reason }),
    });
    await reload();
    notice.value =
      "Signing request cancelled. No further signatures can be added.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function retryRecord() {
  try {
    await api(`/documents/${id}/record/retry`, { method: "POST", body: "{}" });
    await loadRecord();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function requestDeletion() {
  const confirmName = window.prompt(
    `Request deletion of this document? Enter its exact name: ${doc.value?.name}`,
  );
  if (confirmName === null) return;
  busy.value = true;
  error.value = "";
  try {
    await save();
    const result = await api<{ state: string }>(
      `/documents/${id}/deletion-request`,
      {
        method: "POST",
        body: json({ revision: doc.value!.revision, confirmName }),
      },
    );
    notice.value =
      "Deletion requested. Track or withdraw the request under Your data.";
    if (result.state === "recoverable") {
      savedPlacements.value = placementSnapshot.value;
      staged.value = [];
      recipientName.value = recipientEmail.value = "";
      await router.push("/privacy");
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function revoke(invitation: Invitation) {
  if (
    !window.confirm(
      `Revoke the signing link for ${invitation.name}? They will be skipped in the signing order and can no longer use this link.`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/documents/${id}/invitations/${invitation.id}/revoke`, {
      method: "POST",
      body: "{}",
    });
    await reload();
    notice.value = "Signing link revoked.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function previewEmail(invitation: Invitation) {
  try {
    emailPreview.value = {
      ...(await api(`/documents/${id}/invitations/${invitation.id}/email`)),
      invitationId: invitation.id,
    };
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function sendEmail() {
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/documents/${id}/invitations/${emailPreview.value.invitationId}/email`,
      {
        method: "POST",
        body: json({ previewHash: emailPreview.value.previewHash }),
      },
    );
    emailPreview.value = undefined;
    notice.value = "Your email provider accepted the invitation.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="editor-page">
    <RouterLink to="/documents" class="back-link"
      ><ArrowLeft :size="16" />Documents</RouterLink
    >
    <p v-if="loading" role="status" class="loading">Opening your document…</p>
    <template v-if="doc"
      ><header class="editor-heading">
        <div>
          <h1>{{ doc.name }}</h1>
          <p>
            {{ doc.pages.length }} {{ doc.pages.length === 1 ? "page" : "pages"
            }}<span class="dot-separator">·</span
            ><span v-if="staged.length">Signer list not yet shared</span
            ><span v-else>{{
              doc.status === "awaiting"
                ? "Awaiting signatures"
                : doc.status === "completed"
                  ? "Signing completed"
                  : "Ready to sign"
            }}</span>
          </p>
        </div>
        <div
          v-if="editable"
          class="save-status"
          :class="{ 'save-failed': saveError }"
        >
          <span role="status" aria-live="polite">
            <Check
              v-if="!dirty && !saving && !saveError"
              :size="16"
              aria-hidden="true"
            />
            {{
              saving
                ? "Saving…"
                : saveError
                  ? "Changes not saved"
                  : dirty
                    ? "Waiting to save…"
                    : staged.length
                      ? "Text and signatures saved"
                      : "All page edits saved"
            }}
          </span>
          <button
            v-if="saveError"
            class="text-button"
            :disabled="saving"
            @click="retrySave"
          >
            Retry save
          </button>
        </div>
        <button
          v-else
          class="button secondary"
          :disabled="busy"
          @click="refreshStatus"
        >
          <RefreshCw :size="17" />{{ busy ? "Refreshing…" : "Refresh status" }}
        </button>
      </header></template
    >
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="saveError" class="notice error" role="alert">
      Your latest page edits have not been saved. {{ saveError }}
    </p>
    <p v-if="notice" class="notice success" role="status">{{ notice }}</p>
    <div v-if="doc" class="editor-layout">
      <section class="document-workspace" aria-label="PDF editor">
        <div class="page-controls">
          <button
            class="icon-button"
            aria-label="Previous page"
            :disabled="pageIndex === 0"
            @click="jumpToPage(pageIndex - 1)"
          >
            <ChevronLeft :size="20" /></button
          ><label
            >Page
            <select
              :value="pageIndex"
              aria-label="PDF page"
              @change="
                jumpToPage(Number(($event.target as HTMLSelectElement).value))
              "
            >
              <option
                v-for="(_, index) in doc.pages"
                :key="index"
                :value="index"
              >
                {{ index + 1 }}
              </option>
            </select>
            of {{ doc.pages.length }}</label
          ><button
            class="icon-button"
            aria-label="Next page"
            :disabled="pageIndex === doc.pages.length - 1"
            @click="jumpToPage(pageIndex + 1)"
          >
            <ChevronRight :size="20" />
          </button>
        </div>
        <PdfStage
          ref="pdfStage"
          :url="`/api/documents/${id}/pdf`"
          :pages="doc.pages"
          v-model:page-index="pageIndex"
          v-slot="{ pageIndex: visiblePageIndex }"
          ><PlacementBox
            v-for="placement in placements.filter(
              (p) => p.pageIndex === visiblePageIndex,
            )"
            :key="placement.id"
            :field="placement"
            :image="
              placement.kind === 'text'
                ? undefined
                : `/api/signatures/${placement.signatureId}/image`
            "
            :text="placement.kind === 'text' ? placement.text : undefined"
            :font-size="
              placement.kind === 'text' ? placement.fontSize : undefined
            "
            :page="doc.pages[placement.pageIndex]"
            :text-field="placement.kind === 'text'"
            :label="
              placement.kind === 'text'
                ? `Text: ${placement.text}`
                : 'Your signature'
            "
            :active="active === placement.id"
            :editable="editable && !busy"
            inline-tools
            :text-error="
              placement.kind === 'text' ? textProblem(placement) : undefined
            "
            @select="selectPlacement(placement)"
            @remove="removeActive"
            @update="update" /><PlacementBox
            v-for="recipient in staged.filter(
              (r) => r.field.pageIndex === visiblePageIndex,
            )"
            :key="recipient.field.id"
            :field="recipient.field"
            :label="`${staged.indexOf(recipient) + 1}. ${recipient.name}`"
            :active="active === recipient.field.id"
            :editable="!busy"
            inline-tools
            @select="selectPlacement(recipient.field)"
            @remove="removeActive"
            @update="update" /><template
            v-for="recipient in staged"
            :key="`text-${recipient.field.id}`"
          >
            <PlacementBox
              v-for="field in recipient.textFields.filter(
                (f) => f.pageIndex === visiblePageIndex,
              )"
              :key="field.id"
              :field="field"
              :text-field="true"
              :label="`${recipient.name}: ${field.label}`"
              :active="active === field.id"
              :editable="!busy"
              inline-tools
              :text-label="field.label"
              :font-size="field.fontSize"
              @select="selectPlacement(field)"
              @remove="removeActive"
              @update="update"
            /> </template
          ><template v-for="recipient in invitations" :key="recipient.id"
            ><PlacementBox
              v-if="
                recipient.field.pageIndex === visiblePageIndex &&
                recipient.state !== 'revoked'
              "
              :field="recipient.field"
              :label="`${recipient.signingOrder}. ${recipient.name}${recipient.state === 'signed' ? ' · signed' : ''}`" />
            <template v-if="recipient.state !== 'revoked'">
              <PlacementBox
                v-for="field in (recipient.textFields ?? []).filter(
                  (f) => f.pageIndex === visiblePageIndex,
                )"
                :key="field.id"
                :field="field"
                :text-field="true"
                :label="`${recipient.name}: ${field.label}${recipient.state === 'signed' ? ' · completed' : ''}`"
              /> </template></template
        ></PdfStage>
        <p v-if="editable" class="canvas-hint">
          Drag to position. Use the corner to resize. Arrow keys move; Alt +
          arrows resize. Delete removes the selected field from this document.
        </p>
      </section>
      <aside class="editor-tools">
        <template v-if="editable"
          ><div class="segmented editor-tabs">
            <button
              :class="{ selected: tab === 'own' }"
              :aria-pressed="tab === 'own'"
              @click="tab = 'own'"
            >
              <PenLine :size="16" />My signature</button
            ><button
              :class="{ selected: tab === 'text' }"
              :aria-pressed="tab === 'text'"
              @click="tab = 'text'"
            >
              <Type :size="16" />Text</button
            ><button
              :class="{ selected: tab === 'invite' }"
              :aria-pressed="tab === 'invite'"
              @click="tab = 'invite'"
            >
              <Users :size="16" />Invite to sign
            </button>
          </div>
          <section v-if="tab === 'own'" class="tool-section">
            <h2>Choose your signature</h2>
            <p v-if="!signatures.length" class="muted">
              Create a signature and save it for this document and the next.
            </p>
            <div v-else class="signature-choices">
              <button
                v-for="signature in signatures"
                :key="signature.id"
                class="signature-choice"
                :class="{ chosen: selectedSignature === signature.id }"
                :aria-pressed="selectedSignature === signature.id"
                @click="selectedSignature = signature.id"
              >
                <img
                  :src="`/api/signatures/${signature.id}/image`"
                  :alt="signature.name"
                /><span
                  >{{ signature.name
                  }}<Check v-if="selectedSignature === signature.id" :size="15"
                /></span>
              </button>
            </div>
            <button
              v-if="signatures.length"
              class="button primary full"
              :disabled="busy || !selectedSignature"
              @click="addSignature"
            >
              <Plus :size="17" />Add to this page</button
            ><button
              class="text-button new-signature-link"
              @click="creating = !creating"
            >
              <PenLine :size="16" />Draw or upload a new signature</button
            ><SignatureComposer
              v-if="creating"
              @saved="savedSignature"
              @cancel="creating = false"
            />
          </section>
          <section v-else-if="tab === 'text'" class="tool-section">
            <h2>Add text to your PDF</h2>
            <p class="muted">
              Fill in a place, date, name or other detail. Drag the text into
              position on the page.
            </p>
            <form @submit.prevent="addText">
              <label class="field"
                >Text to add<input
                  v-model="textToAdd"
                  required
                  maxlength="200"
                  placeholder="Enter text"
              /></label>
              <label class="field"
                >Text size<select v-model.number="textSize">
                  <option v-for="size in textSizes" :key="size" :value="size">
                    {{ size }} pt
                  </option>
                </select></label
              >
              <button
                class="button primary full"
                :disabled="busy || !textToAdd.trim()"
              >
                <Plus :size="17" />Add text to page
              </button>
            </form>
          </section>
          <section v-else class="tool-section">
            <h2>Choose who signs, in order</h2>
            <p class="muted">
              Add each person and position their field. The next person can sign
              once the person before them has finished.
            </p>
            <form @submit.prevent="addRecipient">
              <label class="field"
                >Recipient name<input
                  v-model="recipientName"
                  required
                  maxlength="100"
                  autocomplete="name" /></label
              ><label class="field"
                >Recipient email<input
                  v-model="recipientEmail"
                  type="email"
                  required
                  maxlength="254"
                  autocomplete="email" /></label
              ><button
                class="button secondary full"
                :disabled="staged.length >= 10 || busy"
              >
                <Plus :size="17" />Add signing field
              </button>
            </form>
            <ol
              v-if="staged.length"
              class="recipient-staging"
              aria-label="Signer order"
            >
              <li v-for="(r, index) in staged" :key="r.field.id">
                <span class="signer-number" aria-hidden="true">{{
                  index + 1
                }}</span>
                <div class="staged-recipient">
                  <button
                    class="text-button signer-field-button"
                    :aria-label="`Position signing field for ${r.name}`"
                    @click="
                      active = r.field.id;
                      jumpToPage(r.field.pageIndex);
                      revealPlacement(r.field);
                    "
                  >
                    <strong>{{ r.name }}</strong
                    ><span>Page {{ r.field.pageIndex + 1 }}</span>
                  </button>
                  <span class="recipient-email">{{ r.email }}</span>
                  <ul
                    v-if="r.textFields.length"
                    class="recipient-text-list"
                    aria-label="Text fields"
                  >
                    <li v-for="field in r.textFields" :key="field.id">
                      <button
                        class="text-button"
                        :aria-label="`Position ${field.label} for ${r.name}`"
                        @click="
                          selectPlacement(field);
                          jumpToPage(field.pageIndex);
                          revealPlacement(field);
                        "
                      >
                        <Type :size="14" />{{
                          field.label || "Untitled field"
                        }}
                        · Page {{ field.pageIndex + 1 }}
                      </button>
                    </li>
                  </ul>
                  <button
                    class="text-button"
                    :aria-label="`Add text field for ${r.name}`"
                    :disabled="busy || r.textFields.length >= 10"
                    @click="addRecipientText(r)"
                  >
                    <Plus :size="15" />Add text field
                  </button>
                  <div class="signer-order-actions">
                    <button
                      class="icon-button"
                      :aria-label="`Move ${r.name} up`"
                      :title="`Move ${r.name} up`"
                      :disabled="index === 0 || busy"
                      @click="moveRecipient(index, -1)"
                    >
                      <ArrowUp :size="17" />
                    </button>
                    <button
                      class="icon-button"
                      :aria-label="`Move ${r.name} down`"
                      :title="`Move ${r.name} down`"
                      :disabled="index === staged.length - 1 || busy"
                      @click="moveRecipient(index, 1)"
                    >
                      <ArrowDown :size="17" />
                    </button>
                    <button
                      class="text-button danger-text"
                      :aria-label="`Remove ${r.name}`"
                      :disabled="busy"
                      @click="removeRecipient(r.field.id)"
                    >
                      <Trash2 :size="15" />Remove
                    </button>
                  </div>
                </div>
              </li>
            </ol>
            <div v-if="staged.length" class="signer-list-confirmation">
              <p class="hint">
                Check the order and each field before creating links. The
                document and signer list will then be locked. All links expire 7
                days from creation.
              </p>
              <p v-if="unfinishedRecipient" class="hint unfinished-recipient">
                Add the person above to the list, or clear their details, before
                creating links.
              </p>
              <label class="checkbox"
                ><input
                  v-model="termsLocked"
                  type="checkbox"
                  :disabled="busy"
                />The agreement terms are complete. Recipient text fields are
                only for signing details, such as names, titles, places and
                dates.</label
              >
              <p class="hint">
                To change agreement terms later, upload a new version and
                collect fresh signatures.
              </p>
              <button
                class="button primary full"
                :disabled="busy || unfinishedRecipient || !termsLocked"
                @click="createInvitations"
              >
                <Link :size="17" />{{
                  busy ? "Creating…" : "Create signing links"
                }}
              </button>
            </div>
          </section>
        </template>
        <section
          v-if="invitations.length"
          class="tool-section signing-requests"
        >
          <h2>Signing order</h2>
          <p class="signing-progress" aria-live="polite">
            {{ signedCount }} of {{ activeCount }} active signers have signed.
            <template v-if="currentSigner"
              >{{ currentSigner.name }} is next.</template
            >
            <template v-else-if="expiredSigner"
              >An expired link is holding up signing. Revoke it to skip that
              person.</template
            >
            <template v-else-if="doc.status === 'completed'"
              >Signing is complete.</template
            >
          </p>
          <p v-if="doc.status === 'awaiting'" class="hint">
            You can share every link now. Each person can sign when it is their
            turn.
          </p>
          <ol class="signer-list" aria-label="Signing requests">
            <li
              v-for="invitation in invitations"
              :key="invitation.id"
              class="invitation"
            >
              <div class="signer-heading">
                <span class="signer-number" aria-hidden="true">{{
                  invitation.signingOrder
                }}</span>
                <div>
                  <strong>{{ invitation.name }}</strong
                  ><span class="recipient-email">{{ invitation.email }}</span>
                </div>
              </div>
              <span class="status" :class="invitation.signingStatus">{{
                signingStatus(invitation)
              }}</span>
              <span v-if="invitation.signedAt" class="hint"
                >Signed {{ formatDate(invitation.signedAt) }}</span
              >
              <span v-else-if="invitation.state === 'pending'" class="hint"
                >{{
                  invitation.signingStatus === "expired" ? "Expired" : "Expires"
                }}
                {{ formatDate(invitation.expiresAt) }}</span
              >
              <template v-if="invitation.state === 'pending'"
                ><CopyField
                  v-if="invitation.signingStatus !== 'expired'"
                  class="signing-link"
                  :value="invitation.url!"
                  :input-label="`Signing link for ${invitation.name}`"
                  copy-label="Copy link"
                  copied-message="Link copied."
                  failure-message="Could not copy the link. Select and copy it from the box."
                  small
                  :disabled="busy"
                />
                <div class="button-row wrap">
                  <button
                    v-if="invitation.signingStatus === 'expired'"
                    class="button small secondary"
                    :disabled="busy"
                    @click="reissue(invitation)"
                  >
                    <RefreshCw :size="15" />Renew link
                  </button>
                  <button
                    v-if="invitation.signingStatus !== 'expired'"
                    class="button small secondary"
                    :disabled="busy"
                    @click="previewEmail(invitation)"
                  >
                    <Mail :size="15" />Email</button
                  ><button
                    class="text-button danger-text"
                    :disabled="busy"
                    @click="revoke(invitation)"
                  >
                    Revoke
                  </button>
                </div></template
              >
            </li>
          </ol>
          <button
            v-if="doc.status === 'awaiting'"
            class="text-button danger-text"
            :disabled="busy"
            @click="cancelSigning"
          >
            Cancel signing request
          </button>
        </section>
        <section class="tool-section download-section">
          <h2>Finish your PDF</h2>
          <p v-if="doc.status === 'cancelled'" class="notice">
            This request was cancelled. Any signatures already applied are
            retained; the document was not signed by everyone requested.
          </p>
          <template v-if="completedRecord?.state === 'ready'">
            <a
              class="button primary full"
              :href="`/api/documents/${id}/record/pdf`"
              download
              ><Download :size="18" />Download completed PDF</a
            >
            <p v-if="completedRecord.evidenceComplete === false" class="notice">
              {{ completedRecord.message }}
            </p>
            <template v-else>
              <a
                class="button secondary full"
                :href="`/api/documents/${id}/record/evidence`"
                download
                >Download signing record</a
              >
              <p class="hint">
                The signing record includes reviewed versions, consent, a
                receipt and an offline verification tool. Keep a copy separately
                from PaperSign.
              </p>
              <p class="hint">
                {{
                  completedRecord.timestamp?.state === "available"
                    ? "A trusted timestamp and validation evidence are included."
                    : completedRecord.timestamp?.state === "failed"
                      ? "The timestamp service failed. Your signed PDF and signing record are preserved."
                      : completedRecord.timestamp?.state === "pending"
                        ? "The trusted timestamp is still being prepared."
                        : "No independently trusted timestamp is attached to this record."
                }}
              </p>
              <details>
                <summary>Receipt fingerprint</summary>
                <code class="receipt-fingerprint">{{
                  completedRecord.receipt?.manifestSha256
                }}</code>
              </details>
            </template>
          </template>
          <p
            v-else-if="
              completedRecord &&
              ['queued', 'working'].includes(completedRecord.state)
            "
            class="notice"
            role="status"
          >
            Preparing the permanent signing record…
          </p>
          <div
            v-else-if="completedRecord?.state === 'failed'"
            class="notice error"
            role="alert"
          >
            <p>{{ completedRecord.error }}</p>
            <button class="button secondary" @click="retryRecord">
              Retry signing record
            </button>
          </div>
          <p v-if="doc.status === 'awaiting'" class="notice">
            The completed PDF will be available when all active requests are
            signed.
          </p>
          <button
            v-if="completedRecord?.state !== 'ready'"
            class="button primary full"
            :disabled="busy || doc.status === 'awaiting'"
            @click="startExport(false)"
          >
            <Download :size="18" />{{
              busy && exportJob
                ? "Preparing PDF…"
                : doc.status === "draft" &&
                    placements.some((p) => p.kind !== "text")
                  ? "Review and sign"
                  : "Prepare download"
            }}
          </button>
          <button
            class="text-button advanced-download-button"
            :disabled="busy || doc.status === 'awaiting'"
            @click="openAdvancedDownload"
          >
            <SlidersHorizontal :size="16" />Advanced download
          </button>
          <a
            v-if="exportJob?.state === 'ready'"
            class="button secondary full download-ready"
            :href="`/api/exports/${exportJob.id}/download`"
            download
            ><Download :size="18" />Download signed PDF</a
          >
          <p class="hint">Your original PDF stays intact.</p>
          <button
            class="text-button danger-text"
            :disabled="busy || doc.status === 'awaiting'"
            @click="requestDeletion"
          >
            Request document deletion
          </button>
          <p v-if="certificateSealingEnabled" class="hint">
            Downloads include an organization certificate seal, trusted
            timestamp and embedded validation evidence.
          </p>
          <p
            v-if="exportJob?.state === 'ready' && exportJob.seal"
            class="hint"
            role="status"
          >
            Certificate seal verified. Timestamp:
            {{ formatDate(exportJob.seal.timestamp) }}.
          </p>
        </section>
      </aside>
    </div>
    <OwnerReviewDialog
      v-if="doc"
      ref="ownerReviewDialog"
      :document-id="id"
      :name="doc.name"
      :pages="doc.pages"
    />
    <dialog
      ref="advancedDialog"
      class="advanced-download-dialog panel"
      aria-labelledby="advanced-download-title"
      aria-describedby="advanced-download-description"
      @close="advancedClosed"
      @click="$event.target === advancedDialog && closeAdvancedDownload()"
    >
      <div class="section-heading">
        <h2 id="advanced-download-title">Advanced download</h2>
        <button
          class="icon-button"
          aria-label="Close advanced download"
          @click="closeAdvancedDownload"
        >
          <X :size="20" />
        </button>
      </div>
      <p id="advanced-download-description" class="muted">
        Choose how to prepare your signed PDF.
      </p>
      <form @submit.prevent="startExport(rasterize)">
        <label class="checkbox"
          ><input
            v-model="rasterize"
            type="checkbox"
            :disabled="busy"
          />Rasterize the download</label
        >
        <p class="hint">
          Turns every page into an image at 200 DPI. Text will no longer be
          searchable or selectable.
        </p>
        <p v-if="advancedError" class="notice error" role="alert">
          {{ advancedError }}
        </p>
        <div class="form-actions">
          <button
            type="button"
            class="button secondary"
            @click="closeAdvancedDownload"
          >
            Cancel
          </button>
          <button
            class="button primary"
            :disabled="busy || doc?.status === 'awaiting'"
          >
            <Download :size="17" />{{
              busy ? "Preparing PDF…" : "Prepare download"
            }}
          </button>
        </div>
      </form>
    </dialog>
    <div
      v-if="emailPreview"
      class="dialog-backdrop"
      @click.self="emailPreview = undefined"
    >
      <section
        class="email-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-title"
      >
        <div class="section-heading">
          <h2 id="email-title">Review invitation email</h2>
          <button
            class="icon-button"
            aria-label="Close email preview"
            @click="emailPreview = undefined"
          >
            <X :size="20" />
          </button>
        </div>
        <dl>
          <dt>To</dt>
          <dd>{{ emailPreview.to }}</dd>
          <dt>CC / BCC</dt>
          <dd>None</dd>
          <dt>Subject</dt>
          <dd>{{ emailPreview.subject }}</dd>
          <dt>Attachments</dt>
          <dd>None</dd>
        </dl>
        <EmailPreview :html="emailPreview.html" :body="emailPreview.body" />
        <p v-if="!emailPreview.enabled" class="notice">
          Email delivery is not configured. Copy the signing link to share it.
        </p>
        <div class="form-actions">
          <button class="button secondary" @click="emailPreview = undefined">
            Close</button
          ><button
            class="button primary"
            :disabled="!emailPreview.enabled || busy"
            @click="sendEmail"
          >
            Send this email
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.recipient-staging {
  margin: 20px 0 0;
}
.recipient-staging > li {
  padding: 16px 0;
}
.staged-recipient {
  display: grid;
  gap: 8px;
}
.signer-field-button {
  padding: 0;
}
.staged-recipient .recipient-email {
  display: block;
  overflow-wrap: anywhere;
}
.staged-recipient > .text-button:not(.signer-field-button) {
  justify-self: start;
  min-height: 40px;
}
.recipient-text-list {
  margin: 0;
}
.recipient-text-list > li {
  display: block;
  border: 0;
  padding: 0;
}
.recipient-text-list .text-button {
  min-height: 40px;
  max-width: 100%;
}
.signer-order-actions {
  margin: 0;
}
.signer-order-actions .text-button {
  min-height: 40px;
}
.signer-list-confirmation {
  display: grid;
  gap: 14px;
  margin-top: 20px;
}
.signer-list-confirmation .hint {
  margin: 0;
}
.selection-tools {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 20px 0;
}
.selection-tools strong {
  font-size: 13px;
}
.selection-tools > .text-button {
  align-self: flex-start;
  min-height: 40px;
}
.selection-tools .hint {
  overflow-wrap: anywhere;
}
.download-section {
  padding-top: 24px;
}
</style>
