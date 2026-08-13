<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';

const props = defineProps<{
  rows: Record<string, unknown>[];
  fields: { name: string }[];
}>();

const chartType = ref<'bar' | 'line' | 'pie' | 'scatter' | 'doughnut' | 'radar'>('bar');
const xField = ref('');
const yField = ref('');
const groupField = ref('');
const aggregate = ref<'sum' | 'avg' | 'count' | 'max' | 'min' | 'none'>('none');
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chartInstance: any = null;

const numericFields = computed(() =>
  props.fields.filter((f) => {
    const sample = props.rows[0]?.[f.name];
    return typeof sample === 'number' || (typeof sample === 'string' && !isNaN(Number(sample)));
  }),
);

const allFields = computed(() => props.fields.map((f) => f.name));

watch(() => props.rows, () => { if (xField.value && yField.value) renderChart(); });

function aggregateData(rows: Record<string, unknown>[], xKey: string, yKey: string, agg: string):
  { labels: string[]; values: number[] } {
  if (agg === 'none' || !xKey || !yKey) {
    return {
      labels: rows.map((r) => String(r[xKey] ?? '')),
      values: rows.map((r) => Number(r[yKey] ?? 0)),
    };
  }
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = String(r[xKey] ?? '');
    const val = Number(r[yKey] ?? 0);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(val);
  }
  const labels: string[] = [];
  const values: number[] = [];
  for (const [k, vals] of groups) {
    labels.push(k);
    switch (agg) {
      case 'sum': values.push(vals.reduce((a, b) => a + b, 0)); break;
      case 'avg': values.push(vals.reduce((a, b) => a + b, 0) / vals.length); break;
      case 'count': values.push(vals.length); break;
      case 'max': values.push(Math.max(...vals)); break;
      case 'min': values.push(Math.min(...vals)); break;
      default: values.push(vals[0]);
    }
  }
  return { labels, values };
}

async function renderChart() {
  await nextTick();
  if (!chartCanvas.value || !xField.value || !yField.value) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const { Chart, registerables } = await import(/* @vite-ignore */ 'chart.js');
  Chart.register(...registerables);

  const isDark = document.body.classList.contains('vscode-dark');
  const textColor = isDark ? '#cccccc' : '#333333';
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  const { labels, values } = aggregateData(props.rows, xField.value, yField.value, aggregate.value);

  const isRadar = chartType.value === 'radar';
  const isPieLike = chartType.value === 'pie' || chartType.value === 'doughnut';
  const colors = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

  const config: any = {
    type: isRadar ? 'radar' : isPieLike ? 'doughnut' : chartType.value,
    data: {
      labels: isPieLike || isRadar || chartType.value === 'bar' || chartType.value === 'line' ? labels : undefined,
      datasets: [{
        label: aggregate.value === 'none' ? yField.value : `${aggregate.value}(${yField.value})`,
        data: chartType.value === 'scatter'
          ? props.rows.map((r) => ({ x: Number(r[xField.value] ?? 0), y: Number(r[yField.value] ?? 0) }))
          : values,
        backgroundColor: isPieLike ? colors : isRadar ? 'rgba(78,121,167,0.2)' : '#4e79a7',
        borderColor: '#4e79a7',
        borderWidth: 1,
        pointBackgroundColor: '#4e79a7',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor } },
      },
      scales: isPieLike || isRadar ? undefined : {
        x: { title: { display: true, text: xField.value, color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } },
        y: { title: { display: true, text: yField.value, color: textColor }, ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true },
      },
    },
  };

  if (isRadar) {
    config.options.scales = {
      r: { ticks: { color: textColor, backdropColor: 'transparent' }, grid: { color: gridColor }, pointLabels: { color: textColor } },
    };
  }

  chartInstance = new (Chart as any)(chartCanvas.value, config);
}

onMounted(() => {
  if (allFields.value.length >= 2) {
    xField.value = allFields.value[0];
    yField.value = numericFields.value[0]?.name || allFields.value[1];
  }
});

onUnmounted(() => {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
});

function exportChart() {
  if (!chartCanvas.value) return;
  const link = document.createElement('a');
  link.download = `chart_${xField.value}_${yField.value}.png`;
  link.href = chartCanvas.value.toDataURL('image/png');
  link.click();
}
</script>

<template>
  <div class="chart-panel">
    <div class="chart-toolbar">
      <select v-model="chartType">
        <option value="bar">Bar</option>
        <option value="line">Line</option>
        <option value="pie">Pie</option>
        <option value="doughnut">Doughnut</option>
        <option value="scatter">Scatter</option>
        <option value="radar">Radar</option>
      </select>
      <select v-model="xField">
        <option v-for="f in allFields" :key="f" :value="f">{{ f }}</option>
      </select>
      <span class="axis-label">X</span>
      <select v-model="yField">
        <option v-for="f in allFields" :key="f" :value="f">{{ f }}</option>
      </select>
      <span class="axis-label">Y</span>
      <select v-model="aggregate">
        <option value="none">Raw</option>
        <option value="sum">SUM</option>
        <option value="avg">AVG</option>
        <option value="count">COUNT</option>
        <option value="max">MAX</option>
        <option value="min">MIN</option>
      </select>
      <button class="btn" @click="renderChart">Render</button>
      <button class="btn" @click="exportChart">Export PNG</button>
    </div>
    <div class="chart-container">
      <canvas ref="chartCanvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.chart-panel { display: flex; flex-direction: column; flex: 1; padding: 8px; }
.chart-toolbar { display: flex; gap: 6px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); flex-wrap: wrap; }
.chart-toolbar select { padding: 2px 6px; font-size: 12px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; }
.axis-label { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.chart-container { flex: 1; min-height: 300px; position: relative; margin-top: 8px; }
.chart-container canvas { width: 100% !important; height: 100% !important; }
</style>