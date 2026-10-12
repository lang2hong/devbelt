<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';

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
  partial?: boolean;
  note?: 'no-connection' | 'no-session' | 'schema-failed' | 'no-database' | 'db-unreachable';
}

export interface QuotaState {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  resetAt: string;
}

const props = defineProps<{
  provider: ProviderState | null;
  context: ContextState | null;
  quota: QuotaState | null;
  connections: { id: string; name: string }[];
  selectedConnId?: string;
  includeColumnComments: boolean;
}>();
const emit = defineEmits<{
  selectConnection: [id: string | null];
  selectScope: [value: string];
  openSettings: [];
  setApiKey: [];
  clearApiKey: [];
  testConnection: [];
  requestContextDetail: [];
}>();

const { t } = useI18n();

const providerLabel = computed(() =>
  props.provider?.mode === 'openai-compatible' ? t('wv.ai.provider.byok') : t('wv.ai.provider.serverProxy'),
);

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

function onSelectScope(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value) emit('selectScope', value);
}

const quotaLabel = computed(() => {
  const quota = props.quota;
  if (!quota) return t('wv.ai.quota.none');
  return t('wv.ai.quota.value', { used: quota.used, limit: quota.limit, remaining: quota.remaining });
});

function onSelect(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('selectConnection', value || null);
}
</script>

<template>
  <div class="ai-context-bar">
    <div class="ai-context-row">
      <span class="ai-badge">{{ providerLabel }}</span>
      <span v-if="provider?.model" class="ai-model">{{ provider.model }}</span>
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
      <button class="ai-context-summary ai-context-link" :title="t('wv.ai.context.detail')" @click="emit('requestContextDetail')">
        {{ contextLabel }}
      </button>
    </div>
    <div class="ai-context-row">
      <span class="ai-context-summary">{{ quotaLabel }}</span>
      <span class="ai-spacer"></span>
      <button class="ai-btn" @click="emit('testConnection')">{{ t('wv.ai.testConnection') }}</button>
      <button class="ai-btn" @click="emit('setApiKey')">{{ t('wv.ai.setApiKey') }}</button>
      <button class="ai-btn" @click="emit('clearApiKey')">{{ t('wv.ai.clearApiKey') }}</button>
      <button class="ai-btn" @click="emit('openSettings')">{{ t('wv.ai.settings') }}</button>
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
  font-size: 12px;
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
  font-size: 11px;
}
.ai-model,
.ai-context-summary {
  color: var(--vscode-descriptionForeground);
}
.ai-context-link {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  text-decoration: underline dotted;
}
.ai-hint {
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.ai-conn-select {
  background: var(--vscode-dropdown-background, var(--vscode-input-background));
  color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  font-size: 12px;
  max-width: 220px;
}
.ai-spacer {
  flex: 1;
}
</style>