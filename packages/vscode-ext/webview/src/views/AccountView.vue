<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';

/**
 * 账户/套餐面板（Vue 版）：三套餐卡片对比 + 当前高亮 + 特征列表 + 用量。
 * 消息协议（与 src/sync/accountView.ts 对齐）：
 *   webview → ext: ready | upgrade{code}
 *   ext → webview: init{mode:'account'} | me{me} | error{message}
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

interface PlanInfo {
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  perSeatMaxDevices: number;
  perUserMaxPrivateConnections: number;
  perUserMaxOpenConnections: number;
  perUserPrivateSyncQuotaBytes: number;
  perUserSyncVersionRetention: number;
  perUserHistoryRetentionCount: number;
  features: number;
}

interface Me {
  user: { id: number; email: string; role: string; status: string };
  plan: PlanInfo;
  plans: PlanInfo[];
  subscription?: { planId: number; status: string };
  usage: { devices: number; connections: number; syncBytes: number };
}

// 与 server domain/enums.ts Feature 位掩码对齐（basic=1<<0 ... export_connections=1<<6）
const FEATURES: Array<{ bit: number; key: string }> = [
  { bit: 1, key: 'account.feature.basic' },
  { bit: 2, key: 'account.feature.er_export' },
  { bit: 4, key: 'account.feature.excel' },
  { bit: 8, key: 'account.feature.datatransfer' },
  { bit: 16, key: 'account.feature.team_share' },
  { bit: 32, key: 'account.feature.audit_log' },
  { bit: 64, key: 'account.feature.export_connections' },
];

const me = ref<Me | null>(null);
const errorMsg = ref('');

function hasFeature(plan: PlanInfo, bit: number): boolean {
  return (plan.features & bit) === bit;
}

function num(v: number): string {
  return v === 0 ? '∞' : String(v);
}

function bytes(n: number): string {
  if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 1073741824 * 10 ? 0 : 1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function upgrade(code: string) {
  post({ type: 'upgrade', code });
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
        <div class="header-title">{{ me.plan.name }}</div>
        <div class="header-sub">{{ t('account.subscription') }}: {{ me.subscription ? me.subscription.status : '-' }}</div>
      </header>

      <div class="plans">
        <div
          v-for="p in me.plans"
          :key="p.code"
          class="plan"
          :class="{ current: p.code === me.plan.code, highlight: p.code === 'pro' && p.code !== me.plan.code }"
        >
          <div class="plan-top">
            <span class="plan-name">{{ p.name }}</span>
            <span v-if="p.code === me.plan.code" class="badge">{{ t('account.current') }}</span>
            <span v-else-if="p.code === 'pro'" class="badge popular">{{ t('account.popular') }}</span>
          </div>

          <div class="price">
            <template v-if="p.priceMonth === 0">
              <span class="amount">{{ t('account.free') }}</span>
            </template>
            <template v-else>
              <span class="currency">¥</span>
              <span class="amount">{{ p.priceMonth }}</span>
              <span class="period">{{ t('account.perMonth') }}</span>
            </template>
          </div>

          <div class="divider"></div>

          <ul class="quota">
            <li><span>{{ t('account.devices') }}</span><b>{{ num(p.perSeatMaxDevices) }}</b></li>
            <li><span>{{ t('account.connections') }}</span><b>{{ num(p.perUserMaxPrivateConnections) }}</b></li>
            <li><span>{{ t('account.openConnections') }}</span><b>{{ num(p.perUserMaxOpenConnections) }}</b></li>
            <li><span>{{ t('account.sync') }}</span><b>{{ p.perUserPrivateSyncQuotaBytes ? bytes(p.perUserPrivateSyncQuotaBytes) : '∞' }}</b></li>
            <li><span>{{ t('account.versionHistory') }}</span><b>{{ num(p.perUserSyncVersionRetention) }}</b></li>
          </ul>

          <ul class="features">
            <li v-for="f in FEATURES" :key="f.key" :class="{ on: hasFeature(p, f.bit) }">
              <span class="mark" :class="hasFeature(p, f.bit) ? 'on' : 'off'">{{ hasFeature(p, f.bit) ? '✓' : '×' }}</span>
              <span class="fname">{{ t(f.key) }}</span>
            </li>
          </ul>

          <button v-if="p.code !== me.plan.code" class="upgrade-btn" @click="upgrade(p.code)">
            {{ t('account.upgrade') }}
          </button>
        </div>
      </div>

      <div class="usage">
        <span>{{ t('account.connections') }}: <b>{{ me.usage.connections }}/{{ me.plan.perUserMaxPrivateConnections || '∞' }}</b></span>
        <span>{{ t('account.devices') }}: <b>{{ me.usage.devices }}/{{ me.plan.perSeatMaxDevices || '∞' }}</b></span>
        <span>{{ t('account.sync') }}: <b>{{ bytes(me.usage.syncBytes) }}</b></span>
      </div>
      <p class="hint">{{ t('account.upgradeHint') }}</p>
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

.plans { display: flex; gap: 16px; align-items: stretch; }
.plan {
  flex: 1; border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  border-radius: 10px; padding: 20px;
  background: var(--vscode-editor-background);
  display: flex; flex-direction: column;
  transition: border-color .15s, box-shadow .15s;
}
.plan.current { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.plan.highlight { border-color: rgba(242, 142, 43, 0.55); }

.plan-top { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; min-height: 22px; }
.plan-name { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
.badge {
  font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  background: var(--vscode-focusBorder); color: #fff;
  text-transform: uppercase; letter-spacing: .5px;
}
.badge.popular { background: #f28e2b; }

.price { display: flex; align-items: baseline; margin-bottom: 14px; }
.price .currency { font-size: 18px; font-weight: 600; }
.price .amount { font-size: 34px; font-weight: 700; line-height: 1; }
.price .period { font-size: 13px; color: var(--vscode-descriptionForeground); margin-left: 4px; }

.divider { height: 1px; background: var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); margin-bottom: 14px; }

.quota { list-style: none; margin: 0 0 14px; padding: 0; font-size: 13px; }
.quota li { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
.quota li span { color: var(--vscode-descriptionForeground); }
.quota li b { font-weight: 600; }

.features { list-style: none; margin: 0; padding: 0; font-size: 13px; flex: 1; }
.features li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.features .mark { width: 16px; text-align: center; font-weight: 700; font-size: 13px; }
.features .mark.on { color: var(--vscode-testing-iconPassed-color, #4ec9b0); }
.features .mark.off { color: var(--vscode-descriptionForeground); opacity: .4; }
.features .fname { color: var(--vscode-descriptionForeground); }
.features li.on .fname { color: var(--vscode-foreground); }

.upgrade-btn {
  margin-top: 16px; padding: 8px; border: 1px solid var(--vscode-focusBorder);
  background: transparent; color: var(--vscode-focusBorder);
  border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
}
.upgrade-btn:hover { background: var(--vscode-focusBorder); color: #fff; }

.usage {
  margin-top: 22px; border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  padding-top: 14px; display: flex; gap: 24px; font-size: 12px;
}
.usage span { color: var(--vscode-descriptionForeground); }
.usage b { color: var(--vscode-foreground); font-weight: 600; }

.hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 12px 0 0; }
</style>