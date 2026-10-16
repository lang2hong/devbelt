<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, nextTick } from 'vue';

const props = withDefaults(defineProps<{ title?: string; closable?: boolean }>(), {
  closable: true,
});
const emit = defineEmits<{ (e: 'close'): void }>();

const titleId = useId();
const dialogEl = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;

function close(): void {
  if (!props.closable) return;
  emit('close');
}

function isFocusable(n: HTMLElement): boolean {
  if (n.tabIndex < 0) return false;
  if (n.hasAttribute('disabled')) return false;
  if (n.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(n);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function focusablesIn(el: HTMLElement): HTMLElement[] {
  return Array.from(
    el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]'),
  ).filter((n) => isFocusable(n));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  const el = dialogEl.value;
  if (!el) return;
  const focusables = focusablesIn(el);
  if (focusables.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && el.contains(active);
  if (e.shiftKey) {
    if (!inside || active === el || active === first) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === el || active === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previousFocus = (document.activeElement as HTMLElement | null) ?? null;
  document.addEventListener('keydown', onKeydown);
  await nextTick();
  dialogEl.value?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  previousFocus?.focus?.();
});
</script>

<template>
  <teleport to="body">
    <div class="modal-mask" @click.self="close">
      <div
        ref="dialogEl"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
      >
        <h3 v-if="title" :id="titleId" class="modal-title">{{ title }}</h3>
        <div class="modal-body"><slot /></div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px 24px; z-index: 1000; overflow-y: auto; }
.modal { background: var(--c-surface); border-radius: 8px; padding: 20px 24px; min-width: min(360px, 90vw); max-width: 90vw; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2); max-height: 88vh; display: flex; flex-direction: column; margin: auto; }
.modal { outline: none; }
.modal-title { margin: 0 0 12px; font-size: 16px; font-weight: 600; color: var(--c-text); flex-shrink: 0; }
.modal-body { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; flex: 1; }
</style>