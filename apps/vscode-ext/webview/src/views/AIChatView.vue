<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { setLanguage, useI18n } from '../composables/useI18n';
import MessageList from '../components/ai/MessageList.vue';
import ChatInput from '../components/ai/ChatInput.vue';
import ConversationDrawer from '../components/ai/ConversationDrawer.vue';
import ContextBar from '../components/ai/ContextBar.vue';
import ContextDetailDrawer, { type ContextDetailState } from '../components/ai/ContextDetailDrawer.vue';
import TablePickerDrawer from '../components/ai/TablePickerDrawer.vue';
import TableNoteEditor, { type TableNoteColumn } from '../components/ai/TableNoteEditor.vue';

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

/**
 * AI Chat 根视图（P9 S3）：独立入口 `aiChat.html`（不走 App.vue mode switch）。
 *
 * 消息协议见 `src/result/aiProtocol.ts`：
 *   up: ready | send | abort | newChat | renameChat | deleteChat | loadHistory |
 *       selectConnection | selectScope | requestTableOptions | selectTables | requestTableNote |
 *       saveTableNote | fetchColumnSample | requestQuotaRefresh | openSettings | setApiKey |
 *       clearApiKey | testConnection | copyCode
 *   down: init | chunk | finish | quotaUpdate | contextChanged | sessionList | sessionLoaded |
 *         contextDetail | prefillInput | toolResult | tableOptions | tableNote | columnSample
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

const provider = ref<any>(null);
const quota = ref<any>(null);
const context = ref<any>(null);
const connections = ref<{ id: string; name: string }[]>([]);
const sessions = ref<SessionSummary[]>([]);
const activeSessionId = ref<string | undefined>(undefined);
const messages = ref<ChatMessage[]>([]);
const streaming = ref<{ content: string } | null>(null);
const selectedConnId = ref<string | undefined>(undefined);
const input = ref('');
const includeColumnComments = ref(true);
/**
 * 侧栏折叠视图组（VSCode 侧栏风格：上下堆叠、各自 ▸/▾，可同时展开）：
 * 上下文明细 / 表选择 / 表说明 / 会话记录。
 */
const sidebarOpen = reactive({ context: false, tables: false, notes: false, sessions: false });
function toggleSection(key: keyof typeof sidebarOpen): void {
  sidebarOpen[key] = !sidebarOpen[key];
}
/** P9 S4：上下文明细（域上下文/默认指令/注入表清单，只读）。 */
const contextDetail = ref<ContextDetailState | null>(null);
/** P9 S7d：表选择（连接 → 库 → 表 第三级）。 */
const tableOptions = ref<string[]>([]);
const tableOptionsLoading = ref(false);
/** P9 S7e：表/列说明编辑器。 */
const tableNoteTable = ref('');
const tableNoteData = ref<{ note?: string; columns: TableNoteColumn[] } | null>(null);
const tableNoteLoading = ref(false);
const samplingColumn = ref<string | null>(null);
const sampleErrors = ref<Record<string, string>>({});
const sampleFill = ref<{ column: string; text: string; seq: number } | null>(null);
let sampleSeq = 0;

const generating = computed(() => streaming.value !== null);

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init':
        setLanguage(!!msg.isZh);
        provider.value = msg.provider ?? null;
        quota.value = msg.quota ?? null;
        context.value = msg.context ?? null;
        connections.value = Array.isArray(msg.connections) ? msg.connections : [];
        sessions.value = Array.isArray(msg.sessions) ? msg.sessions : [];
        includeColumnComments.value = !!msg.includeColumnComments;
        activeSessionId.value = msg.activeSessionId || undefined;
        selectedConnId.value = msg.context?.connId;
        if (!msg.activeSessionId) messages.value = [];
        break;
      case 'sessionLoaded': {
        const session = msg.session;
        if (!session || !session.id) {
          messages.value = [];
          activeSessionId.value = undefined;
          break;
        }
        activeSessionId.value = session.id;
        messages.value = Array.isArray(session.messages) ? [...session.messages] : [];
        streaming.value = null;
        if (session.connId) selectedConnId.value = session.connId;
        break;
      }
      case 'sessionList':
        sessions.value = Array.isArray(msg.sessions) ? msg.sessions : [];
        if (msg.activeSessionId !== undefined) activeSessionId.value = msg.activeSessionId || undefined;
        break;
      case 'chunk':
        if (!streaming.value) streaming.value = { content: '' };
        streaming.value.content += msg.delta ?? '';
        break;
      case 'finish': {
        const content = streaming.value?.content ?? '';
        streaming.value = null;
        if (content) messages.value.push({ role: 'assistant', content });
        if (msg.error) messages.value.push({ role: 'assistant', content: msg.error.message, error: true });
        break;
      }
      case 'quotaUpdate':
        quota.value = msg.quota ?? null;
        break;
      case 'contextChanged':
        context.value = msg.context ?? null;
        break;
      case 'contextDetail':
        contextDetail.value = {
          domainContext: String(msg.domainContext ?? ''),
          defaultDirectives: String(msg.defaultDirectives ?? ''),
          commentCount: Number(msg.context?.commentCount ?? 0),
          tableCount: Number(msg.context?.tableCount ?? 0),
          totalTables: Number(msg.context?.totalTables ?? 0),
          tables: Array.isArray(msg.tables) ? msg.tables : [],
        };
        sidebarOpen.context = true;
        break;
      case 'prefillInput':
        if (typeof msg.text === 'string') input.value = msg.text;
        break;
      case 'tableOptions':
        tableOptions.value = Array.isArray(msg.tables) ? msg.tables : [];
        tableOptionsLoading.value = false;
        if (sidebarOpen.tables && msg.scope !== undefined && context.value?.scope && msg.scope !== context.value.scope) {
          // 响应跨作用域（用户已切库）→ 丢弃，等新一轮
          tableOptions.value = [];
        }
        break;
      case 'tableNote':
        tableNoteTable.value = String(msg.table ?? '');
        tableNoteData.value = {
          ...(typeof msg.note === 'string' && msg.note ? { note: msg.note } : {}),
          columns: Array.isArray(msg.columns) ? msg.columns : [],
        };
        tableNoteLoading.value = false;
        samplingColumn.value = null;
        break;
      case 'columnSample': {
        const column = String(msg.column ?? '');
        samplingColumn.value = null;
        if (Array.isArray(msg.values)) {
          sampleErrors.value = { ...sampleErrors.value, [column]: '' };
          sampleSeq += 1;
          sampleFill.value = { column, text: msg.values.join(', '), seq: sampleSeq };
        } else if (msg.error) {
          sampleErrors.value = { ...sampleErrors.value, [column]: String(msg.error) };
        }
        break;
      }
      case 'toolResult':
        messages.value.push({
          role: 'assistant',
          content: `${String(msg.title ?? '')}\n\n\`\`\`\n${String(msg.content ?? '')}\n\`\`\``,
          error: !!msg.isError,
        });
        break;
      default:
        break;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function send(): void {
  const text = input.value.trim();
  if (!text || generating.value) return;
  messages.value.push({ role: 'user', content: text });
  streaming.value = { content: '' };
  post({ type: 'send', sessionId: activeSessionId.value ?? '', text });
  input.value = '';
}

function stop(): void {
  post({ type: 'abort' });
}

function newChat(): void {
  messages.value = [];
  streaming.value = null;
  post({ type: 'newChat' });
}

function loadSession(id: string): void {
  post({ type: 'loadHistory', sessionId: id });
}

function renameSession(id: string, title: string): void {
  if (title) post({ type: 'renameChat', sessionId: id, title });
}

function deleteSession(id: string): void {
  post({ type: 'deleteChat', sessionId: id });
}

function selectConnection(id: string | null): void {
  selectedConnId.value = id ?? undefined;
  post({ type: 'selectConnection', connId: id });
}

/** S7a：切换作用域（库/逻辑库/索引，单选）。 */
function selectScope(value: string): void {
  post({ type: 'selectScope', value });
}

function openTablePicker(): void {
  sidebarOpen.tables = true;
  tableOptions.value = [];
  tableOptionsLoading.value = true;
  post({ type: 'requestTableOptions' });
}

function applyTableSelection(tables: string[]): void {
  post({ type: 'selectTables', tables });
}

/** P9 S7e：打开表/列说明编辑器（向 host 拉列元数据 + 现有注记）。 */
function editTableNote(table: string): void {
  sidebarOpen.notes = true;
  tableNoteTable.value = table;
  tableNoteData.value = null;
  tableNoteLoading.value = true;
  samplingColumn.value = null;
  sampleErrors.value = {};
  sampleFill.value = null;
  post({ type: 'requestTableNote', table });
}

function saveTableNote(payload: { table: string; note: string; columns: Array<{ name: string; note: string; sample: string }> }): void {
  post({ type: 'saveTableNote', ...payload });
}

function fetchColumnSample(column: string): void {
  samplingColumn.value = column;
  post({ type: 'fetchColumnSample', table: tableNoteTable.value, column });
}

/** P9 S4：打开上下文明细（按需向 host 拉域上下文/默认指令原文 + 注入表清单）。 */
function openContextDetail(): void {
  sidebarOpen.context = true;
  contextDetail.value = null;
  post({ type: 'requestContextDetail' });
}
</script>

<template>
  <div class="ai-root">
    <ContextBar
      :provider="provider"
      :context="context"
      :quota="quota"
      :connections="connections"
      :selected-conn-id="selectedConnId"
      :include-column-comments="includeColumnComments"
      @select-connection="selectConnection"
      @select-scope="selectScope"
      @open-table-picker="openTablePicker"
      @open-settings="post({ type: 'openSettings' })"
      @set-api-key="post({ type: 'setApiKey' })"
      @clear-api-key="post({ type: 'clearApiKey' })"
      @test-connection="post({ type: 'testConnection' })"
      @request-context-detail="openContextDetail"
    />
    <div class="ai-toolbar">
      <button class="ai-btn" @click="newChat">{{ t('wv.ai.newChat') }}</button>
      <button class="ai-btn" @click="toggleSection('sessions')">{{ t('wv.ai.sessions') }}</button>
      <span class="ai-spacer"></span>
      <button v-if="generating" class="ai-btn" @click="stop">{{ t('wv.ai.stop') }}</button>
    </div>
    <div class="ai-body">
      <div class="ai-side">
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('context')">
            <span class="ai-side-chevron">{{ sidebarOpen.context ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.context.detail') }}</span>
          </button>
          <div v-show="sidebarOpen.context" class="ai-side-content">
            <ContextDetailDrawer :detail="contextDetail" @edit-table="editTableNote" />
          </div>
        </div>
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('tables')">
            <span class="ai-side-chevron">{{ sidebarOpen.tables ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.tables.panelTitle') }}</span>
            <span class="ai-side-count">{{ context?.selectedTables?.length ?? 0 }}</span>
          </button>
          <div v-show="sidebarOpen.tables" class="ai-side-content">
            <TablePickerDrawer
              :tables="tableOptions"
              :selected="context?.selectedTables ?? []"
              :loading="tableOptionsLoading"
              @apply="applyTableSelection"
              @edit-note="editTableNote"
            />
          </div>
        </div>
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('notes')">
            <span class="ai-side-chevron">{{ sidebarOpen.notes ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.notes.title') }}</span>
            <span class="ai-side-count">{{ tableNoteTable }}</span>
          </button>
          <div v-show="sidebarOpen.notes" class="ai-side-content">
            <TableNoteEditor
              :table="tableNoteTable"
              :note="tableNoteData?.note"
              :columns="tableNoteData?.columns ?? []"
              :loading="tableNoteLoading"
              :sampling-column="samplingColumn"
              :sample-errors="sampleErrors"
              :sample-fill="sampleFill"
              @save="saveTableNote"
              @fetch-sample="fetchColumnSample"
            />
          </div>
        </div>
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('sessions')">
            <span class="ai-side-chevron">{{ sidebarOpen.sessions ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.sessions') }}</span>
          </button>
          <div v-show="sidebarOpen.sessions" class="ai-side-content">
            <ConversationDrawer
              :sessions="sessions"
              :active-session-id="activeSessionId"
              @new-chat="newChat"
              @load="loadSession"
              @rename="renameSession"
              @delete="deleteSession"
            />
          </div>
        </div>
      </div>
      <div class="ai-main">
        <MessageList :messages="messages" :streaming="streaming" />
        <ChatInput v-model="input" :generating="generating" @send="send" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
.ai-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.ai-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.ai-side {
  width: 340px;
  flex: 0 0 auto;
  border-right: 1px solid var(--vscode-panel-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.ai-side-section {
  border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto;
}
.ai-side-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  padding: 4px 6px;
  cursor: pointer;
  text-align: left;
}
.ai-side-head:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-side-chevron {
  width: 12px;
  color: var(--vscode-descriptionForeground);
}
.ai-side-count {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}
.ai-side-content {
  padding: 2px 8px 8px;
}
.ai-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-spacer {
  flex: 1;
}
</style>