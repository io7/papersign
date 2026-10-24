<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Upload, FileText, ArrowUpRight, Search } from "@lucide/vue";
import { api, errorMessage, formatDate } from "../api";
import type { DocumentInfo } from "../../shared/types";
const router = useRouter(),
  docs = ref<DocumentInfo[]>([]),
  input = ref<HTMLInputElement>(),
  loading = ref(true),
  uploading = ref(false),
  dragging = ref(false),
  error = ref(""),
  search = ref("");
const filtered = computed(() =>
  docs.value.filter((d) =>
    d.name.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
onMounted(async () => {
  try {
    docs.value = await api("/documents");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
async function upload(file?: File) {
  if (!file || uploading.value) return;
  error.value = "";
  dragging.value = false;
  if (
    !file.name.toLowerCase().endsWith(".pdf") ||
    file.size > 25 * 1024 * 1024
  ) {
    error.value = "Choose a PDF smaller than 25 MB.";
    return;
  }
  uploading.value = true;
  try {
    const data = new FormData();
    data.append("file", file);
    const document = await api<DocumentInfo>("/documents", {
      method: "POST",
      body: data,
    });
    await router.push(`/documents/${document.id}`);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = "";
  }
}
</script>
<template>
  <div
    class="page"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="upload($event.dataTransfer?.files[0])"
  >
    <header class="page-heading">
      <div>
        <h1>Documents</h1>
        <p>From the first signature to the finished PDF.</p>
      </div>
      <button
        class="button primary"
        :disabled="uploading"
        @click="input?.click()"
      >
        <Upload :size="18" />{{
          uploading ? "Uploading…" : "Upload PDF"
        }}</button
      ><input
        ref="input"
        class="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        aria-label="Upload PDF"
        @change="upload(($event.target as HTMLInputElement).files?.[0])"
      />
    </header>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="uploading" class="notice" role="status">
      Uploading and checking your PDF…
    </p>
    <div v-if="dragging" class="drop-target">Drop your PDF here</div>
    <p v-if="loading" class="loading" role="status">Loading your documents…</p>
    <section v-else-if="!docs.length" class="empty-state">
      <div class="empty-icon"><FileText :size="36" /></div>
      <h2>A signature away from done.</h2>
      <p>
        Start with a PDF. Add your saved signature,<br />or invite someone else
        to sign.
      </p>
      <button
        class="button primary"
        :disabled="uploading"
        @click="input?.click()"
      >
        Upload your first PDF</button
      ><span class="hint">Drop a PDF here · up to 25 MB and 100 pages</span>
    </section>
    <template v-else
      ><div class="list-toolbar">
        <span
          >{{ docs.length }}
          {{ docs.length === 1 ? "document" : "documents" }}</span
        ><label class="search"
          ><Search :size="17" /><span class="sr-only">Search documents</span
          ><input v-model="search" placeholder="Find a document"
        /></label>
      </div>
      <div class="document-list">
        <div class="document-list-heading">
          <span>Document</span><span>Status</span><span>Last updated</span
          ><span></span>
        </div>
        <RouterLink
          v-for="doc in filtered"
          :key="doc.id"
          class="document-row"
          :to="`/documents/${doc.id}`"
          ><div class="document-title">
            <FileText :size="23" />
            <div>
              <strong>{{ doc.name }}</strong
              ><span
                >{{ doc.pages.length }}
                {{ doc.pages.length === 1 ? "page" : "pages" }} ·
                {{ (doc.byteSize / 1024).toFixed(0) }} KB</span
              >
            </div>
          </div>
          <span class="status" :class="doc.status">{{
            doc.status === "awaiting"
              ? "Awaiting signatures"
              : doc.status === "completed"
                ? "Completed"
                : doc.status === "cancelled"
                  ? "Cancelled"
                  : "Draft"
          }}</span
          ><span class="document-date">{{ formatDate(doc.updatedAt) }}</span
          ><ArrowUpRight :size="18"
        /></RouterLink>
        <p v-if="!filtered.length" class="no-results">
          No documents match “{{ search }}”.
        </p>
      </div></template
    >
  </div>
</template>
