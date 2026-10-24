<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ExplainPlanNode, ExplainWarning } from '@devbelt/explain-core';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import type { ExplainRunMode, ExplainStatementView } from '../../../src/result/protocol';
import {
  buildPlanGrid,
  buildPlanSummary,
  collectPlanIds,
  findPlanNode,
  flattenPlan,
  formatMs,
  formatNumber,
  operationLabel,
  WARNING_HELP_KEYS,
  WARNING_LABEL_KEYS,
  warningSeverity,
  type GridColumn,
} from '../components/explain/types';

type ViewTab = 'table' | 'tree' | 'json';

/** Summary lines shown before "show more". */
const SUMMARY_VISIBLE = 2;

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const statements = ref<ExplainStatementView[]>([]);
const active = ref(0);
const running = ref(false);
const runningMode = ref<ExplainRunMode>('estimate');
/** Mode of the plan currently on screen. */
const resultMode = ref<ExplainRunMode>('estimate');
const analyzeSupported = ref(false);
const error = ref('');
const notice = ref('');
const tab = ref<ViewTab>('table');
const showAllSummary = ref(false);
const sqlExpanded = ref(false);
const selectedId = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());
const copied = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let off: (() => void) | undefined;

const current = computed(() => statements.value[active.value]);
const currentPlan = computed(() => current.value?.plan ?? null);
const analyzed = computed(() => resultMode.value === 'analyze');
const visibleRows = computed(() =>
  currentPlan.value ? flattenPlan(currentPlan.value.roots, expanded.value) : [],
);
const selectedNode = computed<ExplainPlanNode | undefined>(() =>
  currentPlan.value ? findPlanNode(currentPlan.value.roots, selectedId.value) : undefined,
);
const grid = computed(() => (current.value ? buildPlanGrid(current.value, analyzed.value) : undefined));
const summary = computed(() =>
  currentPlan.value
    ? buildPlanSummary(currentPlan.value, {
        analyzed: analyzed.value,
        suggestionCount: current.value?.suggestions?.length ?? 0,
      })
    : [],
);
const visibleSummary = computed(() => (showAllSummary.value ? summary.value : summary.value.slice(0, SUMMARY_VISIBLE)));
const displaySql = computed(() => current.value?.formattedSql ?? current.value?.sql ?? '');
const sqlOneLine = computed(() => (current.value?.sql ?? '').replace(/\s+/g, ' ').trim());
const rawText = computed(() => {
  const source = current.value?.plan ? current.value.plan.raw : current.value?.fallback?.rows;
  if (typeof source === 'string') return source;
  if (source == null || (Array.isArray(source) && source.length === 0)) return current.value?.fallback?.text ?? '';
  return JSON.stringify(source, null, 2);
});
const tabs = computed<ViewTab[]>(() => (currentPlan.value ? ['table', 'tree', 'json'] : ['table', 'json']));
const modeLabel = computed(() => {
  if (!analyzed.value) return t('wv.explain.mode.estimate');
  const ms = currentPlan.value?.executionTimeMs;
  return ms !== undefined ? t('wv.explain.mode.analyzeTime', { ms: ms.toFixed(3) }) : t('wv.explain.mode.analyze');
});
const canAiExplain = computed(() => !!current.value && (!!current.value.plan || !!current.value.fallback?.text));

function columnLabel(column: GridColumn): string {
  return column.literal ? column.label : t(column.label);
}

function op(node: ExplainPlanNode): string {
  return operationLabel(node.operation, t);
}

function warningText(warning: ExplainWarning): string {
  return t(WARNING_LABEL_KEYS[warning]);
}

function warningHelp(warning: ExplainWarning): string {
  return t(WARNING_HELP_KEYS[warning]);
}

function selectStatement(index: number): void {
  active.value = index;
  const plan = statements.value[index]?.plan;
  expanded.value = new Set(plan ? collectPlanIds(plan.roots) : []);
  selectedId.value = plan?.roots[0]?.id ?? null;
  showAllSummary.value = false;
  sqlExpanded.value = false;
  if (!tabs.value.includes(tab.value)) tab.value = 'table';
  // Nothing to tabulate (e.g. truncated plan): open the raw output instead of an empty table.
  if (tab.value === 'table' && !grid.value) tab.value = 'json';
}

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function rerun(): void {
  post({ type: 'rerun' });
}

function analyze(): void {
  notice.value = '';
  post({ type: 'analyze' });
}

function cancelAnalyze(): void {
  post({ type: 'analyzeCancel' });
}

function aiExplain(): void {
  if (!canAiExplain.value) return;
  post({ type: 'aiExplain', index: active.value });
}

function copy(text: string, id: string): void {
  if (!text) return;
  post({ type: 'copyText', text });
  copied.value = id;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = null; }, 1500);
}

onMounted(() => {
  off = onMessage((msg: any) => {
    if (msg.type === 'explainContext') {
      analyzeSupported.value = !!msg.analyzeSupported;
    } else if (msg.type === 'explainRunning') {
      running.value = true;
      runningMode.value = msg.mode === 'analyze' ? 'analyze' : 'estimate';
      error.value = '';
      notice.value = '';
    } else if (msg.type === 'explainPlan') {
      statements.value = Array.isArray(msg.statements) ? msg.statements : [];
      resultMode.value = msg.mode === 'analyze' ? 'analyze' : 'estimate';
      running.value = false;
      error.value = '';
      tab.value = 'table';
      selectStatement(0);
    } else if (msg.type === 'explainNotice') {
      notice.value = String(msg.message ?? '');
      if (runningMode.value === 'analyze') running.value = false;
    } else if (msg.type === 'error') {
      statements.value = [];
      error.value = msg.message || t('wv.explain.empty');
      running.value = false;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => {
  off?.();
  clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <span class="title">{{ t('wv.explain.title') }}</span>
      <span v-if="current && !running" class="mode" :class="{ analyzed }">{{ modeLabel }}</span>
      <span v-if="running" class="running" role="status">
        {{ runningMode === 'analyze' ? t('wv.explain.runningAnalyze') : t('wv.explain.running') }}
      </span>
      <button v-if="running && runningMode === 'analyze'" class="btn" @click="cancelAnalyze">{{ t('wv.explain.cancel') }}</button>
      <span class="spacer" />
      <button class="btn" :disabled="running" @click="rerun">{{ t('wv.explain.rerun') }}</button>
      <button
        class="btn primary"
        :disabled="running || !analyzeSupported"
        :title="analyzeSupported ? t('wv.explain.analyzeHint') : t('wv.explain.analyzeUnavailable')"
        @click="analyze"
      >{{ t('wv.explain.analyze') }}</button>
      <button v-if="canAiExplain" class="btn" :disabled="running" @click="aiExplain">{{ t('wv.explain.aiExplain') }}</button>
    </div>

    <div v-if="notice" class="notice" role="status">
      <span>{{ notice }}</span>
      <button class="link" @click="notice = ''">{{ t('wv.explain.dismiss') }}</button>
    </div>
    <div v-if="error" class="error" role="alert">{{ error }}</div>

    <div v-if="statements.length > 1" class="tabs statements">
      <button
        v-for="(statement, i) in statements"
        :key="i"
        class="tab"
        :class="{ active: i === active }"
        :title="statement.sql"
        @click="selectStatement(i)"
      >{{ t('wv.explain.statement', { n: i + 1 }) }}<span v-if="statement.error" class="tab-failed" :aria-label="statement.error"> ⚠</span></button>
    </div>

    <template v-if="current">
      <div v-if="current.error" class="error" role="alert">{{ current.error }}</div>

      <!-- 结论 + SQL -->
      <div class="head">
        <ul v-if="summary.length" class="summary">
          <li v-for="(item, i) in visibleSummary" :key="i" :class="`lv-${item.level}`">{{ t(item.key, item.vars) }}</li>
        </ul>
        <button v-if="summary.length > SUMMARY_VISIBLE" class="link" @click="showAllSummary = !showAllSummary">
          {{ showAllSummary ? t('wv.explain.showLess') : t('wv.explain.showMore', { n: summary.length - SUMMARY_VISIBLE }) }}
        </button>
        <div v-if="current.fallback && !currentPlan" class="muted">
          {{ t('wv.explain.fallback') }} {{ t('wv.explain.fallbackReason', { reason: current.fallback.reason }) }}
        </div>
        <div class="sql-line">
          <button class="twisty" :aria-expanded="sqlExpanded" :aria-label="sqlExpanded ? t('wv.explain.collapse') : t('wv.explain.expand')" @click="sqlExpanded = !sqlExpanded">{{ sqlExpanded ? '▾' : '▸' }}</button>
          <span class="sql-label">SQL</span>
          <code v-if="!sqlExpanded" class="sql-preview" :title="current.sql" @click="sqlExpanded = true">{{ sqlOneLine }}</code>
          <span v-else class="spacer" />
          <button class="link" @click="copy(current.sql, 'sql')">{{ copied === 'sql' ? t('wv.explain.copied') : t('wv.explain.copySql') }}</button>
        </div>
        <pre v-if="sqlExpanded" class="sql">{{ displaySql }}</pre>
      </div>

      <div class="tabs" role="tablist">
        <button
          v-for="name in tabs"
          :key="name"
          class="tab"
          role="tab"
          :aria-selected="tab === name"
          :class="{ active: tab === name }"
          @click="tab = name"
        >{{ t(`wv.explain.tab.${name}`) }}</button>
      </div>

      <div class="body">
        <!-- 表格 -->
        <section v-if="tab === 'table'" class="grid">
          <template v-if="grid">
            <div v-if="grid.figures.length || grid.kind === 'derived' || grid.kind === 'steps'" class="figures">
              <span v-for="item in grid.figures" :key="item.key">{{ t(item.key) }}：<b>{{ item.value }}</b></span>
              <span v-if="grid.kind === 'derived'" class="muted">{{ t('wv.explain.grid.derived') }}</span>
              <span v-if="grid.kind === 'steps' && analyzed && currentPlan?.dialect === 'mysql'" class="muted">{{ t('wv.explain.grid.analyzeSteps') }}</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th v-for="col in grid.columns" :key="col.key" :class="{ num: col.kind === 'num' }">{{ columnLabel(col) }}</th>
                    <th v-if="grid.rows.some((r) => r.notes.length)">{{ t('wv.explain.col.warnings') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in grid.rows" :key="i" :class="row.level ? `lv-${row.level}` : ''">
                    <td
                      v-for="(col, c) in grid.columns"
                      :key="col.key"
                      :class="{ num: col.kind === 'num', code: col.kind === 'code' }"
                      :style="c === 0 && row.depth ? { paddingLeft: `${row.depth * 14 + 8}px` } : undefined"
                      :title="row.titles[col.key] ?? (col.kind === 'code' ? row.cells[col.key] : undefined)"
                    >
                      <template v-if="!row.cells[col.key]"><span class="muted">{{ col.literal ? 'NULL' : '—' }}</span></template>
                      <template v-else-if="col.kind === 'op'">{{ operationLabel(row.cells[col.key], t) }}</template>
                      <template v-else>{{ row.cells[col.key] }}</template>
                    </td>
                    <td v-if="grid.rows.some((r) => r.notes.length)" class="notes-cell">
                      <span v-for="note in row.notes" :key="note" class="note">{{ t(note) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <div v-else class="muted">{{ current.rawTruncated ? t('wv.explain.rawTruncated') : t('wv.explain.grid.none') }}</div>

          <div v-if="currentPlan" class="suggest" :aria-label="t('wv.explain.suggest.title')">
            <div class="suggest-head">
              <span class="section-title">{{ t('wv.explain.suggest.title') }}</span>
              <span class="muted">{{ t('wv.explain.suggest.notice') }}</span>
            </div>
            <div v-if="!current.suggestions || current.suggestions.length === 0" class="muted">
              {{ t('wv.explain.suggest.none') }}
            </div>
            <div v-for="s in current.suggestions ?? []" :key="s.sql" class="suggestion">
              <div class="suggest-row">
                <span class="chip" :class="`conf-${s.confidence}`">{{ t(`wv.explain.suggest.confidence.${s.confidence}`) }}</span>
                <code class="ddl">{{ s.sql }}</code>
                <button class="btn" @click="copy(s.sql, s.sql)">
                  {{ copied === s.sql ? t('wv.explain.copied') : t('wv.explain.suggest.copy') }}
                </button>
              </div>
              <ul class="notes">
                <li v-for="r in s.reasons" :key="`r-${r}`">{{ t(`wv.explain.suggest.reason.${r}`) }}</li>
                <li v-for="r in s.risks" :key="`k-${r}`" class="risk">{{ t(`wv.explain.suggest.risk.${r}`) }}</li>
              </ul>
            </div>
            <div v-for="r in current.redundantIndexes ?? []" :key="`${r.table}.${r.index}`" class="muted">
              {{ t('wv.explain.suggest.redundant', { table: r.table, index: r.index, coveredBy: r.coveredBy }) }}
            </div>
          </div>
        </section>

        <!-- 计划树 -->
        <section v-else-if="tab === 'tree' && currentPlan" class="plan">
          <div class="tree" role="tree">
            <div
              v-for="row in visibleRows"
              :key="row.node.id"
              class="row"
              role="treeitem"
              :aria-level="row.depth + 1"
              :style="{ paddingLeft: `${row.depth * 16}px` }"
            >
              <button
                class="twisty"
                :class="{ hidden: !row.hasChildren }"
                :aria-label="row.expanded ? t('wv.explain.collapse') : t('wv.explain.expand')"
                @click="toggle(row.node.id)"
              >{{ row.expanded ? '▾' : '▸' }}</button>
              <button class="node" :class="{ selected: row.node.id === selectedId }" @click="selectedId = row.node.id">
                <span class="op">{{ op(row.node) }}</span>
                <span v-if="row.node.object" class="meta">{{ row.node.object }}</span>
                <span v-if="row.node.index" class="meta">[{{ row.node.index }}]</span>
                <span
                  v-for="warning in row.node.warnings"
                  :key="warning"
                  class="dot"
                  :class="`sev-${warningSeverity(warning, row.node)}`"
                  :title="`${warningText(warning)}：${warningHelp(warning)}`"
                >●</span>
              </button>
            </div>
          </div>

          <div class="details">
            <div class="section-title">{{ t('wv.explain.details') }}</div>
            <template v-if="selectedNode">
              <dl>
                <dt>{{ t('wv.explain.operation') }}</dt>
                <dd>{{ op(selectedNode) }}</dd>
                <template v-if="op(selectedNode) !== selectedNode.operation">
                  <dt>{{ t('wv.explain.engineName') }}</dt>
                  <dd class="code">{{ selectedNode.operation }}</dd>
                </template>
                <template v-if="selectedNode.object">
                  <dt>{{ t('wv.explain.object') }}</dt>
                  <dd>{{ selectedNode.object }}</dd>
                </template>
                <template v-if="selectedNode.index">
                  <dt>{{ t('wv.explain.index') }}</dt>
                  <dd>{{ selectedNode.index }}</dd>
                </template>
                <template v-if="selectedNode.estimatedRows !== undefined">
                  <dt>{{ t('wv.explain.estimatedRows') }}</dt>
                  <dd>{{ formatNumber(selectedNode.estimatedRows) }}</dd>
                </template>
                <template v-if="selectedNode.actualRows !== undefined">
                  <dt>{{ t('wv.explain.actualRows') }}</dt>
                  <dd>{{ formatNumber(selectedNode.actualRows, Number.isInteger(selectedNode.actualRows) ? 0 : 2) }}</dd>
                </template>
                <template v-if="selectedNode.estimatedCost !== undefined">
                  <dt>{{ t('wv.explain.estimatedCost') }}</dt>
                  <dd>{{ formatNumber(selectedNode.estimatedCost, 2) }}</dd>
                </template>
                <template v-if="selectedNode.actualTimeMs !== undefined">
                  <dt>{{ t('wv.explain.actualTime') }}</dt>
                  <dd>{{ formatMs(selectedNode.actualTimeMs) }}</dd>
                </template>
                <template v-if="selectedNode.loops !== undefined">
                  <dt>{{ t('wv.explain.loops') }}</dt>
                  <dd>{{ formatNumber(selectedNode.loops) }}</dd>
                </template>
                <template v-if="selectedNode.filter">
                  <dt>{{ t('wv.explain.filter') }}</dt>
                  <dd class="code">{{ selectedNode.filter }}</dd>
                </template>
                <template v-if="selectedNode.joinCondition">
                  <dt>{{ t('wv.explain.joinCondition') }}</dt>
                  <dd class="code">{{ selectedNode.joinCondition }}</dd>
                </template>
                <template v-if="selectedNode.indexCondition">
                  <dt>{{ t('wv.explain.indexCondition') }}</dt>
                  <dd class="code">{{ selectedNode.indexCondition }}</dd>
                </template>
              </dl>
              <div v-if="selectedNode.warnings.length" class="detail-warnings">
                <div class="section-title">{{ t('wv.explain.warnings') }}</div>
                <div v-for="warning in selectedNode.warnings" :key="warning" class="warning-line">
                  <span class="chip" :class="`sev-${warningSeverity(warning, selectedNode)}`">{{ warningText(warning) }}</span>
                  <span class="muted">{{ warningHelp(warning) }}</span>
                </div>
              </div>
            </template>
            <div v-else class="muted">{{ t('wv.explain.noSelection') }}</div>
          </div>
        </section>

        <!-- JSON / 原文 -->
        <section v-else-if="tab === 'json'" class="raw">
          <div class="section-head">
            <button class="btn" :disabled="!rawText" @click="copy(rawText, 'raw')">{{ copied === 'raw' ? t('wv.explain.copied') : t('wv.explain.copyRaw') }}</button>
            <span v-if="current.rawTruncated" class="muted">{{ t('wv.explain.rawTruncated') }}</span>
          </div>
          <pre v-if="rawText">{{ rawText }}</pre>
        </section>
      </div>
    </template>

    <div v-else-if="!running && !error" class="empty">{{ t('wv.explain.empty') }}</div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--vscode-foreground, #ccc); }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); flex-wrap: wrap; }
.title { font-weight: 600; }
.mode { font-size: 11px; padding: 1px 8px; border-radius: 8px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.mode.analyzed { background: var(--vscode-charts-green, #388a34); color: #fff; }
.running, .muted { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
.spacer { flex: 1; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.btn:disabled { opacity: .5; cursor: default; }
.link { border: none; background: none; padding: 0; color: var(--vscode-textLink-foreground, #4daafc); cursor: pointer; font-size: 12px; white-space: nowrap; }
.notice { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 6px 10px; font-size: 12px; background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,.15)); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #cca700); }
.error { padding: 8px 10px; color: var(--vscode-errorForeground, #f48771); white-space: pre-wrap; }

.head { padding: 8px 10px 6px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.summary { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.summary li { padding-left: 8px; border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,.4)); line-height: 1.5; }
.summary li.lv-warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.summary li.lv-ok { border-left-color: var(--vscode-charts-green, #388a34); }
.head > .link { align-self: flex-start; }
.sql-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sql-label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #888); }
.sql-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-descriptionForeground, #888); }
pre.sql { white-space: pre-wrap; max-height: 30vh; }

.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); flex-shrink: 0; }
.tab { padding: 6px 12px; font-size: 12px; border: none; background: none; color: var(--vscode-descriptionForeground, #888); border-bottom: 2px solid transparent; cursor: pointer; }
.tab.active { color: var(--vscode-foreground, #ccc); border-bottom-color: var(--vscode-focusBorder, #007fd4); }
.tab-failed { color: var(--vscode-errorForeground, #f48771); }
.body { flex: 1; min-height: 0; overflow: auto; }
.section-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.section-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }

.grid { padding: 8px 10px; }
.figures { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 6px; font-size: 12px; color: var(--vscode-descriptionForeground, #888); }
.figures b { color: var(--vscode-foreground, #ccc); font-weight: 600; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; font-weight: 600; color: var(--vscode-descriptionForeground, #888); background: var(--vscode-editor-background, #1e1e1e); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.code { font-family: var(--vscode-editor-font-family, monospace); max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06)); }
tr.lv-warn { background: var(--vscode-inputValidation-warningBackground, rgba(204,167,0,.12)); }
tr.lv-warn td:first-child { box-shadow: inset 3px 0 0 var(--vscode-editorWarning-foreground, #cca700); }
.notes-cell { white-space: normal; min-width: 180px; }
.note { display: block; color: var(--vscode-descriptionForeground, #888); }
tr.lv-warn .note { color: var(--vscode-foreground, #ccc); }

.suggest { margin-top: 14px; font-size: 12px; }
.suggest-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; }
.suggestion { padding: 6px 0; border-bottom: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.18)); }
.suggest-row { display: flex; align-items: center; gap: 8px; }
.ddl { flex: 1; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all; }
.notes { margin: 4px 0 0 18px; padding: 0; }
.notes .risk { color: var(--vscode-descriptionForeground, #888); }

.chip { display: inline-block; font-size: 11px; padding: 1px 6px; margin-right: 4px; border-radius: 8px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); white-space: nowrap; }
.chip.sev-warn { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
.chip.conf-high { background: var(--vscode-charts-green, #388a34); }
.chip.conf-medium { background: var(--vscode-charts-blue, #3794ff); }
.chip.conf-low { background: var(--vscode-badge-background, #4d4d4d); }
.dot { font-size: 9px; line-height: 1; color: var(--vscode-descriptionForeground, #888); }
.dot.sev-warn { color: var(--vscode-editorWarning-foreground, #cca700); }

.plan { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(260px, 380px); height: 100%; min-height: 0; }
.tree { overflow: auto; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); padding: 6px 0; }
.row { display: flex; align-items: center; gap: 2px; }
.twisty { width: 18px; height: 20px; border: none; background: none; color: var(--vscode-foreground, #ccc); cursor: pointer; padding: 0; flex-shrink: 0; }
.twisty.hidden { visibility: hidden; }
.node { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; text-align: left; border: none; background: none; color: inherit; padding: 2px 4px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.node:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06)); }
.node.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, inherit); }
.op { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground, #888); font-size: 11px; white-space: nowrap; }
.details { overflow: auto; padding: 10px 12px; }
dl { display: grid; grid-template-columns: 90px 1fr; gap: 4px 8px; margin: 0; font-size: 12px; }
dt { color: var(--vscode-descriptionForeground, #888); }
dd { margin: 0; word-break: break-word; }
dd.code { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; }
.detail-warnings { margin-top: 12px; }
.warning-line { display: flex; gap: 6px; align-items: baseline; margin-bottom: 6px; }

.raw { padding: 8px 10px; }
pre { margin: 0; padding: 8px; overflow: auto; background: var(--vscode-textCodeBlock-background, #1e1e1e); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre; }
.empty { padding: 16px; color: var(--vscode-descriptionForeground, #888); }
</style>
