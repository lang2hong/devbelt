<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * AI Chat 右侧抽屉（会话记录 / 注入的表 / 业务规则 / 额度）。
 *
 * 默认不占位置：打开时覆盖在对话右侧，点遮罩或按 Esc 关闭，关闭后焦点回到触发处。
 * 一次只开一个面板，内容由插槽提供。
 */
const props = defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const panel = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => restoreFocus?.focus());
</script>

<template>
  <div class="ai-drawer-mask" @mousedown.self="emit('close')">
    <aside
      ref="panel"
      class="ai-drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="props.title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="ai-drawer-head">
        <span class="ai-drawer-title-text">{{ props.title }}</span>
        <button class="ai-btn ai-icon-btn" :title="t('wv.ai.drawer.close')" :aria-label="t('wv.ai.drawer.close')" @click="emit('close')">✕</button>
      </header>
      <div class="ai-drawer-body">
        <slot />
      </div>
    </aside>
  </div>
</template>

<style scoped>
.ai-drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  justify-content: flex-end;
}
.ai-drawer {
  width: min(360px, 90vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-left: 1px solid var(--vscode-panel-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.25);
  outline: none;
}
.ai-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-weight: 600;
}
.ai-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
}
</style>
