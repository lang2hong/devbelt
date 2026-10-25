<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { MonitorProposalView } from '../../../../src/monitor/monitorBridge';

/**
 * Agent 提出的监控提案：只有用户点「创建并开始」才会创建任务（扩展端会再校验一次）。
 * 用户只能改间隔；SQL / 列 / 条件来自校验过的提案，界面不允许编辑。
 */
export interface ProposalState {
  proposal: MonitorProposalView;
  status: 'pending' | 'creating' | 'created' | 'discarded' | 'failed';
  error?: string;
}

const props = defineProps<{ state: ProposalState }>();
const emit = defineEmits<{ confirm: [proposalId: string, intervalMinutes: number]; discard: [proposalId: string]; openTasks: [] }>();
const { t } = useI18n();

const INTERVALS = [1, 5, 15, 30, 60, 360, 1440];
const interval = ref(props.state.proposal.intervalMinutes);
const p = computed(() => props.state.proposal);
const intervalOptions = computed(() => [...new Set([...INTERVALS, p.value.intervalMinutes])].sort((a, b) => a - b));

function intervalLabel(minutes: number): string {
  return minutes < 60 ? t('monitor.ui.minutes', { n: minutes }) : t('monitor.ui.hours', { n: Math.round((minutes / 60) * 10) / 10 });
}
</script>

<template>
  <div class="mp" role="group" :aria-label="t('monitor.proposal.title')">
    <div class="mp-head">
      <span class="mp-badge">{{ t('monitor.proposal.title') }}</span>
      <span class="mp-label">{{ p.label }}</span>
    </div>
    <dl class="mp-meta">
      <dt>{{ t('monitor.ui.kind') }}</dt><dd>{{ t(`monitor.ui.kind.${p.kind}`) }}</dd>
      <dt>{{ t('monitor.ui.target') }}</dt><dd>{{ p.connName }}{{ p.database ? ` / ${p.database}` : '' }} · {{ p.table }}</dd>
      <template v-if="p.cursorColumn"><dt>{{ t('monitor.ui.cursor') }}</dt><dd><code>{{ p.cursorColumn }}</code></dd></template>
      <dt>{{ t('monitor.ui.condition') }}</dt><dd>{{ p.conditionText }}</dd>
      <template v-if="p.preview">
        <dt>{{ t('monitor.proposal.current') }}</dt>
        <dd>
          <span v-for="(value, key) in p.preview" :key="key" class="mp-kv" :class="{ watch: key === p.watchColumn }">
            {{ key }} = {{ value === null ? 'NULL' : value.toLocaleString() }}
          </span>
        </dd>
      </template>
    </dl>
    <pre v-if="p.sql" class="mp-sql">{{ p.sql }}</pre>
    <ul v-if="p.warnings.length" class="mp-warn">
      <li v-for="w in p.warnings" :key="w">{{ t(`monitor.warning.${w}`) }}</li>
    </ul>

    <div v-if="props.state.status === 'pending' || props.state.status === 'failed'" class="mp-actions">
      <label class="mp-interval">
        {{ t('monitor.ui.interval') }}
        <select v-model.number="interval">
          <option v-for="m in intervalOptions" :key="m" :value="m">{{ intervalLabel(m) }}</option>
        </select>
      </label>
      <span class="ai-spacer"></span>
      <button class="ai-btn" @click="emit('discard', p.id)">{{ t('monitor.proposal.discard') }}</button>
      <button class="ai-btn ai-btn-primary" @click="emit('confirm', p.id, interval)">{{ t('monitor.proposal.create') }}</button>
    </div>
    <p v-if="props.state.status === 'failed'" class="mp-error" role="alert">{{ props.state.error }}</p>
    <p v-else-if="props.state.status === 'creating'" class="mp-note" role="status">{{ t('monitor.proposal.creating') }}</p>
    <p v-else-if="props.state.status === 'created'" class="mp-ok" role="status">
      {{ t('monitor.proposal.created') }}
      <button class="ai-btn" @click="emit('openTasks')">{{ t('monitor.list.title') }}</button>
    </p>
    <p v-else-if="props.state.status === 'discarded'" class="mp-note">{{ t('monitor.proposal.discarded') }}</p>
  </div>
</template>

<style scoped>
.mp { margin: 8px 0; padding: 10px 12px; border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border)); border-radius: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.mp-head { display: flex; align-items: center; gap: 8px; }
.mp-badge { padding: 0 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
.mp-label { font-weight: 600; }
.mp-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; }
.mp-meta dt { color: var(--vscode-descriptionForeground); }
.mp-meta dd { margin: 0; word-break: break-word; }
.mp-kv { display: inline-block; margin-right: 10px; font-variant-numeric: tabular-nums; }
.mp-kv.watch { font-weight: 600; }
.mp-sql { margin: 0; padding: 6px 8px; max-height: 160px; overflow: auto; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; }
.mp-warn { margin: 0; padding-left: 18px; color: var(--vscode-editorWarning-foreground, #cca700); }
.mp-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mp-interval { display: flex; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); }
.mp-interval select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 2px 6px; }
.mp-note { margin: 0; color: var(--vscode-descriptionForeground); }
.mp-ok { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--vscode-testing-iconPassed, #3fb950); }
.mp-error { margin: 0; color: var(--vscode-errorForeground, #f85149); }
</style>
