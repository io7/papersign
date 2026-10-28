<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Feather,
  Check,
  ChevronLeft,
  ChevronRight,
  PenLine,
  Clock3,
  Mail,
  RefreshCw,
} from "@lucide/vue";
import PdfStage from "../components/PdfStage.vue";
import PlacementBox from "../components/PlacementBox.vue";
import SignatureInput from "../components/SignatureInput.vue";
import { api, json, currentUser, errorMessage } from "../api";
import { fitPdfText, normalizePdfText } from "../../shared/pdf-text";
import type { Signature, SigningRequest } from "../../shared/types";
import type { SigningVerification } from "../../shared/signing-consent";
import type { EvidenceReceipt } from "../../shared/evidence";
const route = useRoute(),
  token = String(route.params.token);
const details = ref<
  SigningRequest & {
    verification: SigningVerification;
    recordVerification?: SigningVerification;
    consent: { version: string; text: string };
    canUseSavedSignature: boolean;
    cancelled?: boolean;
  }
>();
const completedRecord = ref<{
  state: "waiting" | "preparing" | "failed" | "ready" | "unavailable";
  outcome?: string;
  evidenceComplete?: boolean;
  timestamp?: {
    state:
      "available" | "failed" | "pending" | "not-configured" | "not-requested";
  };
  receipt?: EvidenceReceipt;
  participants?: Array<{ name: string; order: number; state: string }>;
}>();
// The verification panel shows its errors beside the code field instead of
// at the top of the page.
const needsVerification = computed(() => {
  const request = details.value;
  return Boolean(
    request &&
    request.state !== "signed" &&
    request.signingStatus !== "waiting" &&
    request.canSign &&
    !request.verification?.verified,
  );
});
const verificationBase = computed(
  () =>
    `/sign/${token}${details.value?.state === "signed" ? "/record" : ""}/verification`,
);
const verificationCode = ref(""),
  codeSent = ref(false),
  resendSeconds = ref(0),
  pdfReady = ref(false),
  reviewId = ref(""),
  receipt = ref<{ id: string; hash: string }>();
let resendTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => clearInterval(resendTimer));
const textValues = ref<Record<string, string>>({});
const textFields = computed(() => details.value?.textFields ?? []);
const textFieldErrors = computed(() => {
  const errors: Record<string, string> = {};
  for (const field of textFields.value) {
    try {
      const page = details.value?.pages[field.pageIndex];
      if (!page)
        throw new Error(
          "This field's page is unavailable. Reload the request.",
        );
      fitPdfText(
        textValues.value[field.id] ?? "",
        field.fontSize,
        field.width * page.width,
        field.height * page.height,
      );
    } catch (e) {
      const message = errorMessage(e);
      errors[field.id] = message.includes("does not fit")
        ? "This text does not fit. Shorten it or ask the sender for a larger field."
        : message;
    }
  }
  return errors;
});
const textFieldsValid = computed(
  () => Object.keys(textFieldErrors.value).length === 0,
);
const signatures = ref<Signature[]>([]),
  selected = ref(""),
  signature = ref<{ png: string; source: "drawn" | "uploaded" } | null>(null),
  method = ref<"new" | "saved">("new");
const name = ref(""),
  consent = ref(false),
  saveToAccount = ref(false),
  busy = ref(false),
  loading = ref(true),
  error = ref(""),
  pageIndex = ref(0),
  pdfStage = ref<InstanceType<typeof PdfStage>>(),
  refreshNotice = ref("");
const pdfUrl = computed(
  () => `/api/sign/${token}/pdf?revision=${details.value?.revision}`,
);
const preview = computed(() =>
  method.value === "saved" && selected.value
    ? `/api/signatures/${selected.value}/image`
    : signature.value?.png,
);
function jumpToPage(index: number) {
  pageIndex.value = index;
  pdfStage.value?.scrollToPage(index);
}
async function load(resetIdentity = true) {
  details.value = await api(`/sign/${token}`);
  textValues.value = Object.fromEntries(
    (details.value?.textFields ?? []).map((field) => [
      field.id,
      textValues.value[field.id] ?? "",
    ]),
  );
  consent.value = false;
  if (resetIdentity) {
    name.value = details.value!.name;
    pageIndex.value = details.value!.field.pageIndex;
  }
  if (
    details.value?.state === "signed" &&
    details.value.recordVerification?.verified
  )
    completedRecord.value = await api(`/sign/${token}/record`);
}
async function checkAgain() {
  busy.value = true;
  error.value = "";
  refreshNotice.value = "";
  try {
    await load();
    if (details.value?.signingStatus === "waiting")
      refreshNotice.value =
        "It is not your turn yet. Check again after the earlier signers have finished.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    await load();
    if (currentUser.value && details.value?.canUseSavedSignature) {
      signatures.value = await api("/signatures");
      selected.value = signatures.value[0]?.id ?? "";
      if (selected.value) method.value = "saved";
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
watch([name, signature, selected, method], () => {
  consent.value = false;
});
function reviewState(state: {
  url: string;
  ready: boolean;
  reviewId?: string;
}) {
  if (state.url !== pdfUrl.value) return;
  pdfReady.value = state.ready && Boolean(state.reviewId);
  reviewId.value = state.reviewId ?? "";
  if (!pdfReady.value) consent.value = false;
}
async function sendCode() {
  if (!details.value) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await api<{ resendAfterSeconds: number }>(
      `${verificationBase.value}/send`,
      { method: "POST", body: json({ revision: details.value.revision }) },
    );
    codeSent.value = true;
    verificationCode.value = "";
    resendSeconds.value = response.resendAfterSeconds;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      if (resendSeconds.value > 0) resendSeconds.value--;
      else clearInterval(resendTimer);
    }, 1000);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function verifyCode() {
  if (!details.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`${verificationBase.value}/confirm`, {
      method: "POST",
      body: json({
        revision: details.value.revision,
        code: verificationCode.value,
      }),
    });
    verificationCode.value = "";
    await load(false);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function downloadReceipt() {
  if (!receipt.value || !details.value) return;
  const bytes = new Blob(
    [
      JSON.stringify(
        {
          format: "papersign-acceptance-receipt-v1",
          documentName: details.value.documentName,
          acceptanceId: receipt.value.id,
          acceptanceHash: receipt.value.hash,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(bytes),
    link = document.createElement("a");
  link.href = url;
  link.download = "papersign-acceptance-receipt.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function sign() {
  if (
    !details.value?.canSign ||
    !details.value.verification?.verified ||
    !pdfReady.value ||
    !reviewId.value ||
    !consent.value ||
    !textFieldsValid.value
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    const submittedText = textFields.value.map((field) => ({
      id: field.id,
      text: normalizePdfText(textValues.value[field.id] ?? ""),
    }));
    let signatureId = method.value === "saved" ? selected.value : undefined;
    if (
      !signatureId &&
      saveToAccount.value &&
      currentUser.value &&
      details.value.canUseSavedSignature &&
      signature.value
    ) {
      const saved = await api<Signature>("/signatures", {
        method: "POST",
        body: json({ name: "My signature", ...signature.value }),
      });
      signatureId = saved.id;
      signatures.value.push(saved);
      selected.value = saved.id;
      method.value = "saved";
    }
    const result = await api<{
      acceptanceReceiptId: string;
      acceptanceReceiptHash: string;
    }>(`/sign/${token}`, {
      method: "POST",
      body: json({
        name: name.value,
        consent: consent.value,
        consentVersion: details.value.consent.version,
        reviewId: reviewId.value,
        revision: details.value.revision,
        textValues: submittedText,
        ...(signatureId ? { signatureId } : { png: signature.value?.png }),
      }),
    });
    receipt.value = {
      id: result.acceptanceReceiptId,
      hash: result.acceptanceReceiptHash,
    };
    codeSent.value = false;
    await load();
  } catch (e) {
    error.value = errorMessage(e);
    consent.value = false;
    // A request may have changed while the signer was reviewing it.
    // Refresh the document and require consent to that current version.
    await load(false).catch(() => {});
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="sign-page">
    <header class="sign-header">
      <RouterLink to="/" class="brand"
        ><Feather :size="26" /><span
          >PaperSign<span class="brand-dot">.</span></span
        ></RouterLink
      ><RouterLink
        v-if="!currentUser"
        :to="{ path: '/login', query: { next: route.fullPath } }"
        class="text-button"
        >Sign in to use saved signatures</RouterLink
      ><span v-else class="muted">{{ currentUser.name }}</span>
    </header>
    <p v-if="loading" class="loading" role="status">
      Opening your signing request…
    </p>
    <p v-if="error && !needsVerification" class="notice error" role="alert">
      {{ error }}
    </p>
    <template v-if="details"
      ><div v-if="details.state === 'signed'" class="sign-complete">
        <span class="completion-icon"><Check :size="30" /></span>
        <h1>Your signature is in place.</h1>
        <p>
          {{
            details.cancelled
              ? "This signing request was cancelled. Your accepted signature remains in its preserved signing record."
              : details.completed
                ? "Signing has finished. You can get the final PDF and its signing record below."
                : "The next person can now sign. Keep this link to get the final PDF once signing has finished."
          }}
        </p>
        <button
          v-if="receipt"
          class="button secondary"
          @click="downloadReceipt"
        >
          Save my acceptance receipt
        </button>
        <section class="record-access" aria-labelledby="record-access-heading">
          <h2 id="record-access-heading">Your signing record</h2>
          <template v-if="!details.recordVerification?.verified">
            <p>
              Verify {{ details.recordVerification?.emailHint }} again to access
              the completed PDF. This access remains available after the signing
              invitation expires.
            </p>
            <p
              v-if="!details.recordVerification?.deliveryAvailable"
              class="notice error"
              role="alert"
            >
              Email verification is unavailable. Ask the sender to contact the
              PaperSign administrator.
            </p>
            <template v-else>
              <form v-if="codeSent" @submit.prevent="verifyCode">
                <label class="field" for="record-email-code"
                  >Email verification code
                  <input
                    id="record-email-code"
                    v-model="verificationCode"
                    class="code-input"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    pattern="[0-9]{6}"
                    minlength="6"
                    maxlength="6"
                    required
                    :disabled="busy"
                  />
                </label>
                <p class="hint">
                  Enter the six-digit code in this browser within 10 minutes.
                </p>
                <button
                  class="button primary"
                  :disabled="busy || !/^\d{6}$/.test(verificationCode)"
                >
                  {{ busy ? "Verifying…" : "Open signing record" }}
                </button>
              </form>
              <button
                :class="codeSent ? 'text-button' : 'button primary'"
                :disabled="busy || resendSeconds > 0"
                @click="sendCode"
              >
                {{
                  resendSeconds > 0
                    ? `Send another code in ${resendSeconds}s`
                    : codeSent
                      ? "Send another code"
                      : busy
                        ? "Sending code…"
                        : "Send verification code"
                }}
              </button>
            </template>
          </template>
          <template v-else-if="completedRecord?.state === 'ready'">
            <p v-if="completedRecord.outcome === 'cancelled'" class="notice">
              The sender cancelled this signing request. The record preserves
              signatures accepted before cancellation. It is not a fully signed
              agreement.
            </p>
            <p
              v-else-if="
                completedRecord.outcome === 'completed-with-revocations'
              "
              class="notice"
            >
              Signing finished with revoked requests. Only the people listed as
              signed below signed this document.
            </p>
            <p v-else>All requested signatures are complete.</p>
            <p v-if="completedRecord.evidenceComplete === false" class="notice">
              This document includes signatures added before PaperSign preserved
              signing evidence. You can download the final PDF, but a complete
              signing record cannot be created for those earlier signatures.
            </p>
            <ul class="record-participants">
              <li
                v-for="participant in completedRecord.participants"
                :key="participant.order"
              >
                <span>{{ participant.name }}</span
                ><span>{{
                  participant.state === "signed" ? "Signed" : "Revoked"
                }}</span>
              </li>
            </ul>
            <div class="record-downloads">
              <a class="button primary" :href="`/api/sign/${token}/record/pdf`"
                >Download final PDF</a
              >
              <a
                v-if="
                  completedRecord.evidenceComplete && completedRecord.receipt
                "
                class="button secondary"
                :href="`/api/sign/${token}/record/evidence`"
                >Download signing evidence</a
              >
              <a
                v-if="
                  completedRecord.evidenceComplete && completedRecord.receipt
                "
                class="text-button"
                :href="`/api/sign/${token}/record/receipt`"
                >Save verification receipt</a
              >
            </div>
            <p
              v-if="completedRecord.evidenceComplete && completedRecord.receipt"
              class="hint"
            >
              Keep the receipt separately from the evidence download. It lets
              you check later that the preserved record is the same one.
            </p>
            <p v-if="completedRecord.timestamp" class="hint" role="status">
              {{
                completedRecord.timestamp.state === "available"
                  ? "An independent timestamp is included in the signing evidence."
                  : completedRecord.timestamp.state === "pending"
                    ? "An independent timestamp is being requested. Check again before saving the evidence package."
                    : completedRecord.timestamp.state === "failed"
                      ? "The independent timestamp could not be obtained. This record currently contains PaperSign's recorded times only."
                      : "Independent timestamping is not configured. This record contains PaperSign's recorded times only."
              }}
            </p>
            <button
              v-if="completedRecord.timestamp?.state === 'pending'"
              class="text-button"
              :disabled="busy"
              @click="checkAgain"
            >
              {{ busy ? "Checking…" : "Check timestamp status" }}
            </button>
          </template>
          <template v-else>
            <p role="status">
              {{
                completedRecord?.state === "unavailable"
                  ? "This document has no preserved completion record. Ask the sender for its existing PDF download."
                  : completedRecord?.state === "failed"
                    ? "The final PDF could not be prepared. Ask the sender to retry preparing it."
                    : completedRecord?.state === "waiting"
                      ? "Other signing requests are still open. The final PDF will be available when signing finishes."
                      : "The final PDF and signing record are being prepared."
              }}
            </p>
            <button
              class="button secondary"
              :disabled="busy"
              @click="checkAgain"
            >
              {{ busy ? "Checking…" : "Check again" }}
            </button>
          </template>
        </section>
        <RouterLink v-if="currentUser" class="button secondary" to="/documents"
          >Go to my documents</RouterLink
        ><RouterLink v-else class="button secondary" to="/register"
          >Create an account for next time</RouterLink
        >
      </div>
      <div
        v-else-if="details.signingStatus === 'waiting'"
        class="sign-complete sign-waiting"
      >
        <span class="completion-icon waiting-icon"><Clock3 :size="30" /></span>
        <h1>Waiting for your turn</h1>
        <p class="waiting-document">{{ details.documentName }}</p>
        <p class="signing-position">
          Signer {{ details.signingOrder }} of {{ details.totalSigners }}
        </p>
        <p>
          {{
            details.waitingForSigners === 1
              ? "One person needs"
              : `${details.waitingForSigners} people need`
          }}
          to sign before you. Keep this private link; you can review the
          document with their signatures and add yours when it is your turn.
        </p>
        <button class="button primary" :disabled="busy" @click="checkAgain">
          <RefreshCw :size="17" />{{ busy ? "Checking…" : "Check again" }}
        </button>
        <p v-if="refreshNotice" class="hint" role="status">
          {{ refreshNotice }}
        </p>
      </div>
      <div v-else-if="!details.canSign" class="sign-complete">
        <h1>
          {{
            details.signingStatus === "expired"
              ? "This signing link has expired"
              : "This signing link was revoked"
          }}
        </h1>
        <p>{{ details.documentName }}</p>
        <p>Contact the sender if you still need to sign this document.</p>
      </div>
      <section
        v-else-if="needsVerification"
        class="sign-verification panel"
        aria-labelledby="verify-email-heading"
      >
        <span class="completion-icon"><Mail :size="28" /></span>
        <h1 id="verify-email-heading">Verify your email to sign</h1>
        <p class="verify-document">{{ details.documentName }}</p>
        <p class="verify-intro">
          {{ codeSent ? "We sent" : "We will send" }} a one-time code to
          <strong>{{ details.verification?.emailHint }}</strong>. Enter it here
          to open the document and add your signature.
        </p>
        <p
          v-if="!details.verification?.deliveryAvailable"
          class="notice error"
          role="alert"
        >
          Email verification is unavailable. Ask the sender to contact the
          PaperSign administrator.
        </p>
        <template v-else>
          <p v-if="error" class="notice error" role="alert">{{ error }}</p>
          <form v-if="codeSent" @submit.prevent="verifyCode">
            <label class="field" for="signer-code"
              >Email verification code
              <input
                id="signer-code"
                v-model="verificationCode"
                class="code-input"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{6}"
                minlength="6"
                maxlength="6"
                required
                :disabled="busy"
                aria-describedby="signer-code-help"
              />
            </label>
            <p id="signer-code-help" class="hint">
              The six-digit code expires in 10 minutes. Keep this browser tab
              open and check your spam folder if needed.
            </p>
            <button
              class="button primary full"
              :disabled="busy || !/^\d{6}$/.test(verificationCode)"
            >
              {{ busy ? "Verifying…" : "Verify and open document" }}
            </button>
          </form>
          <button
            :class="codeSent ? 'text-button resend' : 'button primary full'"
            :disabled="busy || resendSeconds > 0"
            @click="sendCode"
          >
            {{
              resendSeconds > 0
                ? `Send another code in ${resendSeconds}s`
                : codeSent
                  ? "Send another code"
                  : busy
                    ? "Sending code…"
                    : "Send verification code"
            }}
          </button>
        </template>
        <p class="hint verify-footnote">
          Never share your code with anyone, including the sender.
        </p>
      </section>
      <template v-else
        ><div class="sign-title">
          <h1>Review and sign</h1>
          <p>{{ details.documentName }}</p>
          <p class="signing-position">
            Signer {{ details.signingOrder }} of {{ details.totalSigners
            }}<template v-if="details.signingOrder > 1">
              · Earlier signatures are included in this PDF.</template
            >
          </p>
          <a
            class="text-button"
            :href="pdfUrl"
            target="_blank"
            rel="noopener noreferrer"
            >Open PDF in a new tab</a
          >
        </div>
        <div class="sign-layout">
          <section class="document-workspace" aria-label="Document to sign">
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
                    jumpToPage(
                      Number(($event.target as HTMLSelectElement).value),
                    )
                  "
                >
                  <option
                    v-for="(_, index) in details.pages"
                    :key="index"
                    :value="index"
                  >
                    {{ index + 1 }}
                  </option>
                </select>
                of {{ details.pages.length }}</label
              ><button
                class="icon-button"
                aria-label="Next page"
                :disabled="pageIndex === details.pages.length - 1"
                @click="jumpToPage(pageIndex + 1)"
              >
                <ChevronRight :size="20" /></button
              ><button
                v-if="pageIndex !== details.field.pageIndex"
                class="text-button"
                @click="jumpToPage(details.field.pageIndex)"
              >
                Go to signature
              </button>
            </div>
            <PdfStage
              ref="pdfStage"
              :url="pdfUrl"
              :pages="details.pages"
              @review-state="reviewState"
              v-model:page-index="pageIndex"
              v-slot="{ pageIndex: visiblePageIndex }"
              ><PlacementBox
                v-if="visiblePageIndex === details.field.pageIndex"
                :field="details.field"
                :image="preview"
                :label="details.name" /><PlacementBox
                v-for="field in textFields.filter(
                  (field) => field.pageIndex === visiblePageIndex,
                )"
                :key="field.id"
                :field="field"
                :text="
                  textValues[field.id]?.trim()
                    ? textValues[field.id]
                    : undefined
                "
                :font-size="field.fontSize"
                :page="details.pages[field.pageIndex]"
                :text-field="true"
                :label="field.label"
            /></PdfStage>
          </section>
          <section class="guest-signature-panel panel">
            <h2>Your signature</h2>
            <p class="muted">
              Review the document, then apply your signature to the highlighted
              field.
            </p>
            <div v-if="signatures.length" class="segmented">
              <button
                :class="{ selected: method === 'saved' }"
                :aria-pressed="method === 'saved'"
                @click="method = 'saved'"
              >
                Saved signature</button
              ><button
                :class="{ selected: method === 'new' }"
                :aria-pressed="method === 'new'"
                @click="method = 'new'"
              >
                New signature
              </button>
            </div>
            <div v-if="method === 'saved'" class="signature-choices">
              <button
                v-for="s in signatures"
                :key="s.id"
                class="signature-choice"
                :class="{ chosen: selected === s.id }"
                :aria-pressed="selected === s.id"
                @click="selected = s.id"
              >
                <img
                  :src="`/api/signatures/${s.id}/image`"
                  :alt="s.name"
                /><span>{{ s.name }}</span>
              </button>
            </div>
            <SignatureInput v-else @change="signature = $event" />
            <form @submit.prevent="sign">
              <section
                v-if="textFields.length"
                class="guest-text-fields"
                aria-labelledby="guest-text-fields-heading"
              >
                <h3 id="guest-text-fields-heading">Complete these fields</h3>
                <p class="hint">
                  All fields are required. Your entries appear on the PDF.
                </p>
                <div
                  v-for="field in textFields"
                  :key="field.id"
                  class="guest-text-field"
                >
                  <label class="field" :for="`text-field-${field.id}`">
                    {{ field.label }}
                    <input
                      :id="`text-field-${field.id}`"
                      v-model="textValues[field.id]"
                      required
                      maxlength="200"
                      :disabled="busy"
                      :aria-invalid="
                        Boolean(
                          textValues[field.id] && textFieldErrors[field.id],
                        )
                      "
                      :aria-describedby="
                        textValues[field.id] && textFieldErrors[field.id]
                          ? `text-field-error-${field.id}`
                          : undefined
                      "
                      @input="consent = false"
                    />
                  </label>
                  <p
                    v-if="textValues[field.id] && textFieldErrors[field.id]"
                    :id="`text-field-error-${field.id}`"
                    class="hint field-error"
                    role="alert"
                  >
                    {{ textFieldErrors[field.id] }}
                  </p>
                  <button
                    type="button"
                    class="text-button"
                    :aria-label="`Show ${field.label} on page ${field.pageIndex + 1}`"
                    @click="jumpToPage(field.pageIndex)"
                  >
                    Show on page {{ field.pageIndex + 1 }}
                  </button>
                </div>
              </section>
              <label class="field"
                >Your full name<input
                  v-model="name"
                  required
                  maxlength="100"
                  autocomplete="name" /></label
              ><label
                v-if="
                  currentUser &&
                  details.canUseSavedSignature &&
                  method === 'new'
                "
                class="checkbox"
                ><input v-model="saveToAccount" type="checkbox" />Save this
                signature to my account</label
              ><label class="checkbox consent"
                ><input
                  v-model="consent"
                  type="checkbox"
                  required
                  :disabled="!pdfReady || busy"
                />{{ details.consent.text }}</label
              ><button
                class="button primary full"
                :disabled="
                  busy ||
                  !pdfReady ||
                  !consent ||
                  !textFieldsValid ||
                  (method === 'new' ? !signature : !selected)
                "
              >
                <PenLine :size="18" />{{
                  busy ? "Applying signature…" : "Agree and sign"
                }}
              </button>
              <p v-if="!pdfReady" class="hint" role="status">
                Signing becomes available once this document has opened
                successfully. If the viewer reports an error, reload the page.
              </p>
              <p class="hint">
                Your signature and acceptance time will be recorded.
              </p>
            </form>
          </section>
        </div></template
      ></template
    >
  </div>
</template>
<style scoped>
.sign-verification {
  max-width: 500px;
  margin: 64px auto 0;
  padding: 44px 40px 30px;
  text-align: center;
}
.sign-verification .completion-icon {
  margin-bottom: 20px;
}
.sign-verification h1 {
  font-size: 28px;
}
.sign-verification p {
  overflow-wrap: anywhere;
  text-wrap: balance;
}
.verify-document {
  margin-top: 10px;
  font-size: 16px;
  font-weight: 570;
}
.verify-intro {
  margin-top: 14px;
  color: var(--muted);
}
.verify-intro strong {
  color: var(--ink);
  font-weight: 570;
}
.sign-verification .notice {
  margin: 24px 0 0;
  text-align: start;
}
.sign-verification form {
  margin-top: 28px;
  text-align: start;
}
.sign-verification .field {
  margin-bottom: 0;
}
.sign-verification form .hint {
  margin: 8px 0 24px;
  text-wrap: pretty;
}
.sign-verification > .button {
  margin-top: 30px;
}
.resend {
  display: flex;
  width: fit-content;
  margin: 14px auto 0;
  font-variant-numeric: tabular-nums;
}
.verify-footnote {
  max-width: none;
  margin-top: 30px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
input.code-input {
  min-height: 52px;
  font-size: 22px;
  letter-spacing: 0.3em;
  text-align: center;
  font-variant-numeric: tabular-nums;
  /* Balance the trailing letter spacing so the digits sit centred. */
  padding-inline-start: calc(12px + 0.3em);
}
.record-access {
  margin-block: 28px;
  text-align: start;
}
.record-access h2 {
  margin-block-end: 12px;
}
.record-access form {
  margin-block: 20px 12px;
}
.record-participants {
  list-style: none;
  padding: 0;
  margin-block: 20px;
}
.record-participants li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding-block: 10px;
  border-bottom: 1px solid var(--line);
}
.record-participants li span:first-child {
  overflow-wrap: anywhere;
}
.record-downloads {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
@media (max-width: 680px) {
  .sign-verification {
    margin-top: 8px;
    padding: 32px 22px 24px;
  }
  .sign-verification .completion-icon {
    width: 56px;
    height: 56px;
    margin-bottom: 18px;
  }
  .sign-verification h1 {
    font-size: 25px;
  }
}
</style>
