<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 通用确认弹窗（危险操作）。
 *
 * - `role="dialog"` + `aria-modal` + `aria-label`，屏幕阅读器可识别；
 * - Esc 取消，Tab 在按钮间循环，关闭后焦点回到打开前的元素；
 * - 初始焦点落在「取消」上，避免 Enter 误触发删除。
 */
const props = withDefaults(defineProps<{
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}>(), { danger: false });

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const root = ref<HTMLElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('cancel');
    return;
  }
  if (e.key !== 'Tab' || !root.value) return;
  const focusables = root.value.querySelectorAll<HTMLElement>('button');
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  document.addEventListener('keydown', onKeydown);
  void nextTick(() => cancelBtn.value?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  previousFocus?.focus?.();
});
</script>

<template>
  <div class="dialog-mask" @click.self="emit('cancel')">
    <div ref="root" class="dialog" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <div class="dialog-title">{{ title }}</div>
      <div class="dialog-body">{{ message }}</div>
      <div class="dialog-actions">
        <button ref="cancelBtn" class="btn" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button class="btn" :class="{ danger }" @click="emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 6px; padding: 16px; min-width: 320px; max-width: 520px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
.dialog-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.dialog-body { font-size: 12px; color: var(--vscode-foreground, #cccccc); margin-bottom: 14px; white-space: pre-wrap; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
</style>