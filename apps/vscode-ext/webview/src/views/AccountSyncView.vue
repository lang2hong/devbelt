<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 个人同步页：状态 + 一个主操作 + 高级区。
 * 低频/危险操作收进“高级同步”，避免和“立即同步”并排。
 */
const { post, onMessage } = useVsCode();
let __offMsg: (() => void) | undefined;
const { t } = useI18n();

interface SyncStatus {
  initialized: boolean;
  unlocked: boolean;
  keyEpoch: string | null;
  conflicts: number;
  pendingCleanup: boolean;
}

const status = ref<SyncStatus | null>(null);
const loaded = ref(false);
const errorMsg = ref('');

function act(action: string): void {
  post({ type: 'action', action });
}

function stateLabel(s: SyncStatus | null): string {
  return s?.unlocked ? t('account.sync.unlocked') : t('account.sync.locked');
}

onMounted(() => {
  post({ type: 'ready', view: 'sync' });
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'syncStatus') { status.value = msg.status; loaded.value = true; errorMsg.value = ''; }
    else if (msg.type === 'error') errorMsg.value = msg.message;
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="panel">
    <header class="head">
      <div class="title">{{ t('account.card.sync') }}</div>
      <div class="sub">{{ t('account.card.syncHint') }}</div>
    </header>

    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
    <div class="loading" v-else-if="!loaded">{{ t('common.loading') }}</div>
    <div class="loading" v-else-if="!status">{{ t('account.loginRequired') }}</div>

    <template v-else>
      <section class="card">
        <ul class="kv">
          <li><span>{{ t('account.sync.state') }}</span><b>{{ stateLabel(status) }}</b></li>
          <li><span>{{ t('account.sync.epoch') }}</span><b>{{ status.keyEpoch ?? '—' }}</b></li>
          <li><span>{{ t('account.sync.conflicts') }}</span><b>{{ status.conflicts }}</b></li>
          <li v-if="status.pendingCleanup"><span>{{ t('account.sync.pendingCleanup') }}</span><b>{{ t('dict.yes') }}</b></li>
        </ul>

        <div class="primary-row">
          <button v-if="!status.unlocked" class="btn primary" @click="act('devbelt.syncEntry')">{{ t('account.action.unlockOrInitialize') }}</button>
          <button v-else class="btn primary" @click="act('devbelt.syncNow')">{{ t('account.action.syncNow') }}</button>
          <button class="btn" @click="act('devbelt.syncDoctor')">{{ t('account.sync.diagnostics') }}</button>
        </div>

        <details class="advanced">
          <summary>{{ status.unlocked ? t('account.sync.advanced') : t('account.sync.troubleshoot') }}</summary>
          <div class="actions">
            <template v-if="!status.unlocked">
              <button class="btn" @click="act('devbelt.recoverSync')">{{ t('account.action.recoverSync') }}</button>
              <button class="btn" @click="act('devbelt.recoverByAccount')">{{ t('account.action.recoverByAccount') }}</button>
              <button class="btn danger" @click="act('devbelt.resetSync')">{{ t('account.action.resetSync') }}</button>
            </template>
            <template v-else>
              <button class="btn" @click="act('devbelt.syncPull')">{{ t('account.action.pull') }}</button>
              <button class="btn" @click="act('devbelt.syncPush')">{{ t('account.action.push') }}</button>
              <button class="btn" @click="act('devbelt.changeSyncPassword')">{{ t('account.action.changeSyncPassword') }}</button>
            </template>
          </div>
        </details>
      </section>
    </template>
  </div>
</template>

<style scoped>
.panel { padding: 16px; max-width: 760px; }
.head { margin-bottom: 14px; }
.title { font-size: 16px; font-weight: 600; }
.sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; }
.card { border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); border-radius: 8px; padding: 14px; }
.kv { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13px; }
.kv li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12)); }
.kv li:last-child { border-bottom: none; }
.kv span { color: var(--vscode-descriptionForeground); }
.primary-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.advanced { border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12)); padding-top: 8px; }
.advanced summary { cursor: pointer; font-size: 12.5px; color: var(--vscode-descriptionForeground); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.btn { background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2)); color: var(--vscode-button-secondaryForeground, inherit); border: none; padding: 7px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3)); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
.btn.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
.btn.danger:hover { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
.err { color: var(--vscode-errorForeground); font-size: 13px; }
.loading { color: var(--vscode-descriptionForeground); }
</style>