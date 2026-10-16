<script setup lang="ts">
defineProps<{
  label: string;
  required?: boolean;
  hint?: string;
}>();
</script>

<template>
  <label class="form-field">
    <span class="form-label">{{ label }}<span v-if="required" class="req" aria-hidden="true">*</span></span>
    <slot />
    <span v-if="hint" class="form-hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.form-field { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; }
.form-label { font-size: 12.5px; font-weight: 600; color: var(--c-text); }
.req { color: var(--c-danger); margin-left: 3px; }
.form-hint { font-size: 12px; color: var(--c-text-muted); line-height: 1.45; }
</style>
