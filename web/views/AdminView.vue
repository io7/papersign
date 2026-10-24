<script setup lang="ts">
// The Admin page shell: heading, statistics, section navigation and messages.
// Each section lives in ./admin and shares state through the Admin context.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, currentUser, errorMessage, refreshUser } from "../api";
import type { AdminDocument } from "../../shared/admin-types";
import AdminStatistics from "./admin/AdminStatistics.vue";
import AdminUsersSection from "./admin/AdminUsersSection.vue";
import AdminInvitationsSection from "./admin/AdminInvitationsSection.vue";
import AdminDocumentsSection from "./admin/AdminDocumentsSection.vue";
import AdminApiKeysSection from "./admin/AdminApiKeysSection.vue";
import {
  locationQuery,
  provideAdminContext,
  readLocation,
  tabs,
  type AdminLocation,
  type Tab,
} from "./admin/context";

const router = useRouter();
const route = useRoute();
const location = computed(() => readLocation(route.query));
const tab = computed(() => location.value.tab);
const busy = ref(false),
  error = ref(""),
  notice = ref("");
const owner = ref<AdminDocument["owner"]>();
const focusRequest = ref<string | null>(null);
const statistics = ref<InstanceType<typeof AdminStatistics>>();
let listLoader: (() => Promise<void>) | null = null;
let disposed = false;

async function checkAccess(e: unknown, isCurrent = () => !disposed) {
  if (e instanceof ApiError && [401, 403].includes(e.status)) {
    await refreshUser().catch(() => {
      currentUser.value = null;
    });
    if (isCurrent())
      await router.replace(currentUser.value ? "/documents" : "/login");
  }
}
async function failure(e: unknown) {
  error.value = errorMessage(e);
  await checkAccess(e);
}
async function reloadStatistics() {
  await statistics.value?.reload();
}
async function reloadList() {
  await listLoader?.();
}
async function refresh() {
  error.value = "";
  await Promise.all([reloadStatistics(), reloadList()]);
}
async function navigate(value: AdminLocation) {
  notice.value = "";
  error.value = "";
  const next = locationQuery(value);
  if (JSON.stringify(next) === JSON.stringify(locationQuery(location.value))) {
    await reloadList();
    return;
  }
  await router.push({ path: "/admin", query: next });
}
async function selectTab(value: Tab) {
  if (busy.value) return;
  await navigate({ tab: value, query: "", page: 1, ownerId: "" });
}
async function openInvitationForm() {
  if (busy.value) return;
  focusRequest.value = "invite-name";
  await selectTab("Invitations");
}

provideAdminContext({
  location,
  busy,
  error,
  notice,
  owner,
  focusRequest,
  registerList(load) {
    listLoader = load;
    return () => {
      if (listLoader === load) listLoader = null;
    };
  },
  reloadList,
  navigate,
  failure,
  checkAccess,
  reloadStatistics,
  refresh,
});

watch(
  () => route.fullPath,
  () => {
    if (route.path !== "/admin") return;
    if (owner.value?.id !== location.value.ownerId) owner.value = undefined;
    notice.value = "";
    error.value = "";
    // Keep one URL per view so reloads and history restore the same list.
    const canonical = locationQuery(location.value);
    const canonicalKeys = Object.keys(canonical);
    if (
      Object.keys(route.query).length !== canonicalKeys.length ||
      canonicalKeys.some((key) => route.query[key] !== canonical[key])
    )
      void router.replace({
        path: "/admin",
        query: canonical,
        hash: route.hash,
      });
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div class="page admin-page">
    <header class="page-heading">
      <div>
        <h1>Admin</h1>
        <p>Manage accounts, invitations, uploaded documents, and API keys.</p>
      </div>
      <button
        v-if="tab !== 'Invitations'"
        class="button primary admin-invite-action"
        :disabled="busy"
        @click="openInvitationForm"
      >
        Invite user
      </button>
    </header>
    <p>
      <RouterLink to="/admin/operations"
        >Operations and data requests</RouterLink
      >
    </p>
    <AdminStatistics ref="statistics" />
    <div class="admin-workspace">
      <div class="admin-sections" role="group" aria-label="Admin sections">
        <button
          v-for="item in tabs"
          :key="item"
          class="admin-section"
          :class="{ 'is-active': tab === item }"
          :aria-pressed="tab === item"
          :disabled="busy"
          @click="selectTab(item)"
        >
          {{ item }}
        </button>
      </div>
      <div class="admin-workspace-body">
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
        <AdminUsersSection v-if="tab === 'Users'" />
        <AdminInvitationsSection v-else-if="tab === 'Invitations'" />
        <AdminDocumentsSection v-else-if="tab === 'Documents'" />
        <AdminApiKeysSection v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-page .page-heading {
  align-items: flex-start;
  margin-bottom: 28px;
}
.admin-invite-action {
  flex-shrink: 0;
}
.admin-workspace {
  background: white;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.admin-sections {
  display: flex;
  gap: 24px;
  padding: 0 24px;
  border-bottom: 1px solid var(--line);
}
.admin-section {
  position: relative;
  min-height: 56px;
  padding: 15px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 570;
}
.admin-section::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: transparent;
  content: "";
}
.admin-section:hover:not(:disabled),
.admin-section.is-active {
  color: var(--green);
}
.admin-section.is-active::after {
  background: var(--green);
}
.admin-workspace-body {
  padding: 24px;
}
@media (max-width: 680px) {
  .admin-page .page-heading {
    flex-wrap: wrap;
    gap: 14px;
    margin-bottom: 20px;
  }
  .admin-page .page-heading p {
    margin-top: 6px;
  }
  .admin-sections {
    gap: 22px;
    padding-inline: 16px;
    overflow-x: auto;
  }
  .admin-section {
    min-height: 50px;
    padding-block: 12px;
    font-size: 13px;
    flex: none;
    white-space: nowrap;
  }
  .admin-workspace-body {
    padding: 18px 16px;
  }
}
@media (max-width: 380px) {
  .admin-sections {
    gap: 18px;
  }
}
</style>
