<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { MonitorProposalView } from '../../../../src/monitor/monitorBridge';

/**
 * Agent 提出的监控提案：只有用户点「创建并开始」才会创建任务（扩展端会再校验一次）。
 * 用户只能改间隔；SQL / 列 / 条件来自校验过的提案，界面不允许编辑。
 * 放弃的卡片由父组件直接移除；创建成功后收成一行。
 */
export interface ProposalState {
  proposal: MonitorProposalView;
  status: 'pending' | 'creating' | 'created' | 'failed';
  error?: string;
}

const props = defineProps<{ state: ProposalState }>();
const emit = defineEmits<{ confirm: [proposalId: string, intervalMinutes: number]; discard: [proposalId: string]; openTasks: [] }>();
const { t } = useI18n();

const INTERVALS = [1, 5, 15, 30, 60, 360, 1440];
const interval = ref(props.state.proposal.intervalMinutes);
const p = computed(() => props.state.proposal);
const intervalOptions = computed(() => [...new Set([...INTERVALS, p.value.intervalMinutes])].sort((a, b) => a - b));
const busy = computed(() => props.state.status === 'creating');
const target = computed(() => {
  const scope = [p.value.database, p.value.schema].filter(Boolean).join('.');
  return `${p.value.connName} / ${scope ? `${scope}.` : ''}${p.value.table}`;
});

function intervalLabel(minutes: number): string {
  return minutes < 60 ? t('monitor.ui.minutes', { n: minutes }) : t('monitor.ui.hours', { n: Math.round((minutes / 60) * 10) / 10 });
}

function formatValue(value: number | null): string {
  return value === null ? 'NULL' : value.toLocaleString();
}
</script>

<template>
  <div v-if="props.state.status === 'created'" class="mp mp-done" role="status">
    <span class="mp-check" aria-hidden="true">✓</span>
    <span class="mp-done-text">{{ t('monitor.proposal.createdNamed', { name: p.label }) }}</span>
    <button class="mp-link" @click="emit('openTasks')">{{ t('monitor.list.title') }}</button>
  </div>

  <section v-else class="mp" :aria-label="t('monitor.proposal.title')" :aria-busy="busy">
    <header class="mp-head">
      <svg class="mp-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1 8h3l2-5 4 10 2-5h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="mp-titles">
        <div class="mp-title">{{ p.label }}</div>
        <div class="mp-sub">{{ t(`monitor.ui.kind.${p.kind}`) }} · {{ target }}</div>
      </div>
    </header>

    <dl class="mp-rows">
      <div class="mp-row">
        <dt>{{ t('monitor.ui.condition') }}</dt>
        <dd>{{ p.conditionText }}</dd>
      </div>
      <div v-if="p.cursorColumn" class="mp-row">
        <dt>{{ t('monitor.ui.cursor') }}</dt>
        <dd><code>{{ p.cursorColumn }}</code></dd>
      </div>
      <div v-if="p.preview" class="mp-row">
        <dt>{{ t('monitor.proposal.current') }}</dt>
        <dd class="mp-chips">
          <span v-for="(value, key) in p.preview" :key="key" class="mp-chip" :class="{ watch: key === p.watchColumn }">
            <span class="mp-chip-key">{{ key }}</span>
            <span class="mp-chip-val">{{ formatValue(value) }}</span>
          </span>
        </dd>
      </div>
    </dl>

    <details v-if="p.sql" class="mp-sql">
      <summary>{{ t('monitor.proposal.showSql') }}</summary>
      <pre>{{ p.sql }}</pre>
    </details>

    <ul v-if="p.warnings.length" class="mp-warn">
      <li v-for="w in p.warnings" :key="w.code">{{ t(`monitor.warning.${w.code}`, { detail: w.detail ?? '' }) }}</li>
    </ul>

    <p v-if="props.state.status === 'failed'" class="mp-error" role="alert">{{ props.state.error }}</p>

    <footer class="mp-actions">
      <label class="mp-interval">
        <span>{{ t('monitor.ui.interval') }}</span>
        <select v-model.number="interval" :disabled="busy">
          <option v-for="m in intervalOptions" :key="m" :value="m">{{ intervalLabel(m) }}</option>
        </select>
      </label>
      <span class="mp-spacer"></span>
      <button class="ai-btn" :disabled="busy" @click="emit('discard', p.id)">{{ t('monitor.proposal.discard') }}</button>
      <button class="ai-btn ai-btn-primary" :disabled="busy" @click="emit('confirm', p.id, interval)">
        {{ busy ? t('monitor.proposal.creating') : t('monitor.proposal.create') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.mp {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp-head { display: flex; align-items: flex-start; gap: 8px; }
.mp-icon { flex: 0 0 auto; margin-top: 2px; color: var(--vscode-textLink-foreground, #3794ff); }
.mp-titles { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mp-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-sub { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mp-rows { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.mp-row { display: grid; grid-template-columns: 56px 1fr; gap: 8px; align-items: baseline; }
.mp-row dt { color: var(--vscode-descriptionForeground); }
.mp-row dd { margin: 0; min-width: 0; word-break: break-word; }
.mp-row code { font-family: var(--vscode-editor-font-family, monospace); }

.mp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.mp-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--vscode-badge-background, rgba(128, 128, 128, 0.2));
  color: var(--vscode-badge-foreground, inherit);
  font-variant-numeric: tabular-nums;
}
.mp-chip-key { opacity: 0.8; }
.mp-chip.watch { outline: 1px solid var(--vscode-textLink-foreground, #3794ff); }
.mp-chip.watch .mp-chip-val { font-weight: 600; }

.mp-sql summary {
  cursor: pointer;
  color: var(--vscode-textLink-foreground, #3794ff);
  width: fit-content;
}
.mp-sql summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.mp-sql pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  max-height: 160px;
  overflow: auto;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background);
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
}

.mp-warn {
  margin: 0;
  padding: 6px 8px 6px 22px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.12));
  color: var(--vscode-foreground);
}
.mp-warn li + li { margin-top: 2px; }
.mp-error { margin: 0; color: var(--vscode-errorForeground, #f85149); }

.mp-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 2px; }
.mp-spacer { flex: 1; }
.mp-interval { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
.mp-interval select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 3px;
  padding: 2px 6px;
}

.mp-done {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-left-color: var(--vscode-testing-iconPassed, #3fb950);
}
.mp-check { color: var(--vscode-testing-iconPassed, #3fb950); font-weight: 600; }
.mp-done-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--vscode-textLink-foreground, #3794ff);
  font: inherit;
  cursor: pointer;
}
.mp-link:hover { text-decoration: underline; }
.mp-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>
