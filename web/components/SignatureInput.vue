<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import SignaturePad from "signature_pad";
import { Undo2, Trash2, Upload, PenLine } from "@lucide/vue";
import {
  MAX_SIGNATURE_BYTES,
  MAX_SIGNATURE_PIXELS,
  removeWhiteBackground,
} from "../../shared/signature-image";
const props = defineProps<{ initialMode?: "drawn" | "uploaded" }>();
const emit = defineEmits<{
  change: [value: { png: string; source: "drawn" | "uploaded" } | null];
}>();
const mode = ref<"drawn" | "uploaded">(props.initialMode ?? "drawn"),
  canvas = ref<HTMLCanvasElement>(),
  file = ref<HTMLInputElement>();
const hasInk = ref(false),
  image = ref(""),
  error = ref(""),
  processing = ref(false),
  color = ref("#182c3d");
let pad: SignaturePad | undefined,
  observer: ResizeObserver | undefined,
  previousWidth = 0,
  uploadGeneration = 0;
function publish() {
  hasInk.value = Boolean(pad && !pad.isEmpty());
  emit(
    "change",
    mode.value === "drawn"
      ? hasInk.value
        ? { png: pad!.toDataURL("image/png"), source: "drawn" }
        : null
      : image.value
        ? { png: image.value, source: "uploaded" }
        : null,
  );
}
function setup() {
  if (!canvas.value || pad) return;
  pad = new SignaturePad(canvas.value, {
    penColor: color.value,
    minWidth: 1.2,
    maxWidth: 3.2,
    throttle: 8,
  });
  pad.addEventListener("endStroke", publish);
  const resize = () => {
    const target = canvas.value;
    if (!target) return;
    const width = target.getBoundingClientRect().width;
    if (width < 1 || width === previousWidth) return;
    const strokes = pad!.toData();
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    target.width = Math.round(width * ratio);
    target.height = Math.round(200 * ratio);
    target.getContext("2d")!.scale(ratio, ratio);
    pad!.clear();
    if (previousWidth)
      for (const stroke of strokes)
        for (const point of stroke.points) point.x *= width / previousWidth;
    pad!.fromData(strokes);
    previousWidth = width;
    publish();
  };
  // Prepare the backing canvas synchronously before the first pointer stroke.
  // Waiting for ResizeObserver can clear an early stroke while it is in progress.
  resize();
  observer = new ResizeObserver(resize);
  observer.observe(canvas.value);
}
onMounted(setup);
onBeforeUnmount(() => {
  uploadGeneration++;
  observer?.disconnect();
  pad?.off();
});
watch(color, (value) => {
  if (pad) pad.penColor = value;
});
watch(mode, async () => {
  error.value = "";
  await nextTick();
  setup();
  publish();
});
function undo() {
  const data = pad?.toData() ?? [];
  data.pop();
  pad?.fromData(data);
  publish();
}
function clear() {
  pad?.clear();
  publish();
}
async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement,
    chosen = input.files?.[0];
  if (!chosen) return;
  const generation = ++uploadGeneration;
  processing.value = false;
  error.value = "";
  image.value = "";
  publish();
  input.value = "";
  if (chosen.type !== "image/png" || chosen.size > MAX_SIGNATURE_BYTES) {
    error.value = "Choose a PNG smaller than 2 MB.";
    return;
  }
  processing.value = true;
  let bitmap: ImageBitmap | undefined;
  try {
    // Check IHDR before decoding so a tiny compressed file cannot allocate an
    // unbounded browser canvas. The server independently enforces this limit.
    const header = new Uint8Array(await chosen.slice(0, 33).arrayBuffer());
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const isPng =
      header.length === 33 &&
      signature.every((value, index) => header[index] === value);
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    if (!isPng || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
      throw new Error("This file is not a valid PNG.");
    const width = view.getUint32(16),
      height = view.getUint32(20);
    if (!width || !height || width * height > MAX_SIGNATURE_PIXELS)
      throw new Error("Choose a PNG with no more than 12 million pixels.");
    bitmap = await createImageBitmap(chosen).catch(() => {
      throw new Error(
        "This PNG could not be read. Choose another signature image.",
      );
    });
    if (generation !== uploadGeneration) return;
    const cleaned = document.createElement("canvas");
    cleaned.width = bitmap.width;
    cleaned.height = bitmap.height;
    const context = cleaned.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error("This browser could not prepare the signature.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, cleaned.width, cleaned.height);
    if (!removeWhiteBackground(pixels.data))
      throw new Error(
        "The signature is blank. Draw or upload a visible signature.",
      );
    context.putImageData(pixels, 0, 0);
    const png = cleaned.toDataURL("image/png");
    if (png.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 + 22)
      throw new Error(
        "The prepared signature is too large. Choose a smaller PNG.",
      );
    image.value = png;
    publish();
  } catch (cause) {
    if (generation === uploadGeneration)
      error.value =
        cause instanceof Error
          ? cause.message
          : "This PNG could not be read. Choose another signature image.";
  } finally {
    bitmap?.close();
    if (generation === uploadGeneration) processing.value = false;
  }
}
</script>
<template>
  <div class="signature-input">
    <div class="segmented" aria-label="Signature method">
      <button
        type="button"
        :class="{ selected: mode === 'drawn' }"
        :aria-pressed="mode === 'drawn'"
        @click="mode = 'drawn'"
      >
        <PenLine :size="16" />Draw</button
      ><button
        type="button"
        :class="{ selected: mode === 'uploaded' }"
        :aria-pressed="mode === 'uploaded'"
        @click="mode = 'uploaded'"
      >
        <Upload :size="16" />Upload PNG
      </button>
    </div>
    <div v-show="mode === 'drawn'">
      <div class="drawing-surface">
        <canvas ref="canvas" aria-label="Draw your signature" role="img" /><span
          v-if="!hasInk"
          class="drawing-placeholder"
          >Draw your signature here</span
        ><span class="drawing-baseline" aria-hidden="true"></span>
      </div>
      <div class="drawing-tools">
        <div class="ink-options" aria-label="Ink color">
          <button
            type="button"
            :class="{ selected: color === '#182c3d' }"
            aria-label="Black ink"
            :aria-pressed="color === '#182c3d'"
            @click="color = '#182c3d'"
          >
            <span class="ink-dot black"></span>Black</button
          ><button
            type="button"
            :class="{ selected: color === '#2555a4' }"
            aria-label="Blue ink"
            :aria-pressed="color === '#2555a4'"
            @click="color = '#2555a4'"
          >
            <span class="ink-dot blue"></span>Blue
          </button>
        </div>
        <div class="button-row">
          <button
            class="text-button"
            type="button"
            :disabled="!hasInk"
            @click="undo"
          >
            <Undo2 :size="16" />Undo</button
          ><button
            class="text-button"
            type="button"
            :disabled="!hasInk"
            @click="clear"
          >
            <Trash2 :size="16" />Clear
          </button>
        </div>
      </div>
      <p class="hint">
        Use your mouse, finger, or pen. Prefer a file? Choose Upload PNG.
      </p>
    </div>
    <div v-show="mode === 'uploaded'">
      <input
        ref="file"
        class="sr-only"
        type="file"
        accept="image/png"
        aria-label="Upload signature PNG"
        @change="chooseFile"
      /><button
        class="signature-upload"
        type="button"
        :disabled="processing"
        @click="file?.click()"
      >
        <img v-if="image" :src="image" alt="Signature preview" /><template
          v-else
          ><Upload :size="25" /><strong>{{
            processing
              ? "Preparing your signature…"
              : "Choose your signature PNG"
          }}</strong
          ><span
            >White backgrounds are removed automatically · up to 2 MB</span
          ></template
        ></button
      ><button
        v-if="image"
        type="button"
        class="text-button"
        :disabled="processing"
        @click="file?.click()"
      >
        Choose a different PNG
      </button>
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  </div>
</template>
