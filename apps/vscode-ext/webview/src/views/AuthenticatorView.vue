<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import type { AuthenticatorSnapshotEntry } from '../../../src/result/protocol';

/**
 * P5 S2 · 验证器视图（基础列表）。
 *
 * 只渲染 issuer/account、大号 code、倒计时圈与复制反馈；收 snapshot / tick / copyOk / error。
 * 添加/编辑/分组/标签/搜索/导出属 S3。code 切换以主进程 tick 消息为唯一权威，
 * webview 端不自行跑 TOTP。
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

const entries = ref<AuthenticatorSnapshotEntry[]>([]);
const codes = ref<Record<string, { code: string; secondsLeft: number }>>({});
const copiedId = ref<string | null>(null);
const errMsg = ref('');

const RING_CIRCUMFERENCE = 2 * Math.PI * 13;

let off: (() => void) | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let errTimer: ReturnType<typeof setTimeout> | undefined;

function onMsg(msg: any): void {
  if (msg.type === 'snapshot') {
    entries.value = msg.entries ?? [];
  } else if (msg.type === 'tick') {
    codes.value = msg.codes ?? {};
  } else if (msg.type === 'copyOk') {
    copiedId.value = msg.entryId;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1200);
  } else if (msg.type === 'error') {
    errMsg.value = msg.message ?? '';
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(() => { errMsg.value = ''; }, 4000);
  }
}

function nameOf(e: AuthenticatorSnapshotEntry): string {
  return e.issuer || e.account || '';
}
function accountOf(e: AuthenticatorSnapshotEntry): string {
  return e.issuer && e.account ? e.account : '';
}
function codeOf(e: AuthenticatorSnapshotEntry): string {
  return codes.value[e.id]?.code ?? '••••••';
}
function secondsLeft(e: AuthenticatorSnapshotEntry): number {
  return codes.value[e.id]?.secondsLeft ?? 0;
}
function dashOffset(e: AuthenticatorSnapshotEntry): number {
  const period = e.period || 30;
  const frac = Math.max(0, Math.min(1, secondsLeft(e) / period));
  return RING_CIRCUMFERENCE * (1 - frac);
}
function copy(e: AuthenticatorSnapshotEntry): void {
  const c = codes.value[e.id];
  if (!c) return;
  post({ type: 'copy', code: c.code, entryId: e.id });
}

onMounted(() => {
  post({ type: 'ready' });
  off = onMessage(onMsg);
});
onUnmounted(() => {
  off?.();
  if (copiedTimer) clearTimeout(copiedTimer);
  if (errTimer) clearTimeout(errTimer);
});
</script>

<template>
  <div class="auth">
    <div v-if="errMsg" class="auth-err">{{ errMsg }}</div>
    <div v-if="entries.length === 0" class="auth-empty">{{ t('wv.authenticator.empty') }}</div>
    <ul v-else class="auth-list">
      <li
        v-for="e in entries"
        :key="e.id"
        class="auth-card"
        :class="{ missing: e.error === 'secretMissing', warn: secondsLeft(e) <= 5 }"
        role="button"
        tabindex="0"
        @click="copy(e)"
        @keydown.enter.prevent="copy(e)"
        @keydown.space.prevent="copy(e)"
      >
        <div class="meta">
          <div class="issuer">{{ nameOf(e) }}</div>
          <div v-if="accountOf(e)" class="account">{{ accountOf(e) }}</div>
        </div>
        <div class="code-area">
          <span v-if="e.error === 'secretMissing'" class="missing-text">{{ t('wv.authenticator.secretMissing') }}</span>
          <template v-else>
            <span class="code">{{ codeOf(e) }}</span>
            <svg class="ring" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <circle class="ring-track" cx="16" cy="16" r="13" />
              <circle
                class="ring-progress"
                cx="16"
                cy="16"
                r="13"
                :stroke-dasharray="RING_CIRCUMFERENCE"
                :stroke-dashoffset="dashOffset(e)"
              />
            </svg>
          </template>
        </div>
        <span v-if="copiedId === e.id" class="copied">{{ t('wv.authenticator.copied') }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.auth { padding: 8px; color: var(--vscode-foreground); font-size: 13px; }
.auth-err {
  margin-bottom: 8px; padding: 6px 8px; border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
  color: var(--vscode-errorForeground);
}
.auth-empty { padding: 16px 8px; opacity: 0.8; line-height: 1.5; }
.auth-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.auth-card {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 8px 10px; border-radius: 6px; cursor: pointer;
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
  border: 1px solid var(--vscode-widget-border, transparent);
}
.auth-card:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.16)); }
.auth-card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.auth-card.missing { opacity: 0.7; cursor: default; }
.auth-card.warn .code { color: var(--vscode-errorForeground); }
.meta { min-width: 0; display: flex; flex-direction: column; }
.issuer { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-area { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.code { font-family: var(--vscode-editor-font-family, monospace); font-size: 20px; letter-spacing: 2px; }
.missing-text { font-size: 11px; color: var(--vscode-errorForeground); max-width: 140px; }
.ring { transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--vscode-foreground, #888); opacity: 0.2; stroke-width: 2.5; }
.ring-progress {
  fill: none; stroke: var(--vscode-progressBar-background, #0a84ff);
  stroke-width: 2.5; stroke-linecap: round; transition: stroke-dashoffset 0.9s linear;
}
.copied {
  position: absolute; top: 4px; right: 6px; font-size: 10px;
  color: var(--vscode-descriptionForeground);
}
</style>