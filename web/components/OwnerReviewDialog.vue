<script setup lang="ts">
import { ref, nextTick } from "vue";
import { X, PenLine } from "@lucide/vue";
import PdfStage from "./PdfStage.vue";
import { api, json, errorMessage } from "../api";
import type { PageInfo } from "../../shared/types";
const props = defineProps<{
  documentId: string;
  name: string;
  pages: PageInfo[];
}>();
type Review = {
  reviewId: string;
  revision: number;
  pdfUrl: string;
  sha256: string;
  consent: { version: string; text: string };
};
const dialog = ref<HTMLDialogElement>(),
  review = ref<Review>(),
  error = ref(""),
  busy = ref(false),
  ready = ref(false),
  consent = ref(false),
  page = ref(0);
let resolveReview: ((result: Review | undefined) => void) | undefined;
async function open(revision: number): Promise<Review | undefined> {
  review.value = undefined;
  error.value = "";
  ready.value = false;
  consent.value = false;
  page.value = 0;
  busy.value = true;
  await nextTick();
  dialog.value?.showModal();
  const result = new Promise<Review | undefined>((resolve) => {
    resolveReview = resolve;
  });
  try {
    review.value = await api(`/documents/${props.documentId}/review`, {
      method: "POST",
      body: json({ revision }),
    });
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
  return result;
}
function close() {
  dialog.value?.close();
  resolveReview?.(undefined);
  resolveReview = undefined;
  review.value = undefined;
  ready.value = false;
  consent.value = false;
}
function accept() {
  if (!ready.value || !consent.value || !review.value) return;
  resolveReview?.(review.value);
  resolveReview = undefined;
  dialog.value?.close();
}
function reviewState(state: { url: string; ready: boolean }) {
  if (state.url === review.value?.pdfUrl) {
    ready.value = state.ready;
    if (!state.ready) consent.value = false;
  }
}
defineExpose({ open });
</script>
<template>
  <dialog
    ref="dialog"
    class="owner-review-dialog panel"
    aria-labelledby="owner-review-title"
    @cancel.prevent="close"
    @close="close"
  >
    <div class="section-heading">
      <h2 id="owner-review-title">Review and sign</h2>
      <button
        class="icon-button"
        aria-label="Close signature review"
        @click="close"
      >
        <X :size="20" />
      </button>
    </div>
    <p class="muted">
      Review {{ name }} with your signature and completed fields. Accepting
      locks this version for signing.
    </p>
    <p v-if="error" class="notice error" role="alert">
      {{ error }}
      <RouterLink to="/account" @click="close">Account security</RouterLink>
    </p>
    <p v-if="busy" role="status">Preparing your review…</p>
    <template v-if="review">
      <a :href="review.pdfUrl" target="_blank" rel="noopener"
        >Open the reviewed PDF in a new tab</a
      >
      <PdfStage
        :url="review.pdfUrl"
        :pages="pages"
        :page-index="page"
        @update:page-index="page = $event"
        @review-state="reviewState"
      />
      <label class="checkbox consent"
        ><input v-model="consent" type="checkbox" :disabled="!ready" />{{
          review.consent.text
        }}</label
      >
      <p v-if="!ready" class="hint" role="status">
        The document must open successfully before you can accept it.
      </p>
      <div class="form-actions">
        <button class="button secondary" @click="close">Back to editing</button
        ><button
          class="button primary"
          :disabled="!ready || !consent"
          @click="accept"
        >
          <PenLine :size="18" />Agree and sign
        </button>
      </div>
    </template>
  </dialog>
</template>
<style scoped>
.owner-review-dialog {
  width: min(1100px, calc(100vw - 32px));
  max-height: 94dvh;
  overflow: auto;
}
.owner-review-dialog > p {
  max-width: 70ch;
}
.owner-review-dialog :deep(.pdf-stage) {
  height: 52dvh;
  max-height: 52dvh;
  margin-top: 16px;
}
.owner-review-dialog .consent {
  margin-top: 20px;
  align-items: flex-start;
}
.owner-review-dialog .form-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
}
@media (max-width: 600px) {
  .owner-review-dialog {
    width: calc(100vw - 16px);
    padding: 16px;
  }
  .owner-review-dialog .form-actions .button {
    flex: 1;
  }
}
</style>
