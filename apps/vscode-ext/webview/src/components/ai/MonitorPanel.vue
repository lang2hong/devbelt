<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useVsCode } from '../../composables/useVsCode';
import LineChart from './charts/LineChart.vue';
import BarChart from './charts/BarChart.vue';
import type { MonitorDetail, MonitorTaskView } from '../../../../src/monitor/monitorBridge';
import MonitorConditionEditor from './MonitorConditionEditor.vue';
import {
  historySeries, formatMonitorTime, formatIntervalText, proposalFailureText,
  INTERVAL_CHOICES, isConditionComplete, type ConditionInput,
} from '../../utils/monitorView';

/**
 * 「后台任务」抽屉内容：任务列表 → 详情（A 类折线图 + 表格；B 类新增行表格 + 每次新增柱状图）。
 * 所有操作都发给扩展执行；这里不直接访问数据库。
 */
const props = defineProps<{
  tasks: MonitorTaskView[];
  executing: boolean;
  focusId?: string | null;
  details: Record<string, MonitorDetail | null>;
  editResult?: { id: string; ok: boolean; reason?: string } | null;
}>();
const emit = defineEmits<{ explain: [id: string, includeRows: boolean] }>();
const { t, isZh } = useI18n();
const { post } = useVsCode();

const selectedId = ref<string | null>(props.focusId ?? null);
const includeRows = ref(false);
const editing = ref(false);
const editInterval = ref(5);
const editCondition = ref<ConditionInput | undefined>(undefined);
const editError = ref('');
const editReady = computed(() => editing.value && isConditionComplete(editCondition.value));
watch(() => props.focusId, (id) => { if (id) open(id); });

const selected = computed(() => props.tasks.find((task) => task.id === selectedId.value) ?? null);
const detail = computed(() => (selectedId.value ? props.details[selectedId.value] ?? null : null));
const pausedCount = computed(() => props.tasks.filter((task) => task.status === 'paused').length);
const series = computed(() => (detail.value ? historySeries(detail.value) : null));
const latestRows = computed(() => detail.value?.rows ?? null);
const rowColumns = computed(() => (latestRows.value?.rows[0] ? Object.keys(latestRows.value.rows[0]) : []));

function open(id: string): void {
  selectedId.value = id;
  includeRows.value = false;
  editing.value = false;
  post({ type: 'monitorDetail', id });
}

function startEdit(task: MonitorTaskView): void {
  editing.value = true;
  editError.value = '';
  editInterval.value = Math.round(task.intervalMs / 60_000);
  editCondition.value = task.condition ? { ...task.condition } : undefined;
}

function cancelEdit(): void {
  editing.value = false;
  editError.value = '';
}

function saveEdit(): void {
  if (!selected.value || !editCondition.value) return;
  editError.value = '';
  const condition = editCondition.value;
  post({
    type: 'monitorEdit',
    id: selected.value.id,
    intervalMinutes: editInterval.value,
    condition: { type: condition.type, ...(condition.value !== undefined ? { value: condition.value } : {}) },
  });
}

watch(() => props.editResult, (result) => {
  if (!result || result.id !== selectedId.value) return;
  if (result.ok) { editing.value = false; return; }
  editError.value = t('monitor.edit.failed', { reason: proposalFailureText(t, result.reason, []) });
});

function intervalLabel(minutes: number): string {
  return minutes < 60 ? t('monitor.ui.minutes', { n: minutes }) : t('monitor.ui.hours', { n: Math.round((minutes / 60) * 10) / 10 });
}

function act(id: string, action: 'resume' | 'pause' | 'runNow' | 'remove'): void {
  post({ type: 'monitorAction', id, action });
  if (action === 'remove' && selectedId.value === id) selectedId.value = null;
}

function statusText(task: MonitorTaskView): string {
  if (task.status === 'running') return t('monitor.ui.status.running');
  if (task.status === 'error') return t('monitor.ui.status.error');
  return task.pausedReason ? t(`monitor.list.paused.${task.pausedReason}`) : t('monitor.ui.status.paused');
}

function kindText(task: MonitorTaskView): string {
  return t(`monitor.ui.kind.${task.kind}`);
}

function lastText(task: MonitorTaskView): string {
  if (!task.lastRunAt) return t('monitor.ui.neverRun');
  const time = formatMonitorTime(task.lastRunAt);
  if (task.lastError) return t('monitor.list.lastError', { time, error: task.lastError });
  if (task.kind === 'newRows') return t('monitor.ui.lastNewRows', { time, n: task.lastValue ?? 0 });
  if (task.kind === 'metric') return t('monitor.ui.lastMetric', { time, column: task.watchColumn ?? '', value: task.lastValue?.toLocaleString() ?? '—' });
  return t('monitor.list.lastValue', { time, value: task.lastValue?.toLocaleString() ?? '—' });
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
</script>

<template>
  <div class="mon">
    <p v-if="!props.executing && props.tasks.length" class="mon-note">{{ t('monitor.list.titleOtherWindow') }}</p>

    <!-- 列表 -->
    <template v-if="!selected">
      <div class="mon-actions">
        <button v-if="pausedCount" class="ai-btn ai-btn-primary" @click="post({ type: 'monitorResumeAll' })">
          {{ t('monitor.list.resumeAll', { n: pausedCount }) }}
        </button>
      </div>
      <p v-if="props.tasks.length === 0" class="mon-note">{{ t('monitor.list.empty') }}</p>
      <ul class="mon-list">
        <li v-for="task in props.tasks" :key="task.id">
          <button class="mon-item" @click="open(task.id)">
            <span class="mon-dot" :class="task.status" aria-hidden="true"></span>
            <span class="mon-main">
              <span class="mon-title">{{ task.label }}</span>
              <span class="mon-sub">{{ kindText(task) }} · {{ formatIntervalText(task.intervalMs, isZh) }} · {{ task.connName }}</span>
              <span class="mon-sub" :class="{ err: task.lastError }">{{ lastText(task) }}</span>
            </span>
            <span class="mon-status">{{ statusText(task) }}</span>
          </button>
        </li>
      </ul>
    </template>

    <!-- 详情 -->
    <template v-else>
      <button class="ai-btn mon-back" @click="selectedId = null">← {{ t('monitor.ui.back') }}</button>
      <h3 class="mon-h">{{ selected.label }}</h3>
      <dl class="mon-meta">
        <dt>{{ t('monitor.ui.kind') }}</dt><dd>{{ kindText(selected) }}</dd>
        <dt>{{ t('monitor.ui.target') }}</dt><dd>{{ selected.connName }}{{ selected.database ? ` / ${selected.database}` : '' }} · {{ selected.table }}</dd>
        <dt>{{ t('monitor.ui.interval') }}</dt>
        <dd v-if="!editing">{{ formatIntervalText(selected.intervalMs, isZh) }}</dd>
        <dd v-else>
          <select v-model.number="editInterval" class="mon-select">
            <option v-for="m in INTERVAL_CHOICES" :key="m" :value="m">{{ intervalLabel(m) }}</option>
          </select>
        </dd>
        <dt>{{ t('monitor.ui.condition') }}</dt>
        <dd v-if="!editing">{{ selected.conditionText || '—' }}</dd>
        <dd v-else>
          <MonitorConditionEditor v-model="editCondition" :kind="selected.kind" />
        </dd>
        <template v-if="selected.cursorColumn"><dt>{{ t('monitor.ui.cursor') }}</dt><dd><code>{{ selected.cursorColumn }}</code></dd></template>
        <dt>{{ t('monitor.ui.status') }}</dt><dd>{{ statusText(selected) }}</dd>
        <dt>{{ t('monitor.ui.last') }}</dt><dd :class="{ err: selected.lastError }">{{ lastText(selected) }}</dd>
      </dl>
      <pre v-if="selected.sql" class="mon-sql">{{ selected.sql }}</pre>

      <div class="mon-actions">
        <button v-if="selected.status === 'paused'" class="ai-btn ai-btn-primary" @click="act(selected.id, 'resume')">{{ t('monitor.action.resume') }}</button>
        <button v-else class="ai-btn" @click="act(selected.id, 'pause')">{{ t('monitor.action.pause') }}</button>
        <button class="ai-btn" :disabled="!props.executing" @click="act(selected.id, 'runNow')">{{ t('monitor.action.runNow') }}</button>
        <button class="ai-btn" :disabled="!props.executing" @click="startEdit(selected)">{{ t('monitor.action.edit') }}</button>
        <button class="ai-btn" @click="emit('explain', selected.id, includeRows)">{{ t('monitor.ui.explain') }}</button>
        <button class="ai-btn mon-danger" @click="act(selected.id, 'remove')">{{ t('monitor.action.remove') }}</button>
      </div>
      <div v-if="editing" class="mon-actions">
        <button class="ai-btn ai-btn-primary" :disabled="!editReady" @click="saveEdit">{{ t('monitor.action.save') }}</button>
        <button class="ai-btn" @click="cancelEdit">{{ t('monitor.action.cancel') }}</button>
        <span v-if="!editReady" class="mon-note">{{ t('monitor.proposal.conditionMissing') }}</span>
      </div>
      <p v-if="editing && editError" class="err" role="alert">{{ editError }}</p>
      <label v-if="selected.kind === 'newRows'" class="mon-check">
        <input v-model="includeRows" type="checkbox" />
        {{ t('monitor.ui.explainIncludeRows') }}
      </label>

      <p v-if="!detail" class="mon-note">{{ t('monitor.ui.loading') }}</p>
      <template v-else>
        <template v-if="series && series.x.length > 1">
          <LineChart v-if="selected.kind !== 'newRows'" :x-label="t('monitor.ui.time')" :x-values="series.x" :series="series.series" />
          <BarChart v-else :x-label="t('monitor.ui.time')" :x-values="series.x" :series="series.series" />
        </template>
        <p v-else class="mon-note">{{ t('monitor.ui.notEnoughPoints') }}</p>

        <template v-if="selected.kind === 'newRows'">
          <h4 class="mon-h4">{{ t('monitor.ui.latestRows') }}</h4>
          <p v-if="!latestRows" class="mon-note">{{ t('monitor.ui.noRowsYet') }}</p>
          <template v-else>
            <p class="mon-note">{{ t('monitor.ui.rowsAt', { time: formatMonitorTime(latestRows.at), n: latestRows.rows.length }) }}<span v-if="latestRows.more"> · {{ t('monitor.ui.rowsMore') }}</span></p>
            <div class="mon-table-wrap">
              <table class="mon-table">
                <thead><tr><th v-for="col in rowColumns" :key="col">{{ col }}</th></tr></thead>
                <tbody>
                  <tr v-for="(row, i) in latestRows.rows" :key="i">
                    <td v-for="col in rowColumns" :key="col">{{ cell(row[col]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </template>

        <h4 class="mon-h4">{{ t('monitor.ui.history') }}</h4>
        <div class="mon-table-wrap">
          <table class="mon-table">
            <thead>
              <tr>
                <th>{{ t('monitor.ui.time') }}</th>
                <th v-for="col in series?.columns ?? []" :key="col" class="num">{{ col }}</th>
                <th class="num">{{ t('monitor.ui.duration') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in series?.rows ?? []" :key="i" :class="{ err: row.error }">
                <td>{{ row.time }}</td>
                <template v-if="row.error"><td :colspan="series?.columns.length ?? 1" class="err">{{ row.error }}</td></template>
                <template v-else><td v-for="col in series?.columns ?? []" :key="col" class="num">{{ row.cells[col] ?? '—' }}</td></template>
                <td class="num">{{ row.duration }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.mon { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.mon-note { margin: 0; color: var(--vscode-descriptionForeground); }
.mon-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mon-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mon-item { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mon-item:hover, .mon-item:focus-visible { background: var(--vscode-list-hoverBackground); outline: none; }
.mon-dot { width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-descriptionForeground); }
.mon-dot.running { background: var(--vscode-testing-iconPassed, #3fb950); }
.mon-dot.error { background: var(--vscode-editorWarning-foreground, #cca700); }
.mon-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.mon-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-sub { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-status { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.err { color: var(--vscode-errorForeground, #f85149); }
.mon-back { align-self: flex-start; }
.mon-select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 3px;
  padding: 2px 6px;
}
.mon-h { margin: 4px 0 0; font-size: 13px; }
.mon-h4 { margin: 8px 0 0; font-size: 12px; }
.mon-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; }
.mon-meta dt { color: var(--vscode-descriptionForeground); }
.mon-meta dd { margin: 0; word-break: break-word; }
.mon-sql { margin: 0; padding: 6px 8px; max-height: 160px; overflow: auto; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; }
.mon-check { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
.mon-danger { color: var(--vscode-errorForeground, #f85149); }
.mon-table-wrap { overflow: auto; max-height: 280px; }
.mon-table { border-collapse: collapse; width: 100%; }
.mon-table th, .mon-table td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; white-space: nowrap; }
.mon-table th { position: sticky; top: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground); font-weight: 600; }
.mon-table .num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
