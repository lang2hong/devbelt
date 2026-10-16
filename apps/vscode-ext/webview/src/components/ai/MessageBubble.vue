<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import CodeBlock from './CodeBlock.vue';
import ToolResultInline from './ToolResultInline.vue';
import ToolRunningInline from './ToolRunningInline.vue';
import { useI18n } from '../../composables/useI18n';
import { parseInlineSegments, parseMessageBlocks, type AiInlineSegment, type AiRunningPayload, type AiToolResultPayload } from '../../utils/aiChatStream';

const props = defineProps<{
  message: { role: 'user' | 'assistant'; content: string; error?: boolean; blockResults?: Record<number, AiToolResultPayload>; blockRunning?: Record<number, AiRunningPayload> };
  streaming?: boolean;
  /** 当前连接引擎（传给 CodeBlock 决定运行按钮显隐）。 */
  dbType?: string;
  /** 消息在消息流中的下标（blockRef 绑定用，P9）。 */
  msgIdx?: number;
}>();

const { t } = useI18n();

const blocks = computed(() => parseMessageBlocks(props.message.content));

function segments(text: string): AiInlineSegment[] {
  return parseInlineSegments(text);
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
        <p v-else class="ai-text">
          <template v-for="(seg, segIndex) in segments(block.content)" :key="segIndex">
            <code v-if="seg.type === 'code'" class="ai-inline-code">{{ seg.content }}</code>
            <span v-else>{{ seg.content }}</span>
          </template>
        </p>
      </template>
      <span v-if="streaming && !message.content" class="ai-thinking">{{ t('wv.ai.thinking') }}</span>
      <span v-else-if="streaming" class="ai-cursor">▍</span>
    </template>
    <p v-else class="ai-text">{{ message.content }}</p>
  </div>
</template>

<style scoped>
.ai-bubble {
  padding: 6px 10px;
  border-radius: 6px;
  margin: 4px 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.ai-bubble-user {
  background: var(--vscode-input-background, rgba(128, 128, 128, 0.15));
  align-self: flex-end;
}
.ai-bubble-assistant {
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
}
.ai-bubble-error {
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  color: var(--vscode-errorForeground, #f48771);
}
.ai-text {
  margin: 0;
  white-space: pre-wrap;
}
.ai-inline-code {
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  padding: 0 3px;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}
.ai-table-block {
  margin: 4px 0;
}
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
.ai-table-head:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-table-chevron {
  width: 12px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}
.ai-table-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-table-scroll {
  margin: 2px 0 4px 16px;
  max-width: calc(100% - 16px);
  overflow-x: auto;
}
.ai-table {
  border-collapse: collapse;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
.ai-table th,
.ai-table td {
  border: 1px solid var(--vscode-panel-border);
  padding: 2px 6px;
  text-align: left;
  white-space: nowrap;
}
.ai-table th {
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
}
.ai-thinking {
  color: var(--vscode-descriptionForeground);
  animation: ai-pulse 1.2s ease-in-out infinite;
}
@keyframes ai-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
.ai-cursor {
  animation: ai-blink 1s steps(2, start) infinite;
}
@keyframes ai-blink {
  to {
    visibility: hidden;
  }
}
</style>