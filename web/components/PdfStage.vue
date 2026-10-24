<script setup lang="ts">
import {
  ref,
  shallowRef,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import PdfPage from "./PdfPage.vue";
import type { PageInfo } from "../../shared/types";
GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{
  url: string;
  pages: PageInfo[];
  pageIndex: number;
}>();
const emit = defineEmits<{
  "update:pageIndex": [pageIndex: number];
  "review-state": [
    state: { url: string; ready: boolean; reviewId?: string; sha256?: string },
  ];
}>();
const stage = ref<HTMLElement>(),
  loading = ref(true),
  error = ref("");
const pdf = shallowRef<PDFDocumentProxy>(),
  renderedPages = shallowRef(new Set<number>());
let loadingTask: PDFDocumentLoadingTask | undefined,
  resizeObserver: ResizeObserver | undefined,
  frame = 0,
  generation = 0,
  observedPage = props.pageIndex;
let fetchController: AbortController | undefined;
let reviewMetadata: { reviewId?: string; sha256?: string } = {};
let hasRenderedPage = false;
const failedPages = new Set<number>();
function reportReviewState() {
  emit("review-state", {
    url: props.url,
    ready: Boolean(
      pdf.value &&
      !loading.value &&
      !error.value &&
      hasRenderedPage &&
      !failedPages.size,
    ),
    ...reviewMetadata,
  });
}
function pageRenderState(state: {
  pageIndex: number;
  ready: boolean;
  error: boolean;
}) {
  if (state.error) failedPages.add(state.pageIndex);
  if (state.ready) {
    hasRenderedPage = true;
    failedPages.delete(state.pageIndex);
  }
  reportReviewState();
}
let explicitSelection:
  | { index: number; scrollTop: number; width: number; height: number }
  | undefined;

function updateViewport() {
  const viewport = stage.value;
  if (!viewport) return;
  const top = viewport.scrollTop,
    bottom = top + viewport.clientHeight,
    center = (top + bottom) / 2;
  const pages = [
    ...viewport.querySelectorAll<HTMLElement>("[data-page-index]"),
  ].map((element) => ({
    index: Number(element.dataset.pageIndex),
    top: element.offsetTop,
    bottom: element.offsetTop + element.offsetHeight,
    distance: Math.abs(element.offsetTop + element.offsetHeight / 2 - center),
  }));
  // Keep layout placeholders for the whole document, but only paint nearby pages.
  // The hard cap also bounds memory for PDFs with unusually short page sizes.
  const nearbyPages = pages
    .filter((page) => page.bottom >= top - 500 && page.top <= bottom + 500)
    .sort((a, b) => a.distance - b.distance)
    .map((page) => page.index);
  const selectedIndex = explicitSelection?.index;
  renderedPages.value = new Set(
    (selectedIndex === undefined
      ? nearbyPages
      : [
          selectedIndex,
          ...nearbyPages.filter((index) => index !== selectedIndex),
        ]
    ).slice(0, 6),
  );
  // A requested page remains selected even when it is shorter than the viewport,
  // or all pages fit and the browser cannot scroll it to the top.
  if (explicitSelection) return;
  const current = pages
    .filter((page) => page.bottom > top && page.top < bottom)
    .sort((a, b) => a.distance - b.distance)[0];
  if (current && current.index !== observedPage) {
    observedPage = current.index;
    emit("update:pageIndex", current.index);
  }
}
function scheduleViewportUpdate() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    updateViewport();
  });
}
function scrolled() {
  // Resizing can clamp scrollTop and dispatch scroll before ResizeObserver.
  // Restore the requested page before interpreting that movement as user input.
  if (
    explicitSelection &&
    stage.value &&
    (stage.value.clientWidth !== explicitSelection.width ||
      stage.value.clientHeight !== explicitSelection.height)
  ) {
    scrollToPage(explicitSelection.index);
    return;
  }
  if (
    explicitSelection &&
    stage.value &&
    Math.abs(stage.value.scrollTop - explicitSelection.scrollTop) > 1
  )
    explicitSelection = undefined;
  scheduleViewportUpdate();
}
function scrollToPage(index: number) {
  const viewport = stage.value,
    target = viewport?.querySelector<HTMLElement>(
      `[data-page-index="${index}"]`,
    );
  if (!viewport || !target) return;
  observedPage = index;
  viewport.scrollTo({ top: target.offsetTop, behavior: "instant" });
  explicitSelection = {
    index,
    scrollTop: viewport.scrollTop,
    width: viewport.clientWidth,
    height: viewport.clientHeight,
  };
  emit("update:pageIndex", index);
  updateViewport();
}
defineExpose({ scrollToPage });

async function load() {
  const currentGeneration = ++generation;
  loading.value = true;
  error.value = "";
  pdf.value = undefined;
  reviewMetadata = {};
  hasRenderedPage = false;
  failedPages.clear();
  reportReviewState();
  fetchController?.abort();
  const controller = new AbortController();
  fetchController = controller;
  const previousTask = loadingTask;
  loadingTask = undefined;
  // Stop old renderers before destroying the shared document/worker.
  await nextTick();
  await previousTask?.destroy().catch(() => {});
  if (currentGeneration !== generation) return;
  try {
    const response = await fetch(props.url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("PDF request failed");
    const bytes = await response.arrayBuffer();
    if (currentGeneration !== generation) return;
    reviewMetadata = {
      reviewId: response.headers.get("X-PaperSign-Review") ?? undefined,
      sha256: response.headers.get("X-PaperSign-Review-SHA256") ?? undefined,
    };
    const task = getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    loadingTask = task;
    const document = await task.promise;
    if (currentGeneration !== generation) return;
    pdf.value = document;
    loading.value = false;
    reportReviewState();
    await nextTick();
    scrollToPage(props.pageIndex);
  } catch {
    if (currentGeneration !== generation) return;
    error.value = "The PDF could not be opened. Reload the page and try again.";
    loading.value = false;
    reportReviewState();
  }
}
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (explicitSelection) scrollToPage(explicitSelection.index);
    else scheduleViewportUpdate();
  });
  if (stage.value) resizeObserver.observe(stage.value);
  scrollToPage(props.pageIndex);
  void load();
});
watch(
  () => props.pageIndex,
  (index) => {
    if (index !== observedPage) scrollToPage(index);
  },
);
watch(
  () => props.url,
  () => void load(),
);
onBeforeUnmount(() => {
  generation++;
  fetchController?.abort();
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  void loadingTask?.destroy();
});
</script>
<template>
  <div
    ref="stage"
    class="pdf-stage"
    role="region"
    aria-label="Scrollable PDF document"
    tabindex="0"
    @scroll.passive="scrolled"
  >
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="pdf-loading" role="status">Opening PDF…</p>
    <div
      v-for="(page, index) in pages"
      :key="index"
      class="pdf-page-container"
      :data-page-index="index"
    >
      <p class="pdf-page-number">Page {{ index + 1 }} of {{ pages.length }}</p>
      <PdfPage
        :pdf="pdf"
        :page-index="index"
        :page="page"
        :active="renderedPages.has(index) && !loading && !error"
        @render-state="pageRenderState"
      >
        <slot :page-index="index" />
      </PdfPage>
    </div>
  </div>
</template>
