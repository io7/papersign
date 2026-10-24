<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import { api, errorMessage } from "../../api";
import type { AdminSummary } from "../../../shared/admin-types";
import { useAdminContext } from "./context";
import { size } from "./format";

const { checkAccess } = useAdminContext();
const summary = ref<AdminSummary>();
const state = ref<"loading" | "loaded" | "error">("loading");
const failure = ref("");
const expanded = ref(false);
let requestId = 0;
let disposed = false;

async function reload() {
  const id = ++requestId;
  state.value = "loading";
  failure.value = "";
  summary.value = undefined;
  try {
    const result = await api<AdminSummary>("/admin/summary");
    if (id !== requestId || disposed) return;
    summary.value = result;
    state.value = "loaded";
  } catch (e) {
    if (id !== requestId || disposed) return;
    failure.value = errorMessage(e);
    state.value = "error";
    await checkAccess(e, () => id === requestId && !disposed);
  }
}
defineExpose({ reload });
onMounted(reload);
onBeforeUnmount(() => {
  disposed = true;
  ++requestId;
});
</script>

<template>
  <div class="admin-overview">
    <button
      class="text-button admin-summary-toggle"
      :aria-expanded="expanded"
      aria-controls="admin-statistics"
      @click="expanded = !expanded"
    >
      {{ expanded ? "Hide usage statistics" : "Show usage statistics" }}
      <ChevronDown :size="16" :class="{ expanded }" />
    </button>
    <div
      id="admin-statistics"
      class="admin-summary-content"
      :class="{ 'is-collapsed': !expanded }"
    >
      <p v-if="state === 'loading'" class="hint" role="status">
        Loading usage statistics…
      </p>
      <div v-else-if="state === 'error'" class="admin-load-error">
        <p role="alert">Usage statistics could not be loaded. {{ failure }}</p>
        <button class="text-button" @click="reload">Retry statistics</button>
      </div>
      <dl
        v-else-if="summary"
        class="admin-summary"
        aria-label="Usage statistics"
      >
        <div>
          <dt>Users</dt>
          <dd>
            {{ summary.users }}
            <span
              >{{ summary.admins }}
              {{ summary.admins === 1 ? "Admin" : "Admins" }}</span
            >
          </dd>
        </div>
        <div>
          <dt>Uploaded PDFs</dt>
          <dd>
            {{ summary.documents }}
            <span>{{ size(summary.uploadedBytes) }} of originals</span>
          </dd>
        </div>
        <div>
          <dt>Awaiting signatures</dt>
          <dd>{{ summary.documentsAwaiting }}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{{ summary.documentsCompleted }}</dd>
        </div>
        <div>
          <dt>Saved signatures</dt>
          <dd>{{ summary.storedSignatures }}</dd>
        </div>
        <div>
          <dt>Pending invites</dt>
          <dd>{{ summary.pendingAccountInvitations }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.admin-overview {
  margin-bottom: 28px;
}
.admin-summary-toggle {
  display: none;
}
.admin-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  padding: 0;
  margin: 0;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 12px;
  font-variant-numeric: tabular-nums;
}
.admin-summary > div {
  min-width: 0;
  padding: 16px 18px;
  border-right: 1px solid var(--line);
}
.admin-summary > div:last-child {
  border-right: 0;
}
.admin-summary dt {
  min-height: 39px;
  font-size: 13px;
  color: var(--muted);
}
.admin-summary dd {
  margin: 4px 0 0;
  font-size: 24px;
  line-height: 1.3;
  font-weight: 620;
}
.admin-summary dd span {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  color: var(--muted);
}
.admin-load-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 20px 0;
}
.admin-load-error p {
  color: var(--red);
  overflow-wrap: anywhere;
  flex: 1 1 240px;
}
@media (max-width: 1200px) {
  .admin-summary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .admin-summary > div:nth-child(3n) {
    border-right: 0;
  }
  .admin-summary > div:nth-child(-n + 3) {
    border-bottom: 1px solid var(--line);
  }
  .admin-summary dt {
    min-height: 0;
  }
}
@media (max-width: 680px) {
  .admin-overview {
    margin-bottom: 16px;
  }
  .admin-summary-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 36px;
  }
  .admin-summary-toggle .expanded {
    transform: rotate(180deg);
  }
  .admin-summary-content {
    padding-top: 12px;
  }
  .admin-summary-content.is-collapsed {
    display: none;
  }
  .admin-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .admin-summary > div {
    padding: 14px;
    border: 0;
  }
  .admin-summary > div:nth-child(odd) {
    border-right: 1px solid var(--line);
  }
  .admin-summary > div:nth-child(-n + 4) {
    border-bottom: 1px solid var(--line);
  }
  .admin-summary dd {
    font-size: 22px;
  }
}
</style>
