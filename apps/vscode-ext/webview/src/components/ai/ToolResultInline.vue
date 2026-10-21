<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { formatToolResultContent, parseMessageBlocks, type AiToolResultPayload } from '../../utils/aiChatStream';
import { inferCharts, type ChartType } from '../../utils/chartInference';
import { fmtChartValue } from './charts/chartShared';
import { useI18n } from '../../composables/useI18n';
import MarkdownText from './MarkdownText.vue';
import { OPTIMIZE_SQL_KEY } from '../../utils/runInChat';
import { formatElapsed, isSlowQuery } from '../../../../src/ai/slowQuery';
import BarChart from './charts/BarChart.vue';
import LineChart from './charts/LineChart.vue';
import PieChart from './charts/PieChart.vue';

/**
 * 代码块下方的内联执行结果（P9：toolRef 绑定 blockRef 后就地渲染，不再追加到消息流末尾）。
 * md 表格复用 parseMessageBlocks；结果中的代码块**不带运行按钮**（结果只读）。
 * 图表（P9 结果驱动）：表格 ⇄ 图表切换——preferChart（用户消息命中图表意图）默认展开图，
 * 否则默认表格 + 形态可用的图型按钮（[柱][线][饼]，用户手动切换）。
 */
const props = defineProps<{ result: AiToolResultPayload; sql?: string }>();

const { t } = useI18n();

const formatted = computed(() => formatToolResultContent(props.result));

/** 慢查询（完成或被取消且耗时达阈值）→ 提示 + 「让 AI 优化」入口（优化流程在根组件）。 */
const optimizeSql = inject(OPTIMIZE_SQL_KEY, undefined);
const slow = computed(() => isSlowQuery(props.result.costMs) && !!props.sql && !!optimizeSql);
function optimize(): void {
  if (props.sql) optimizeSql?.(props.sql, props.result.costMs);
}
const blocks = computed(() => parseMessageBlocks(formatted.value.content));

/** 首个表块作为图表数据源。 */
const tableBlock = computed(() => blocks.value.find((b): b is { type: 'table'; header: string[]; rows: string[][]; summary?: string } => b.type === 'table'));
const chartSpec = computed(() => (tableBlock.value ? inferCharts(tableBlock.value.header, tableBlock.value.rows) : null));

type View = 'table' | ChartType;
const view = ref<View>('table');
watch(
  () => props.result,
  (r) => {
    view.value = r.preferChart && chartSpec.value ? chartSpec.value.types[0]! : 'table';
  },
  { immediate: true },
);

const CHART_META: Record<ChartType, { label: string }> = {
  bar: { label: 'wv.ai.chart.bar' },
  line: { label: 'wv.ai.chart.line' },
  pie: { label: 'wv.ai.chart.pie' },
};

/** 图表语义三件套：标题（按 dim 统计 metrics）/ 副行（原结果标题）/ 提示（项数·总计·悬停）。 */
const chartTitle = computed(() => {
  const spec = chartSpec.value;
  if (!spec) return '';
  const metrics = spec.series.map((s) => s.label).join(' / ');
  return t('wv.ai.chart.title', { dim: spec.xLabel, metrics });
});
const chartTotal = computed(() => (chartSpec.value ? chartSpec.value.series[0]!.values.reduce((a, b) => a + b, 0) : 0));
const chartHint = computed(() => {
  const spec = chartSpec.value;
  if (!spec) return '';
  const base = t('wv.ai.chart.hint', { n: spec.xValues.length });
  if (view.value === 'pie') return `${base} · ${t('wv.ai.chart.total', { total: fmtChartValue(chartTotal.value) })}`;
  return base;
});
</script>

<template>
  <div class="ai-inline-result" :class="{ 'ai-inline-result-error': formatted.error }">
    <div v-if="chartSpec && !formatted.error" class="ai-chart-switch">
      <button
        class="ai-btn ai-chart-btn"
        :class="{ on: view === 'table' }"
        @click="view = 'table'"
      >{{ t('wv.ai.chart.table') }}</button>
      <button
        v-for="ct in chartSpec.types"
        :key="ct"
        class="ai-btn ai-chart-btn"
        :class="{ on: view === ct }"
        @click="view = ct"
      >{{ t(CHART_META[ct].label) }}</button>
    </div>
    <template v-if="view !== 'table' && chartSpec && !formatted.error">
      <div class="ai-chart-head">
        <span class="ai-chart-title">{{ chartTitle }}</span>
        <span v-if="result.title" class="ai-chart-sub">{{ result.title }}</span>
      </div>
      <div class="ai-chart-area">
        <BarChart v-if="view === 'bar'" :x-label="chartSpec.xLabel" :x-values="chartSpec.xValues" :series="chartSpec.series" />
        <LineChart v-else-if="view === 'line'" :x-label="chartSpec.xLabel" :x-values="chartSpec.xValues" :series="chartSpec.series" />
        <PieChart v-else :x-label="chartSpec.xLabel" :x-values="chartSpec.xValues" :series="chartSpec.series" />
      </div>
      <p class="ai-chart-hint">{{ chartHint }}</p>
    </template>
    <template v-else>
      <template v-for="(block, index) in blocks" :key="index">
      <div v-if="block.type === 'table'" class="ai-table-block">
        <div v-if="block.summary" class="ai-table-summary">{{ block.summary }}</div>
        <div class="ai-table-scroll">
          <table class="ai-table">
            <thead>
              <tr>
                <th v-for="(cell, cellIndex) in block.header" :key="cellIndex">{{ cell }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
                <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <pre v-else-if="block.type === 'code'" class="ai-inline-code"><code>{{ block.content }}</code></pre>
      <component v-else-if="block.type === 'heading'" :is="`h${block.level}`" class="ai-inline-heading">
        <MarkdownText :text="block.content" />
      </component>
      <ul v-else-if="block.type === 'list' && !block.ordered" class="ai-inline-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownText :text="item" /></li>
      </ul>
      <ol v-else-if="block.type === 'list'" class="ai-inline-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownText :text="item" /></li>
      </ol>
      <blockquote v-else-if="block.type === 'quote'" class="ai-inline-quote"><MarkdownText :text="block.content" /></blockquote>
      <hr v-else-if="block.type === 'hr'" class="ai-inline-hr" />
      <p v-else class="ai-inline-text"><MarkdownText :text="block.content" /></p>
      </template>
    </template>
    <div v-if="slow" class="ai-slow-hint">
      <span>{{ t('wv.ai.run.slowResult', { time: formatElapsed(result.costMs ?? 0) }) }}</span>
      <button class="ai-btn" @click="optimize">{{ t('wv.ai.run.optimize') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ai-inline-result {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--vscode-focusBorder, #0078d4);
  background: var(--vscode-editor-background, #1e1e1e);
  border-radius: 4px;
  font-size: 12.5px;
}
.ai-inline-result-error { border-left-color: var(--vscode-errorForeground, #f14c4c); }
.ai-slow-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--vscode-editorWarning-foreground, #cca700);
  font-size: 12px;
}
.ai-chart-switch { display: flex; gap: 6px; margin-bottom: 6px; }
.ai-chart-btn {
  border: 1px solid var(--vscode-panel-border, #333); background: transparent;
  color: var(--vscode-descriptionForeground, #888); border-radius: 4px;
  padding: 2px 10px; font-size: 11px; cursor: pointer;
}
.ai-chart-btn.on {
  border-color: var(--vscode-focusBorder, #0078d4);
  color: var(--vscode-foreground, #ccc); background: rgba(125, 125, 125, 0.15);
}
.ai-chart-head { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 10px; flex-wrap: wrap; }
.ai-chart-title { font-weight: 600; font-size: 13px; color: var(--vscode-foreground, #ccc); }
.ai-chart-sub { font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
.ai-chart-area { padding: 4px 4px 0; }
.ai-chart-hint { margin: 8px 0 0; font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
.ai-inline-text { margin: 2px 0; white-space: pre-wrap; word-break: break-word; }
.ai-inline-heading { margin: 8px 0 4px; font-weight: 600; font-size: 1.05em; }
.ai-inline-list { margin: 4px 0; padding-left: 20px; }
.ai-inline-quote { margin: 4px 0; padding: 2px 8px; border-left: 3px solid var(--vscode-panel-border, #444); color: var(--vscode-descriptionForeground); }
.ai-inline-hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 8px 0; }
.ai-inline-code { margin: 2px 0; padding: 6px 8px; background: rgba(125, 125, 125, 0.12); border-radius: 4px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.ai-table-block { margin: 4px 0; }
.ai-table-summary { margin: 2px 0 4px; font-weight: 600; font-size: 12px; color: var(--vscode-foreground, #ccc); }
.ai-table-scroll { overflow-x: auto; }
.ai-table { border-collapse: collapse; font-size: 12px; }
.ai-table th, .ai-table td { border: 1px solid var(--vscode-panel-border, #333); padding: 3px 8px; text-align: left; white-space: nowrap; }
.ai-table th { background: rgba(125, 125, 125, 0.15); }
</style>