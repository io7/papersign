<script setup lang="ts">
import { ArrowUpRight } from "@lucide/vue";
import { formatDate } from "../../api";
import type { AdminDocument } from "../../../shared/admin-types";
import AdminList from "./AdminList.vue";
import { useAdminContext } from "./context";
import { size, statusName } from "./format";

const { busy, location, owner, navigate } = useAdminContext();

function loaded(documents: AdminDocument[]) {
  const ownerId = location.value.ownerId;
  if (!ownerId) return;
  const match = documents.find((doc) => doc.owner.id === ownerId);
  if (match) owner.value = match.owner;
}
async function showAllUsers() {
  if (busy.value) return;
  owner.value = undefined;
  await navigate({ tab: "Documents", ownerId: "", page: 1, query: "" });
}
</script>

<template>
  <AdminList
    title="Documents"
    label="documents"
    endpoint="documents"
    @loaded="loaded"
  >
    <template #filters>
      <div v-if="location.ownerId" class="admin-owner-filter">
        <span>
          <template v-if="owner"
            >Documents uploaded by <strong>{{ owner.name }}</strong> ({{
              owner.email
            }})</template
          >
          <template v-else>Documents uploaded by the selected user.</template>
        </span>
        <button class="text-button" :disabled="busy" @click="showAllUsers">
          Show all users
        </button>
      </div>
    </template>
    <template #default="{ items: documents }">
      <article
        v-for="doc in documents"
        :key="doc.id"
        class="admin-record"
        :aria-label="doc.name"
      >
        <div class="admin-record-main">
          <h3>{{ doc.name }}</h3>
          <p>{{ doc.owner.name }}</p>
          <p>{{ doc.owner.email }}</p>
        </div>
        <div class="admin-record-metadata">
          <span class="status" :class="doc.status">{{
            statusName(doc.status)
          }}</span>
          <p>
            {{ doc.pageCount }} {{ doc.pageCount === 1 ? "page" : "pages" }} ·
            {{ size(doc.byteSize) }}
          </p>
          <p>Uploaded {{ formatDate(doc.createdAt) }}</p>
        </div>
        <a
          class="button secondary admin-document-action"
          :href="`/api/admin/documents/${doc.id}/pdf`"
          target="_blank"
          rel="noopener"
          >Open uploaded PDF<ArrowUpRight :size="16"
        /></a>
      </article>
    </template>
  </AdminList>
</template>

<style scoped src="./admin-shared.css"></style>
<style scoped>
.admin-owner-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  margin: 0 0 20px;
  padding: 12px 16px;
  background: var(--soft);
  font-size: 13px;
}
.admin-owner-filter > span {
  min-width: 0;
  flex: 1 1 240px;
  overflow-wrap: anywhere;
}
.admin-owner-filter > button {
  flex-shrink: 0;
}
@media (max-width: 680px) {
  .admin-owner-filter {
    padding: 12px;
  }
}
</style>
