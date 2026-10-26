<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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

/** 宽度可拖：记住上次的值（localStorage），限制在 [MIN_WIDTH, 90vw]。 */
const MIN_WIDTH = 320;
const WIDTH_KEY = 'devbelt.ai.drawerWidth';
const DEFAULT_WIDTH = 360;
const width = ref(readWidth());
const maxWidth = (): number => Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.9));

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH) return Math.min(saved, 900);
  } catch { /* 无 localStorage 时用默认值 */ }
  return DEFAULT_WIDTH;
}

function applyWidth(next: number, persist = false): void {
  width.value = Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, next)));
  if (persist) {
    try { localStorage.setItem(WIDTH_KEY, String(width.value)); } catch { /* 忽略 */ }
  }
}

let dragStartX = 0;
let dragStartWidth = 0;
function onResizeStart(event: PointerEvent): void {
  event.preventDefault();
  dragStartX = event.clientX;
  dragStartWidth = width.value;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', onResizeEnd, { once: true });
}

function onResizeMove(event: PointerEvent): void {
  // 从右往左拖变宽
  applyWidth(dragStartWidth + (dragStartX - event.clientX));
}

function onResizeEnd(): void {
  window.removeEventListener('pointermove', onResizeMove);
  applyWidth(width.value, true);
}

function onResizeKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16;
  if (event.key === 'ArrowLeft') applyWidth(width.value + step, true);
  else if (event.key === 'ArrowRight') applyWidth(width.value - step, true);
  else if (event.key === 'Home') applyWidth(MIN_WIDTH, true);
  else if (event.key === 'End') applyWidth(maxWidth(), true);
  else return;
  event.preventDefault();
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', onResizeEnd);
});

const drawerStyle = computed(() => ({ width: `${width.value}px` }));

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
      :style="drawerStyle"
      @keydown="onKeydown"
    >
      <div
        class="ai-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('wv.ai.drawer.resize')"
        :aria-valuemin="MIN_WIDTH"
        :aria-valuemax="maxWidth()"
        :aria-valuenow="width"
        tabindex="0"
        @pointerdown="onResizeStart"
        @keydown="onResizeKey"
      ></div>
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
  position: relative;
  min-width: 320px;
  max-width: 90vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  border-left: 1px solid var(--vscode-panel-border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.25);
  outline: none;
}
.ai-drawer-resize {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  background: transparent;
  z-index: 1;
}
.ai-drawer-resize:hover, .ai-drawer-resize:focus-visible {
  background: var(--vscode-focusBorder);
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
