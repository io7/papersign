<script setup lang="ts">
import { ref, onMounted } from "vue";
import { PenLine, Upload, Star, Pencil, Trash2 } from "@lucide/vue";
import SignatureComposer from "../components/SignatureComposer.vue";
import { api, json, errorMessage, formatDate } from "../api";
import type { Signature } from "../../shared/types";
const signatures = ref<Signature[]>([]),
  loading = ref(true),
  error = ref(""),
  notice = ref(""),
  creating = ref(false),
  mode = ref<"drawn" | "uploaded">("drawn"),
  busy = ref("");
const editing = ref(""),
  rename = ref(""),
  removing = ref("");
async function load() {
  signatures.value = await api("/signatures");
}
onMounted(async () => {
  try {
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
function create(value: "drawn" | "uploaded") {
  mode.value = value;
  creating.value = true;
}
async function saved() {
  await load();
  creating.value = false;
  notice.value = "Signature saved. It is ready for your next document.";
}
async function update(signature: Signature, patch: object) {
  busy.value = signature.id;
  error.value = "";
  try {
    await api(`/signatures/${signature.id}`, {
      method: "PATCH",
      body: json(patch),
    });
    await load();
    editing.value = "";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = "";
  }
}
async function remove(signature: Signature) {
  busy.value = signature.id;
  error.value = "";
  try {
    await api(`/signatures/${signature.id}`, { method: "DELETE" });
    await load();
    removing.value = "";
    notice.value =
      "Signature removed from your library. Existing signed PDFs are unchanged.";
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = "";
  }
}
</script>
<template>
  <div class="page">
    <header class="page-heading">
      <div>
        <h1>Your signatures</h1>
        <p>Draw it once. Keep it ready for every document.</p>
      </div>
      <div class="button-row">
        <button class="button secondary" @click="create('uploaded')">
          <Upload :size="18" />Upload PNG</button
        ><button class="button primary" @click="create('drawn')">
          <PenLine :size="18" />Draw signature
        </button>
      </div>
    </header>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice success" role="status">{{ notice }}</p>
    <SignatureComposer
      v-if="creating"
      :key="mode"
      :initial-mode="mode"
      @saved="saved"
      @cancel="creating = false"
    />
    <p v-if="loading" class="loading" role="status">Loading your signatures…</p>
    <section v-else-if="!signatures.length && !creating" class="empty-state">
      <div class="empty-icon"><PenLine :size="34" /></div>
      <h2>Make your mark.</h2>
      <p>
        Draw your signature or upload a transparent PNG.<br />It will be here
        whenever you need to sign.
      </p>
      <button class="button primary" @click="create('drawn')">
        Create your first signature
      </button>
    </section>
    <section v-else class="signature-grid" aria-label="Saved signatures">
      <article
        v-for="signature in signatures"
        :key="signature.id"
        class="signature-card"
      >
        <div class="signature-preview">
          <img
            :src="`/api/signatures/${signature.id}/image`"
            :alt="signature.name"
          /><span v-if="signature.isDefault" class="default-label"
            ><Star :size="12" fill="currentColor" />Default</span
          >
        </div>
        <div class="signature-details">
          <form
            v-if="editing === signature.id"
            class="rename-form"
            @submit.prevent="update(signature, { name: rename })"
          >
            <label class="sr-only" :for="`rename-${signature.id}`"
              >Signature name</label
            ><input
              :id="`rename-${signature.id}`"
              v-model="rename"
              required
              maxlength="80"
              autofocus
            /><button
              class="button small primary"
              :disabled="busy === signature.id || !rename.trim()"
            >
              Save</button
            ><button type="button" class="text-button" @click="editing = ''">
              Cancel
            </button>
          </form>
          <template v-else
            ><h2>{{ signature.name }}</h2>
            <p>
              {{ signature.source === "drawn" ? "Drawn" : "Uploaded" }} ·
              {{ formatDate(signature.createdAt) }}
            </p></template
          >
          <div v-if="removing === signature.id" class="remove-confirm">
            <p>
              Remove this saved signature? Existing signed PDFs will stay
              intact.
            </p>
            <div class="button-row">
              <button
                class="button small danger"
                :disabled="busy === signature.id"
                @click="remove(signature)"
              >
                Remove signature</button
              ><button class="text-button" @click="removing = ''">
                Keep it
              </button>
            </div>
          </div>
          <div v-else class="signature-actions">
            <button
              class="text-button"
              :disabled="signature.isDefault || busy === signature.id"
              @click="update(signature, { isDefault: true })"
            >
              <Star :size="15" />{{
                signature.isDefault ? "Default signature" : "Make default"
              }}
            </button>
            <div class="button-row">
              <button
                class="icon-button"
                :aria-label="`Rename ${signature.name}`"
                title="Rename"
                @click="
                  editing = signature.id;
                  rename = signature.name;
                "
              >
                <Pencil :size="16" /></button
              ><button
                class="icon-button"
                :aria-label="`Remove ${signature.name}`"
                title="Remove"
                @click="removing = signature.id"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </div>
      </article>
    </section>
    <p v-if="signatures.length" class="library-note">
      Only you can access these saved signatures. Your default is selected when
      you open a new document.
    </p>
  </div>
</template>
