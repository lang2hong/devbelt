<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/** 安全页：登录密码、同步口令、恢复/重置等低频操作集中在这里。 */
const { post, onMessage } = useVsCode();
let __offMsg: (() => void) | undefined;
const { t } = useI18n();
const errorMsg = ref('');

function act(action: string): void {
  post({ type: 'action', action });
}

onMounted(() => {
  post({ type: 'ready', view: 'security' });
  // 安全页只触发命令；仍监听错误，避免宿主端异常静默。
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'error') errorMsg.value = msg.message;
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="panel">
    <header class="head">
      <div class="title">{{ t('account.security.title') }}</div>
      <div class="sub">{{ t('account.security.intro') }}</div>
    </header>
    <p class="err" v-if="errorMsg">{{ errorMsg }}</p>

    <section class="card">
      <div class="card-title">{{ t('account.security.account') }}</div>
      <div class="actions">
        <button class="btn" @click="act('devbelt.changeLoginPassword')">{{ t('account.action.changeLoginPassword') }}</button>
        <button class="btn" @click="act('devbelt.changeSyncPassword')">{{ t('account.action.changeSyncPassword') }}</button>
        <button class="btn" @click="act('devbelt.authenticator')">{{ t('account.action.authenticator') }}</button>
      </div>
    </section>

    <section class="card danger-zone">
      <div class="card-title">{{ t('account.security.danger') }}</div>
      <p class="hint">{{ t('account.security.dangerHint') }}</p>
      <div class="actions">
        <button class="btn" @click="act('devbelt.recoverSync')">{{ t('account.action.recoverSync') }}</button>
        <button class="btn" @click="act('devbelt.recoverByAccount')">{{ t('account.action.recoverByAccount') }}</button>
        <button class="btn" @click="act('devbelt.resetSync')">{{ t('account.action.resetSync') }}</button>
        <button class="btn" @click="act('devbelt.resetLocalSync')">{{ t('account.action.resetLocalSync') }}</button>
        <button class="btn danger" @click="act('devbelt.destroySync')">{{ t('account.action.destroySync') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel { padding: 16px; max-width: 860px; display: grid; gap: 14px; }
.head { margin-bottom: 2px; }
.title { font-size: 16px; font-weight: 600; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); border-radius: 8px; padding: 14px; }
.card-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 10px; }
.err { color: var(--vscode-errorForeground); font-size: 13px; }
.danger-zone { border-color: var(--vscode-inputValidation-errorBorder, rgba(190, 17, 0, 0.6)); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2)); color: var(--vscode-button-secondaryForeground, inherit); border: none; padding: 7px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3)); }
.btn.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
.btn.danger:hover { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
</style>