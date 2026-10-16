<script setup lang="ts" generic="T extends string">
defineProps<{
  modelValue: T;
  tabs: Array<{ key: T; label: string }>;
}>();
defineEmits<{ 'update:modelValue': [value: T] }>();
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.key"
      role="tab"
      :aria-selected="modelValue === t.key"
      :class="{ on: modelValue === t.key }"
      @click="$emit('update:modelValue', t.key)"
    >{{ t.label }}</button>
  </div>
</template>

<style scoped>
.tabs { display: inline-flex; gap: 4px; background: #eaeef2; padding: 3px; border-radius: var(--r-md); }
.tabs button { border: none; background: transparent; padding: 6px 14px; border-radius: var(--r-sm); font-size: 13px; color: var(--c-text-muted); cursor: pointer; font-family: inherit; }
.tabs button:hover { color: var(--c-text); }
.tabs button.on { background: var(--c-surface); color: var(--c-text); box-shadow: var(--shadow-sm); font-weight: 600; }
</style>
