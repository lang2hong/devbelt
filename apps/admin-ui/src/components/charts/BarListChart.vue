<script setup lang="ts">
import { computed } from 'vue';
import { chartColor } from './palette';
import { formatValue, type ValueKind } from './format';

/** 横向条形图（内联 SVG 之外用 CSS 宽度），适合版本、活跃窗口等长标签分布。 */
interface Item {
  label: string;
  value: number;
  color?: string;
}

const props = withDefaults(defineProps<{
  items: Item[];
  kind?: ValueKind;
  note?: string;
  emptyText?: string;
}>(), {
  kind: 'number',
  note: '',
  emptyText: '暂无数据。',
});

const rows = computed(() => {
  const items = props.items
    .map((it, i) => ({ ...it, color: it.color ?? chartColor(i), value: Math.max(0, it.value) }))
    .filter((it) => it.value > 0);
  const max = Math.max(1, ...items.map((it) => it.value));
  return items.map((it) => ({ ...it, pct: (it.value / max) * 100 }));
});
</script>

<template>
  <div class="bars">
    <div v-if="rows.length" class="rows">
      <div v-for="r in rows" :key="r.label" class="row">
        <div class="meta">
          <span class="label" :title="r.label">{{ r.label }}</span>
          <b>{{ formatValue(r.value, kind) }}</b>
        </div>
        <div class="track"><div class="bar" :style="{ width: `${r.pct}%`, background: r.color }" /></div>
      </div>
    </div>
    <p v-else class="empty">{{ emptyText }}</p>
    <p v-if="note && rows.length" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.bars { display: flex; flex-direction: column; gap: 8px; }
.rows { display: flex; flex-direction: column; gap: 9px; }
.row { display: flex; flex-direction: column; gap: 4px; }
.meta { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; }
.label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-muted); }
.meta b { font-weight: 600; white-space: nowrap; }
.track { height: 6px; border-radius: 3px; background: var(--c-surface-muted); overflow: hidden; }
.bar { height: 100%; border-radius: 3px; min-width: 2px; }
.empty { padding: 24px 8px; text-align: center; color: var(--c-text-muted); font-size: 13px; }
.note { margin: 2px 0 0; color: var(--c-text-subtle); font-size: 11px; }
</style>