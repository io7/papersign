<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { PenLine, Trash2, Type } from "@lucide/vue";
import type { SigningField, PageInfo } from "../../shared/types";
import { fitPdfText } from "../../shared/pdf-text";
const props = defineProps<{
  field: SigningField;
  image?: string;
  text?: string;
  fontSize?: number;
  page?: PageInfo;
  textField?: boolean;
  label: string;
  active?: boolean;
  editable?: boolean;
  inlineTools?: boolean;
  textLabel?: string;
  textError?: string;
}>();
const emit = defineEmits<{
  update: [field: SigningField];
  select: [];
  remove: [];
}>();
const placementElement = ref<HTMLElement>(),
  toolbarElement = ref<HTMLElement>(),
  toolbarPosition = ref({ left: 0, top: 0, width: 0, visible: false });
const showTools = computed(() =>
  Boolean(props.inlineTools && props.editable && props.active),
);
const hasTextTools = computed(
  () => props.text !== undefined || props.textLabel !== undefined,
);
const toolbarLabel = computed(() =>
  props.text !== undefined
    ? "Text controls"
    : props.textLabel !== undefined
      ? "Text field controls"
      : "Signature controls",
);
const textSizes = [6, 8, 10, 12, 14, 16, 18, 24, 36];
const toolbarStyle = computed(() => ({
  left: `${toolbarPosition.value.left}px`,
  top: `${toolbarPosition.value.top}px`,
  width: `${toolbarPosition.value.width}px`,
  visibility: toolbarPosition.value.visible
    ? ("visible" as const)
    : ("hidden" as const),
}));
const style = computed(() => ({
  left: `${props.field.x * 100}%`,
  top: `${props.field.y * 100}%`,
  width: `${props.field.width * 100}%`,
  height: `${props.field.height * 100}%`,
}));
const textLayout = computed(() => {
  if (props.text === undefined || !props.page) return;
  try {
    return fitPdfText(
      props.text,
      props.fontSize ?? 12,
      props.field.width * props.page.width,
      props.field.height * props.page.height,
    );
  } catch {
    // Keep invalid text selectable so it can be corrected in the toolbar.
    return;
  }
});
function updateText(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit("update", {
    ...props.field,
    ...(props.text !== undefined ? { text: value } : { label: value }),
  });
}
function updateFontSize(event: Event) {
  const patch = { fontSize: Number((event.target as HTMLSelectElement).value) };
  emit("update", { ...props.field, ...patch });
}
function positionToolbar() {
  const anchor = placementElement.value,
    toolbar = toolbarElement.value;
  if (!anchor || !toolbar || !showTools.value) return;
  const field = anchor.getBoundingClientRect(),
    stage = anchor.closest(".pdf-stage")?.getBoundingClientRect(),
    viewport = window.visualViewport,
    viewportLeft = viewport?.offsetLeft ?? 0,
    viewportTop = viewport?.offsetTop ?? 0,
    viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth),
    viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight),
    left = Math.max(viewportLeft + 12, stage?.left ?? 0),
    right = Math.min(viewportRight - 12, stage?.right ?? viewportRight),
    top = Math.max(viewportTop + 8, stage?.top ?? 0),
    bottom = Math.min(viewportBottom - 8, stage?.bottom ?? viewportBottom),
    width = Math.max(0, Math.min(hasTextTools.value ? 360 : 154, right - left)),
    height = toolbar.getBoundingClientRect().height,
    visible =
      field.bottom > top &&
      field.top < bottom &&
      field.right > left &&
      field.left < right;
  toolbarPosition.value = {
    left: clamp(field.left, left, Math.max(left, right - width)),
    top: clamp(
      field.top - height - 10 >= top
        ? field.top - height - 10
        : field.bottom + 10,
      top,
      Math.max(top, bottom - height),
    ),
    width,
    visible,
  };
}
let toolbarFrame = 0;
function scheduleToolbarPosition() {
  if (toolbarFrame) return;
  toolbarFrame = requestAnimationFrame(() => {
    toolbarFrame = 0;
    positionToolbar();
  });
}
watch(
  showTools,
  (visible, _previous, cleanup) => {
    if (!visible) return;
    let cancelled = false;
    const observer = new ResizeObserver(scheduleToolbarPosition);
    document.addEventListener("scroll", scheduleToolbarPosition, true);
    window.addEventListener("resize", scheduleToolbarPosition);
    window.visualViewport?.addEventListener("resize", scheduleToolbarPosition);
    window.visualViewport?.addEventListener("scroll", scheduleToolbarPosition);
    void nextTick(() => {
      if (cancelled) return;
      if (placementElement.value?.parentElement)
        observer.observe(placementElement.value.parentElement);
      if (toolbarElement.value) observer.observe(toolbarElement.value);
      positionToolbar();
    });
    cleanup(() => {
      cancelled = true;
      observer.disconnect();
      document.removeEventListener("scroll", scheduleToolbarPosition, true);
      window.removeEventListener("resize", scheduleToolbarPosition);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleToolbarPosition,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        scheduleToolbarPosition,
      );
    });
  },
  { immediate: true, flush: "post" },
);
watch(
  () => [props.field.x, props.field.y, props.field.width, props.field.height],
  scheduleToolbarPosition,
  { flush: "post" },
);
onBeforeUnmount(() => cancelAnimationFrame(toolbarFrame));
let drag:
  | {
      initial: SigningField;
      width: number;
      height: number;
      x: number;
      y: number;
      resize: boolean;
    }
  | undefined;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
function start(event: PointerEvent) {
  if (!props.editable || event.button !== 0) return;
  event.preventDefault();
  emit("select");
  const target = event.currentTarget as HTMLElement,
    area = target.parentElement!.getBoundingClientRect();
  target.focus();
  target.setPointerCapture(event.pointerId);
  drag = {
    initial: { ...props.field },
    width: area.width,
    height: area.height,
    x: event.clientX,
    y: event.clientY,
    resize: (event.target as HTMLElement).dataset.resize === "true",
  };
}
function move(event: PointerEvent) {
  if (!drag) return;
  const field = { ...drag.initial },
    dx = (event.clientX - drag.x) / drag.width,
    dy = (event.clientY - drag.y) / drag.height;
  if (drag.resize) {
    if (props.image) {
      const ratio = field.height / field.width;
      field.width = clamp(
        field.width + dx,
        0.03,
        Math.min(1 - field.x, (1 - field.y) / ratio),
      );
      field.height = field.width * ratio;
    } else {
      field.width = clamp(field.width + dx, 0.01, 1 - field.x);
      field.height = clamp(field.height + dy, 0.002, 1 - field.y);
    }
  } else {
    field.x = clamp(field.x + dx, 0, 1 - field.width);
    field.y = clamp(field.y + dy, 0, 1 - field.height);
  }
  emit("update", field);
}
function keyboard(event: KeyboardEvent) {
  if (showTools.value && ["Enter", "F2"].includes(event.key)) {
    event.preventDefault();
    toolbarElement.value
      ?.querySelector<HTMLElement>("input, select, button")
      ?.focus();
    return;
  }
  if (
    !props.editable ||
    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  )
    return;
  event.preventDefault();
  const field = { ...props.field },
    step = event.shiftKey ? 0.02 : 0.005;
  if (event.altKey) {
    if (props.image) {
      const ratio = field.height / field.width;
      field.width = clamp(
        field.width +
          (["ArrowRight", "ArrowDown"].includes(event.key) ? step : -step),
        0.03,
        Math.min(1 - field.x, (1 - field.y) / ratio),
      );
      field.height = field.width * ratio;
    } else {
      field.width = clamp(
        field.width +
          (event.key === "ArrowRight"
            ? step
            : event.key === "ArrowLeft"
              ? -step
              : 0),
        0.01,
        1 - field.x,
      );
      field.height = clamp(
        field.height +
          (event.key === "ArrowDown"
            ? step
            : event.key === "ArrowUp"
              ? -step
              : 0),
        0.002,
        1 - field.y,
      );
    }
  } else {
    field.x = clamp(
      field.x +
        (event.key === "ArrowRight"
          ? step
          : event.key === "ArrowLeft"
            ? -step
            : 0),
      0,
      1 - field.width,
    );
    field.y = clamp(
      field.y +
        (event.key === "ArrowDown"
          ? step
          : event.key === "ArrowUp"
            ? -step
            : 0),
      0,
      1 - field.height,
    );
  }
  emit("update", field);
}
</script>
<template>
  <div
    ref="placementElement"
    class="placement"
    :data-placement-id="field.id"
    :class="{
      active,
      editable,
      recipient: !image && text === undefined,
      'text-placement': textField,
    }"
    :style="style"
    :tabindex="editable ? 0 : undefined"
    :role="editable ? 'button' : 'img'"
    :aria-label="
      editable
        ? `${label}. Move with arrow keys; hold Alt to resize.${inlineTools ? ' Press Enter to edit.' : ''}`
        : label
    "
    @pointerdown="start"
    @pointermove="move"
    @pointerup="drag = undefined"
    @pointercancel="drag = undefined"
    @lostpointercapture="drag = undefined"
    @keydown="keyboard"
    @focus="emit('select')"
  >
    <svg
      v-if="textLayout && page"
      class="pdf-text-preview"
      :viewBox="`0 0 ${field.width * page.width} ${field.height * page.height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <text
        x="0"
        :y="textLayout.baseline"
        :font-size="textLayout.fontSize"
        :textLength="textLayout.width"
        lengthAdjust="spacingAndGlyphs"
        font-family="Helvetica, Arial, sans-serif"
        font-kerning="none"
        fill="black"
      >
        {{ textLayout.text }}
      </text>
    </svg>
    <img v-else-if="image" :src="image" :alt="label" draggable="false" /><span
      v-else
      class="recipient-label"
      ><Type v-if="textField" :size="15" /><PenLine v-else :size="15" />{{
        label
      }}</span
    ><span
      v-if="editable && active"
      class="resize-handle"
      data-resize="true"
      aria-hidden="true"
    ></span>
  </div>
  <Teleport to="body">
    <div
      v-if="showTools"
      ref="toolbarElement"
      class="placement-toolbar"
      :class="{ 'has-text-tools': hasTextTools }"
      :data-placement-id="field.id"
      :style="toolbarStyle"
      role="toolbar"
      :aria-label="toolbarLabel"
      @pointerdown.stop
      @click.stop
      @keydown.esc.stop.prevent="placementElement?.focus()"
    >
      <template v-if="hasTextTools">
        <input
          class="placement-text-input"
          :aria-label="text !== undefined ? 'Text' : 'Field label'"
          :value="text ?? textLabel"
          :maxlength="text !== undefined ? 200 : 80"
          :aria-invalid="Boolean(textError)"
          :aria-describedby="textError ? `field-error-${field.id}` : undefined"
          @input="updateText"
        />
        <select
          aria-label="Font size"
          :value="fontSize ?? 12"
          @change="updateFontSize"
        >
          <option v-for="size in textSizes" :key="size" :value="size">
            {{ size }} pt
          </option>
        </select>
      </template>
      <button
        type="button"
        class="placement-remove"
        aria-label="Remove from page"
        title="Remove from page"
        @click="emit('remove')"
      >
        <Trash2 :size="17" aria-hidden="true" />
        <span v-if="!hasTextTools">Remove</span>
      </button>
      <p
        v-if="textError"
        :id="`field-error-${field.id}`"
        class="placement-text-error"
        role="alert"
      >
        {{ textError }}
      </p>
    </div>
  </Teleport>
</template>

<style scoped>
.placement-toolbar {
  position: fixed;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 8px;
  background: var(--paper);
  color: var(--ink);
  box-shadow: 0 4px 18px #163f3833;
  cursor: default;
  touch-action: manipulation;
}
.placement-toolbar.has-text-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 78px 36px;
}
.placement-toolbar input,
.placement-toolbar select,
.placement-remove {
  min-width: 0;
  height: 36px;
  border-radius: 5px;
  font-size: 13px;
}
.placement-toolbar input,
.placement-toolbar select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--line);
  background: var(--paper);
  color: var(--ink);
}
.placement-toolbar input[aria-invalid="true"] {
  border-color: var(--red);
}
.placement-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  padding: 6px;
  border: 0;
  background: transparent;
  color: var(--red);
}
.placement-remove:hover {
  background: #f3e7e5;
}
.placement-text-error {
  grid-column: 1 / -1;
  padding: 0 4px 4px;
  color: var(--red);
  font-size: 12px;
  line-height: 1.4;
}
@media (pointer: coarse) {
  .placement-toolbar input,
  .placement-toolbar select,
  .placement-remove {
    height: 44px;
    font-size: 16px;
  }
  .placement-toolbar.has-text-tools {
    grid-template-columns: minmax(0, 1fr) 86px 44px;
  }
}
</style>
