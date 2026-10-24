<script setup lang="ts">
import { ref, onMounted } from "vue";
import { Download, RotateCcw, Trash2 } from "@lucide/vue";
import { api, json, errorMessage, currentUser, formatDate } from "../api";
const policy = ref<any>(),
  storage = ref<any>(),
  trash = ref<any[]>([]),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  loading = ref(true);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    [policy.value, storage.value, trash.value] = await Promise.all([
      api("/privacy"),
      api("/account/storage"),
      api("/documents/trash/list"),
    ]);
  } finally {
    loading.value = false;
  }
}
async function retry() {
  try {
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
onMounted(() => load().catch((e) => (error.value = errorMessage(e))));
async function restore(id: string) {
  busy.value = true;
  error.value = "";
  try {
    await api(`/documents/${id}/restore`, { method: "POST", body: "{}" });
    await load();
    notice.value =
      "Deletion request withdrawn. The document remains available.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function requestDeletion() {
  const confirmEmail = window.prompt(
    "Enter your account email to request deletion. An administrator will review the request; your signing records will not be removed automatically.",
  );
  if (!confirmEmail) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/account/deletion-request", {
      method: "POST",
      body: json({ confirmEmail }),
    });
    await load();
    notice.value = "Your account deletion request is awaiting review.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function withdraw() {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api("/account/deletion-request/withdraw", {
      method: "POST",
      body: "{}",
    });
    await load();
    notice.value = "Account deletion request withdrawn.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="page privacy-page">
    <header class="page-heading">
      <div>
        <h1>Your data and records</h1>
        <p>Understand what PaperSign keeps and manage your requests.</p>
      </div>
    </header>
    <div v-if="error" class="privacy-error">
      <p class="notice error" role="alert">{{ error }}</p>
      <button
        class="button secondary"
        :disabled="busy || loading"
        @click="retry"
      >
        Try again
      </button>
    </div>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <template v-if="policy">
      <section class="privacy-section">
        <h2>What is recorded</h2>
        <p>{{ policy.evidence }}</p>
        <p>{{ policy.adminAccess }}</p>
        <p v-if="policy.operator">Service operator: {{ policy.operator }}.</p>
      </section>
      <section class="privacy-section">
        <h2>Keeping and deleting records</h2>
        <p>{{ policy.retention }}</p>
        <p>
          Document deletions have a recovery window of at least
          {{ policy.recoveryDays }} days. Until permanent deletion is approved
          and carried out, the stored records still count towards your storage
          usage.
        </p>
        <p>{{ policy.backups }}</p>
      </section>
      <section class="privacy-section">
        <h2>Your storage and exports</h2>
        <p v-if="storage">
          {{ (storage.usedBytes / 1024 / 1024).toFixed(1) }} MB of
          {{ (storage.limitBytes / 1024 / 1024).toFixed(0) }} MB used, including
          originals, signatures, reviewed versions and generated PDFs.
        </p>
        <a class="button secondary" href="/api/account/data-index" download
          ><Download :size="18" />Download account index</a
        >
        <p class="hint">
          The index lists your documents and signature library. Each completed
          document also has its own PDF and portable signing record.
        </p>
      </section>
      <section class="privacy-section">
        <h2>Document deletion requests</h2>
        <p v-if="!trash.length" class="muted">
          No pending requests. Request deletion from the document editor.
        </p>
        <ul v-else class="privacy-requests">
          <li v-for="doc in trash" :key="doc.id">
            <div>
              <strong>{{ doc.name }}</strong>
              <p>
                {{ doc.deletedAt ? "In recovery window" : "Awaiting approval" }}
                · {{ formatDate(doc.requestedAt) }}
              </p>
            </div>
            <button
              class="button secondary small"
              :disabled="busy"
              @click="restore(doc.id)"
            >
              <RotateCcw :size="16" />Withdraw request
            </button>
          </li>
        </ul>
      </section>
      <section class="privacy-section">
        <h2>Account deletion</h2>
        <p>
          Request a review of {{ currentUser?.email }} and its stored data.
          Other participants' signing records and recovery backups must be
          considered before an administrator approves permanent deletion.
        </p>
        <template v-if="storage?.deletionRequestedAt"
          ><p class="notice">
            Requested {{ formatDate(storage.deletionRequestedAt) }}. Awaiting
            administrator review.
          </p>
          <button class="button secondary" :disabled="busy" @click="withdraw">
            Withdraw account request
          </button></template
        ><button
          v-else
          class="button secondary"
          :disabled="busy"
          @click="requestDeletion"
        >
          <Trash2 :size="18" />Request account deletion
        </button>
      </section>
    </template>
    <p v-else-if="loading" role="status">Loading your data policy…</p>
  </div>
</template>
<style scoped>
.privacy-page {
  max-width: 1040px;
}
.privacy-section {
  padding: 28px 0;
  border-top: 1px solid var(--line, #dce3dc);
}
.privacy-section h2 {
  margin-bottom: 12px;
}
.privacy-section p {
  max-width: 72ch;
  overflow-wrap: anywhere;
}
.privacy-section > p {
  line-height: 1.65;
}
.privacy-section > p + p {
  margin-top: 12px;
}
.privacy-section > .button {
  margin-top: 16px;
}
.privacy-section > .hint {
  margin-top: 12px;
}
.privacy-section > .notice {
  margin: 16px 0 0;
}
.privacy-error {
  margin-bottom: 24px;
}
.privacy-requests {
  padding: 0;
  list-style: none;
}
.privacy-requests li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 0;
}
.privacy-requests li > div {
  min-width: 0;
}
.privacy-requests strong {
  overflow-wrap: anywhere;
}
.privacy-requests p {
  margin: 4px 0;
  color: var(--muted, #586a60);
}
@media (max-width: 600px) {
  .privacy-requests li {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
