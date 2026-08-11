<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();
const tables = ref<{ name: string; columns: { name: string; type: string; isPK: boolean }[] }[]>([]);
const foreignKeys = ref<{ tableName: string; columnName: string; refTable: string; refColumn: string }[]>([]);
const error = ref('');

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'data') {
      tables.value = msg.tables || [];
      foreignKeys.value = msg.foreignKeys || [];
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

// 简单网格布局：每列最多 4 个表，间距 220x200
const COLS = 3;
const TABLE_W = 200;
const TABLE_H = 160;
const GAP_X = 60;
const GAP_Y = 60;

const layout = computed(() => {
  const positions = new Map<string, { x: number; y: number }>();
  tables.value.forEach((t, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    positions.set(t.name, {
      x: col * (TABLE_W + GAP_X) + 20,
      y: row * (TABLE_H + GAP_Y) + 20,
    });
  });
  return positions;
});

const svgWidth = computed(() => tables.value.length > 0 ? COLS * (TABLE_W + GAP_X) + 20 : 800);
const svgHeight = computed(() => {
  const rows = Math.ceil(tables.value.length / COLS);
  return rows * (TABLE_H + GAP_Y) + 20 || 600;
});

const fkLines = computed(() => {
  return foreignKeys.value.map((fk) => {
    const src = layout.value.get(fk.tableName);
    const dst = layout.value.get(fk.refTable);
    if (!src || !dst) return null;
    return {
      x1: src.x + TABLE_W / 2,
      y1: src.y + TABLE_H / 2,
      x2: dst.x + TABLE_W / 2,
      y2: dst.y + TABLE_H / 2,
      label: `${fk.tableName}.${fk.columnName} → ${fk.refTable}.${fk.refColumn}`,
    };
  }).filter(Boolean);
});
</script>

<template>
  <div class="app">
    <div class="error" v-if="error">{{ error }}</div>
    <div class="canvas" v-else>
      <svg :width="svgWidth" :height="svgHeight" class="er-svg">
        <!-- Foreign key lines -->
        <g v-for="(line, i) in fkLines" :key="'fk'+i">
          <line :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
            stroke="var(--vscode-textLink-foreground)" stroke-width="1.5" stroke-dasharray="4 2" />
          <circle :cx="line.x2" :cy="line.y2" r="3" fill="var(--vscode-textLink-foreground)" />
        </g>
        <!-- Tables -->
        <g v-for="t in tables" :key="t.name" :transform="`translate(${layout.get(t.name)?.x || 0}, ${layout.get(t.name)?.y || 0})`">
          <rect :width="TABLE_W" :height="TABLE_H" rx="4"
            fill="var(--vscode-editor-background)" stroke="var(--vscode-focusBorder)" stroke-width="1.5" />
          <rect width="TABLE_W" height="28" rx="4" fill="var(--vscode-titleBar-activeBackground)" />
          <text x="10" y="18" class="table-title">{{ t.name }}</text>
          <text v-for="(c, i) in t.columns.slice(0, 6)" :key="c.name"
            :x="10" :y="44 + i * 16" class="col-name">
            <tspan v-if="c.isPK" fill="var(--vscode-charts-yellow)" font-weight="bold">🔑 </tspan>
            {{ c.name }}: {{ c.type }}
          </text>
          <text v-if="t.columns.length > 6" x="10" :y="44 + 6 * 16 + 4" class="more" :data="t.columns.length">
            +{{ t.columns.length - 6 }} more
          </text>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.app { font-family: var(--vscode-font-family); height: 100vh; overflow: auto; }
.canvas { padding: 8px; }
.er-svg { display: block; }
.table-title { font-size: 13px; font-weight: bold; fill: var(--vscode-foreground); }
.col-name { font-size: 11px; fill: var(--vscode-descriptionForeground); }
.more { font-size: 11px; fill: var(--vscode-descriptionForeground); font-style: italic; }
.error { padding: 12px; color: var(--vscode-errorForeground); }
</style>
