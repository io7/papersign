<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Mail, X } from "@lucide/vue";
import CopyField from "../../components/CopyField.vue";
import EmailPreview from "../../components/EmailPreview.vue";
import { api, formatDate } from "../../api";
import type {
  AccountInvitation,
  InvitationEmailPreview,
  UserRole,
} from "../../../shared/admin-types";
import AdminList from "./AdminList.vue";
import { useAdminContext } from "./context";
import { roleName, statusName } from "./format";

const {
  busy,
  error,
  notice,
  location,
  focusRequest,
  navigate,
  failure,
  refresh,
  reloadStatistics,
} = useAdminContext();
const nameInput = ref<HTMLInputElement>();
const name = ref(""),
  email = ref(""),
  role = ref<UserRole>("user");
const emailDialog = ref<HTMLDialogElement>(),
  preview = ref<InvitationEmailPreview>(),
  previewed = ref<AccountInvitation>();
let emailTrigger: HTMLButtonElement | undefined;
let disposed = false;

watch(
  focusRequest,
  async (request) => {
    if (request !== "invite-name") return;
    focusRequest.value = null;
    await nextTick();
    nameInput.value?.focus();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
});

async function invite() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api<AccountInvitation>("/admin/account-invitations", {
      method: "POST",
      body: JSON.stringify({
        name: name.value.trim(),
        email: email.value.trim(),
        role: role.value,
      }),
    });
    name.value = "";
    email.value = "";
    role.value = "user";
    await navigate({ ...location.value, page: 1, query: "" });
    await reloadStatistics();
    notice.value =
      "Invitation created. Copy its private link or preview the email below.";
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
async function revoke(invitation: AccountInvitation) {
  if (
    busy.value ||
    !window.confirm(
      `Revoke the invitation for ${invitation.email}? Its link will stop working.`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/admin/account-invitations/${invitation.id}/revoke`, {
      method: "POST",
      body: "{}",
    });
    await refresh();
    notice.value = "Invitation revoked.";
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
async function openPreview(invitation: AccountInvitation, event: MouseEvent) {
  if (busy.value) return;
  emailTrigger = event.currentTarget as HTMLButtonElement;
  busy.value = true;
  error.value = "";
  try {
    preview.value = await api(
      `/admin/account-invitations/${invitation.id}/email`,
    );
    previewed.value = invitation;
    busy.value = false;
    await nextTick();
    if (disposed || !emailTrigger?.isConnected) return;
    emailTrigger.focus({ preventScroll: true });
    emailDialog.value?.showModal();
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
async function restoreEmailFocus() {
  const trigger = emailTrigger;
  emailTrigger = undefined;
  await nextTick();
  if (
    !disposed &&
    trigger?.isConnected &&
    !trigger.disabled &&
    !emailDialog.value?.open
  )
    trigger.focus({ preventScroll: true });
}
async function sendEmail() {
  if (busy.value || !preview.value?.enabled || !previewed.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/admin/account-invitations/${previewed.value.id}/email`, {
      method: "POST",
      body: JSON.stringify({ previewHash: preview.value.previewHash }),
    });
    emailDialog.value?.close();
    notice.value = `Invitation email sent to ${preview.value.to}.`;
  } catch (e) {
    emailDialog.value?.close();
    await failure(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="admin-invite-form" aria-labelledby="invite-title">
    <h2 id="invite-title">Invite someone to PaperSign</h2>
    <p class="muted">
      Private links expire after seven days. Admins can manage all accounts and
      view uploaded PDFs.
    </p>
    <form class="invite-fields" @submit.prevent="invite">
      <label class="field"
        >Name<input
          ref="nameInput"
          v-model="name"
          required
          maxlength="100"
          autocomplete="off"
      /></label>
      <label class="field"
        >Email<input
          v-model="email"
          type="email"
          required
          maxlength="254"
          autocomplete="off"
      /></label>
      <label class="field"
        >Role<select v-model="role">
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select></label
      >
      <button class="button primary" :disabled="busy">
        {{ busy ? "Please wait…" : "Create invitation" }}
      </button>
    </form>
  </section>
  <AdminList
    v-slot="{ items: invitations }"
    title="Invitations"
    label="invitations"
    endpoint="account-invitations"
  >
    <article
      v-for="invitation in invitations"
      :key="invitation.id"
      class="admin-record invitation-record"
      :aria-label="invitation.email"
    >
      <div class="admin-record-main">
        <h3>{{ invitation.name }}</h3>
        <p>{{ invitation.email }}</p>
        <p class="hint">{{ roleName(invitation.role) }}</p>
      </div>
      <div class="admin-record-metadata">
        <span
          class="status"
          :class="
            invitation.state === 'accepted' ? 'completed' : invitation.state
          "
          >{{ statusName(invitation.state) }}</span
        >
        <p>
          {{
            invitation.state === "accepted"
              ? `Accepted ${formatDate(invitation.acceptedAt!)}`
              : `Expires ${formatDate(invitation.expiresAt)}`
          }}
        </p>
      </div>
      <div v-if="invitation.url" class="invitation-actions">
        <CopyField
          :value="invitation.url"
          label="Private invitation link"
          :input-label="`Invitation link for ${invitation.email}`"
          copy-label="Copy link"
          copied-message="Link copied."
          failure-message="Could not copy the link. Select and copy it from the box."
          :disabled="busy"
        />
        <div class="button-row wrap">
          <button
            class="button secondary"
            :disabled="busy"
            @click="openPreview(invitation, $event)"
          >
            <Mail :size="16" />Preview email</button
          ><button
            class="text-button danger-text"
            :disabled="busy"
            @click="revoke(invitation)"
          >
            Revoke
          </button>
        </div>
      </div>
    </article>
  </AdminList>
  <dialog
    ref="emailDialog"
    class="email-dialog panel"
    aria-labelledby="account-email-title"
    @cancel="busy && $event.preventDefault()"
    @close="restoreEmailFocus"
  >
    <div class="section-heading">
      <h2 id="account-email-title">Review invitation email</h2>
      <button
        class="icon-button"
        aria-label="Close email preview"
        :disabled="busy"
        @click="emailDialog?.close()"
      >
        <X :size="20" />
      </button>
    </div>
    <template v-if="preview"
      ><dl class="email-metadata">
        <dt>To</dt>
        <dd>{{ preview.to }}</dd>
        <dt>CC / BCC</dt>
        <dd>None</dd>
        <dt>Subject</dt>
        <dd>{{ preview.subject }}</dd>
        <dt>Attachments</dt>
        <dd>None</dd>
      </dl>
      <EmailPreview :html="preview.html" :body="preview.body" />
      <p v-if="!preview.enabled" class="notice">
        Email delivery is not configured. Copy the invitation link instead.
      </p>
      <div class="form-actions">
        <button
          class="button secondary"
          :disabled="busy"
          @click="emailDialog?.close()"
        >
          Close</button
        ><button
          class="button primary"
          :disabled="busy || !preview.enabled"
          @click="sendEmail"
        >
          {{ busy ? "Sending…" : "Send invitation email" }}
        </button>
      </div></template
    >
  </dialog>
</template>

<style scoped src="./admin-shared.css"></style>
<style scoped>
.email-dialog {
  color: var(--ink);
  max-width: calc(100% - 32px);
}
.email-dialog::backdrop {
  background: #15372c73;
}
</style>
