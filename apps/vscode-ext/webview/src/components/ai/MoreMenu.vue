<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * AI Chat 顶栏「⋯」更多菜单：低频功能统一收纳在这里，顶栏只留连接/库/新对话。
 *
 * 菜单语义：按钮 aria-haspopup/expanded；列表 role=menu；方向键移动、Enter 选择、
 * Esc 关闭并把焦点还给按钮；点击菜单外部关闭。
 */
export interface MoreMenuItem {
  id: string;
  label: string;
  /** 右侧附注（如「已配置」「12 张表」）。 */
  hint?: string;
  disabled?: boolean;
  /** 菜单内的分隔线（显示在本项上方）。 */
  separator?: boolean;
}

const props = defineProps<{ items: MoreMenuItem[] }>();
const emit = defineEmits<{ select: [id: string] }>();
const { t } = useI18n();

const open = ref(false);
const active = ref(0);
const button = ref<HTMLButtonElement | null>(null);
const root = ref<HTMLDivElement | null>(null);
const itemEls = ref<HTMLButtonElement[]>([]);

function enabledIndexes(): number[] {
  return props.items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
}

function focusActive(): void {
  void nextTick(() => itemEls.value[active.value]?.focus());
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) {
    active.value = enabledIndexes()[0] ?? 0;
    focusActive();
  }
}

function close(returnFocus = true): void {
  if (!open.value) return;
  open.value = false;
  if (returnFocus) void nextTick(() => button.value?.focus());
}

function choose(item: MoreMenuItem): void {
  if (item.disabled) return;
  close();
  emit('select', item.id);
}

function move(step: number): void {
  const enabled = enabledIndexes();
  if (enabled.length === 0) return;
  const at = enabled.indexOf(active.value);
  active.value = enabled[(at + step + enabled.length) % enabled.length]!;
  focusActive();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
  else if (event.key === 'Tab') close(false);
}

function onDocumentClick(event: MouseEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close(false);
}

watch(open, (value) => {
  if (value) document.addEventListener('mousedown', onDocumentClick);
  else document.removeEventListener('mousedown', onDocumentClick);
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentClick));
</script>

<template>
  <div ref="root" class="ai-more">
    <button
      ref="button"
      class="ai-btn ai-icon-btn"
      :title="t('wv.ai.more')"
      :aria-label="t('wv.ai.more')"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >⋯</button>
    <div v-if="open" class="ai-more-menu" role="menu" @keydown="onKeydown">
      <template v-for="(item, i) in props.items" :key="item.id">
        <div v-if="item.separator" class="ai-more-sep" role="separator"></div>
        <button
          :ref="(el) => { if (el) itemEls[i] = el as HTMLButtonElement; }"
          class="ai-more-item"
          role="menuitem"
          :disabled="item.disabled"
          :tabindex="i === active ? 0 : -1"
          @click="choose(item)"
          @mouseenter="!item.disabled && (active = i)"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.hint" class="ai-more-hint">{{ item.hint }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ai-more { position: relative; }
.ai-more-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 220px;
  padding: 4px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.ai-more-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ai-more-item:hover:not(:disabled),
.ai-more-item:focus-visible {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, inherit);
  outline: none;
}
.ai-more-item:disabled { opacity: 0.5; cursor: default; }
.ai-more-hint { color: var(--vscode-descriptionForeground); font-size: calc(var(--vscode-font-size, 13px) - 2px); }
.ai-more-sep { height: 1px; margin: 4px 2px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }
</style>
