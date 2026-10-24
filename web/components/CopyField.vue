<script setup lang="ts">
// A read-only value with a Copy button and feedback beside it. Used for
// signing links, invitation links, authenticator setup keys and API keys.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { Copy } from "@lucide/vue";
import { copyText } from "../api";

const props = withDefaults(
  defineProps<{
    value: string;
    /** Visible label above the box. */
    label?: string;
    /** Accessible name of the box when it differs from the visible label. */
    inputLabel?: string;
    copyLabel?: string;
    copiedMessage?: string;
    failureMessage?: string;
    monospace?: boolean;
    small?: boolean;
    /** Full-width box with the button below, for values people read or type. */
    stacked?: boolean;
    disabled?: boolean;
  }>(),
  {
    label: undefined,
    inputLabel: undefined,
    copyLabel: "Copy",
    copiedMessage: "Copied.",
    failureMessage: "Could not copy. Select the text in the box and copy it.",
  },
);
const inputId = useId();
const feedbackId = useId();
const state = ref<"idle" | "copying" | "copied" | "error">("idle");
const feedback = ref<HTMLElement>();
let disposed = false;

const buttonText = computed(() => {
  if (state.value === "copied") return "Copied";
  if (state.value === "copying") return "Copying…";
  return props.copyLabel;
});
const message = computed(() =>
  state.value === "error" ? props.failureMessage : props.copiedMessage,
);
// A new value makes earlier feedback misleading.
watch(
  () => props.value,
  () => (state.value = "idle"),
);
onBeforeUnmount(() => (disposed = true));

async function copy() {
  if (state.value === "copying") return;
  state.value = "copying";
  try {
    await copyText(props.value);
    if (!disposed) state.value = "copied";
  } catch {
    if (!disposed) state.value = "error";
  }
  await nextTick();
  feedback.value?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
</script>

<template>
  <div class="copy-field" :class="{ small, stacked }">
    <label v-if="label" :for="inputId" class="copy-field-label">{{
      label
    }}</label>
    <div class="copy-field-row">
      <!-- Stacked values wrap, so a long key stays readable on a phone. -->
      <textarea
        v-if="stacked"
        :id="inputId"
        :value="value"
        :class="{ monospace }"
        :aria-label="inputLabel"
        rows="1"
        readonly
        spellcheck="false"
        @focus="($event.target as HTMLTextAreaElement).select()"
      ></textarea>
      <input
        v-else
        :id="inputId"
        :value="value"
        :class="{ monospace }"
        :aria-label="inputLabel"
        readonly
        spellcheck="false"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <button
        type="button"
        class="button secondary"
        :class="{ small }"
        :disabled="disabled || state === 'copying'"
        :aria-describedby="state === 'idle' ? undefined : feedbackId"
        @click="copy"
      >
        <Copy :size="small ? 15 : 16" />{{ buttonText }}
      </button>
    </div>
    <p
      v-if="state === 'copied' || state === 'error'"
      :id="feedbackId"
      ref="feedback"
      class="copy-field-feedback"
      :class="{ error: state === 'error' }"
      :role="state === 'error' ? 'alert' : 'status'"
    >
      {{ message }}
    </p>
  </div>
</template>

<style scoped>
.copy-field {
  min-width: 0;
}
.copy-field-label {
  display: block;
  margin-bottom: 7px;
  font-size: 13px;
  font-weight: 570;
}
.copy-field-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}
.copy-field-row input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.copy-field.small .copy-field-row input {
  padding: 7px 9px;
  font-size: 12px;
}
.copy-field-row input.monospace {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.copy-field-row .button {
  flex-shrink: 0;
}
.copy-field.stacked .copy-field-row {
  flex-direction: column;
  align-items: flex-start;
}
.copy-field-row textarea {
  width: 100%;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  overflow-wrap: anywhere;
  word-break: break-all;
  field-sizing: content;
}
.copy-field-row textarea.monospace {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.copy-field-feedback {
  margin-top: 8px;
  scroll-margin-block: 12px;
  font-size: 13px;
  color: var(--green);
}
.copy-field-feedback.error {
  color: var(--red);
}
</style>
