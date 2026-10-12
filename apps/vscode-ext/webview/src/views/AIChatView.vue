<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { setLanguage, useI18n } from '../composables/useI18n';
import MessageList from '../components/ai/MessageList.vue';
import ChatInput from '../components/ai/ChatInput.vue';
import ConversationDrawer from '../components/ai/ConversationDrawer.vue';
import ContextBar from '../components/ai/ContextBar.vue';
import ContextDetailDrawer, { type ContextDetailState } from '../components/ai/ContextDetailDrawer.vue';

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
 *       selectConnection | selectScope | requestQuotaRefresh | openSettings | setApiKey |
 *       clearApiKey | testConnection | copyCode
 *   down: init | chunk | finish | quotaUpdate | contextChanged | sessionList | sessionLoaded
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
const showSessions = ref(false);
const includeColumnComments = ref(true);
/** P9 S4：Context 抽屉明细（schema/域上下文/默认指令原文，只读）。 */
const showContextDetail = ref(false);
const contextDetail = ref<ContextDetailState | null>(null);

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
          schemaText: String(msg.schemaText ?? ''),
          domainContext: String(msg.domainContext ?? ''),
          defaultDirectives: String(msg.defaultDirectives ?? ''),
          commentCount: Number(msg.context?.commentCount ?? 0),
          tableCount: Number(msg.context?.tableCount ?? 0),
          totalTables: Number(msg.context?.totalTables ?? 0),
        };
        showContextDetail.value = true;
        break;
      case 'prefillInput':
        if (typeof msg.text === 'string') input.value = msg.text;
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
  showSessions.value = false;
  messages.value = [];
  streaming.value = null;
  post({ type: 'newChat' });
}

function loadSession(id: string): void {
  showSessions.value = false;
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

/** P9 S4：打开 Context 明细抽屉（按需向 host 拉 schema/域上下文原文）。 */
function openContextDetail(): void {
  showContextDetail.value = true;
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
      @open-settings="post({ type: 'openSettings' })"
      @set-api-key="post({ type: 'setApiKey' })"
      @clear-api-key="post({ type: 'clearApiKey' })"
      @test-connection="post({ type: 'testConnection' })"
      @request-context-detail="openContextDetail"
    />
    <div class="ai-toolbar">
      <button class="ai-btn" @click="newChat">{{ t('wv.ai.newChat') }}</button>
      <button class="ai-btn" @click="showSessions = !showSessions">{{ t('wv.ai.sessions') }}</button>
      <span class="ai-spacer"></span>
      <button v-if="generating" class="ai-btn" @click="stop">{{ t('wv.ai.stop') }}</button>
    </div>
    <div class="ai-body">
      <ContextDetailDrawer
        v-if="showContextDetail"
        :detail="contextDetail"
        @close="showContextDetail = false"
      />
      <ConversationDrawer
        v-if="showSessions"
        :sessions="sessions"
        :active-session-id="activeSessionId"
        @new-chat="newChat"
        @load="loadSession"
        @rename="renameSession"
        @delete="deleteSession"
        @close="showSessions = false"
      />
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
  font-size: 13px;
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