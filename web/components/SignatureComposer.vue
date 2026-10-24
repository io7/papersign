<script setup lang="ts">
import { ref } from "vue";
import { X } from "@lucide/vue";
import SignatureInput from "./SignatureInput.vue";
import { api, json, errorMessage } from "../api";
import type { Signature } from "../../shared/types";
defineProps<{ initialMode?: "drawn" | "uploaded" }>();
const emit = defineEmits<{ saved: [signature: Signature]; cancel: [] }>();
const name = ref("My signature"),
  signature = ref<{ png: string; source: "drawn" | "uploaded" } | null>(null),
  busy = ref(false),
  error = ref("");
async function save() {
  if (!signature.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    emit(
      "saved",
      await api<Signature>("/signatures", {
        method: "POST",
        body: json({ name: name.value, ...signature.value }),
      }),
    );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="composer panel" aria-labelledby="composer-title">
    <div class="section-heading">
      <h2 id="composer-title">New signature</h2>
      <button
        class="icon-button"
        aria-label="Close new signature"
        @click="emit('cancel')"
      >
        <X :size="20" />
      </button>
    </div>
    <p class="muted">Save it to your account and use it on any document.</p>
    <form @submit.prevent="save">
      <label class="field"
        >Signature name<input
          v-model="name"
          required
          maxlength="80"
          autocomplete="off" /></label
      ><SignatureInput
        :initial-mode="initialMode"
        @change="signature = $event"
      />
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div class="form-actions">
        <button
          type="button"
          class="button secondary"
          :disabled="busy"
          @click="emit('cancel')"
        >
          Cancel</button
        ><button
          class="button primary"
          :disabled="!signature || !name.trim() || busy"
        >
          {{ busy ? "Saving…" : "Save signature" }}
        </button>
      </div>
    </form>
  </section>
</template>
