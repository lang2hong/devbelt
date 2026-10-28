<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useI18n } from '../composables/useI18n';
import { buildChartData, parseChartNumber, type ChartAggregate } from '../utils/resultChartData';

const props = defineProps<{
  rows: Record<string, unknown>[];
  fields: { name: string }[];
}>();

const { t } = useI18n();

/** Y 轴多选列数上限：每列一个系列，过多系列既挤又慢。 */
const MAX_SERIES = 8;

const chartType = ref<'bar' | 'line' | 'pie' | 'scatter' | 'doughnut' | 'radar'>('bar');
const xField = ref('');
const yFields = ref<string[]>([]);
const aggregate = ref<ChartAggregate>('none');
const chartTitle = ref('');
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chartInstance: any = null;

const numericFields = computed(() =>
  props.fields.filter((f) => {
    const sample = props.rows[0]?.[f.name];
    return typeof sample === 'number' || (typeof sample === 'string' && !isNaN(Number(sample)));
  }),
);

const allFields = computed(() => props.fields.map((f) => f.name));

const isPieLike = computed(() => chartType.value === 'pie' || chartType.value === 'doughnut');

/**
 * Y 多选的后置约束：
 * - 超过 MAX_SERIES 截断（原生多选允许全选，这里收敛到上限）；
 * - 多系列时饼图/环形图无意义 → 自动切回柱状图。
 */
watch(yFields, (ys) => {
  if (ys.length > MAX_SERIES) {
    yFields.value = ys.slice(0, MAX_SERIES);
    return;
  }
  if (isPieLike.value && ys.length > 1) chartType.value = 'bar';
  // 散点图需要逐行的原始 X/Y，聚合后没有可配对的点。
  if (chartType.value === 'scatter' && aggregate.value !== 'none') chartType.value = 'line';
});

watch(aggregate, (agg) => {
  if (agg !== 'none' && chartType.value === 'scatter') chartType.value = 'line';
});

function scheduleRender(): void {
  if (xField.value && yFields.value.length > 0) void renderChart();
}

// rows 只在结果集整体替换时变（浅监听即可）；配置项用 ref 身份比较。
// 早前把 rows 放进 deep 监听，会在每次改配置时遍历全部结果行。
watch(() => props.rows, scheduleRender);
watch([chartType, xField, yFields, aggregate], scheduleRender);

/** 标题输入防抖：避免每个按键重建一次 chart.js 实例。 */
let titleTimer: ReturnType<typeof setTimeout> | undefined;
watch(chartTitle, () => {
  if (titleTimer) clearTimeout(titleTimer);
  titleTimer = setTimeout(() => { titleTimer = undefined; scheduleRender(); }, 250);
});

/** 默认标题：`A、B、C 按 X`。 */
const effectiveTitle = computed(() => {
  if (chartTitle.value.trim()) return chartTitle.value.trim();
  if (yFields.value.length === 0) return '';
  return t('wv.chart.defaultTitle', { metrics: yFields.value.join(' / '), dim: xField.value });
});

async function renderChart() {
  await nextTick();
  if (!chartCanvas.value || !xField.value || yFields.value.length === 0) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const { Chart, registerables } = await import(/* @vite-ignore */ 'chart.js');
  Chart.register(...registerables);

  const isDark = document.body.classList.contains('vscode-dark');
  const textColor = isDark ? '#cccccc' : '#333333';
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  const isRadar = chartType.value === 'radar';
  const { labels, series } = buildChartData(props.rows, xField.value, yFields.value, aggregate.value);

  const colors = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

  const datasets = series.map((s, i) => {
    const color = colors[i % colors.length];
    if (chartType.value === 'scatter') {
      return {
        label: s.label,
        data: props.rows.map((r) => ({ x: parseChartNumber(r[xField.value]) ?? 0, y: parseChartNumber(r[yFields.value[i]]) ?? 0 })),
        backgroundColor: color,
        borderColor: color,
        borderWidth: 1,
      };
    }
    const pieLike = chartType.value === 'pie' || chartType.value === 'doughnut';
    return {
      label: s.label,
      data: s.values,
      backgroundColor: pieLike ? colors.slice(0, s.values.length) : series.length > 1 ? color : '#4e79a7',
      borderColor: pieLike ? undefined : color,
      borderWidth: pieLike ? 1 : 1.5,
      pointBackgroundColor: color,
      ...(isRadar ? { fill: true, backgroundColor: `${color}33` } : {}),
    };
  });

  const config: any = {
    type: isRadar ? 'radar' : isPieLike.value ? 'doughnut' : chartType.value,
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: !!effectiveTitle.value, text: effectiveTitle.value, color: textColor },
        legend: { display: datasets.length > 1 || isPieLike.value, labels: { color: textColor } },
      },
      scales: isPieLike.value || isRadar ? undefined : {
        x: { title: { display: true, text: xField.value, color: textColor }, ticks: { color: textColor }, grid: { color: gridColor } },
        y: { title: { display: true, text: aggregate.value === 'none' ? yFields.value.join(' / ') : `${aggregate.value}(${yFields.value.join(', ')})`, color: textColor }, ticks: { color: textColor }, grid: { color: gridColor }, beginAtZero: true },
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
    yFields.value = [numericFields.value[0]?.name || allFields.value[1]];
  }
});

onUnmounted(() => {
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = undefined; }
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
});

function exportChart() {
  if (!chartCanvas.value) return;
  const link = document.createElement('a');
  link.download = `chart_${xField.value}_${yFields.value.join('_')}.png`;
  link.href = chartCanvas.value.toDataURL('image/png');
  link.click();
}
</script>

<template>
  <div class="chart-panel">
    <div class="chart-toolbar">
      <select v-model="chartType">
        <option value="bar">{{ t('wv.chart.typeBar') }}</option>
        <option value="line">{{ t('wv.chart.typeLine') }}</option>
        <option value="pie" :disabled="yFields.length > 1" :title="yFields.length > 1 ? t('wv.chart.pieSingleOnly') : ''">{{ t('wv.chart.typePie') }}</option>
        <option value="doughnut" :disabled="yFields.length > 1" :title="yFields.length > 1 ? t('wv.chart.pieSingleOnly') : ''">{{ t('wv.chart.typeDoughnut') }}</option>
        <option value="scatter" :disabled="aggregate !== 'none'" :title="aggregate !== 'none' ? t('wv.chart.scatterRawOnly') : ''">{{ t('wv.chart.typeScatter') }}</option>
        <option value="radar">{{ t('wv.chart.typeRadar') }}</option>
      </select>
      <span class="axis-label">{{ t('wv.chart.xAxis') }}</span>
      <select v-model="xField">
        <option v-for="f in allFields" :key="f" :value="f">{{ f }}</option>
      </select>
      <span class="axis-label">{{ t('wv.chart.yAxis') }}</span>
      <select
        v-model="yFields"
        multiple
        :size="Math.min(5, Math.max(3, allFields.length))"
        :title="t('wv.chart.maxSeries', { max: MAX_SERIES })"
      >
        <option v-for="f in allFields" :key="f" :value="f">{{ f }}</option>
      </select>
      <span class="axis-label">{{ t('wv.chart.seriesByColumn') }}</span>
      <select v-model="aggregate">
        <option value="none">{{ t('wv.chart.aggRaw') }}</option>
        <option value="sum">{{ t('wv.chart.aggSum') }}</option>
        <option value="avg">{{ t('wv.chart.aggAvg') }}</option>
        <option value="count">{{ t('wv.chart.aggCount') }}</option>
        <option value="max">{{ t('wv.chart.aggMax') }}</option>
        <option value="min">{{ t('wv.chart.aggMin') }}</option>
      </select>
      <input
        v-model="chartTitle"
        class="title-input"
        :placeholder="t('wv.chart.title')"
        :title="t('wv.chart.title')"
      />
      <button class="btn" @click="renderChart">{{ t('wv.chart.render') }}</button>
      <button class="btn" @click="exportChart">{{ t('wv.chart.exportPng') }}</button>
    </div>
    <p v-if="yFields.length === 0" class="hint">{{ t('wv.chart.yRequired') }}</p>
    <div class="chart-container">
      <canvas ref="chartCanvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.chart-panel { display: flex; flex-direction: column; flex: 1; padding: 8px; }
.chart-toolbar { display: flex; gap: 6px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); flex-wrap: wrap; }
.chart-toolbar select, .chart-toolbar input { padding: 2px 6px; font-size: 12px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; }
.chart-toolbar select[multiple] { max-width: 220px; overflow: auto; }
.axis-label { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); white-space: nowrap; }
.title-input { width: 160px; }
.hint { margin: 8px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground, #808080); }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.chart-container { flex: 1; min-height: 300px; position: relative; margin-top: 8px; }
.chart-container canvas { width: 100% !important; height: 100% !important; }
</style>