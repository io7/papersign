<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { PageInfo } from "../../shared/types";
const props = defineProps<{
  pdf?: PDFDocumentProxy;
  pageIndex: number;
  page: PageInfo;
  active: boolean;
}>();
const emit = defineEmits<{
  "render-state": [
    state: { pageIndex: number; ready: boolean; error: boolean },
  ];
}>();
const canvas = ref<HTMLCanvasElement>(),
  element = ref<HTMLElement>(),
  width = ref(0),
  loaded = ref(false),
  error = ref("");
let renderTask: RenderTask | undefined,
  renderedCanvas: HTMLCanvasElement | undefined,
  pdfPage: PDFPageProxy | undefined,
  observer: ResizeObserver | undefined,
  resizeTimer: ReturnType<typeof setTimeout> | undefined,
  generation = 0;

async function render() {
  const currentGeneration = ++generation,
    previousTask = renderTask;
  previousTask?.cancel();
  await previousTask?.promise.catch(() => {});
  if (currentGeneration !== generation) return;
  loaded.value = false;
  error.value = "";
  emit("render-state", {
    pageIndex: props.pageIndex,
    ready: false,
    error: false,
  });
  if (!props.active || !props.pdf || !canvas.value || !width.value) {
    if (renderedCanvas) {
      renderedCanvas.width = 0;
      renderedCanvas.height = 0;
      renderedCanvas = undefined;
    }
    pdfPage?.cleanup();
    pdfPage = undefined;
    return;
  }
  try {
    const currentPage = await props.pdf.getPage(props.pageIndex + 1);
    if (currentGeneration !== generation || !canvas.value) return;
    pdfPage = currentPage;
    const base = currentPage.getViewport({ scale: 1 }),
      viewport = currentPage.getViewport({ scale: width.value / base.width }),
      // At most six canvases, each capped at four million backing pixels.
      dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
      );
    renderedCanvas = canvas.value;
    renderedCanvas.width = Math.max(1, Math.round(viewport.width * dpr));
    renderedCanvas.height = Math.max(1, Math.round(viewport.height * dpr));
    const task = currentPage.render({
      canvas: renderedCanvas,
      viewport,
      transform: [dpr, 0, 0, dpr, 0, 0],
    });
    renderTask = task;
    await task.promise;
    if (currentGeneration === generation) {
      loaded.value = true;
      emit("render-state", {
        pageIndex: props.pageIndex,
        ready: true,
        error: false,
      });
    }
  } catch (cause: any) {
    if (
      currentGeneration === generation &&
      cause.name !== "RenderingCancelledException"
    ) {
      error.value =
        "This page could not be displayed. Reload the document to try again.";
      emit("render-state", {
        pageIndex: props.pageIndex,
        ready: false,
        error: true,
      });
    }
  }
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      width.value = element.value?.clientWidth ?? 0;
    }, 100);
  });
  if (element.value) {
    width.value = element.value.clientWidth;
    observer.observe(element.value);
  }
});
watch(
  () => [props.pdf, props.active, width.value],
  () => void render(),
  { flush: "post" },
);
onBeforeUnmount(() => {
  generation++;
  clearTimeout(resizeTimer);
  observer?.disconnect();
  renderTask?.cancel();
  const oldCanvas = renderedCanvas;
  void renderTask?.promise
    .catch(() => {})
    .then(() => {
      if (oldCanvas) {
        oldCanvas.width = 0;
        oldCanvas.height = 0;
      }
      pdfPage?.cleanup();
    });
});
</script>
<template>
  <div
    ref="element"
    class="pdf-page"
    :style="{ aspectRatio: String(page.width / page.height) }"
    :aria-label="`PDF page ${pageIndex + 1}`"
  >
    <canvas
      v-if="active && pdf"
      ref="canvas"
      :aria-label="`PDF page ${pageIndex + 1} preview`"
    />
    <p v-if="error" class="pdf-page-error notice error" role="alert">
      {{ error }}
    </p>
    <p v-else-if="active && !loaded" class="pdf-loading" role="status">
      Opening page {{ pageIndex + 1 }}…
    </p>
    <div v-if="active && loaded && !error" class="pdf-overlay"><slot /></div>
  </div>
</template>
