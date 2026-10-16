<script setup lang="ts">
import { inject, ref } from 'vue';
import { useVsCode } from '../../composables/useVsCode';
import { useI18n } from '../../composables/useI18n';
import { RUN_IN_CHAT_KEY } from '../../utils/runInChat';

const props = defineProps<{
  code: string;
  lang?: string;
  dbType?: string;
  /** 所在消息与块的下标（结果内联绑定 blockRef 用，P9）。 */
  msgIdx?: number;
  blockIdx?: number;
}>();
const isSql = (): boolean => !props.lang || props.lang === 'sql';
const engine = (): string => String(props.dbType ?? '').toUpperCase();
/** 运行按钮仅在与当前连接引擎匹配时显示（sql/无标 → 关系引擎；redis → REDIS；json → ES）。 */
const canExecute = (): boolean => {
  if (props.lang === 'redis') return engine() === 'REDIS';
  if (props.lang === 'json') return engine() === 'ELASTICSEARCH';
  return engine() === '' || ['MYSQL', 'PG', 'SQLITE'].includes(engine());
};
const { post } = useVsCode();
const { t } = useI18n();
const copied = ref(false);

function copy(): void {
  post({ type: 'copyCode', text: props.code });
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}

/** P9 S4：应用到编辑器（活动 SQL 编辑器插入/替换；否则新 untitled 文档）。 */
function apply(): void {
  post({ type: 'applyCode', text: props.code });
}

/** 在引擎面板执行（SQL=结果面板 / Redis=控制台 / ES=DSL tab；确认/只读/生产门禁照旧）。 */
function runInPanel(): void {
  if (props.lang === 'redis') {
    post({ type: 'runRedisInPanel', text: props.code });
    return;
  }
  if (props.lang === 'json') {
    post({ type: 'runEsDslInPanel', text: props.code });
    return;
  }
  post({ type: 'executeSql', text: props.code });
}

/** 在对话中执行（结果内联回填到本代码块下方；代次由视图根补齐，写语句门禁在宿主）。 */
const dispatchRunInChat = inject(RUN_IN_CHAT_KEY, (payload) => {
  // 根未提供（异常装配）时兜底为无绑定的直发，结果走尾部气泡。
  const type = payload.kind === 'sql' ? 'executeSqlInChat' : payload.kind === 'redis' ? 'runRedis' : 'runEsDsl';
  post({ type, text: payload.text });
});
function runInChat(): void {
  dispatchRunInChat({
    kind: props.lang === 'redis' ? 'redis' : props.lang === 'json' ? 'es' : 'sql',
    text: props.code,
    msgIdx: props.msgIdx,
    blockIdx: props.blockIdx,
  });
}
</script>

<template>
  <div class="ai-code">
    <div class="ai-code-head">
      <span class="ai-code-lang">{{ lang || 'code' }}</span>
      <div class="ai-code-actions">
        <button class="ai-btn ai-code-copy" @click="copy">{{ copied ? t('wv.ai.copied') : t('wv.ai.copy') }}</button>
        <button v-if="isSql()" class="ai-btn" @click="apply">{{ t('wv.ai.insert') }}</button>
        <button v-if="canExecute()" class="ai-btn" @click="runInPanel">{{ t('wv.ai.runPanel') }}</button>
        <button v-if="canExecute()" class="ai-btn" @click="runInChat">{{ t('wv.ai.runChat') }}</button>
      </div>
    </div>
    <pre class="ai-code-body"><code>{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.ai-code {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  margin: 4px 0;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
}
.ai-code-actions {
  display: flex;
  gap: 4px;
}
.ai-code-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 8px;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.ai-code-body {
  margin: 0;
  padding: 8px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  white-space: pre;
}
</style>