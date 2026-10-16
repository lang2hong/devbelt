<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  createAdminAiModelPricing,
  getAdminAiBillingSettings,
  getAdminAiFinance,
  listAdminAiModelPricing,
  updateAdminAiBillingSettings,
  updateAdminAiModelPricing,
  type AdminAiBillingSettings,
  type AdminAiFinance,
  type AdminAiModelPricing,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import Modal from '../components/Modal.vue';

/**
 * AI 计费引擎（管理后台显性化）：模型计价表 / 计费设置（激活模型、上游连接、调整系数）/
 * 财务月报。统一 token 口径：计费 token = (输入 + 输出 × k) × 系数；预占与结算同口径。
 * 上游 API Key 只写不读（回显仅「已配置 + 尾号」）；写操作 reason 必填进审计。
 */

const settings = ref<AdminAiBillingSettings | null>(null);
const pricing = ref<AdminAiModelPricing[]>([]);
const finance = ref<AdminAiFinance | null>(null);
const financeMonth = ref(monthKeyOf(new Date()));
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

async function load(): Promise<void> {
  state.value = 'loading';
  const [s, p, f] = await Promise.all([getAdminAiBillingSettings(), listAdminAiModelPricing(), getAdminAiFinance(financeMonth.value)]);
  if (s.kind === 'ok' && p.kind === 'ok' && f.kind === 'ok') {
    settings.value = s.value;
    pricing.value = p.value.items;
    finance.value = f.value;
    state.value = 'ready';
  } else if (s.kind === 'unauthorized' || p.kind === 'unauthorized' || f.kind === 'unauthorized') relogin();
  else state.value = 'error';
}

async function loadFinance(): Promise<void> {
  const f = await getAdminAiFinance(financeMonth.value);
  if (f.kind === 'ok') finance.value = f.value;
  else if (f.kind === 'unauthorized') relogin();
  else error.value = '财务数据加载失败。';
}

onMounted(() => void load());

// ── 计费设置 ──

const activeModel = ref('');
const baseUrl = ref('');
const apiKey = ref('');
const clearKey = ref(false);
const multiplier = ref('1');
const settingsReason = ref('');
const showSettingsForm = ref(false);

function openSettings(): void {
  const s = settings.value;
  activeModel.value = s?.activeModel ?? '';
  baseUrl.value = s?.upstreamBaseUrl ?? '';
  apiKey.value = '';
  clearKey.value = false;
  multiplier.value = String(s?.globalMultiplier ?? 1);
  settingsReason.value = '';
  error.value = '';
  showSettingsForm.value = true;
}

async function saveSettings(): Promise<void> {
  if (busy.value || !showSettingsForm.value) return;
  const m = Number(multiplier.value);
  if (!Number.isFinite(m) || m < 0.01 || m > 100) {
    error.value = '调整系数必须在 0.01–100。';
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
    };
    if (clearKey.value) input.clearUpstreamApiKey = true;
    else if (apiKey.value.trim()) input.upstreamApiKey = apiKey.value.trim();
    const r = await updateAdminAiBillingSettings(input, settingsReason.value.trim(), write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      showSettingsForm.value = false;
      settings.value = r.value;
      notice.value = '计费设置已更新（即时生效）。';
      await Promise.all([loadFinance()]);
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
  status: 'active' | 'disabled';
  reason: string;
}
const pricingForm = ref<PricingForm | null>(null);

function openPricingCreate(): void {
  pricingForm.value = { mode: 'create', model: '', providerCode: '', inputYuan: '0.8', outputYuan: '2', weight: '', status: 'active', reason: '' };
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
    error.value = '权重覆盖须在 0.01–100（留空 = 按单价推导）。';
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
      <h2>AI 计费</h2>
      <p class="sub">统一 token 口径：计费 token = (输入 + 输出 × k) × 调整系数（k = 权重覆盖 ?? 输出单价÷输入单价）；预占与结算同口径。缓存价不分（按全价计 = 保守高估成本）。</p>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error && !settingsForm && !pricingForm" class="error">{{ error }}</p>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>

    <template v-if="state === 'ready' && settings">
      <h3>生效配置</h3>
      <table class="table">
        <tbody>
          <tr><th>激活模型</th><td class="mono">{{ settings.activeModel ?? '（env 回退）' }}<span class="muted"> · env: {{ settings.env.model || '（未配置）' }}</span></td></tr>
          <tr><th>上游地址</th><td class="mono">{{ settings.upstreamBaseUrl ?? '（env 回退）' }}<span class="muted"> · env: {{ settings.env.baseUrl ?? '（未配置）' }}</span></td></tr>
          <tr><th>上游 Key</th><td>{{ settings.upstreamApiKeyConfigured ? `已配置（${settings.upstreamApiKeyHint}）` : '未配置' }}<span class="muted"> · env: {{ settings.env.apiKeyConfigured ? '已配置（回退可用）' : '未配置' }}</span></td></tr>
          <tr><th>调整系数</th><td>× {{ settings.globalMultiplier }}（实际计费 ÷ 真实消耗）</td></tr>
          <tr v-if="finance"><th>当前权重 k</th><td>{{ finance.weight }}（计价模型：{{ finance.pricingModel ?? '未配置 → k=1' }}）</td></tr>
        </tbody>
      </table>
      <p class="bar"><button class="btn" :disabled="busy" @click="openSettings">修改设置</button></p>

      <h3>模型计价</h3>
      <table class="table">
        <thead>
          <tr><th>模型</th><th>厂商</th><th>输入价（元/1M）</th><th>输出价（元/1M）</th><th>权重 k（覆盖）</th><th>推导 k</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="p in pricing" :key="p.model">
            <td class="mono">{{ p.model }}</td>
            <td class="mono">{{ p.providerCode ?? '—' }}</td>
            <td>{{ (p.inputCentsPerM / 100).toFixed(2) }}</td>
            <td>{{ (p.outputCentsPerM / 100).toFixed(2) }}</td>
            <td>{{ p.weightOverride ?? '—' }}</td>
            <td>{{ p.inputCentsPerM > 0 ? (p.outputCentsPerM / p.inputCentsPerM).toFixed(2) : '1.00' }}</td>
            <td><span class="badge" :class="p.status">{{ p.status === 'active' ? '启用' : '停用' }}</span></td>
            <td class="actions">
              <button class="btn small" :disabled="busy" @click="openPricingEdit(p)">编辑</button>
              <button class="btn small secondary" :disabled="busy" @click="togglePricing(p)">{{ p.status === 'active' ? '停用' : '启用' }}</button>
            </td>
          </tr>
          <tr v-if="pricing.length === 0"><td colspan="8" class="muted">暂无计价行（未配置时 k=1、成本未知）。</td></tr>
        </tbody>
      </table>
      <p class="bar"><button class="btn" :disabled="busy" @click="openPricingCreate">新增计价</button></p>

      <h3>财务月报</h3>
      <div class="bar">
        <input v-model="financeMonth" type="month" @change="loadFinance" />
        <button class="btn secondary" :disabled="busy" @click="loadFinance">刷新</button>
      </div>
      <table v-if="finance" class="table">
        <tbody>
          <tr><th>请求次数</th><td>{{ finance.usage.requestCount }}</td></tr>
          <tr><th>原始 token</th><td>输入 {{ fmtTokens(finance.usage.promptTokens) }} · 输出 {{ fmtTokens(finance.usage.completionTokens) }}</td></tr>
          <tr><th>计费 token</th><td>输入 {{ fmtTokens(finance.billing.promptTokens) }} · 输出 {{ fmtTokens(finance.billing.completionTokens) }}<span class="muted">（k={{ finance.weight }} × {{ finance.multiplier }}）</span></td></tr>
          <tr><th>折算成本</th><td>{{ fmtCents(finance.costCents) }}<span class="muted">（按激活模型现价折算，历史为近似）</span></td></tr>
          <tr><th>实收</th><td>加油包 {{ fmtCents(finance.revenue.topupCents) }} · 套餐 {{ fmtCents(finance.revenue.planCents) }}</td></tr>
          <tr><th>毛利</th><td :class="{ neg: finance.marginCents !== null && finance.marginCents < 0 }">{{ fmtCents(finance.marginCents) }}</td></tr>
        </tbody>
      </table>
    </template>

    <Modal v-if="showSettingsForm" title="计费设置（即时生效）" :closable="!busy" @close="showSettingsForm = false">
      <input v-model="activeModel" type="text" maxlength="128" placeholder="激活模型（空 = 回退 env）" />
      <input v-model="baseUrl" type="text" maxlength="255" placeholder="上游 Base URL（https://…；空 = 回退 env）" />
      <input v-model="apiKey" type="password" autocomplete="off" maxlength="512" :placeholder="settings?.upstreamApiKeyConfigured ? `已配置（${settings.upstreamApiKeyHint}），输入新值覆盖` : '上游 API Key（只写不读）'" />
      <label class="check"><input v-model="clearKey" type="checkbox" :disabled="!!apiKey" /> 清除已配置 Key（回退 env）</label>
      <input v-model="multiplier" type="text" placeholder="调整系数（0.01–100，实际计费 ÷ 真实消耗）" />
      <input v-model="settingsReason" type="text" maxlength="500" placeholder="变更原因（必填，进审计）" />
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="saveSettings">保存</button>
        <button class="btn secondary" :disabled="busy" @click="showSettingsForm = false">取消</button>
      </div>
    </Modal>

    <Modal v-if="pricingForm" :title="pricingForm.mode === 'create' ? '新增模型计价' : `编辑计价 · ${pricingForm.model}`" :closable="!busy" @close="closePricing">
      <input v-if="pricingForm.mode === 'create'" v-model="pricingForm.model" type="text" maxlength="128" placeholder="模型名（如 qwen-plus）" />
      <input v-model="pricingForm.providerCode" type="text" maxlength="32" placeholder="厂商 code（可选，如 dashscope）" />
      <input v-model="pricingForm.inputYuan" type="text" placeholder="输入单价（元 / 百万 token）" />
      <input v-model="pricingForm.outputYuan" type="text" placeholder="输出单价（元 / 百万 token）" />
      <input v-model="pricingForm.weight" type="text" placeholder="权重 k 覆盖（空 = 按单价推导）" />
      <select v-if="pricingForm.mode === 'edit'" v-model="pricingForm.status">
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <input v-model="pricingForm.reason" type="text" maxlength="500" placeholder="变更原因（必填，进审计）" />
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
.badge.active { background: #dafbe1; color: var(--c-success-text); }
.badge.disabled { background: #ffebe9; color: var(--c-danger); }
.check { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 4px 0 8px; }
.notice { color: var(--c-success-text); font-size: 13px; }
.neg { color: var(--c-danger); font-weight: 700; }
h3 { font-size: 15px; font-weight: 700; margin: 28px 0 8px; }
</style>
