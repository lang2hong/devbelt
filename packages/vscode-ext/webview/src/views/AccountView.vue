<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 账户面板：展示邮箱与个人 Free 权益。
 * 消息协议（与 src/sync/accountView.ts 对齐）：
 *   webview → ext: ready
 *   ext → webview: init{mode:'account'} | me{me} | error{message}
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

const me = ref<Me | null>(null);
const errorMsg = ref('');

function maxDevices(v: number | null | undefined): string {
  return v === 0 || v == null ? '∞' : String(v);
}

onMounted(() => {
  post({ type: 'ready' });
  onMessage((msg: any) => {
    if (msg.type === 'me') me.value = msg.me;
    else if (msg.type === 'error') errorMsg.value = msg.message;
  });
});
</script>

<template>
  <div class="account-panel">
    <div class="err" v-if="errorMsg">{{ errorMsg }}</div>
    <template v-else-if="me">
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
    </template>
    <div v-else class="loading">…</div>
  </div>
</template>

<style scoped>
.account-panel { padding: 24px; height: 100%; box-sizing: border-box; overflow-y: auto; }
.err { color: var(--vscode-errorForeground); }
.loading { color: var(--vscode-descriptionForeground); }
.header { margin-bottom: 20px; }
.header-title { font-size: 18px; font-weight: 600; }
.header-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.kv { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.kv li { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); }
.kv li span { color: var(--vscode-descriptionForeground); }
.kv li b { font-weight: 600; }
</style>
