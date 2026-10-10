<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { filterJson } from './types';

const { t } = useI18n();
import JsonNode from './JsonNode.vue';

const props = defineProps<{ value: unknown; /** 填满父容器剩余高度（取消 52vh 上限），用于 DSL raw 等全高场景。 */ fill?: boolean }>();
const query = ref('');

const filtered = computed(() => filterJson(props.value, query.value));
const entries = computed<[string, unknown][]>(() =>
  filtered.value && typeof filtered.value === 'object' && !Array.isArray(filtered.value)
    ? Object.entries(filtered.value as Record<string, unknown>)
    : [],
);
</script>

<template>
  <div class="json-tree" :class="{ 'json-tree-fill': fill }">
    <input v-model="query" class="json-tree-filter" :placeholder="t('wv.es.jsonFilter')" />
    <div class="json-tree-body">
      <JsonNode v-for="[k, v] in entries" :key="k" :label="k" :value="v" :depth="0" />
      <pre v-if="!entries.length" class="json-tree-fallback">{{ JSON.stringify(filtered, null, 2) ?? '{}' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.json-tree { display: flex; flex-direction: column; min-height: 0; }
.json-tree-fill { flex: 1; min-height: 0; }
.json-tree-fill .json-tree-body { max-height: none; flex: 1; min-height: 0; }
.json-tree-filter { margin-bottom: 4px; font-size: 12px; }
.json-tree-body { flex: 1; overflow: auto; max-height: 52vh; }
.json-tree-fallback { font-size: 12px; white-space: pre; }
</style>