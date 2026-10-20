<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { formatDateTime } from '../utils/formatTime';

/**
 * 账户概览：只展示身份与订阅摘要。
 * 同步、设备、套餐、安全分别由顶部页签承载，避免这里重复入口。
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

const me = ref<Me | null>(null);
const loaded = ref(false);
const errorMsg = ref('');

function maxDevices(v: number | null | undefined): string {
  return v === 0 || v == null ? '∞' : String(v);
}

function act(action: string): void {
  post({ type: 'action', action });
}

onMounted(() => {
  post({ type: 'ready', view: 'account' });
  __offMsg = onMessage((msg: any) => {
    if (msg.type === 'me') { me.value = msg.me; loaded.value = true; errorMsg.value = ''; }
    else if (msg.type === 'error') errorMsg.value = msg.message;
  });
});

onUnmounted(() => { __offMsg?.(); });
</script>

<template>
  <div class="account-panel">
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
    <div v-else-if="!loaded" class="loading">…</div>
    <template v-else-if="!me">
      <div class="loading">{{ t('account.loginRequired') }}</div>
    </template>
    <template v-else>
      <section class="card">
        <header class="card-head">
          <span class="dot ok"></span>
          <div>
            <div class="title">{{ me.user.email }}</div>
            <div class="sub">{{ me.subscription?.planCode || 'free' }}</div>
          </div>
        </header>
        <ul class="kv">
          <li><span>{{ t('account.plan') }}</span><b>{{ me.subscription?.planCode || 'free' }}</b></li>
          <li><span>{{ t('account.status') }}</span><b>{{ me.subscription?.status || 'active' }}</b></li>
          <li><span>{{ t('account.expires') }}</span><b>{{ formatDateTime(me.subscription?.periodEndTime) }}</b></li>
          <li><span>{{ t('account.databases') }}</span><b>{{ (me.subscription?.entitlement?.allowedDatabaseTypes || []).join(', ') || '—' }}</b></li>
          <li><span>{{ t('account.devices') }}</span><b>{{ maxDevices(me.subscription?.entitlement?.maxDevices) }}</b></li>
        </ul>
      </section>

      <section class="card">
        <header class="card-head">
          <span class="dot"></span>
          <div class="title">{{ t('account.card.quick') }}</div>
        </header>
        <div class="actions">
          <button class="btn" @click="act('devbelt.openConsole')">{{ t('account.action.openConsole') }}</button>
          <button class="btn danger" @click="act('devbelt.logout')">{{ t('account.action.logout') }}</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.account-panel { padding: 16px; box-sizing: border-box; overflow-y: auto; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); align-content: start; }
.account-panel > .err, .account-panel > .loading { grid-column: 1 / -1; }
.err { color: var(--vscode-errorForeground); }
.loading { color: var(--vscode-descriptionForeground); }
.card { border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); border-radius: 8px; padding: 14px; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-descriptionForeground, #8c8c8c); flex-shrink: 0; }
.dot.ok { background: var(--vscode-testing-iconPassed, #2ea043); }
.title { font-size: 14px; font-weight: 600; }
.sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.kv { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.kv li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12)); }
.kv li:last-child { border-bottom: none; }
.kv li span { color: var(--vscode-descriptionForeground); }
.kv li b { font-weight: 600; text-align: right; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2)); color: var(--vscode-button-secondaryForeground, inherit); border: none; padding: 7px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3)); }
.btn.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
.btn.danger:hover { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
</style>