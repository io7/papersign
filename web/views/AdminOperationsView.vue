<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ArrowLeft, RefreshCw } from "@lucide/vue";
import { api, json, errorMessage, formatDate } from "../api";
const checks = ref<Array<{ name: string; ok: boolean; detail: string }>>([]),
  requests = ref<any>(),
  error = ref(""),
  busy = ref(false),
  loading = ref(true);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [operations, deletions] = await Promise.all([
      api("/admin/operations"),
      api("/admin/deletion-requests"),
    ]);
    checks.value = operations.checks;
    requests.value = deletions;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
async function decide(document: any, approve: boolean) {
  const reason = window.prompt(
    approve
      ? `Approve deletion of “${document.name}”? It will enter a ${requests.value.recoveryDays}-day recovery window. Enter the reason:`
      : `Decline deletion of “${document.name}”. Enter the reason:`,
  );
  if (!reason?.trim()) return;
  busy.value = true;
  try {
    await api(`/admin/deletion-requests/${document.id}/decision`, {
      method: "POST",
      body: json({ approve, requestedAt: document.requestedAt, reason }),
    });
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="page admin-operations">
    <RouterLink class="back-link" to="/admin"
      ><ArrowLeft :size="16" />Admin</RouterLink
    >
    <header class="page-heading">
      <div>
        <h1>Operations and data requests</h1>
        <p>Service health, recovery safeguards and deletion decisions.</p>
      </div>
      <button
        class="button secondary"
        :disabled="busy || loading"
        @click="load"
      >
        <RefreshCw :size="17" />Refresh
      </button>
    </header>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">Checking PaperSign…</p>
    <template v-else
      ><section>
        <h2>Service health</h2>
        <ul class="operations-checks">
          <li v-for="check in checks" :key="check.name">
            <strong>{{ check.name }}</strong
            ><span>{{ check.detail }}</span
            ><span class="status" :class="check.ok ? 'completed' : 'revoked'">{{
              check.ok ? "Healthy" : "Needs attention"
            }}</span>
          </li>
        </ul>
        <p class="hint">
          The operator monitor also checks public HTTPS and backup age. An
          external monitor is needed to detect a host or network outage.
        </p>
      </section>
      <section v-if="requests">
        <h2>Document deletion requests</h2>
        <p v-if="!requests.documents.length" class="muted">
          No pending document requests.
        </p>
        <ul class="operations-requests">
          <li v-for="doc in requests.documents" :key="doc.id">
            <div>
              <strong>{{ doc.name }}</strong>
              <p>
                {{ doc.ownerEmail }} · requested
                {{ formatDate(doc.requestedAt) }}
              </p>
              <p v-if="doc.deletedAt">
                Recovery window started {{ formatDate(doc.deletedAt) }}.
                Permanent deletion requires a separate operator action.
              </p>
            </div>
            <div v-if="!doc.deletedAt" class="button-row wrap">
              <button
                class="button secondary small"
                :disabled="busy"
                @click="decide(doc, false)"
              >
                Decline</button
              ><button
                class="button secondary small"
                :disabled="busy"
                @click="decide(doc, true)"
              >
                Approve recovery window
              </button>
            </div>
          </li>
        </ul>
      </section>
      <section v-if="requests">
        <h2>Account deletion requests</h2>
        <p v-if="!requests.accounts.length" class="muted">
          No pending account requests.
        </p>
        <ul class="operations-requests">
          <li v-for="account in requests.accounts" :key="account.id">
            <div>
              <strong>{{ account.name }}</strong>
              <p>
                {{ account.email }} · requested
                {{ formatDate(account.requestedAt) }}
              </p>
              <p>
                Review retained signing records, other participants' access and
                backup expiry before arranging permanent deletion.
              </p>
            </div>
          </li>
        </ul>
      </section></template
    >
  </div>
</template>
<style scoped>
.admin-operations {
  max-width: 1160px;
}
.admin-operations section {
  padding: 24px 0;
  border-top: 1px solid var(--line, #dce3dc);
}
.operations-checks,
.operations-requests {
  padding: 0;
  list-style: none;
}
.operations-checks li {
  display: grid;
  grid-template-columns: 120px 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
}
.operations-checks strong {
  text-transform: capitalize;
}
.operations-requests li {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 0;
}
.operations-requests p {
  max-width: 65ch;
  margin: 4px 0;
  color: var(--muted, #586a60);
}
.operations-requests strong,
.operations-requests p {
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .operations-checks li {
    grid-template-columns: 1fr auto;
  }
  .operations-checks li > span:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .operations-requests li {
    flex-direction: column;
  }
}
</style>
