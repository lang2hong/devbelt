<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** 会话记录（嵌入 AI 侧栏的折叠面板；头部由容器提供）。 */
const props = defineProps<{
  sessions: ConversationSummary[];
  activeSessionId?: string;
}>();
const emit = defineEmits<{
  newChat: [];
  load: [id: string];
  rename: [id: string, title: string];
  delete: [id: string];
}>();

const { t } = useI18n();
const editingId = ref<string | undefined>(undefined);
const editTitle = ref('');
const confirmingId = ref<string | undefined>(undefined);
const search = ref('');

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return q ? props.sessions.filter((s) => s.title.toLowerCase().includes(q)) : props.sessions;
});

const groups = computed(() => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const day = 24 * 3600 * 1000;
  const buckets = [
    { key: 'today', label: t('wv.ai.history.today'), items: [] as ConversationSummary[] },
    { key: 'yesterday', label: t('wv.ai.history.yesterday'), items: [] as ConversationSummary[] },
    { key: 'week', label: t('wv.ai.history.week'), items: [] as ConversationSummary[] },
    { key: 'older', label: t('wv.ai.history.older'), items: [] as ConversationSummary[] },
  ];
  for (const session of filtered.value) {
    const ts = session.updatedAt;
    const diff = startOfDay - new Date(ts).setHours(0, 0, 0, 0);
    const bucket = diff <= 0 ? buckets[0]! : diff <= day ? buckets[1]! : diff <= day * 7 ? buckets[2]! : buckets[3]!;
    bucket.items.push(session);
  }
  return buckets.filter((b) => b.items.length > 0);
});

function startRename(session: ConversationSummary): void {
  editingId.value = session.id;
  editTitle.value = session.title;
}

function commitRename(): void {
  if (editingId.value) emit('rename', editingId.value, editTitle.value.trim());
  editingId.value = undefined;
}

function onDelete(session: ConversationSummary): void {
  if (confirmingId.value === session.id) {
    confirmingId.value = undefined;
    emit('delete', session.id);
  } else {
    confirmingId.value = session.id;
  }
}
</script>

<template>
  <div class="ai-drawer-pane">
    <div class="ai-drawer-actions">
      <button class="ai-btn" @click="emit('newChat')">{{ t('wv.ai.newChat') }}</button>
      <input v-model="search" class="ai-drawer-search" type="search" :placeholder="t('wv.ai.history.search')" />
    </div>
    <div v-for="group in groups" :key="group.key" class="ai-history-group">
      <div class="ai-history-label">{{ group.label }}</div>
      <ul class="ai-drawer-list">
        <li
          v-for="session in group.items"
          :key="session.id"
          class="ai-drawer-item"
          :class="{ 'ai-drawer-item-active': session.id === props.activeSessionId }"
        >
          <template v-if="editingId === session.id">
            <input
              v-model="editTitle"
              class="ai-drawer-rename"
              @keydown.enter.prevent="commitRename"
              @keydown.esc="editingId = undefined"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <button class="ai-drawer-title" :title="session.title" @click="emit('load', session.id)">
              {{ session.title }}
            </button>
            <span v-if="session.messageCount" class="ai-drawer-count">{{ session.messageCount }}</span>
            <div class="ai-drawer-ops">
              <button class="ai-btn" :title="t('wv.ai.rename')" @click="startRename(session)">✎</button>
              <button class="ai-btn" :title="t('wv.ai.delete')" @click="onDelete(session)">
                {{ confirmingId === session.id ? t('wv.ai.deleteConfirm') : '🗑' }}
              </button>
            </div>
          </template>
        </li>
      </ul>
    </div>
    <p v-if="filtered.length === 0" class="ai-drawer-empty">{{ t('wv.ai.history.empty') }}</p>
  </div>
</template>

<style scoped>
.ai-drawer-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.ai-drawer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ai-drawer-search {
  flex: 1;
  min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
  padding: 3px 8px;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
.ai-history-group { margin-top: 6px; }
.ai-history-label { padding: 4px 6px 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.ai-drawer-count { font-size: 10px; color: var(--vscode-descriptionForeground); }
.ai-drawer-empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px 6px; }
.ai-drawer-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ai-drawer-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 2px 6px;
}
.ai-drawer-item-active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.ai-drawer-title {
  flex: 1;
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  padding: 3px 2px;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
.ai-drawer-ops {
  display: flex;
  gap: 2px;
}
.ai-drawer-rename {
  flex: 1;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder);
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
</style>