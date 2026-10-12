<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../../composables/useI18n';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

const props = defineProps<{
  sessions: ConversationSummary[];
  activeSessionId?: string;
}>();
const emit = defineEmits<{
  newChat: [];
  load: [id: string];
  rename: [id: string, title: string];
  delete: [id: string];
  close: [];
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
  <div class="ai-drawer">
    <div class="ai-drawer-head">
      <span>{{ t('wv.ai.sessions') }}</span>
      <div>
        <button class="ai-btn" @click="emit('newChat')">{{ t('wv.ai.newChat') }}</button>
        <button class="ai-btn" @click="emit('close')">✕</button>
      </div>
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
.ai-drawer {
  border-right: 1px solid var(--vscode-panel-border);
  width: 220px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.ai-drawer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
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
  font-size: 12px;
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
  font-size: 12px;
}
</style>