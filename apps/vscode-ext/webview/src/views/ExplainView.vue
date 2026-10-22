<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ExplainPlanNode, ExplainWarning } from '@devbelt/explain-core';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import type { ExplainStatementView } from '../../../src/result/protocol';
import {
  collectPlanIds,
  findPlanNode,
  flattenPlan,
  formatMs,
  formatNumber,
  WARNING_LABEL_KEYS,
  warningClass,
} from '../components/explain/types';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const statements = ref<ExplainStatementView[]>([]);
const active = ref(0);
const running = ref(false);
const error = ref('');
const selectedId = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());
const showRaw = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let off: (() => void) | undefined;

const current = computed(() => statements.value[active.value]);
const currentPlan = computed(() => current.value?.plan ?? null);
const visibleRows = computed(() =>
  currentPlan.value ? flattenPlan(currentPlan.value.roots, expanded.value) : [],
);
const selectedNode = computed<ExplainPlanNode | undefined>(() =>
  currentPlan.value ? findPlanNode(currentPlan.value.roots, selectedId.value) : undefined,
);
const rawText = computed(() => {
  const source = current.value?.plan?.raw ?? current.value?.fallback?.rows ?? null;
  return source == null ? '' : JSON.stringify(source, null, 2);
});

function warningLabel(warning: ExplainWarning): string {
  return WARNING_LABEL_KEYS[warning];
}

function selectStatement(index: number): void {
  active.value = index;
  const plan = statements.value[index]?.plan;
  expanded.value = new Set(plan ? collectPlanIds(plan.roots) : []);
  selectedId.value = plan?.roots[0]?.id ?? null;
  showRaw.value = false;
}

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function select(id: string): void {
  selectedId.value = id;
}

function rerun(): void {
  post({ type: 'rerun' });
}

function copyRaw(): void {
  if (!rawText.value) return;
  post({ type: 'copyText', text: rawText.value });
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
}

onMounted(() => {
  off = onMessage((msg: any) => {
    if (msg.type === 'explainRunning') {
      running.value = true;
      error.value = '';
    } else if (msg.type === 'explainPlan') {
      statements.value = Array.isArray(msg.statements) ? msg.statements : [];
      running.value = false;
      error.value = '';
      selectStatement(0);
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
      <span v-if="running" class="running">{{ t('wv.explain.running') }}</span>
      <span class="spacer" />
      <button class="btn" :disabled="running" @click="rerun">{{ t('wv.explain.rerun') }}</button>
      <button class="btn" :disabled="!rawText" @click="copyRaw">{{ t('wv.explain.copyRaw') }}</button>
      <span v-if="copied" class="copied">{{ t('wv.explain.copied') }}</span>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="statements.length > 1" class="tabs">
      <button
        v-for="(statement, i) in statements"
        :key="i"
        class="tab"
        :class="{ active: i === active }"
        :title="statement.sql"
        @click="selectStatement(i)"
      >{{ t('wv.explain.statement', { n: i + 1 }) }}</button>
    </div>

    <template v-if="current">
      <div v-if="currentPlan" class="warnings">
        <span v-if="currentPlan.warnings.length === 0" class="muted">{{ t('wv.explain.noWarnings') }}</span>
        <span
          v-for="warning in currentPlan.warnings"
          :key="warning"
          class="chip"
          :class="warningClass(warning)"
        >{{ t(warningLabel(warning)) }}</span>
      </div>

      <div v-if="currentPlan" class="plan">
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
            <button class="node" :class="{ selected: row.node.id === selectedId }" @click="select(row.node.id)">
              <span class="op">{{ row.node.operation }}</span>
              <span v-if="row.node.object" class="meta">{{ row.node.object }}</span>
              <span v-if="row.node.index" class="meta">[{{ row.node.index }}]</span>
              <span
                v-for="warning in row.node.warnings"
                :key="warning"
                class="dot"
                :class="warningClass(warning)"
                :title="t(warningLabel(warning))"
              >●</span>
            </button>
          </div>
        </div>

        <div class="details">
          <div class="details-title">{{ t('wv.explain.details') }}</div>
          <template v-if="selectedNode">
            <dl>
              <dt>{{ t('wv.explain.operation') }}</dt>
              <dd>{{ selectedNode.operation }}</dd>
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
                <dd>{{ formatNumber(selectedNode.actualRows) }}</dd>
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
            </dl>
            <div v-if="selectedNode.warnings.length" class="detail-warnings">
              <div class="details-title">{{ t('wv.explain.warnings') }}</div>
              <span
                v-for="warning in selectedNode.warnings"
                :key="warning"
                class="chip"
                :class="warningClass(warning)"
              >{{ t(warningLabel(warning)) }}</span>
            </div>
          </template>
          <div v-else class="muted">{{ t('wv.explain.noSelection') }}</div>
        </div>
      </div>

      <div v-else-if="current.fallback" class="fallback">
        <div class="fallback-title">{{ t('wv.explain.fallback') }}</div>
        <div class="muted">{{ t('wv.explain.fallbackReason', { reason: current.fallback.reason }) }}</div>
        <pre>{{ current.fallback.text || rawText }}</pre>
      </div>

      <div v-if="currentPlan" class="raw">
        <label class="raw-toggle">
          <input v-model="showRaw" type="checkbox" />
          {{ t('wv.explain.rawPlan') }}
        </label>
        <pre v-if="showRaw">{{ rawText }}</pre>
      </div>
    </template>

    <div v-else-if="!running && !error" class="empty">{{ t('wv.explain.empty') }}</div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.title { font-weight: 600; font-size: 13px; }
.running, .copied, .muted { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
.spacer { flex: 1; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
.btn:disabled { opacity: .5; cursor: default; }
.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.tab { padding: 4px 10px; font-size: 12px; border: none; background: none; color: var(--vscode-descriptionForeground, #888); border-bottom: 2px solid transparent; cursor: pointer; }
.tab.active { color: var(--vscode-textLink-foreground, #4daafc); border-bottom-color: var(--vscode-focusBorder, #007fd4); }
.warnings { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
.chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.chip.warn-fullTableScan { background: var(--vscode-errorForeground, #f48771); }
.dot.warn-fullTableScan { color: var(--vscode-errorForeground, #f48771); }
.chip.warn-filesort { background: var(--vscode-editorWarning-foreground, #cca700); }
.dot.warn-filesort { color: var(--vscode-editorWarning-foreground, #cca700); }
.chip.warn-temporaryTable { background: var(--vscode-editorWarning-foreground, #cca700); }
.dot.warn-temporaryTable { color: var(--vscode-editorWarning-foreground, #cca700); }
.chip.warn-highCost { background: var(--vscode-errorForeground, #f48771); }
.dot.warn-highCost { color: var(--vscode-errorForeground, #f48771); }
.chip.warn-nestedLoop { background: var(--vscode-charts-blue, #3794ff); }
.dot.warn-nestedLoop { color: var(--vscode-charts-blue, #3794ff); }
.chip.warn-missingIndex { background: var(--vscode-charts-orange, #d18616); }
.dot.warn-missingIndex { color: var(--vscode-charts-orange, #d18616); }
.plan { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(280px, 380px); flex: 1; min-height: 0; }
.tree { overflow: auto; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); padding: 6px 0; }
.row { display: flex; align-items: center; gap: 2px; }
.twisty { width: 18px; height: 20px; border: none; background: none; color: var(--vscode-foreground, #ccc); cursor: pointer; padding: 0; }
.twisty.hidden { visibility: hidden; }
.node { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; text-align: left; border: none; background: none; color: inherit; padding: 2px 4px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.node:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06)); }
.node.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }
.op { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground, #888); font-size: 11px; white-space: nowrap; }
.dot { font-size: 9px; line-height: 1; border-radius: 50%; }
.details { overflow: auto; padding: 10px 12px; }
.details-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; }
dl { display: grid; grid-template-columns: 100px 1fr; gap: 4px 8px; margin: 0; font-size: 12px; }
dt { color: var(--vscode-descriptionForeground, #888); }
dd { margin: 0; word-break: break-word; }
dd.code { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; }
.detail-warnings { margin-top: 12px; }
.raw { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); padding: 6px 10px; overflow: auto; max-height: 30vh; }
.raw-toggle { font-size: 12px; color: var(--vscode-descriptionForeground, #888); }
pre { margin: 6px 0; padding: 8px; overflow: auto; background: var(--vscode-textCodeBlock-background, #1e1e1e); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; }
.error { padding: 8px 10px; color: var(--vscode-errorForeground, #f48771); white-space: pre-wrap; }
.fallback { padding: 10px; overflow: auto; }
.fallback-title { font-weight: 600; margin-bottom: 4px; }
.empty { padding: 16px; color: var(--vscode-descriptionForeground, #888); }
</style>