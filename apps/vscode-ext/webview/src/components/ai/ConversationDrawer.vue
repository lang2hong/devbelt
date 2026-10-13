<script setup lang="ts">
import { ref } from 'vue';
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
    </div>
    <ul class="ai-drawer-list">
      <li
        v-for="session in props.sessions"
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
}
.ai-drawer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
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