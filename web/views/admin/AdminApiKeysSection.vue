<script setup lang="ts">
import { ref } from "vue";
import CopyField from "../../components/CopyField.vue";
import { api, formatDate } from "../../api";
import type { AdminApiKey, CreatedApiKey } from "../../../shared/admin-types";
import AdminList from "./AdminList.vue";
import { useAdminContext } from "./context";

const { busy, error, notice, location, navigate, failure } = useAdminContext();
const list = ref<{ reload(): Promise<void> }>();
const name = ref(""),
  lifetime = ref<30 | 90 | 365>(90);
// The secret lives only in this section: leaving the tab discards it.
const created = ref<CreatedApiKey | null>(null);

function keyStatusName(key: AdminApiKey) {
  return key.state.charAt(0).toUpperCase() + key.state.slice(1);
}
function keyDates(key: AdminApiKey) {
  if (key.state === "revoked") return `Revoked ${formatDate(key.revokedAt!)}`;
  if (key.state === "expired") return `Expired ${formatDate(key.expiresAt)}`;
  return `Expires ${formatDate(key.expiresAt)}`;
}
async function createKey() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  created.value = null;
  try {
    const result = await api<CreatedApiKey>("/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: name.value.trim(),
        lifetimeDays: lifetime.value,
      }),
    });
    name.value = "";
    lifetime.value = 90;
    await navigate({ ...location.value, page: 1, query: "" });
    created.value = result;
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
async function revokeKey(key: AdminApiKey) {
  if (
    busy.value ||
    !window.confirm(
      `Revoke the API key “${key.name}” (${key.prefix}…)? Programs using it stop working immediately.`,
    )
  )
    return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/admin/api-keys/${key.id}/revoke`, {
      method: "POST",
      body: "{}",
    });
    if (created.value?.key.id === key.id) created.value = null;
    await list.value?.reload();
    notice.value = "API key revoked.";
  } catch (e) {
    await failure(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="admin-invite-form" aria-labelledby="api-key-title">
    <h2 id="api-key-title">Create an API key</h2>
    <p class="muted">
      A key acts as you. It can upload PDFs, add text and signers, create
      signing links, send invitation emails and download completed records. It
      cannot sign, open Admin or change accounts.
    </p>
    <form class="key-fields" @submit.prevent="createKey">
      <label class="field"
        >Name<input
          v-model="name"
          required
          maxlength="80"
          autocomplete="off"
          placeholder="What will use this key?"
      /></label>
      <label class="field"
        >Expires after<select v-model.number="lifetime">
          <option :value="30">30 days</option>
          <option :value="90">90 days</option>
          <option :value="365">1 year</option>
        </select></label
      >
      <button class="button primary" :disabled="busy">
        {{ busy ? "Please wait…" : "Create key" }}
      </button>
    </form>
    <div
      v-if="created"
      class="api-key-secret"
      role="region"
      aria-labelledby="api-key-secret-title"
    >
      <h3 id="api-key-secret-title">Copy your new key now</h3>
      <p>
        PaperSign shows “{{ created.key.name }}” only once. Store it where the
        program can read it. It expires on
        {{ formatDate(created.key.expiresAt) }}.
      </p>
      <CopyField
        :value="created.secret"
        label="API key"
        copy-label="Copy key"
        copied-message="API key copied."
        failure-message="Could not copy the key. Select and copy it from the box."
        monospace
      />
      <div class="button-row wrap">
        <button class="text-button" @click="created = null">
          I have stored it
        </button>
      </div>
    </div>
  </section>
  <AdminList
    ref="list"
    v-slot="{ items: keys }"
    title="API keys"
    label="API keys"
    endpoint="api-keys"
  >
    <article
      v-for="key in keys"
      :key="key.id"
      class="admin-record"
      :aria-label="key.name"
    >
      <div class="admin-record-main">
        <h3>{{ key.name }}</h3>
        <p>
          <code class="api-key-prefix">{{ key.prefix }}…</code>
        </p>
        <p class="hint">{{ key.owner.name }} · {{ key.owner.email }}</p>
      </div>
      <div class="admin-record-metadata">
        <span
          class="status"
          :class="key.state === 'active' ? 'ready' : key.state"
          >{{ keyStatusName(key) }}</span
        >
        <p>{{ keyDates(key) }}</p>
        <p>
          {{
            key.lastUsedAt
              ? `Last used ${formatDate(key.lastUsedAt)}`
              : "Never used"
          }}
        </p>
      </div>
      <button
        v-if="key.state !== 'revoked'"
        class="text-button danger-text admin-key-action"
        :aria-label="`Revoke API key ${key.name}`"
        :disabled="busy"
        @click="revokeKey(key)"
      >
        Revoke
      </button>
      <span v-else class="admin-key-action" aria-hidden="true"></span>
    </article>
  </AdminList>
</template>

<style scoped src="./admin-shared.css"></style>
