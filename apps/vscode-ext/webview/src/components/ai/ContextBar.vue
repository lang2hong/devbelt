<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { formatCreditTokens } from '../../utils/credits';

export interface ProviderState {
  mode: 'server-proxy' | 'openai-compatible';
  model: string;
  baseUrl: string;
  available: boolean;
  reason?: 'login-required' | 'api-key-missing' | 'not-configured';
}

export interface ContextState {
  connId?: string;
  connName?: string;
  dbType?: string;
  database?: string;
  schema?: string;
  tableCount: number;
  totalTables: number;
  commentCount: number;
  estimatedTokens: number;
  truncated?: boolean;
  scopeKind?: 'database' | 'redis-db' | 'index';
  scope?: string;
  scopeOptions?: string[];
  selectedTables?: string[];
  partial?: boolean;
  note?: 'no-connection' | 'no-session' | 'schema-failed' | 'no-database' | 'db-unreachable';
}

export interface QuotaState {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  /** 月段剩余（P9.1 双段；缺失回退 remaining）。 */
  monthlyRemaining: number;
  /** 加油包可用余额（P9.1；缺失为 0）。 */
  topupRemaining: number;
  resetAt: string;
}

const props = defineProps<{
  provider: ProviderState | null;
  context: ContextState | null;
  quota: QuotaState | null;
  quotaRefreshing?: boolean;
  quotaFeedback?: 'ok' | 'failed' | null;
  connections: { id: string; name: string }[];
  selectedConnId?: string;
  includeColumnComments: boolean;
}>();
const emit = defineEmits<{
  selectConnection: [id: string | null];
  openConnection: [];
  selectScope: [value: string];
  openConsole: [path: string];
  openSettings: [];
  /** 模型接入弹层（替代原 设置/清除 Key/测试 三个散按钮；Key 管理并入弹层）。 */
  openModelAccess: [];
  requestContextDetail: [];
  /** 手动刷新积分（宿主 requestQuotaRefresh）。 */
  refreshQuota: [];
}>();

const { t } = useI18n();

const providerLabel = computed(() =>
  props.provider?.mode === 'openai-compatible' ? t('wv.ai.provider.byok') : t('wv.ai.provider.serverProxy'),
);

/** BYOK 直连上游，不消耗服务端积分；积分区整体隐藏，避免误导。 */
const showQuota = computed(() => props.provider?.mode !== 'openai-compatible');

const providerHint = computed(() => {
  const reason = props.provider?.reason;
  if (!reason) return '';
  if (reason === 'login-required') return t('wv.ai.provider.loginRequired');
  if (reason === 'api-key-missing') return t('wv.ai.provider.apiKeyMissing');
  return t('wv.ai.provider.notConfigured');
});

const contextLabel = computed(() => {
  const ctx = props.context;
  if (!ctx || ctx.note === 'no-connection') return t('wv.ai.context.noConnection');
  if (ctx.note === 'no-session') return t('wv.ai.context.noSession');
  if (ctx.note === 'schema-failed') return t('wv.ai.context.schemaFailed');
  if (ctx.note === 'no-database') return t('wv.ai.context.noDatabase');
  if (ctx.note === 'db-unreachable') return t('wv.ai.context.dbUnreachable');
  if (ctx.scopeKind === 'redis-db') {
    return t('wv.ai.context.redisSummary', { db: ctx.scope ?? '?', tokens: ctx.estimatedTokens });
  }
  if (ctx.scopeKind === 'index') {
    return t('wv.ai.context.indexSummary', { index: ctx.scope ?? '?', tokens: ctx.estimatedTokens });
  }
  const summary = t('wv.ai.context.summary', {
    tables: ctx.totalTables > ctx.tableCount ? `${ctx.tableCount}/${ctx.totalTables}` : ctx.tableCount,
    comments: ctx.commentCount,
    tokens: ctx.estimatedTokens,
  });
  const parts = [summary];
  if (ctx.truncated) parts.push(t('wv.ai.context.truncated'));
  if (ctx.partial) parts.push(t('wv.ai.context.partial'));
  return parts.join(' · ');
});

const scopeOptions = computed(() => props.context?.scopeOptions ?? []);
const showScopeSelect = computed(() => !!props.context?.scopeKind && scopeOptions.value.length > 0);

/** 「连接未打开」时点击摘要按钮 = 重试打开连接（抽屉无会话时毫无内容，只会困住用户）。 */
const connectionNotOpen = computed(() => props.context?.note === 'no-session');

function onSummaryClick(): void {
  if (connectionNotOpen.value) emit('openConnection');
  else emit('requestContextDetail');
}


function onSelectScope(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) emit('selectScope', value);
}

const deltaLabel = ref<string | null>(null);
let deltaTimer: number | undefined;
watch(
  () => props.quota,
  (next, prev) => {
    if (!next || !prev) return;
    const saved = prev.remaining - next.remaining;
    if (saved <= 0) return;
    deltaLabel.value = t('wv.ai.quota.delta', { credits: formatCreditTokens(saved) });
    if (deltaTimer) window.clearTimeout(deltaTimer);
    deltaTimer = window.setTimeout(() => { deltaLabel.value = null; }, 2400);
  },
);
onBeforeUnmount(() => { if (deltaTimer) window.clearTimeout(deltaTimer); });

const quotaLabel = computed(() => {
  const quota = props.quota;
  if (!quota) return t('wv.ai.quota.none');
  if (quota.topupRemaining > 0) {
    return t('wv.ai.quota.dual', {
      used: formatCreditTokens(quota.used),
      limit: formatCreditTokens(quota.limit),
      monthly: formatCreditTokens(quota.monthlyRemaining ?? quota.remaining),
      topup: formatCreditTokens(quota.topupRemaining),
    });
  }
  return t('wv.ai.quota.value', { used: formatCreditTokens(quota.used), limit: formatCreditTokens(quota.limit), remaining: formatCreditTokens(quota.remaining) });
});

const usedPct = computed(() => {
  const q = props.quota;
  if (!q) return 0;
  const total = q.used + q.remaining;
  return total > 0 ? Math.min(100, Math.max(0, (q.used / total) * 100)) : 0;
});
const quotaLow = computed(() => !!props.quota && props.quota.remaining <= 0);

function onSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectConnection', value || null);
}
</script>

<template>
  <div class="ai-context-bar">
    <div class="ai-context-row">
      <span class="ai-badge">{{ providerLabel }}</span>
      <button v-if="provider?.model" class="ai-model ai-model-btn" :title="t('wv.ai.modelAccess')" @click="emit('openModelAccess')">{{ provider.model }}</button>
      <span v-if="providerHint" class="ai-hint">{{ providerHint }}</span>
    </div>
    <div class="ai-context-row">
      <select class="ai-conn-select" :value="props.selectedConnId ?? ''" @change="onSelect">
        <option value="">{{ t('wv.ai.connect') }}</option>
        <option v-for="conn in props.connections" :key="conn.id" :value="conn.id">{{ conn.name }}</option>
      </select>
      <select
        v-if="showScopeSelect"
        class="ai-conn-select"
        :title="t('wv.ai.scope.title')"
        :value="props.context?.scope ?? ''"
        @change="onSelectScope"
      >
        <option v-for="option in scopeOptions" :key="option" :value="option">{{ option }}</option>
      </select>
      <button
        class="ai-context-summary ai-context-link"
        :title="connectionNotOpen ? t('wv.ai.context.openHint') : t('wv.ai.context.detail')"
        @click="onSummaryClick"
      >
        {{ contextLabel }}
      </button>
    </div>
    <div class="ai-context-row">
      <template v-if="showQuota">
        <span class="ai-context-summary" :class="{ 'ai-quota-low': quotaLow }">{{ quotaLabel }}</span>
        <span v-if="deltaLabel" class="ai-quota-delta" role="status" aria-live="polite">{{ deltaLabel }}</span>
        <span v-if="quotaFeedback" class="ai-quota-notice" :class="quotaFeedback" role="status" aria-live="polite">
          {{ quotaFeedback === 'ok' ? t('wv.ai.quota.refreshOk') : t('wv.ai.quota.refreshFailed') }}
        </span>
        <button class="ai-btn ai-quota-refresh" :disabled="quotaRefreshing" :title="quotaRefreshing ? t('wv.ai.quota.refreshing') : t('wv.ai.quota.refresh')" @click="emit('refreshQuota')">
          {{ quotaRefreshing ? '…' : '↻' }}
        </button>
        <button
          v-if="quota"
          class="ai-btn ai-quota-buy"
          :title="t('wv.ai.quota.buy.title')"
          @click="emit('openConsole', '/db/ai-topup')"
        >{{ t('wv.ai.quota.buy') }}</button>
      </template>
      <span v-else class="ai-context-summary ai-byok-note">{{ t('wv.ai.quota.byok') }}</span>
      <span class="ai-spacer"></span>
      <button class="ai-btn" @click="emit('openModelAccess')">{{ t('wv.ai.modelAccess') }}</button>
      <button class="ai-btn" @click="emit('openSettings')">{{ t('wv.ai.settings') }}</button>
    </div>
    <div v-if="showQuota && quota" class="ai-quota-bar" :class="{ low: quotaLow }" :title="t('wv.ai.quota.barTitle')">
      <span :style="{ width: `${usedPct}%` }"></span>
    </div>
  </div>
</template>

<style scoped>
.ai-context-bar {
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
.ai-context-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ai-badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  padding: 0 5px;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
}
.ai-model,
.ai-context-summary {
  color: var(--vscode-descriptionForeground);
}
.ai-model-btn {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  text-decoration: underline dotted;
}
.ai-model-btn:hover { color: var(--vscode-foreground); }
.ai-context-link {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
  font-family: inherit;
  text-decoration: underline dotted;
}
.ai-hint {
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.ai-quota-notice { font-size: calc(var(--vscode-font-size, 13px) - 2px); }
.ai-quota-notice.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.ai-quota-notice.failed { color: var(--vscode-errorForeground, #f85149); }
.ai-byok-note { opacity: .75; }
.ai-quota-refresh:disabled { opacity: .5; cursor: default; }
.ai-conn-select {
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  font-size: var(--vscode-font-size, 13px);
  padding: 4px 8px;
  min-height: 26px;
  max-width: 240px;
}
.ai-spacer {
  flex: 1;
}
</style>