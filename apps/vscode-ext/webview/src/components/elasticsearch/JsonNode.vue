<script setup lang="ts">
import { computed } from 'vue';

/** 递归 JSON 节点：对象/数组用 <details> 折叠；叶子单行展示。 */
const props = defineProps<{ label: string; value: unknown; depth?: number }>();

const kind = computed<'object' | 'array' | 'leaf'>(() => {
  const v = props.value;
  if (v === null || typeof v !== 'object') return 'leaf';
  return Array.isArray(v) ? 'array' : 'object';
});
const entries = computed<[string, unknown][]>(() => {
  if (kind.value === 'object') return Object.entries(props.value as Record<string, unknown>);
  if (kind.value === 'array') return (props.value as unknown[]).map((v, i) => [String(i), v]);
  return [];
});
const preview = computed(() => {
  if (kind.value === 'object') return `{…} ${entries.value.length}`;
  if (kind.value === 'array') return `[…] ${entries.value.length}`;
  return JSON.stringify(props.value);
});
const leafClass = computed(() => {
  const v = props.value;
  if (typeof v === 'string') return 'str';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  return 'null';
});
</script>

<template>
  <div class="json-node" :style="{ marginLeft: depth ? '12px' : '0' }">
    <template v-if="kind === 'leaf'">
      <span class="json-key">{{ label }}</span><span class="json-colon">:</span>
      <span class="json-leaf" :class="leafClass">{{ preview }}</span>
    </template>
    <details v-else :open="(depth ?? 0) < 2">
      <summary><span class="json-key">{{ label }}</span><span class="json-colon">:</span><span class="json-preview">{{ preview }}</span></summary>
      <JsonNode v-for="[k, v] in entries" :key="k" :label="k" :value="v" :depth="(depth ?? 0) + 1" />
    </details>
  </div>
</template>

<style scoped>
.json-node { font-size: 12px; line-height: 1.5; }
.json-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
.json-colon { margin-right: 4px; }
.json-preview { opacity: .6; margin-left: 4px; }
.json-leaf.str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
.json-leaf.num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.json-leaf.bool { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.json-leaf.null { opacity: .5; }
summary { cursor: pointer; }
</style>