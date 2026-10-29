<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getOverview, type AdminOverview } from '../api/admin';
import { setAccessToken } from '@devbelt/auth-client';
import TelemetryTrendChart from '../components/TelemetryTrendChart.vue';
import DonutChart from '../components/charts/DonutChart.vue';
import BarListChart from '../components/charts/BarListChart.vue';
import DailyBarChart from '../components/charts/DailyBarChart.vue';
import { chartColor } from '../components/charts/palette';

/**
 * 平台概览：图表化仪表盘。
 * 数据来自既有表；趋势口径均为 UTC，服务端已补齐 30 天。
 */
const data = ref<AdminOverview | null>(null);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

const STATUS_LABEL: Record<string, string> = {
  new: '待回复',
  triaged: '处理中',
  done: '已解决',
  rejected: '已关闭',
};
const STATUS_COLOR: Record<string, string> = {
  new: 'var(--c-accent)',
  triaged: '#d9ad2b',
  done: '#3aa675',
  rejected: '#d6303f',
};
const STATUS_ORDER = ['new', 'triaged', 'done', 'rejected'] as const;

const CATEGORY_LABEL: Record<string, string> = {
  bug: 'Bug',
  feature: '功能建议',
  other: '其他',
};

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCents(n: number): string {
  return `¥${(n / 100).toFixed(2)}`;
}

const platformItems = computed(() => (data.value?.devices.platforms ?? [])
  .map((p, i) => ({ label: p.platform || '未知', value: p.count, color: chartColor(i) })));

const versionItems = computed(() => (data.value?.devices.versions ?? [])
  .map((v, i) => ({ label: v.version || '未知', value: v.count, color: chartColor(i) })));

const statusItems = computed(() => {
  const counts = new Map((data.value?.feedback.byStatus ?? []).map((s) => [s.status, s.count]));
  return STATUS_ORDER
    .map((status) => ({ label: STATUS_LABEL[status] ?? status, value: counts.get(status) ?? 0, color: STATUS_COLOR[status] }))
    .filter((i) => i.value > 0);
});

const categoryItems = computed(() => (data.value?.feedback.byCategory ?? [])
  .map((c, i) => ({ label: CATEGORY_LABEL[c.category] ?? c.category, value: c.count, color: chartColor(i) }))
  .filter((i) => i.value > 0));

const revenueItems = computed(() => {
  const b = data.value?.billing;
  if (!b) return [];
  const plan = Math.max(0, b.revenueCents30d - b.topupRevenueCents30d);
  return [
    { label: '套餐', value: plan, color: 'var(--c-accent)' },
    { label: 'AI 充值', value: b.topupRevenueCents30d, color: '#3aa675' },
  ].filter((i) => i.value > 0);
});

const activeWindowItems = computed(() => {
  const t = data.value?.telemetry;
  if (!t) return [];
  return [
    { label: '24 小时', value: t.active24h, color: 'var(--c-accent)' },
    { label: '7 天', value: t.active7d, color: '#3aa675' },
    { label: '30 天', value: t.active30d, color: '#d9ad2b' },
  ];
});

const feedbackTotal = computed(() => (data.value?.feedback.byStatus ?? []).reduce((n, s) => n + s.count, 0));
const processedFeedback = computed(() => {
  const counts = data.value?.feedback.byStatus ?? [];
  return counts.find((s) => s.status === 'triaged')?.count ?? 0;
});

async function load(): Promise<void> {
  state.value = 'loading';
  error.value = '';
  const r = await getOverview();
  if (r.kind === 'ok') {
    data.value = r.value;
    state.value = 'ready';
    return;
  }
  if (r.kind === 'unauthorized') { relogin(); return; }
  state.value = 'error';
  error.value = r.kind === 'forbidden' ? '需要平台管理员权限。' : '加载失败，请稍后重试。';
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="head">
      <div>
        <h2>概览</h2>
        <p class="sub">用户、安装、营收、AI 与反馈的图表化快照。趋势按 UTC 日期。</p>
      </div>
      <button class="btn" :disabled="state === 'loading'" @click="load">刷新</button>
    </header>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">{{ error }}</p>

    <template v-else-if="data">
      <div class="kpis">
        <div class="kpi">
          <div class="kpi-label">用户总数</div>
          <div class="kpi-value">{{ data.users.total.toLocaleString('zh-CN') }}</div>
          <div class="kpi-hint">7 日新增 {{ data.users.new7d }} · 7 日活跃 {{ data.users.active7d }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">安装总数</div>
          <div class="kpi-value">{{ data.telemetry.totalInstalls.toLocaleString('zh-CN') }}</div>
          <div class="kpi-hint">7 日新装 {{ data.telemetry.newInstalls7d }} · 30 日 {{ data.telemetry.newInstalls30d }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">7 日活跃安装</div>
          <div class="kpi-value">{{ data.telemetry.active7d.toLocaleString('zh-CN') }}</div>
          <div class="kpi-hint">24 小时 {{ data.telemetry.active24h }} · 30 日 {{ data.telemetry.active30d }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">近 30 天营收</div>
          <div class="kpi-value">{{ fmtCents(data.billing.revenueCents30d) }}</div>
          <div class="kpi-hint">{{ data.billing.paidOrders30d }} 笔支付 · 其中 AI 充值 {{ fmtCents(data.billing.topupRevenueCents30d) }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">本月 AI tokens</div>
          <div class="kpi-value">{{ fmtTokens(data.ai.monthTokens) }}</div>
          <div class="kpi-hint">计费 {{ fmtTokens(data.ai.monthBilledTokens) }} · {{ data.ai.monthRequests }} 次请求</div>
        </div>
        <div class="kpi" :class="{ alert: data.feedback.newCount > 0 }">
          <div class="kpi-label">待回复反馈</div>
          <div class="kpi-value">{{ data.feedback.newCount.toLocaleString('zh-CN') }}</div>
          <div class="kpi-hint">处理中 {{ processedFeedback }} · 共 {{ feedbackTotal }} 条</div>
        </div>
      </div>

      <div class="trend-grid">
        <section class="panel span-2">
          <header class="panel-head">
            <h3>安装与活跃趋势</h3>
            <span class="sub">近 30 天 · 活跃数据自上线起</span>
          </header>
          <TelemetryTrendChart :points="data.telemetry.daily" />
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>每日新增用户</h3>
            <span class="sub">按注册时间</span>
          </header>
          <DailyBarChart :points="data.users.daily" :series="[{ key: 'newUsers', label: '新增用户' }]" />
        </section>

        <section class="panel">
          <header class="panel-head">
            <h3>每日 AI tokens</h3>
            <span class="sub">原始用量</span>
          </header>
          <DailyBarChart :points="data.ai.daily" :series="[{ key: 'tokens', label: '原始 tokens' }]" kind="tokens" />
        </section>

        <section class="panel span-2">
          <header class="panel-head">
            <h3>每日营收</h3>
            <span class="sub">套餐 + AI 充值 · 已排除手工赠送单</span>
          </header>
          <DailyBarChart
            stacked
            :points="data.billing.daily"
            :series="[{ key: 'planCents', label: '套餐' }, { key: 'topupCents', label: 'AI 充值' }]"
            kind="money"
          />
        </section>
      </div>

      <div class="dist-grid">
        <section class="panel">
          <header class="panel-head"><h3>设备平台</h3><span class="sub">活跃设备</span></header>
          <DonutChart :items="platformItems" center-label="活跃设备" />
        </section>

        <section class="panel">
          <header class="panel-head"><h3>客户端版本</h3><span class="sub">活跃设备</span></header>
          <BarListChart :items="versionItems" />
        </section>

        <section class="panel">
          <header class="panel-head"><h3>反馈状态</h3><span class="sub">全部反馈</span></header>
          <DonutChart :items="statusItems" center-label="反馈" />
        </section>

        <section class="panel">
          <header class="panel-head"><h3>反馈分类</h3><span class="sub">全部反馈</span></header>
          <DonutChart :items="categoryItems" center-label="反馈" />
        </section>

        <section class="panel">
          <header class="panel-head"><h3>营收构成</h3><span class="sub">近 30 天</span></header>
          <DonutChart :items="revenueItems" center-label="营收" kind="money" />
        </section>

        <section class="panel">
          <header class="panel-head"><h3>活跃窗口</h3><span class="sub">滚动窗口，互相包含</span></header>
          <BarListChart :items="activeWindowItems" />
        </section>
      </div>

      <section class="panel ops">
        <header class="panel-head"><h3>同步与运行</h3><span class="sub">当前快照</span></header>
        <div class="ops-grid">
          <div><span>云端连接</span><b>{{ data.sync.connectionMetas.toLocaleString('zh-CN') }}</b></div>
          <div><span>云端存储</span><b>{{ fmtBytes(data.sync.storageBytes) }}</b></div>
          <div><span>已启用同步用户</span><b>{{ data.sync.syncedUsers.toLocaleString('zh-CN') }}</b></div>
          <div><span>本月计费 tokens</span><b>{{ fmtTokens(data.ai.monthBilledTokens) }}</b></div>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; color: var(--c-text-muted); font-size: 12px; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }

.kpis { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.kpi { padding: 14px 16px; border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface); min-width: 0; }
.kpi-label { color: var(--c-text-muted); font-size: 12px; }
.kpi-value { font-size: 24px; font-weight: 700; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi-hint { color: var(--c-text-muted); font-size: 11.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi.alert { border-color: var(--c-accent); }

.trend-grid { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.trend-grid .span-2 { grid-column: span 2; }
.dist-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }

.panel { padding: 14px 16px; border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface); min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.panel-head h3 { margin: 0; font-size: 14px; }
.panel-head .sub { font-size: 11.5px; }

.ops { margin-top: 2px; }
.ops-grid { display: grid; gap: 10px 24px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-top: 4px; }
.ops-grid div { display: flex; flex-direction: column; gap: 2px; }
.ops-grid span { color: var(--c-text-muted); font-size: 12px; }
.ops-grid b { font-size: 17px; font-weight: 700; }

.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }

@media (max-width: 900px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trend-grid { grid-template-columns: minmax(0, 1fr); }
  .trend-grid .span-2 { grid-column: auto; }
}
@media (max-width: 560px) {
  .kpis { grid-template-columns: minmax(0, 1fr); }
}
</style>