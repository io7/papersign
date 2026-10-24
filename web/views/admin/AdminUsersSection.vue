<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api, currentUser, formatDate, refreshUser } from "../../api";
import type { AdminUser, UserRole } from "../../../shared/admin-types";
import AdminList from "./AdminList.vue";
import { useAdminContext } from "./context";
import { roleName } from "./format";

const { busy, error, notice, owner, navigate, failure, refresh } =
  useAdminContext();
const router = useRouter();
const roleEdits = ref<Record<string, UserRole>>({});

function loaded(users: AdminUser[]) {
  roleEdits.value = Object.fromEntries(users.map((u) => [u.id, u.role]));
}
async function userDocuments(user: AdminUser) {
  if (busy.value) return;
  owner.value = user;
  await navigate({ tab: "Documents", ownerId: user.id, page: 1, query: "" });
}
async function changeRole(user: AdminUser) {
  const role = roleEdits.value[user.id];
  if (!role || role === user.role || busy.value) return;
  if (
    !window.confirm(
      `Change ${user.name} (${user.email}) from ${roleName(user.role)} to ${roleName(role)}?${user.id === currentUser.value?.id ? " This changes your own access." : ""}`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api(`/admin/users/${user.id}/role`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRole: user.role, role }),
    });
    await refreshUser();
    if (currentUser.value?.role !== "admin") {
      await router.replace("/documents");
      return;
    }
    await refresh();
    notice.value = `${user.name} is now ${roleName(role) === "Admin" ? "an Admin" : "a User"}.`;
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AdminList
    v-slot="{ items: users }"
    title="Users"
    label="users"
    endpoint="users"
    @loaded="loaded"
  >
    <article
      v-for="user in users"
      :key="user.id"
      class="admin-record"
      :aria-label="user.email"
    >
      <div class="admin-record-main">
        <h3>
          {{ user.name }}
          <span v-if="user.id === currentUser?.id" class="hint">(you)</span>
        </h3>
        <p>{{ user.email }}</p>
        <p class="hint">Joined {{ formatDate(user.createdAt) }}</p>
      </div>
      <div class="admin-record-metadata">
        <button
          class="text-button"
          :disabled="busy"
          @click="userDocuments(user)"
        >
          {{ user.documentCount }}
          {{ user.documentCount === 1 ? "document" : "documents" }}
        </button>
        <p>{{ user.signatureCount }} saved signatures</p>
      </div>
      <div class="admin-role-controls">
        <label class="field"
          >Role<select
            v-model="roleEdits[user.id]"
            :aria-label="`Role for ${user.email}`"
            :disabled="busy"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select></label
        ><button
          class="button secondary"
          :aria-label="`Apply role for ${user.email}`"
          :disabled="busy || roleEdits[user.id] === user.role"
          @click="changeRole(user)"
        >
          Apply role
        </button>
      </div>
    </article>
  </AdminList>
</template>

<style scoped src="./admin-shared.css"></style>
