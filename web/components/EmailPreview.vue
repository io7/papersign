<script setup lang="ts">
defineProps<{ html?: string; body: string }>();
</script>

<template>
  <div class="email-preview">
    <iframe
      v-if="html"
      :srcdoc="html"
      title="Invitation email preview"
      sandbox=""
      referrerpolicy="no-referrer"
      class="email-preview-frame"
    />
    <details v-if="html" class="email-text-alternative">
      <summary>Plain-text version</summary>
      <pre class="email-body">{{ body }}</pre>
    </details>
    <pre v-else class="email-body">{{ body }}</pre>
  </div>
</template>

<style scoped>
.email-preview {
  margin-bottom: 20px;
}
.email-preview-frame {
  display: block;
  width: 100%;
  height: 600px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
}
.email-text-alternative summary {
  padding: 12px 0;
  color: var(--green);
  cursor: pointer;
  font-size: 13px;
}
</style>
