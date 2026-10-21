<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import CodeBlock from './CodeBlock.vue';
import MarkdownText from './MarkdownText.vue';
import ToolResultInline from './ToolResultInline.vue';
import ToolRunningInline from './ToolRunningInline.vue';
import { useI18n } from '../../composables/useI18n';
import { parseMessageBlocks, type AiRunningPayload, type AiToolResultPayload } from '../../utils/aiChatStream';
import { formatCredits } from '../../utils/credits';
import { formatDateTime } from '../../utils/formatTime';
import { formatElapsed } from '../../../../src/ai/slowQuery';
import type { AiMessageUsage } from '../../../../src/ai/aiSessionStore';

const props = defineProps<{
  message: { role: 'user' | 'assistant'; content: string; reasoning?: string; error?: boolean; usage?: AiMessageUsage; blockResults?: Record<number, AiToolResultPayload>; blockRunning?: Record<number, AiRunningPayload> };
  streaming?: boolean;
  /** 当前连接引擎（传给 CodeBlock 决定运行按钮显隐）。 */
  dbType?: string;
  /** 消息在消息流中的下标（blockRef 绑定用，P9）。 */
  msgIdx?: number;
  /** 最后一条 assistant 可重新生成（含失败重试）。 */
  canRegenerate?: boolean;
  /** 用户消息可编辑后重发。 */
  canEdit?: boolean;
}>();

const emit = defineEmits<{
  (e: 'copy', text: string): void;
  (e: 'regenerate'): void;
  (e: 'edit'): void;
}>();
const { t } = useI18n();

const blocks = computed(() => parseMessageBlocks(props.message.content));
const copied = ref(false);

function copy(): void {
  emit('copy', props.message.content);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1500);
}

/** 表格折叠状态（按块下标；默认展开，记录已收起的块）。 */
const closedTables = reactive(new Set<number>());
function toggleTable(index: number): void {
  if (closedTables.has(index)) closedTables.delete(index);
  else closedTables.add(index);
}
// 内容变更（历史会话加载/消息被复用）时清空折叠状态，避免按 index 复用实例导致跨消息继承收起。
watch(
  () => props.message.content,
  () => {
    closedTables.clear();
  },
);
</script>

<template>
  <div
    class="ai-bubble"
    :class="{
      'ai-bubble-user': message.role === 'user',
      'ai-bubble-assistant': message.role === 'assistant',
      'ai-bubble-error': message.error,
    }"
  >
    <template v-if="message.role === 'assistant' && !message.error">
      <details v-if="message.reasoning" class="ai-reasoning" :open="props.streaming">
        <summary>{{ props.streaming ? t('wv.ai.reasoning.streaming') : t('wv.ai.reasoning') }}</summary>
        <pre class="ai-reasoning-text">{{ message.reasoning }}</pre>
      </details>
      <template v-for="(block, index) in blocks" :key="index">
        <template v-if="block.type === 'code'">
          <CodeBlock :code="block.content" :lang="block.lang" :db-type="props.dbType" :msg-idx="props.msgIdx" :block-idx="index" />
          <ToolRunningInline v-if="message.blockRunning?.[index]" :run-id="message.blockRunning[index]!.runId" :started-at="message.blockRunning[index]!.startedAt" />
          <ToolResultInline v-if="message.blockResults?.[index]" :result="message.blockResults[index]!" :sql="block.content" />
        </template>
        <div v-else-if="block.type === 'table'" class="ai-table-block">
          <button class="ai-table-head" @click="toggleTable(index)">
            <span class="ai-table-chevron">{{ closedTables.has(index) ? '▸' : '▾' }}</span>
            <span class="ai-table-title">{{ block.summary ?? t('wv.ai.table', { rows: block.rows.length }) }}</span>
          </button>
          <div v-if="!closedTables.has(index)" class="ai-table-scroll">
            <table class="ai-table">
              <thead>
                <tr>
                  <th v-for="(cell, cellIndex) in block.header" :key="cellIndex">{{ cell }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
                  <td v-for="(cell, cellIndex) in block.header" :key="cellIndex">{{ row[cellIndex] ?? '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <component v-else-if="block.type === 'heading'" :is="`h${block.level}`" class="ai-md-heading">
          <MarkdownText :text="block.content" />
        </component>
        <ul v-else-if="block.type === 'list' && !block.ordered" class="ai-md-list">
          <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownText :text="item" /></li>
        </ul>
        <ol v-else-if="block.type === 'list'" class="ai-md-list">
          <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownText :text="item" /></li>
        </ol>
        <blockquote v-else-if="block.type === 'quote'" class="ai-md-quote">
          <MarkdownText :text="block.content" />
        </blockquote>
        <hr v-else-if="block.type === 'hr'" class="ai-md-hr" />
        <p v-else class="ai-text">
          <MarkdownText :text="block.content" />
        </p>
      </template>
      <span v-if="streaming && !message.content" class="ai-thinking">{{ t('wv.ai.thinking') }}</span>
      <span v-else-if="streaming" class="ai-cursor">▍</span>
    </template>
    <p v-else class="ai-text">
      <MarkdownText :text="message.content" />
    </p>

    <div v-if="message.role === 'assistant' && message.usage && !props.streaming" class="ai-msg-usage">
      <span v-if="message.usage.credits !== null">{{ t('wv.ai.msg.credits', { credits: formatCredits(message.usage.credits) }) }}</span>
      <span v-else>{{ t('wv.ai.msg.creditsUnknown') }}</span>
      <span v-if="message.usage.credits === null && message.usage.tokens !== null">{{ t('wv.ai.msg.tokens', { tokens: message.usage.tokens.toLocaleString() }) }}</span>
      <span>{{ t('wv.ai.msg.duration', { duration: formatElapsed(message.usage.durationMs) }) }}</span>
      <span>{{ t('wv.ai.msg.startedAt', { time: formatDateTime(message.usage.startedAt) }) }}</span>
    </div>

    <div v-if="!props.streaming" class="ai-msg-actions">
      <button class="ai-btn" @click="copy">{{ copied ? t('wv.ai.copied') : t('wv.ai.copy') }}</button>
      <button v-if="props.canEdit" class="ai-btn" @click="emit('edit')">{{ t('wv.ai.edit') }}</button>
      <button v-if="props.canRegenerate" class="ai-btn" @click="emit('regenerate')">
        {{ message.error ? t('wv.ai.retry') : t('wv.ai.regenerate') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-bubble {
  padding: 4px 2px;
  border-radius: 18px;
  margin: 8px 0;
  line-height: 1.6;
  font-size: calc(var(--vscode-font-size, 13px) + 1px);
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ai-bubble-user {
  background: var(--vscode-input-background, rgba(128, 128, 128, 0.15));
  align-self: flex-end;
  max-width: 88%;
  padding: 8px 14px;
  border-radius: 18px 18px 4px 18px;
}
.ai-bubble-assistant { background: transparent; }
.ai-bubble-error {
  padding: 8px 14px;
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  color: var(--vscode-errorForeground, #f48771);
}
.ai-text {
  margin: 0;
  white-space: pre-wrap;
}
.ai-msg-usage {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 6px;
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  font-variant-numeric: tabular-nums;
}
.ai-md-heading {
  margin: 12px 0 6px;
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: -0.01em;
}
h1.ai-md-heading { font-size: 1.35em; }
h2.ai-md-heading { font-size: 1.22em; }
h3.ai-md-heading { font-size: 1.12em; }
h4.ai-md-heading, h5.ai-md-heading, h6.ai-md-heading { font-size: 1em; }
.ai-md-list { margin: 4px 0 8px; padding-left: 22px; }
.ai-md-list li { margin: 2px 0; }
.ai-md-quote {
  margin: 6px 0;
  padding: 4px 10px;
  border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border, #555));
  background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.08));
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
}
.ai-md-hr { border: none; border-top: 1px solid var(--vscode-panel-border, #444); margin: 10px 0; }
.ai-reasoning {
  margin: 2px 0 10px;
  border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.08));
  max-width: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.ai-reasoning summary {
  cursor: pointer;
  font-size: 12px;
  opacity: 0.75;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-reasoning-text {
  margin: 6px 0 2px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: inherit;
  font-size: 12.5px;
  opacity: 0.8;
  max-height: 240px;
  max-width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}
.ai-table-block { margin: 4px 0; min-width: 0; max-width: 100%; }
.ai-table-head {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  font-family: inherit;
  font-size: inherit;
  padding: 2px 4px;
  cursor: pointer;
  text-align: left;
}
.ai-table-head:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12)); }
.ai-table-chevron { width: 12px; flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
.ai-table-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-table-scroll { margin: 2px 0 4px 16px; max-width: calc(100% - 16px); min-width: 0; overflow-x: auto; }
.ai-table { border-collapse: collapse; font-size: calc(var(--vscode-font-size, 13px) - 1px); }
.ai-table th, .ai-table td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; white-space: nowrap; }
.ai-table th { background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12)); }
.ai-thinking { color: var(--vscode-descriptionForeground); animation: ai-pulse 1.2s ease-in-out infinite; }
@keyframes ai-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.ai-cursor { animation: ai-blink 1s steps(2, start) infinite; }
@keyframes ai-blink { to { visibility: hidden; } }
.ai-msg-actions { display: flex; gap: 4px; margin-top: 2px; opacity: 0; transition: opacity 0.12s; }
.ai-bubble:hover .ai-msg-actions, .ai-bubble:focus-within .ai-msg-actions { opacity: 1; }
@media (hover: none) { .ai-msg-actions { opacity: 1; } }
</style>