<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface RowDiff {
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  pkValues: Record<string, unknown>;
  sourceRow?: Record<string, unknown>;
  targetRow?: Record<string, unknown>;
}

interface TableDataDiff {
  tableName: string;
  pkColumns: string[];
  columnNames: string[];
  rows: RowDiff[];
}

interface SkippedTable {
  tableName: string;
  reason: 'target-missing-pk' | 'no-key-or-columns';
  missingColumns?: string[];
}

interface DiffResult {
  diffs: TableDataDiff[];
  skipped?: SkippedTable[];
  sourceDb: string;
  targetDb: string;
}

const diff = ref<DiffResult | null>(null);
const error = ref('');
const applied = ref(false);
const expandedTables = ref<Set<string>>(new Set());

const summary = computed(() => {
  if (!diff.value) return { added: 0, removed: 0, changed: 0 };
  let added = 0, removed = 0, changed = 0;
  for (const td of diff.value.diffs) {
    for (const r of td.rows) {
      if (r.status === 'added') added++;
      else if (r.status === 'removed') removed++;
      else if (r.status === 'changed') changed++;
    }
  }
  return { added, removed, changed };
});

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'diff') {
      diff.value = msg.diff;
    } else if (msg.type === 'error') {
      error.value = msg.message;
    } else if (msg.type === 'applied') {
      applied.value = true;
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

function toggleTable(table: string) {
  const next = new Set(expandedTables.value);
  if (next.has(table)) next.delete(table);
  else next.add(table);
  expandedTables.value = next;
}

function applySync() {
  post({ type: 'applySync' });
}

function statusClass(status: string) {
  return { added: 'status-added', removed: 'status-removed', changed: 'status-changed' }[status] || '';
}
</script>

<template>
  <div class="data-diff">
    <div class="diff-header">
      <h3>{{ diff?.sourceDb }} → {{ diff?.targetDb }}</h3>
      <div class="diff-summary">
        <span class="status-added">+{{ summary.added }} {{ t('wv.dataDiff.added') }}</span>
        <span class="status-removed">-{{ summary.removed }} {{ t('wv.dataDiff.removed') }}</span>
        <span class="status-changed">~{{ summary.changed }} {{ t('wv.dataDiff.changed') }}</span>
      </div>
      <div class="diff-actions">
        <button class="btn primary" :disabled="applied" @click="applySync">{{ t('wv.dataDiff.applySync') }}</button>
        <span v-if="applied" class="status-added">{{ t('wv.dataDiff.applied') }}</span>
      </div>
    </div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="diff && diff.skipped && diff.skipped.length" class="diff-skipped">
      <div class="skipped-title">{{ t('wv.dataDiff.skippedTitle') }}</div>
      <div v-for="s in diff.skipped" :key="s.tableName" class="skipped-row">
        <span class="table-name">{{ s.tableName }}</span>
        <span class="skipped-reason">
          {{ s.reason === 'target-missing-pk'
            ? t('wv.dataDiff.skippedTargetMissing', { cols: (s.missingColumns || []).join(', ') })
            : t('wv.dataDiff.skippedNoKey') }}
        </span>
      </div>
    </div>
    <div v-if="diff" class="diff-tables">
      <div v-for="td in diff.diffs" :key="td.tableName" class="diff-table">
        <div class="table-header" @click="toggleTable(td.tableName)">
          <span class="expand-icon">{{ expandedTables.has(td.tableName) ? '▼' : '▶' }}</span>
          <span class="table-name">{{ td.tableName }}</span>
          <span class="table-count">{{ td.rows.length }} row(s)</span>
        </div>
        <div v-if="expandedTables.has(td.tableName)" class="table-rows">
          <div v-for="(row, i) in td.rows" :key="i" class="diff-row" :class="statusClass(row.status)">
            <span class="row-status">{{ row.status }}</span>
            <span class="row-pk">{{ JSON.stringify(row.pkValues) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-diff { padding: 12px; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #cccccc); }
.diff-header { margin-bottom: 12px; }
.diff-header h3 { margin: 0 0 8px; font-size: 14px; }
.diff-summary { display: flex; gap: 12px; margin-bottom: 8px; font-size: 13px; }
.diff-actions { display: flex; gap: 8px; align-items: center; }
.btn { padding: 4px 12px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
.btn:disabled { opacity: 0.5; cursor: default; }
.status-added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
.status-removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771); }
.status-changed { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2b74b); }
.error { color: var(--vscode-errorForeground, #f48771); margin-bottom: 8px; }
.diff-tables { display: flex; flex-direction: column; gap: 4px; }
.diff-table { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; }
.table-header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; cursor: pointer; background: var(--vscode-editor-background, #1e1e1e); }
.table-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.expand-icon { font-size: 10px; width: 14px; }
.table-name { font-weight: 600; font-size: 13px; }
.table-count { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); margin-left: auto; }
.table-rows { padding: 4px 0; }
.diff-row { display: flex; gap: 8px; padding: 3px 24px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.08)); }
.row-status { font-weight: 600; min-width: 70px; }
.row-pk { color: var(--vscode-descriptionForeground, #808080); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-skipped { margin-bottom: 8px; padding: 8px 10px; border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500); border-radius: 3px; background: var(--vscode-inputValidation-warningBackground, rgba(184,149,0,0.1)); }
.skipped-title { font-size: 12px; font-weight: 600; color: var(--vscode-editorWarning-foreground, #e2b74b); margin-bottom: 4px; }
.skipped-row { display: flex; gap: 8px; font-size: 12px; }
.skipped-reason { color: var(--vscode-descriptionForeground, #808080); }
</style>