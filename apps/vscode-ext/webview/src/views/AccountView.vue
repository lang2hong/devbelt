<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 账户面板（可视化控制台）：账户 / 个人同步 / 连接数据 / 账号操作，全部按钮化。
 * 同步按钮严格按状态显隐（与命令可用性保持一致）：
 *   未初始化 → 初始化；已锁定 → 解锁 + 恢复类；已解锁 → 拉取/推送/改口令/清除。
 * 消息协议（与 src/sync/accountView.ts 对齐）：
 *   webview → ext: ready | action{action}
 *   ext → webview: me{me} | syncStatus{status} | error{message}
 */
const { post, onMessage } = useVsCode();
let __offMsg: (() => void) | undefined;
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
  // 统一入口后不再用本机 initialized 判定（第二台设备会误判）；只看解锁态。
  return s?.unlocked ? t('account.sync.unlocked') : t('account.sync.locked');
}

/** 状态灯：绿=已解锁，橙=已锁定，灰=未初始化。 */
function statusClass(s: SyncStatus | null): string {
  if (s?.unlocked) return 'ok';
  if (s?.initialized) return 'locked';
  return 'off';
}

function act(action: string): void {
  post({ type: 'action', action });
}

onMounted(() => {
  post({ type: 'ready', view: 'account' });
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'me') { me.value = msg.me; loaded.value = true; errorMsg.value = ''; }
    else if (msg.type === 'syncStatus') status.value = msg.status;
    else if (msg.type === 'error') errorMsg.value = msg.message;
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="account-panel">
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
    <div v-else-if="!loaded" class="loading">…</div>
    <div v-else-if="!me" class="loading">{{ t('account.loginRequired') }}</div>
    <template v-else>
      <!-- 账户卡片 -->
      <section class="card">
        <header class="card-head">
          <span class="dot ok"></span>
          <div>
            <div class="title">{{ me.user.email }}</div>
            <div class="sub">{{ me.subscription?.planCode || 'free' }}</div>
          </div>
        </header>
        <ul class="kv">
          <li><span>{{ t('account.status') }}</span><b>{{ me.subscription?.status || 'active' }}</b></li>
          <li><span>{{ t('account.databases') }}</span><b>{{ (me.subscription?.entitlement?.allowedDatabaseTypes || []).join(', ') || '—' }}</b></li>
          <li><span>{{ t('account.devices') }}</span><b>{{ maxDevices(me.subscription?.entitlement?.maxDevices) }}</b></li>
        </ul>
      </section>

      <!-- 个人同步卡片（状态灯 + 状态驱动按钮） -->
      <section class="card">
        <header class="card-head">
          <span class="dot" :class="statusClass(status)"></span>
          <div>
            <div class="title">{{ t('account.card.sync') }}</div>
            <div class="sub">{{ t('account.card.syncHint') }}</div>
          </div>
        </header>
        <ul class="kv">
          <li><span>{{ t('account.sync.state') }}</span><b>{{ syncStateLabel(status) }}</b></li>
          <li><span>{{ t('account.sync.epoch') }}</span><b>{{ status?.keyEpoch ?? '—' }}</b></li>
          <li><span>{{ t('account.sync.conflicts') }}</span><b>{{ status?.conflicts ?? 0 }}</b></li>
        </ul>

        <!-- 未解锁（未初始化或已锁定）：单一入口，按远端状态自动路由（有→解锁，无→初始化） -->
        <div v-if="!status?.unlocked" class="actions">
          <button class="btn primary" @click="act('devbelt.syncEntry')">{{ t('account.action.unlockOrInitialize') }}</button>
          <button class="btn" @click="act('devbelt.recoverSync')">{{ t('account.action.recoverSync') }}</button>
          <button class="btn" @click="act('devbelt.recoverByAccount')">{{ t('account.action.recoverByAccount') }}</button>
          <button class="btn" @click="act('devbelt.resetSync')">{{ t('account.action.resetSync') }}</button>
        </div>
        <!-- 已解锁：手动同步（自动同步由开关/聚焦/本地变更负责） -->
        <div v-else class="actions">
          <button class="btn" @click="act('devbelt.syncNow')">{{ t('account.action.syncNow') }}</button>
          <button class="btn" @click="act('devbelt.syncPull')">{{ t('account.action.pull') }}</button>
          <button class="btn" @click="act('devbelt.syncPush')">{{ t('account.action.push') }}</button>
          <button class="btn" @click="act('devbelt.changeSyncPassword')">{{ t('account.action.changeSyncPassword') }}</button>
        </div>
      </section>

      <!-- 连接数据卡片 -->
      <section class="card">
        <header class="card-head">
          <span class="dot"></span>
          <div class="title">{{ t('account.card.data') }}</div>
        </header>
        <div class="actions">
          <button class="btn" @click="act('devbelt.importConnections')">{{ t('account.action.importConnections') }}</button>
          <button class="btn" @click="act('devbelt.exportConnections')">{{ t('account.action.exportConnections') }}</button>
        </div>
      </section>

      <!-- 账号操作卡片 -->
      <section class="card">
        <header class="card-head">
          <span class="dot"></span>
          <div class="title">{{ t('account.card.accountOps') }}</div>
        </header>
        <div class="actions">
          <button class="btn" @click="act('devbelt.changeLoginPassword')">{{ t('account.action.changeLoginPassword') }}</button>
          <button class="btn" @click="act('devbelt.sessions')">{{ t('account.action.sessions') }}</button>
          <button class="btn" @click="act('devbelt.plans')">{{ t('account.action.plans') }}</button>
          <button class="btn" @click="act('devbelt.openConsole')">{{ t('account.action.openConsole') }}</button>
          <button class="btn danger" @click="act('devbelt.logout')">{{ t('account.action.logout') }}</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.account-panel { padding: 16px; box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
.err { color: var(--vscode-errorForeground); }
.loading { color: var(--vscode-descriptionForeground); }
.card { border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); border-radius: 8px; padding: 14px; background: var(--vscode-editor-background, #fff); }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-descriptionForeground, #8c8c8c); flex-shrink: 0; }
.dot.ok { background: #2ea043; }
.dot.locked { background: #d29922; }
.dot.off { background: var(--vscode-descriptionForeground, #8c8c8c); }
.title { font-size: 14px; font-weight: 600; }
.sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.kv { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13px; }
.kv li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12)); }
.kv li:last-child { border-bottom: none; }
.kv li span { color: var(--vscode-descriptionForeground); }
.kv li b { font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.primary { font-weight: 600; }
.btn.danger { background: var(--vscode-errorForeground); color: #fff; }
</style>
