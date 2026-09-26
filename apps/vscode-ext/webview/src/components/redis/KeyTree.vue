<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import type { KeyRow, RedisKeyFolder } from './types';

const { t } = useI18n();
const props = defineProps<{
  folders: RedisKeyFolder;
  cursor: string;
  done: boolean;
  scanned: number;
  match: string;
  count: number;
  loading: boolean;
  /** S5-3：树点键打开时高亮的目标键（webview 内尽力而为）。 */
  activeKey?: string;
}>();
const emit = defineEmits<{
  (e: 'refresh', match: string, count: number): void;
  (e: 'loadMore'): void;
  (e: 'select', key: string): void;
  (e: 'deleteSelected', keys: string[]): void;
}>();

const matchInput = ref(props.match);
const countInput = ref(String(props.count));
const expanded = ref<Set<string>>(new Set());
const selected = ref<Set<string>>(new Set());

const rows = computed<KeyRow[]>(() => {
  const out: KeyRow[] = [];
  const walk = (folder: RedisKeyFolder, depth: number): void => {
    for (const f of folder.folders) {
      out.push({ kind: 'folder', name: f.name, path: f.path, depth, count: f.count });
      if (expanded.value.has(f.path)) walk(f, depth + 1);
    }
    for (const k of folder.keys) out.push({ kind: 'key', name: k, path: k, depth });
  };
  walk(props.folders, 0);
  return out;
});

const selectedCount = computed(() => selected.value.size);

function toggleFolder(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path); else next.add(path);
  expanded.value = next;
}

function onClick(row: KeyRow, ev: MouseEvent): void {
  if (row.kind === 'folder') { toggleFolder(row.path); return; }
  const next = new Set(selected.value);
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
    if (next.has(row.path)) next.delete(row.path); else next.add(row.path);
  } else {
    next.clear();
    next.add(row.path);
  }
  selected.value = next;
  emit('select', row.path);
}

function refresh(): void {
  expanded.value = new Set();
  selected.value = new Set();
  emit('refresh', matchInput.value, Number(countInput.value));
}

function deleteSelected(): void {
  if (selected.value.size) emit('deleteSelected', [...selected.value]);
}
</script>

<template>
  <div class="key-tree">
    <div class="toolbar">
      <input v-model="matchInput" class="match" :placeholder="t('wv.redis.keys.match')" @keydown.enter="refresh" />
      <input v-model="countInput" class="count" :title="t('wv.redis.keys.count')" />
      <button class="btn" @click="refresh">{{ t('wv.redis.keys.refresh') }}</button>
    </div>
    <div class="meta">
      <span>{{ scanned }}</span>
      <span v-if="selectedCount" class="sel">{{ t('wv.redis.keys.selected', { count: selectedCount }) }}</span>
      <button v-if="selectedCount" class="btn danger" @click="deleteSelected">{{ t('wv.redis.keys.deleteSelected') }}</button>
    </div>
    <div class="rows">
      <div
        v-for="row in rows"
        :key="row.kind + ':' + row.path"
        class="row"
        :class="{ folder: row.kind === 'folder', active: selected.has(row.path) || row.path === activeKey }"
        :style="{ paddingLeft: 6 + row.depth * 14 + 'px' }"
        @click="onClick(row, $event)"
      >
        <span class="icon">{{ row.kind === 'folder' ? (expanded.has(row.path) ? '▾' : '▸') : '•' }}</span>
        <span class="name">{{ row.name }}</span>
        <span v-if="row.kind === 'folder'" class="badge">{{ row.count }}</span>
      </div>
      <div v-if="!rows.length" class="empty">{{ loading ? t('wv.redis.keys.loading') : t('wv.redis.keys.empty') }}</div>
    </div>
    <div class="footer">
      <button v-if="!done" class="btn" :disabled="loading" @click="emit('loadMore')">
        {{ loading ? t('wv.redis.keys.loading') : t('wv.redis.keys.loadMore') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.key-tree { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.toolbar { display: flex; gap: 4px; }
.match { flex: 1; min-width: 0; }
.count { width: 52px; }
input { padding: 3px 5px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.meta { display: flex; gap: 8px; align-items: center; padding: 4px 0; color: var(--vscode-descriptionForeground); }
.sel { color: var(--vscode-foreground); }
.rows { flex: 1; overflow: auto; }
.row { display: flex; align-items: center; gap: 4px; padding: 2px 4px; cursor: pointer; white-space: nowrap; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row.folder { color: var(--vscode-foreground); }
.icon { width: 12px; color: var(--vscode-descriptionForeground); }
.badge { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
.empty { color: var(--vscode-descriptionForeground); padding: 12px; text-align: center; }
.btn { padding: 3px 8px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
.footer { padding-top: 4px; }
</style>
