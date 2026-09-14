<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { formatDateTime } from '../utils/formatTime';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface AuditEntry {
  id: string;
  action: string;
  connName: string;
  database?: string;
  sql?: string;
  rowCount?: number;
  costTime?: number;
  timestamp: number;
}

const entries = ref<AuditEntry[]>([]);
const filterAction = ref('');
const selected = ref<AuditEntry | null>(null);

const actionLabels: Record<string, string> = {
  query_execute: 'Query',
  query_explain: 'Explain',
  data_edit: 'Edit',
  data_delete: 'Delete',
  data_insert: 'Insert',
  schema_change: 'Schema',
  connection_open: 'Connect',
  connection_close: 'Disconnect',
  user_manage: 'User',
  import_data: 'Import',
  export_data: 'Export',
};

function formatSql(sql?: string): string {
  if (!sql) return '';
  return sql.length > 200 ? sql.slice(0, 200) + '...' : sql;
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'entries') {
      entries.value = msg.entries;
    }
  });
});

onUnmounted(() => {});
</script>

<template>
  <div class="audit-panel">
    <div class="toolbar">
      <select v-model="filterAction" @change="post({ type: 'filter', action: filterAction })">
        <option value="">{{ t('wv.audit.allActions') }}</option>
        <option v-for="(label, key) in actionLabels" :key="key" :value="key">{{ label }}</option>
      </select>
      <button class="btn" @click="post({ type: 'clear' })">{{ t('wv.common.clear') }}</button>
    </div>
    <div class="entry-list">
      <div
        v-for="e in entries"
        :key="e.id"
        class="entry"
        :class="{ selected: selected?.id === e.id }"
        @click="selected = selected?.id === e.id ? null : e"
      >
        <span class="time">{{ formatDateTime(e.timestamp) }}</span>
        <span class="action" :class="e.action">{{ actionLabels[e.action] || e.action }}</span>
        <span class="conn">{{ e.connName }}{{ e.database ? '/' + e.database : '' }}</span>
        <span class="meta" v-if="e.rowCount !== undefined">{{ e.rowCount }} rows</span>
        <span class="meta" v-if="e.costTime !== undefined">{{ e.costTime }}ms</span>
      </div>
      <div v-if="!entries.length" class="empty">{{ t('wv.audit.noEntries') }}</div>
    </div>
    <div v-if="selected" class="detail">
      <pre>{{ selected.sql || '(no SQL)' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.audit-panel { display: flex; flex-direction: column; height: 100%; padding: 8px; }
.toolbar { display: flex; gap: 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.toolbar select { padding: 2px 6px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.entry-list { flex: 1; overflow-y: auto; margin-top: 8px; }
.entry { display: flex; gap: 8px; padding: 4px 4px; cursor: pointer; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08)); align-items: center; flex-wrap: wrap; }
.entry:hover { background: var(--vscode-list-hoverBackground); }
.entry.selected { background: var(--vscode-list-activeSelectionBackground); }
.time { color: var(--vscode-descriptionForeground); min-width: 140px; }
.action { padding: 1px 6px; border-radius: 3px; font-weight: 500; }
.action.query_execute { background: #4e79a720; color: #4e79a7; }
.action.schema_change { background: #f28e2b20; color: #f28e2b; }
.action.data_edit, .action.data_delete, .action.data_insert { background: #e1575920; color: #e15759; }
.action.connection_open, .action.connection_close { background: #59a14f20; color: #59a14f; }
.action.import_data, .action.export_data { background: #b07aa120; color: #b07aa1; }
.conn { color: var(--vscode-foreground); }
.meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.detail { border-top: 1px solid var(--vscode-panel-border); padding: 8px 0; }
.detail pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 8px; border-radius: 4px; max-height: 200px; overflow-y: auto; }
</style>