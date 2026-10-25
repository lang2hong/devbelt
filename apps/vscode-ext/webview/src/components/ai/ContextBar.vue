<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { formatCreditTokens, isQuotaLow } from '../../utils/credits';
import MoreMenu, { type MoreMenuItem } from './MoreMenu.vue';

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

/**
 * AI Chat 顶栏（单行）：连接 / 库 / 低额度提示 / 新对话 / 更多。
 *
 * 常规状态只显示这一行；只有出问题（未登录、未配置 Key、连接未打开、库不可达等）时
 * 才在下方出现一条提示和处理按钮。额度明细、会话、表、规则、模型、设置都在「⋯」里。
 */
const props = defineProps<{
  provider: ProviderState | null;
  context: ContextState | null;
  quota: QuotaState | null;
  connections: { id: string; name: string }[];
  selectedConnId?: string;
  menuItems: MoreMenuItem[];
}>();
const emit = defineEmits<{
  selectConnection: [id: string | null];
  openConnection: [];
  selectScope: [value: string];
  newChat: [];
  menu: [id: string];
  openQuota: [];
  openModelAccess: [];
  /** 打开「实际注入的表」抽屉。 */
  openTables: [];
}>();

const { t } = useI18n();

/** 自带 Key 直连上游，不消耗服务端积分：不显示额度。 */
const usesQuota = computed(() => props.provider?.mode !== 'openai-compatible');
const quotaLow = computed(() => usesQuota.value && isQuotaLow(props.quota));
const quotaBadge = computed(() => {
  const q = props.quota;
  if (!q) return '';
  return q.remaining <= 0
    ? t('wv.ai.quota.exhausted')
    : t('wv.ai.quota.low', { remaining: formatCreditTokens(q.remaining) });
});

/**
 * 「实际注入的表」按钮（放在库选择器之后）：只对关系引擎、上下文正常时显示。
 * 被截断（库内表多于实际注入）时标黄，提示手动选表或用 Agent。
 */
const RELATIONAL = new Set(['MYSQL', 'PG', 'SQLITE']);
const showTables = computed(() => {
  const ctx = props.context;
  if (!ctx || ctx.note || !props.selectedConnId) return false;
  return RELATIONAL.has(String(ctx.dbType ?? '').toUpperCase());
});
const tablesTruncated = computed(() => {
  const ctx = props.context;
  return !!ctx && (ctx.truncated === true || ctx.totalTables > ctx.tableCount);
});
const tablesLabel = computed(() => {
  const ctx = props.context;
  if (!ctx) return '';
  return ctx.totalTables > ctx.tableCount
    ? t('wv.ai.tables.badgeOf', { n: ctx.tableCount, total: ctx.totalTables })
    : t('wv.ai.tables.badge', { n: ctx.tableCount });
});
const tablesTitle = computed(() => (tablesTruncated.value ? t('wv.ai.tables.truncatedHint') : t('wv.ai.tables.badgeHint')));

const scopeOptions = computed(() => props.context?.scopeOptions ?? []);
const showScopeSelect = computed(() => !!props.context?.scopeKind && scopeOptions.value.length > 0);

/** 只有需要用户处理时才出现的提示条（文案 + 可选处理按钮）。 */
const alert = computed<{ text: string; action?: { label: string; event: 'openConnection' | 'openModelAccess' } } | null>(() => {
  const reason = props.provider?.reason;
  if (reason === 'login-required') return { text: t('wv.ai.provider.loginRequired') };
  if (reason === 'api-key-missing') return { text: t('wv.ai.provider.apiKeyMissing'), action: { label: t('wv.ai.modelAccess'), event: 'openModelAccess' } };
  if (reason === 'not-configured') return { text: t('wv.ai.provider.notConfigured'), action: { label: t('wv.ai.modelAccess'), event: 'openModelAccess' } };
  const note = props.context?.note;
  if (note === 'no-session') return { text: t('wv.ai.context.noSession'), action: { label: t('wv.ai.context.openHint'), event: 'openConnection' } };
  if (note === 'schema-failed') return { text: t('wv.ai.context.schemaFailed') };
  if (note === 'no-database') return { text: t('wv.ai.context.noDatabase') };
  if (note === 'db-unreachable') return { text: t('wv.ai.context.dbUnreachable') };
  return null;
});

function onSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectConnection', value || null);
}

function onSelectScope(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) emit('selectScope', value);
}

function runAlertAction(): void {
  const event = alert.value?.action?.event;
  if (event === 'openConnection') emit('openConnection');
  else if (event === 'openModelAccess') emit('openModelAccess');
}
</script>

<template>
  <div class="ai-context-bar">
    <div class="ai-context-row">
      <select class="ai-conn-select" :aria-label="t('wv.ai.connect')" :value="props.selectedConnId ?? ''" @change="onSelect">
        <option value="">{{ t('wv.ai.connect') }}</option>
        <option v-for="conn in props.connections" :key="conn.id" :value="conn.id">{{ conn.name }}</option>
      </select>
      <select
        v-if="showScopeSelect"
        class="ai-conn-select"
        :title="t('wv.ai.scope.title')"
        :aria-label="t('wv.ai.scope.title')"
        :value="props.context?.scope ?? ''"
        @change="onSelectScope"
      >
        <option v-for="option in scopeOptions" :key="option" :value="option">{{ option }}</option>
      </select>
      <button
        v-if="showTables"
        class="ai-tables-badge"
        :class="{ truncated: tablesTruncated }"
        :title="tablesTitle"
        :aria-label="tablesTitle"
        @click="emit('openTables')"
      >{{ tablesLabel }}</button>
      <span class="ai-spacer"></span>
      <button v-if="quotaLow" class="ai-quota-low-badge" :title="t('wv.ai.quota.view')" @click="emit('openQuota')">{{ quotaBadge }}</button>
      <button class="ai-btn ai-icon-btn" :title="t('wv.ai.newChat')" :aria-label="t('wv.ai.newChat')" @click="emit('newChat')">＋</button>
      <MoreMenu :items="props.menuItems" @select="emit('menu', $event)" />
    </div>
    <div v-if="alert" class="ai-alert" role="status">
      <span>{{ alert.text }}</span>
      <button v-if="alert.action" class="ai-btn" @click="runAlertAction">{{ alert.action.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.ai-context-bar {
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
.ai-context-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ai-conn-select {
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  font-size: var(--vscode-font-size, 13px);
  padding: 4px 8px;
  min-height: 26px;
  max-width: 200px;
  min-width: 0;
}
.ai-spacer {
  flex: 1;
}
.ai-tables-badge {
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border-radius: 999px;
  padding: 2px 10px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.ai-tables-badge:hover { color: var(--vscode-foreground); }
.ai-tables-badge.truncated {
  border-color: var(--vscode-editorWarning-foreground, #cca700);
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.ai-quota-low-badge {
  border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
  color: var(--vscode-editorWarning-foreground, #cca700);
  background: transparent;
  border-radius: 999px;
  padding: 2px 10px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.ai-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.12));
  border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
}
</style>
