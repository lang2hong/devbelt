<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 账户面板：账户/订阅基本信息 + 个人同步状态 + 操作入口。
 * 消息协议（与 src/sync/accountView.ts 对齐）：
 *   webview → ext: ready | action{action}
 *   ext → webview: me{me} | syncStatus{status} | error{message}
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface Me {
  user: { userId: string; email: string; displayName: string | null; emailVerified: boolean; status: string; lastLoginTime: string | null };
  subscription: {
    planCode: string | null;
    status: string | null;
    entitlement: { allowedDatabaseTypes: string[]; maxDevices: number } | null;
    periodStartTime: string | null;
    periodEndTime: string | null;
  } | null;
}

interface SyncStatus {
  initialized: boolean;
  unlocked: boolean;
  keyEpoch: string | null;
  conflicts: number;
  pendingCleanup: boolean;
}

const me = ref<Me | null>(null);
const status = ref<SyncStatus | null>(null);
const loaded = ref(false);
const errorMsg = ref('');

function maxDevices(v: number | null | undefined): string {
  return v === 0 || v == null ? '∞' : String(v);
}

function syncStateLabel(s: SyncStatus | null): string {
  if (!s || !s.initialized) return t('account.sync.notInitialized');
  return s.unlocked ? t('account.sync.unlocked') : t('account.sync.locked');
}

function act(action: string): void {
  post({ type: 'action', action });
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'me') { me.value = msg.me; loaded.value = true; errorMsg.value = ''; }
    else if (msg.type === 'syncStatus') status.value = msg.status;
    else if (msg.type === 'error') errorMsg.value = msg.message;
  });
});
</script>

<template>
  <div class="account-panel">
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
    <div v-else-if="!loaded" class="loading">…</div>
    <div v-else-if="!me" class="loading">{{ t('account.loginRequired') }}</div>
    <template v-else>
      <header class="header">
        <div class="header-title">{{ me.user.email }}</div>
        <div class="header-sub">{{ t('account.freePlan') }}</div>
      </header>
      <ul class="kv">
        <li><span>{{ t('account.subscription') }}</span><b>{{ me.subscription?.planCode || 'free' }}</b></li>
        <li><span>{{ t('account.status') }}</span><b>{{ me.subscription?.status || 'active' }}</b></li>
        <li><span>{{ t('account.databases') }}</span><b>{{ (me.subscription?.entitlement?.allowedDatabaseTypes || []).join(', ') || '—' }}</b></li>
        <li><span>{{ t('account.devices') }}</span><b>{{ maxDevices(me.subscription?.entitlement?.maxDevices) }}</b></li>
      </ul>

      <h4 class="section">{{ t('account.sync') }}</h4>
      <ul class="kv">
        <li><span>{{ t('account.sync.state') }}</span><b>{{ syncStateLabel(status) }}</b></li>
        <li><span>{{ t('account.sync.epoch') }}</span><b>{{ status?.keyEpoch ?? '—' }}</b></li>
        <li><span>{{ t('account.sync.conflicts') }}</span><b>{{ status?.conflicts ?? 0 }}</b></li>
        <li v-if="status?.pendingCleanup"><span>{{ t('account.sync.pendingCleanup') }}</span><b>…</b></li>
      </ul>

      <h4 class="section">{{ t('account.actions') }}</h4>
      <div class="actions">
        <button class="btn" @click="act('dbclient.changeLoginPassword')">{{ t('account.action.changeLoginPassword') }}</button>
        <button class="btn" @click="act('dbclient.changeSyncPassword')">{{ t('account.action.changeSyncPassword') }}</button>
        <button class="btn" @click="act('dbclient.recoverSync')">{{ t('account.action.recoverSync') }}</button>
        <button class="btn" @click="act('dbclient.recoverByAccount')">{{ t('account.action.recoverByAccount') }}</button>
        <button class="btn" @click="act('dbclient.syncPull')">{{ t('account.action.pull') }}</button>
        <button class="btn" @click="act('dbclient.syncPush')">{{ t('account.action.push') }}</button>
        <button class="btn" @click="act('dbclient.resetSync')">{{ t('account.action.resetSync') }}</button>
        <button class="btn" @click="act('dbclient.sessions')">{{ t('account.action.sessions') }}</button>
        <button class="btn" @click="act('dbclient.openConsole')">{{ t('account.action.openConsole') }}</button>
        <button class="btn danger" @click="act('dbclient.logout')">{{ t('account.action.logout') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.account-panel { padding: 24px; height: 100%; box-sizing: border-box; overflow-y: auto; }
.err { color: var(--vscode-errorForeground); }
.loading { color: var(--vscode-descriptionForeground); }
.header { margin-bottom: 20px; }
.header-title { font-size: 18px; font-weight: 600; }
.header-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.section { margin: 20px 0 8px; font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
.kv { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.kv li { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); }
.kv li span { color: var(--vscode-descriptionForeground); }
.kv li b { font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.danger { background: var(--vscode-errorForeground); color: #fff; }
</style>