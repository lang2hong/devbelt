<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  createAdminAiModelPricing,
  getAdminAiBillingSettings,
  getAdminAiFinanceSummary,
  listAdminAiModelPricing,
  listAdminAiProviders,
  listAdminAiSkus,
  updateAdminAiBillingSettings,
  updateAdminAiModelPricing,
  type AdminAiBillingSettings,
  type AdminAiFinanceSummary,
  type AdminAiModelPricing,
  type AdminAiProvider,
  type AdminAiTopupSku,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import Modal from '../components/Modal.vue';
import Tabs from '../components/Tabs.vue';
import FormField from '../components/FormField.vue';
import { fmtCredits, costCentsPerCredit } from '../lib/credits';

/**
 * AI 计费（管理后台）：经营概览（区间毛利统计）/ 模型价格（含每模型倍率与毛利测算）/
 * 接入设置（厂商+模型联动选择）。上游 API Key 只写不读；写操作 reason 必填进审计。
 */

type BillingTab = 'overview' | 'pricing' | 'settings';
const tab = ref<BillingTab>('overview');

const settings = ref<AdminAiBillingSettings | null>(null);
const pricing = ref<AdminAiModelPricing[]>([]);
const providers = ref<AdminAiProvider[]>([]);
const skus = ref<AdminAiTopupSku[]>([]);
const summary = ref<AdminAiFinanceSummary | null>(null);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const write = useIdempotencyKey();

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtCents(cents: number | null): string {
  return cents === null ? '—' : `¥${(cents / 100).toFixed(2)}`;
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n.toLocaleString();
}

// ── 区间统计 ──
const RANGES: Array<{ key: string; label: string; months: number }> = [
  { key: 'this', label: '本月', months: 1 },
  { key: '3', label: '近 3 月', months: 3 },
  { key: '6', label: '近 6 月', months: 6 },
  { key: '12', label: '近 12 月', months: 12 },
];
const rangeKey = ref('this');

const rangeFromTo = computed(() => {
  const now = new Date();
  const to = monthKeyOf(now);
  const sel = RANGES.find((r) => r.key === rangeKey.value) ?? RANGES[0]!;
  if (sel.key === 'this') return { from: to, to };
  const from = new Date(now.getFullYear(), now.getMonth() - (sel.months - 1), 1);
  return { from: monthKeyOf(from), to };
});

async function loadSummary(): Promise<void> {
  const { from, to } = rangeFromTo.value;
  const r = await getAdminAiFinanceSummary(from, to);
  if (r.kind === 'ok') summary.value = r.value;
  else if (r.kind === 'unauthorized') relogin();
  else error.value = '统计加载失败。';
}

async function onRangeChange(): Promise<void> {
  summary.value = null;
  await loadSummary();
}

const actualOutputRatio = computed(() => {
  const t = summary.value?.total;
  if (!t || t.rawPromptTokens + t.rawCompletionTokens === 0) return null;
  return t.rawCompletionTokens / (t.rawPromptTokens + t.rawCompletionTokens);
});

const marginRate = computed(() => {
  const t = summary.value?.total;
  if (!t || t.costCents === null) return null;
  const revenue = t.topupCents + t.planCents;
  if (revenue === 0) return null;
  return (revenue - t.costCents) / revenue;
});

async function load(): Promise<void> {
  state.value = 'loading';
  const [s, p, pv, sk, sum] = await Promise.all([
    getAdminAiBillingSettings(),
    listAdminAiModelPricing(),
    listAdminAiProviders(),
    listAdminAiSkus(),
    getAdminAiFinanceSummary(rangeFromTo.value.from, rangeFromTo.value.to),
  ]);
  if (s.kind === 'ok' && p.kind === 'ok' && sum.kind === 'ok') {
    settings.value = s.value;
    pricing.value = p.value.items;
    providers.value = pv.kind === 'ok' ? pv.value.items : [];
    skus.value = sk.kind === 'ok' ? sk.value.items : [];
    summary.value = sum.value;
    state.value = 'ready';
  } else if (s.kind === 'unauthorized' || p.kind === 'unauthorized' || sum.kind === 'unauthorized') relogin();
  else state.value = 'error';
}

onMounted(() => void load());

// ── 毛利测算基准（模型价格表）──

/** 当前上架 SKU 中最低 ¥/积分（保守口径的积分参考售价）。 */
const creditPriceCents = computed(() => {
  const active = skus.value.filter((s) => s.status === 'active' && s.tokens > 0);
  if (active.length === 0) return null;
  return Math.min(...active.map((s) => (s.priceCents / s.tokens) * 1000));
});

function derivedWeight(p: AdminAiModelPricing): number {
  if (p.weightOverride !== null) return p.weightOverride;
  if (p.inputCentsPerM > 0) return Math.max(0.01, Math.min(100, p.outputCentsPerM / p.inputCentsPerM));
  return 1;
}

/** 每模型生效倍率（覆盖 ?? 全局）。 */
function effectiveMultiplier(p: AdminAiModelPricing): number {
  return p.multiplierOverride ?? settings.value?.globalMultiplier ?? 1;
}

/** 每积分成本（分；输入输出混合口径，输出占比为测算假设）。 */
function perCreditCostCents(p: AdminAiModelPricing): number {
  const ratio = settings.value?.typicalOutputRatio ?? 0.2;
  return costCentsPerCredit(p.inputCentsPerM, p.outputCentsPerM, derivedWeight(p), effectiveMultiplier(p), ratio);
}

/** 测算毛利率（对比最低价积分售价；测算值，非实际记账）。 */
/** 模型毛利表的测算毛利率（按模型名取计价行）。 */
function modelMarginRate(model: string): number | null {
  const p = pricing.value.find((x) => x.model === model);
  return p ? marginRateOf(p) : null;
}

function marginRateOf(p: AdminAiModelPricing): number | null {
  const price = creditPriceCents.value;
  if (price === null || price <= 0) return null;
  return (price - perCreditCostCents(p)) / price;
}

// ── 计费设置 ──

const activeModel = ref('');
const baseUrl = ref('');
const apiKey = ref('');
const clearKey = ref(false);
const multiplier = ref('1');
const outputRatio = ref('');
const settingsReason = ref('');
const showSettingsForm = ref(false);
const settingsProvider = ref('');

/** 可作为激活模型的计价行：全部计价行（模型唯一），按厂商筛选仅影响展示。 */
const activeModelOptions = computed(() => pricing.value.filter((p) => p.status === 'active'));

const providerOptions = computed(() => {
  const codes = new Set<string>();
  for (const p of pricing.value) if (p.providerCode) codes.add(p.providerCode);
  for (const pv of providers.value) codes.add(pv.code);
  return [...codes].sort();
});

const modelOptionsForProvider = computed(() =>
  activeModelOptions.value.filter((p) => !settingsProvider.value || p.providerCode === settingsProvider.value),
);

function openSettings(): void {
  const s = settings.value;
  activeModel.value = s?.activeModel ?? '';
  baseUrl.value = s?.upstreamBaseUrl ?? '';
  apiKey.value = '';
  clearKey.value = false;
  multiplier.value = String(s?.globalMultiplier ?? 1);
  outputRatio.value = String(s?.typicalOutputRatio ?? 0.2);
  settingsReason.value = '';
  settingsProvider.value = activeModelOptions.value.find((p) => p.model === activeModel.value)?.providerCode ?? '';
  error.value = '';
  showSettingsForm.value = true;
}

async function saveSettings(): Promise<void> {
  if (busy.value || !showSettingsForm.value) return;
  const m = Number(multiplier.value);
  if (!Number.isFinite(m) || m < 0.01 || m > 100) {
    error.value = '计费倍率必须在 0.01–100。';
    return;
  }
  const ratio = Number(outputRatio.value);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    error.value = '输出占比必须在 0–1 之间（如 0.2）。';
    return;
  }
  if (!settingsReason.value.trim()) {
    error.value = '请填写变更原因。';
    return;
  }
  const tag = 'billing-settings';
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const input: Parameters<typeof updateAdminAiBillingSettings>[0] = {
      activeModel: activeModel.value.trim() || null,
      upstreamBaseUrl: baseUrl.value.trim() || null,
      globalMultiplier: m,
      typicalOutputRatio: ratio,
    };
    if (clearKey.value) input.clearUpstreamApiKey = true;
    else if (apiKey.value.trim()) input.upstreamApiKey = apiKey.value.trim();
    const r = await updateAdminAiBillingSettings(input, settingsReason.value.trim(), write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      showSettingsForm.value = false;
      settings.value = r.value;
      notice.value = '计费设置已更新（即时生效）。';
      await loadSummary();
    } else if (r.kind === 'unauthorized') {
      write.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      write.reset(tag);
      error.value = '操作失败：参数非法（地址须 https、模型名不含空白）。';
    }
  } finally {
    busy.value = false;
  }
}

// ── 计价表 ──

interface PricingForm {
  mode: 'create' | 'edit';
  model: string;
  providerCode: string;
  inputYuan: string;
  outputYuan: string;
  weight: string;
  multiplier: string;
  status: 'active' | 'disabled';
  reason: string;
}
const pricingForm = ref<PricingForm | null>(null);

function openPricingCreate(): void {
  pricingForm.value = { mode: 'create', model: '', providerCode: '', inputYuan: '0.8', outputYuan: '2', weight: '', multiplier: '', status: 'active', reason: '' };
  error.value = '';
}

function openPricingEdit(p: AdminAiModelPricing): void {
  pricingForm.value = {
    mode: 'edit',
    model: p.model,
    providerCode: p.providerCode ?? '',
    inputYuan: (p.inputCentsPerM / 100).toString(),
    outputYuan: (p.outputCentsPerM / 100).toString(),
    weight: p.weightOverride === null ? '' : String(p.weightOverride),
    multiplier: p.multiplierOverride === null ? '' : String(p.multiplierOverride),
    status: p.status,
    reason: '',
  };
  error.value = '';
}

function closePricing(): void {
  if (busy.value) return;
  pricingForm.value = null;
}

async function savePricing(): Promise<void> {
  const f = pricingForm.value;
  if (!f || busy.value) return;
  const inputCents = Math.round(Number(f.inputYuan) * 100);
  const outputCents = Math.round(Number(f.outputYuan) * 100);
  if (!Number.isSafeInteger(inputCents) || inputCents < 0 || !Number.isSafeInteger(outputCents) || outputCents < 0) {
    error.value = '单价必须是非负数字（元 / 百万 token）。';
    return;
  }
  if (!f.model.trim() || /\s/.test(f.model.trim())) {
    error.value = '模型名不能为空且不含空白。';
    return;
  }
  if (!f.reason.trim()) {
    error.value = '请填写变更原因。';
    return;
  }
  const weightOverride = f.weight.trim() === '' ? null : Number(f.weight);
  if (weightOverride !== null && (!Number.isFinite(weightOverride) || weightOverride < 0.01 || weightOverride > 100)) {
    error.value = '输出折算倍数须在 0.01–100（留空 = 按单价推导）。';
    return;
  }
  const multiplierOverride = f.multiplier.trim() === '' ? null : Number(f.multiplier);
  if (multiplierOverride !== null && (!Number.isFinite(multiplierOverride) || multiplierOverride < 0.01 || multiplierOverride > 100)) {
    error.value = '计费倍率须在 0.01–100（留空 = 用全局）。';
    return;
  }
  const tag = `pricing:${f.mode}:${f.model}`;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const body = {
      providerCode: f.providerCode.trim() || null,
      inputCentsPerM: inputCents,
      outputCentsPerM: outputCents,
      weightOverride,
      multiplierOverride,
      ...(f.mode === 'edit' ? { status: f.status } : {}),
    };
    const r =
      f.mode === 'create'
        ? await createAdminAiModelPricing({ model: f.model.trim(), ...body }, f.reason.trim(), write.ensure(tag), csrf)
        : await updateAdminAiModelPricing(f.model, body, f.reason.trim(), write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      pricingForm.value = null;
      notice.value = `计价 ${f.model} 已${f.mode === 'create' ? '新增' : '更新'}。`;
      await load();
    } else if (r.kind === 'unauthorized') {
      write.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      write.reset(tag);
      error.value = f.mode === 'create' ? '新增失败：模型已存在或参数非法。' : '更新失败：模型不存在或参数非法。';
    }
  } finally {
    busy.value = false;
  }
}

async function togglePricing(p: AdminAiModelPricing): Promise<void> {
  if (busy.value) return;
  const to = p.status === 'active' ? 'disabled' : 'active';
  const tag = `pricing-toggle:${p.model}:${to}`;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await updateAdminAiModelPricing(p.model, { status: to }, to === 'disabled' ? '运营停用' : '运营启用', write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      notice.value = `计价 ${p.model} 已${to === 'disabled' ? '停用' : '启用'}。`;
      await load();
    } else if (r.kind === 'unauthorized') {
      write.reset(tag);
      relogin();
    } else {
      write.reset(tag);
      error.value = '操作失败，请重试。';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <div>
        <h2>AI 计费</h2>
        <p class="sub">AI 服务的用量、成本、收入与毛利总览，以及模型价格和接入设置。</p>
      </div>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error && !settingsForm && !pricingForm" class="error">{{ error }}</p>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>

    <template v-if="state === 'ready' && settings">
    <Tabs v-model="tab" :tabs="[{ key: 'overview', label: '经营概览' }, { key: 'pricing', label: '模型价格' }, { key: 'settings', label: '接入设置' }]" />
    <details class="rules">
      <summary>计费规则说明</summary>
      <p>1 积分 = 1000 计费 token。计费 token =（输入 + 输出 × k）× 倍率：k 默认取输出单价 ÷ 输入单价，可在模型价格里手动覆盖；倍率默认取全局，也可按模型覆盖。扣费按上游返回的真实用量逐笔结算（多退少补）。缓存价格不单独区分，按全价计（成本不会低估）。</p>
    </details>

    <!-- ── 经营概览 ── -->
    <div v-if="tab === 'overview'">
      <div class="bar">
        <select v-model="rangeKey" @change="onRangeChange">
          <option v-for="r in RANGES" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select>
        <button class="btn secondary" :disabled="busy" @click="loadSummary">刷新</button>
        <span class="muted range-note" v-if="summary">{{ summary.from }} ~ {{ summary.to }}</span>
      </div>
      <template v-if="summary">
        <div class="stat-grid">
          <div class="stat"><span class="stat-label">请求次数</span><span class="stat-value">{{ summary.total.requestCount.toLocaleString() }}</span></div>
          <div class="stat"><span class="stat-label">消耗积分</span><span class="stat-value">{{ fmtCredits(summary.total.billingPromptTokens + summary.total.billingCompletionTokens) }}</span></div>
          <div class="stat"><span class="stat-label">上游成本</span><span class="stat-value">{{ fmtCents(summary.total.costCents) }}</span></div>
          <div class="stat"><span class="stat-label">充值收入</span><span class="stat-value">{{ fmtCents(summary.total.topupCents) }}</span></div>
          <div class="stat"><span class="stat-label">套餐收入</span><span class="stat-value">{{ fmtCents(summary.total.planCents) }}</span></div>
          <div class="stat"><span class="stat-label">实收合计</span><span class="stat-value">{{ fmtCents(summary.total.topupCents + summary.total.planCents) }}</span></div>
          <div class="stat"><span class="stat-label">毛利</span><span class="stat-value" :class="{ neg: (summary.total.marginCents ?? 0) < 0 }">{{ fmtCents(summary.total.marginCents) }}</span></div>
          <div class="stat"><span class="stat-label">毛利率</span><span class="stat-value">{{ marginRate === null ? '—' : `${(marginRate * 100).toFixed(1)}%` }}</span></div>
        </div>
        <p class="muted small" v-if="actualOutputRatio !== null">实际输出占比：{{ (actualOutputRatio * 100).toFixed(1) }}%（成本测算假设为 {{ (settings.typicalOutputRatio * 100).toFixed(0) }}%，可在接入设置中调整）</p>
        <p class="privacy-note">成本取每笔请求当时的价格快照（请求流水，精确）；收入取订单流水。更早月份（流水上线前）请看说明文档的近似口径。</p>

        <h4>逐月明细</h4>
        <table class="table">
          <thead><tr><th>月份</th><th>请求数</th><th>原始输入</th><th>原始输出</th><th>消耗积分</th><th>成本</th><th>实收（充值 / 套餐）</th><th>毛利</th></tr></thead>
          <tbody>
            <tr v-for="m in summary.months" :key="m.usageMonth">
              <td class="mono">{{ m.usageMonth }}</td>
              <td>{{ m.requestCount }}</td>
              <td>{{ fmtTokens(m.rawPromptTokens) }}</td>
              <td>{{ fmtTokens(m.rawCompletionTokens) }}</td>
              <td>{{ fmtCredits(m.billingPromptTokens + m.billingCompletionTokens) }}</td>
              <td>{{ fmtCents(m.costCents) }}</td>
              <td>{{ fmtCents(m.topupCents) }} / {{ fmtCents(m.planCents) }}</td>
              <td :class="{ neg: (m.marginCents ?? 0) < 0 }">{{ fmtCents(m.marginCents) }}</td>
            </tr>
            <tr v-if="summary.months.length === 0"><td colspan="8" class="muted">该区间暂无请求流水。</td></tr>
          </tbody>
        </table>

        <h4>模型毛利</h4>
        <p class="muted small">毛利率为测算值：按「消耗积分 × 参考积分售价 − 上游成本」计算；参考售价取上架档位中最低 ¥/积分（{{ creditPriceCents === null ? '未配置' : fmtCents(creditPriceCents) }}/积分）。</p>
        <table class="table">
          <thead><tr><th>模型</th><th>请求数</th><th>消耗积分</th><th>原始输入/输出</th><th>上游成本</th><th>测算毛利率</th></tr></thead>
          <tbody>
            <tr v-for="mm in summary.models" :key="mm.model">
              <td class="mono">{{ mm.model }}</td>
              <td>{{ mm.requestCount }}</td>
              <td>{{ fmtCredits(mm.billingPromptTokens + mm.billingCompletionTokens) }}</td>
              <td>{{ fmtTokens(mm.rawPromptTokens) }} / {{ fmtTokens(mm.rawCompletionTokens) }}</td>
              <td>{{ fmtCents(mm.costCents) }}</td>
              <td>{{ modelMarginRate(mm.model) === null ? '—' : `${((modelMarginRate(mm.model)!) * 100).toFixed(1)}%` }}</td>
            </tr>
            <tr v-if="summary.models.length === 0"><td colspan="6" class="muted">该区间暂无请求流水。</td></tr>
          </tbody>
        </table>
      </template>
      <p class="muted" v-else>加载中…</p>
    </div>

    <!-- ── 模型价格 ── -->
    <div v-else-if="tab === 'pricing'">
      <p class="bar"><button class="btn" :disabled="busy" @click="openPricingCreate">新增计价</button></p>
      <table class="table">
        <thead>
          <tr><th>模型</th><th>厂商</th><th>输入价（元/百万）</th><th>输出价（元/百万）</th><th>输出折算倍数（手动）</th><th>按价格推导</th><th>计费倍率</th><th>每积分成本</th><th>测算毛利率</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="p in pricing" :key="p.model">
            <td class="mono">{{ p.model }}</td>
            <td class="mono">{{ p.providerCode ?? '—' }}</td>
            <td>{{ (p.inputCentsPerM / 100).toFixed(2) }}</td>
            <td>{{ (p.outputCentsPerM / 100).toFixed(2) }}</td>
            <td>{{ p.weightOverride ?? '按价格' }}</td>
            <td>{{ p.inputCentsPerM > 0 ? (p.outputCentsPerM / p.inputCentsPerM).toFixed(2) : '1.00' }}</td>
            <td>{{ p.multiplierOverride ?? `用全局（${settings.globalMultiplier}）` }}</td>
            <td>{{ fmtCents(perCreditCostCents(p)) }}</td>
            <td>{{ marginRateOf(p) === null ? '—' : `${((marginRateOf(p)!) * 100).toFixed(1)}%` }}</td>
            <td><span class="badge" :class="p.status">{{ p.status === 'active' ? '启用' : '停用' }}</span></td>
            <td class="actions">
              <button class="btn small" :disabled="busy" @click="openPricingEdit(p)">编辑</button>
              <button class="btn small secondary" :disabled="busy" @click="togglePricing(p)">{{ p.status === 'active' ? '停用' : '启用' }}</button>
            </td>
          </tr>
          <tr v-if="pricing.length === 0"><td colspan="11" class="muted">暂无计价（未配置时输出按 1 倍输入计，成本无法估算）。</td></tr>
        </tbody>
      </table>
      <p class="muted small">每积分成本 = 1000 × [(1−占比)×输入价 + 占比×输出价] ÷ [(1−占比) + 占比×k] ÷ 倍率（占比取接入设置中的测算假设）。</p>
    </div>

    <!-- ── 接入设置 ── -->
    <div v-else-if="tab === 'settings'">
      <table class="table">
        <tbody>
          <tr><th>当前使用的模型</th><td class="mono">{{ settings.activeModel ?? '使用服务器默认' }}<span class="muted" v-if="settings.env.model">（服务器默认：{{ settings.env.model }}）</span></td></tr>
          <tr><th>接口地址</th><td class="mono">{{ settings.upstreamBaseUrl ?? '使用服务器默认' }}<span class="muted" v-if="settings.env.baseUrl">（服务器默认：{{ settings.env.baseUrl }}）</span></td></tr>
          <tr><th>API Key</th><td>{{ settings.upstreamApiKeyConfigured ? `已配置（${settings.upstreamApiKeyHint}）` : '未配置' }}<span class="muted"> · 服务器默认：{{ settings.env.apiKeyConfigured ? '已配置' : '未配置' }}</span></td></tr>
          <tr><th>全局计费倍率</th><td>× {{ settings.globalMultiplier }}<span class="muted">（用户实际计费 ÷ 真实消耗，默认 1；模型可单独覆盖）</span></td></tr>
          <tr><th>成本测算输出占比</th><td>{{ (settings.typicalOutputRatio * 100).toFixed(0) }}%<span class="muted">（仅用于价格表的每积分成本/毛利率测算列）</span></td></tr>
        </tbody>
      </table>
      <p class="bar"><button class="btn" :disabled="busy" @click="openSettings">修改设置</button></p>
    </div>
    </template>

    <Modal v-if="showSettingsForm" title="接入设置（即时生效）" :closable="!busy" @close="showSettingsForm = false">
      <FormField label="厂商" hint="可选；仅用于筛选下方模型列表。">
        <select v-model="settingsProvider">
          <option value="">全部厂商</option>
          <option v-for="c in providerOptions" :key="c" :value="c">{{ c }}</option>
        </select>
      </FormField>
      <FormField label="激活模型" required hint="所有 AI 请求都走这个模型；留空使用服务器默认。">
        <select v-model="activeModel">
          <option value="">（使用服务器默认）</option>
          <option v-for="p in modelOptionsForProvider" :key="p.model" :value="p.model">{{ p.model }}<template v-if="p.providerCode">（{{ p.providerCode }}）</template></option>
        </select>
      </FormField>
      <FormField label="接口地址" hint="必须 https；留空使用服务器默认。">
        <input v-model="baseUrl" type="text" maxlength="255" placeholder="https://api.example.com/v1" />
      </FormField>
      <FormField label="API Key" :hint="settings?.upstreamApiKeyConfigured ? `已配置（尾号 ${settings.upstreamApiKeyHint}），输入新值即覆盖` : '只保存不可回读。'">
        <input v-model="apiKey" type="password" autocomplete="off" maxlength="512" placeholder="输入新 Key 覆盖" />
      </FormField>
      <label class="check"><input v-model="clearKey" type="checkbox" :disabled="!!apiKey" /> 清除已保存的 Key（改用服务器默认）</label>
      <FormField label="全局计费倍率" required hint="0.01–100，默认 1；单个模型可在模型价格里覆盖。">
        <input v-model="multiplier" type="text" placeholder="如 1.2" />
      </FormField>
      <FormField label="成本测算输出占比" required hint="0–1（如 0.2 = 输入:输出 4:1）；只影响测算展示，不影响扣费。">
        <input v-model="outputRatio" type="text" placeholder="如 0.2" />
      </FormField>
      <FormField label="变更原因" required hint="必填，会记录到审计日志。">
        <input v-model="settingsReason" type="text" maxlength="500" placeholder="例如：切换到 DeepSeek v4.1" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="saveSettings">保存</button>
        <button class="btn secondary" :disabled="busy" @click="showSettingsForm = false">取消</button>
      </div>
    </Modal>

    <Modal v-if="pricingForm" :title="pricingForm.mode === 'create' ? '新增模型计价' : `编辑计价 · ${pricingForm.model}`" :closable="!busy" @close="closePricing">
      <FormField v-if="pricingForm.mode === 'create'" label="模型名" required hint="如 qwen-plus；创建后不可改。">
        <input v-model="pricingForm.model" type="text" maxlength="128" placeholder="qwen-plus" />
      </FormField>
      <FormField label="厂商" hint="可选；仅展示关联，不影响计费。">
        <select v-model="pricingForm.providerCode">
          <option value="">（不指定）</option>
          <option v-for="c in providerOptions" :key="c" :value="c">{{ c }}</option>
        </select>
      </FormField>
      <FormField label="输入单价" required hint="元 / 百万 token。">
        <input v-model="pricingForm.inputYuan" type="text" placeholder="如 0.8" />
      </FormField>
      <FormField label="输出单价" required hint="元 / 百万 token。">
        <input v-model="pricingForm.outputYuan" type="text" placeholder="如 2" />
      </FormField>
      <FormField label="输出折算倍数（k）" hint="留空 = 按单价自动推导（输出价 ÷ 输入价）。">
        <input v-model="pricingForm.weight" type="text" placeholder="如 4" />
      </FormField>
      <FormField label="计费倍率" hint="留空 = 用全局倍率；该模型按此倍率扣积分。">
        <input v-model="pricingForm.multiplier" type="text" placeholder="如 1.5" />
      </FormField>
      <FormField v-if="pricingForm.mode === 'edit'" label="状态">
        <select v-model="pricingForm.status">
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
      </FormField>
      <FormField label="变更原因" required hint="必填，会记录到审计日志。">
        <input v-model="pricingForm.reason" type="text" maxlength="500" placeholder="例如：新增 DeepSeek v4.1 计价" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="savePricing">保存</button>
        <button class="btn secondary" :disabled="busy" @click="closePricing">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.bar input, .bar select { width: auto; margin-bottom: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.active { background: var(--c-success-bg); color: var(--c-success-text); }
.badge.disabled { background: var(--c-danger-bg); color: var(--c-danger); }
.check { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 4px 0 12px; }
.notice { color: var(--c-success-text); font-size: 13px; }
.neg { color: var(--c-danger); font-weight: 700; }
h4 { margin: 20px 0 8px; font-size: 14px; }
.small { font-size: 12.5px; }
.range-note { font-size: 12.5px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
.stat { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 12px; color: var(--c-text-muted); }
.stat-value { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.stat-value.neg { color: var(--c-danger); }
.rules { margin: 14px 0; border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-surface); padding: 8px 12px; }
.rules summary { cursor: pointer; font-size: 13px; color: var(--c-text-muted); }
.rules p { margin: 8px 0 2px; font-size: 13px; line-height: 1.6; color: var(--c-text); }
.privacy-note { font-size: 12.5px; color: var(--c-text-muted); background: var(--c-surface-muted); border-radius: var(--r-sm); padding: 8px 12px; }
</style>
