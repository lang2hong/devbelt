<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getOverview, type AdminOverview } from '../api/admin';
import { setAccessToken } from '@devbelt/auth-client';

/**
 * 平台概览：用户 / 设备 / 同步 / AI / 营收 / 反馈的只读聚合。
 * 数据来自现有表与 user_feedback，无独立埋点。
 */
const data = ref<AdminOverview | null>(null);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');

const STATUS_LABEL: Record<string, string> = {
  new: '待处理',
  triaged: '已分类',
  done: '已处理',
  rejected: '已拒绝',
};

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
        <p class="sub">用户、设备、同步、AI 用量与反馈的当前快照。</p>
      </div>
      <button class="btn" :disabled="state === 'loading'" @click="load">刷新</button>
    </header>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">{{ error }}</p>

    <template v-else-if="data">
      <div class="cards">
        <div class="card"><div class="label">用户总数</div><div class="value">{{ data.users.total }}</div></div>
        <div class="card"><div class="label">7 日新增</div><div class="value">{{ data.users.new7d }}</div></div>
        <div class="card"><div class="label">7 日活跃</div><div class="value">{{ data.users.active7d }}</div></div>
        <div class="card"><div class="label">活跃设备</div><div class="value">{{ data.devices.active }}</div></div>
        <div class="card"><div class="label">云端连接</div><div class="value">{{ data.sync.connectionMetas }}</div></div>
        <div class="card"><div class="label">云端存储</div><div class="value">{{ fmtBytes(data.sync.storageBytes) }}</div></div>
        <div class="card"><div class="label">已启用同步用户</div><div class="value">{{ data.sync.syncedUsers }}</div></div>
        <div class="card"><div class="label">本月 AI tokens</div><div class="value">{{ fmtTokens(data.ai.monthTokens) }}</div><div class="hint">{{ data.ai.monthRequests }} 次请求</div></div>
        <div class="card"><div class="label">近 30 天营收</div><div class="value">{{ fmtCents(data.billing.revenueCents30d) }}</div><div class="hint">{{ data.billing.paidOrders30d }} 笔支付</div></div>
        <div class="card"><div class="label">其中 AI 充值（30 天）</div><div class="value">{{ fmtCents(data.billing.topupRevenueCents30d) }}</div><div class="hint">{{ data.billing.topupOrders30d }} 笔，已含在营收内</div></div>
        <div class="card" :class="{ alert: data.feedback.newCount > 0 }"><div class="label">待处理反馈</div><div class="value">{{ data.feedback.newCount }}</div><div class="hint">共 {{ data.feedback.byStatus.reduce((a, b) => a + b.count, 0) }} 条</div></div>
      </div>

      <div class="section-head">
        <h3>扩展安装与活跃</h3>
        <span class="muted">匿名心跳口径，非 Marketplace 安装数</span>
      </div>
      <div class="cards">
        <div class="card"><div class="label">安装总数</div><div class="value">{{ data.telemetry.totalInstalls }}</div><div class="hint">首次激活</div></div>
        <div class="card"><div class="label">7 日新安装</div><div class="value">{{ data.telemetry.newInstalls7d }}</div><div class="hint">30 日 {{ data.telemetry.newInstalls30d }}</div></div>
        <div class="card"><div class="label">24 小时活跃</div><div class="value">{{ data.telemetry.active24h }}</div></div>
        <div class="card"><div class="label">7 日活跃</div><div class="value">{{ data.telemetry.active7d }}</div></div>
        <div class="card"><div class="label">30 日活跃</div><div class="value">{{ data.telemetry.active30d }}</div></div>
      </div>

      <div class="panels">
        <div class="panel">
          <h3>活跃设备平台</h3>
          <ul v-if="data.devices.platforms.length">
            <li v-for="p in data.devices.platforms" :key="p.platform">
              <span>{{ p.platform || '（未知）' }}</span><b>{{ p.count }}</b>
            </li>
          </ul>
          <p v-else class="muted">暂无数据。</p>
        </div>
        <div class="panel">
          <h3>客户端版本</h3>
          <ul v-if="data.devices.versions.length">
            <li v-for="v in data.devices.versions" :key="v.version">
              <span class="mono">{{ v.version || '—' }}</span><b>{{ v.count }}</b>
            </li>
          </ul>
          <p v-else class="muted">暂无数据。</p>
        </div>
        <div class="panel">
          <h3>反馈状态</h3>
          <ul v-if="data.feedback.byStatus.length">
            <li v-for="s in data.feedback.byStatus" :key="s.status">
              <span>{{ STATUS_LABEL[s.status] ?? s.status }}</span><b>{{ s.count }}</b>
            </li>
          </ul>
          <p v-else class="muted">暂无反馈。</p>
        </div>
        <div class="panel">
          <h3>反馈分类</h3>
          <ul v-if="data.feedback.byCategory.length">
            <li v-for="c in data.feedback.byCategory" :key="c.category">
              <span>{{ CATEGORY_LABEL[c.category] ?? c.category }}</span><b>{{ c.count }}</b>
            </li>
          </ul>
          <p v-else class="muted">暂无反馈。</p>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; color: var(--c-text-muted); font-size: 13px; }
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.card { padding: 14px 16px; border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface); }
.card .label { color: var(--c-text-muted); font-size: 12px; }
.card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
.card .hint { color: var(--c-text-muted); font-size: 12px; margin-top: 2px; }
.card.alert { border-color: var(--c-accent); }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-top: 4px; }
.section-head h3 { margin: 0; font-size: 14px; }
.panels { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.panel { padding: 14px 16px; border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface); }
.panel h3 { margin: 0 0 10px; font-size: 14px; }
.panel ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.panel li { display: flex; justify-content: space-between; font-size: 13px; }
.mono { font-family: var(--c-font-mono, monospace); }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
</style>