<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { filterJson } from './types';

const { t } = useI18n();
import JsonNode from './JsonNode.vue';

const props = defineProps<{ value: unknown; /** 填满父容器剩余高度（取消 52vh 上限），用于 DSL raw 等全高场景。 */ fill?: boolean }>();
const query = ref('');
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const filtered = computed(() => filterJson(props.value, query.value));
const entries = computed<[string, unknown][]>(() =>
  filtered.value && typeof filtered.value === 'object' && !Array.isArray(filtered.value)
    ? Object.entries(filtered.value as Record<string, unknown>)
    : [],
);

async function copyJson(): Promise<void> {
  const text = JSON.stringify(filtered.value, null, 2) ?? '{}';
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    copied.value = false;
  }
}
onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="json-tree" :class="{ 'json-tree-fill': fill }">
    <div class="json-tree-toolbar">
      <input v-model="query" class="json-tree-filter" :placeholder="t('wv.es.jsonFilter')" />
      <button class="json-tree-copy" @click="copyJson">{{ copied ? t('wv.es.jsonCopied') : t('wv.es.jsonCopy') }}</button>
    </div>
    <div class="json-tree-body">
      <template v-if="entries.length">
        <JsonNode v-for="[k, v] in entries" :key="k" :label="k" :value="v" :depth="0" />
      </template>
      <JsonNode v-else-if="filtered !== undefined" :label="t('wv.es.jsonRoot')" :value="filtered" :depth="0" />
      <pre v-else class="json-tree-fallback">{{ JSON.stringify(filtered, null, 2) ?? '{}' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.json-tree { display: flex; flex-direction: column; min-height: 0; }
.json-tree-fill { flex: 1; min-height: 0; }
.json-tree-fill .json-tree-body { max-height: none; flex: 1; min-height: 0; }
.json-tree-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
.json-tree-filter { flex: 1; min-width: 140px; font-size: 12px; }
.json-tree-copy { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 0; }
.json-tree-body { flex: 1; overflow: auto; max-height: 52vh; }
.json-tree-fallback { font-size: 12px; white-space: pre; }
</style>