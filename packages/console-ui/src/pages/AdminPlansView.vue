<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ensureCsrf } from '../api/consoleAuth';
import { listPlans, updatePlan, type AdminFeatureDef, type AdminPlan } from '../api/admin';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

/**
 * 套餐管理：编辑 name/价格/上下架/排序 + 特性值（按 value_type 渲染）。
 * 保存为整组事务替换 + 乐观锁（version）；冲突提示刷新后重试。
 * 兜底档（free/organization_free）不可归档——服务端会拒，前端同时禁用归档选项。
 */

interface EditableFeature {
  key: string;
  label: { en: string; zh: string };
  valueType: string;
  unit: string | null;
  boolValue: boolean;
  numberValue: number;
  listValue: string;
  stringValue: string;
}

const state = ref<'loading' | 'ready' | 'error'>('loading');
const plans = ref<AdminPlan[]>([]);
const featureDefs = ref<AdminFeatureDef[]>([]);
const selectedId = ref<number | null>(null);
const saving = ref(false);
const errorMsg = ref('');
const okMsg = ref('');

const name = ref('');
const priceYuan = ref(0);
const sortOrder = ref(0);
const status = ref<'active' | 'archived'>('active');
const reason = ref('admin console plan edit');
const features = ref<EditableFeature[]>([]);

const idem = useIdempotencyKey();

const selected = computed(() => plans.value.find((p) => p.id === selectedId.value) ?? null);
const isFallback = computed(() => selected.value != null && ['free', 'organization_free'].includes(selected.value.code));

function defsForPlan(plan: AdminPlan): AdminFeatureDef[] {
  return featureDefs.value.filter((d) => d.kind === 'both' || d.kind === plan.kind);
}

function toEditable(plan: AdminPlan): EditableFeature[] {
  return defsForPlan(plan)
    .filter((d) => d.key in plan.features)
    .map((d) => {
      const v = plan.features[d.key];
      return {
        key: d.key,
        label: d.label,
        valueType: d.valueType,
        unit: d.unit,
        boolValue: v === true,
        numberValue: typeof v === 'number' ? v : 0,
        listValue: Array.isArray(v) ? v.join(', ') : '',
        stringValue: typeof v === 'string' ? v : '',
      };
    });
}

function select(plan: AdminPlan): void {
  selectedId.value = plan.id;
  name.value = plan.name;
  priceYuan.value = plan.priceCents / 100;
  sortOrder.value = plan.sortOrder;
  status.value = plan.status === 'archived' ? 'archived' : 'active';
  features.value = toEditable(plan);
  errorMsg.value = '';
  okMsg.value = '';
}

function featureValue(f: EditableFeature): unknown {
  if (f.valueType === 'bool') return f.boolValue;
  if (f.valueType === 'number' || f.valueType === 'bytes') return Number(f.numberValue);
  if (f.valueType === 'stringList') {
    return f.listValue.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return f.stringValue;
}

async function load(): Promise<void> {
  state.value = 'loading';
  const r = await listPlans();
  if (r.kind === 'unauthorized') {
    window.location.assign('/login');
    return;
  }
  if (r.kind !== 'ok') {
    state.value = 'error';
    return;
  }
  plans.value = r.value.items;
  featureDefs.value = r.value.featureDefs;
  state.value = 'ready';
  if (plans.value.length > 0) select(plans.value[0]);
}

async function save(): Promise<void> {
  const plan = selected.value;
  if (!plan || saving.value) return;
  saving.value = true;
  errorMsg.value = '';
  okMsg.value = '';
  const payload = {
    name: name.value.trim(),
    priceCents: Math.round(priceYuan.value * 100),
    billingUnit: plan.billingUnit as 'month' | 'seat-month',
    sortOrder: sortOrder.value,
    status: status.value,
    features: features.value.map((f) => ({ featureKey: f.key, value: featureValue(f) })),
    expectedVersion: plan.version,
    reason: reason.value.trim() || 'admin console plan edit',
  };
  try {
    const csrf = await ensureCsrf();
    const tag = `plan:${plan.id}:${plan.version}`;
    const r = await updatePlan(plan.id, payload, idem.ensure(tag), csrf);
    if (r.kind === 'ok') {
      idem.reset(tag);
      const idx = plans.value.findIndex((p) => p.id === plan.id);
      if (idx >= 0) plans.value[idx] = r.value.plan;
      select(r.value.plan);
      okMsg.value = '已保存。';
    } else if (r.kind === 'conflict') {
      idem.reset(tag);
      errorMsg.value = '版本冲突：该套餐已被其他管理员修改，请刷新后重试。';
    } else if (r.kind === 'bad-request') {
      idem.reset(tag);
      errorMsg.value = r.message ?? '校验失败。';
    } else if (isRetryableFailure(r.kind)) {
      errorMsg.value = '保存失败，请重试。';
    } else {
      idem.reset(tag);
      errorMsg.value = r.message ?? '保存失败。';
    }
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <h2>套餐</h2>
    <p class="muted">编辑套餐价格、上下架与特性值。兜底档（Free）不可归档。</p>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">加载失败。</p>

    <div v-else class="layout">
      <ul class="list">
        <li v-for="p in plans" :key="p.id" :class="{ on: p.id === selectedId }" @click="select(p)">
          <span class="code">{{ p.name }}</span>
          <span class="muted">{{ p.code }} · v{{ p.version }} · {{ p.status === 'active' ? '上架' : '下架' }}</span>
        </li>
      </ul>

      <div v-if="selected" class="editor">
        <label>名称</label>
        <input v-model="name" type="text" maxlength="64" />

        <label>价格（元）</label>
        <input v-model.number="priceYuan" type="number" min="0" step="0.01" />

        <label>排序</label>
        <input v-model.number="sortOrder" type="number" />

        <label>变更原因（审计）</label>
        <input v-model="reason" type="text" maxlength="500" data-testid="reason" />

        <label>状态</label>
        <select v-model="status">
          <option value="active">上架</option>
          <option value="archived" :disabled="isFallback">下架</option>
        </select>

        <h3>特性</h3>
        <div v-for="f in features" :key="f.key" class="feature">
          <span class="flabel">{{ f.key }}<span class="muted" v-if="f.unit">（{{ f.unit }}）</span></span>
          <template v-if="f.valueType === 'bool'">
            <input v-model="f.boolValue" type="checkbox" />
          </template>
          <template v-else-if="f.valueType === 'number' || f.valueType === 'bytes'">
            <input v-model.number="f.numberValue" type="number" min="0" step="1" />
          </template>
          <template v-else-if="f.valueType === 'stringList'">
            <input v-model="f.listValue" type="text" placeholder="逗号分隔" />
          </template>
          <template v-else>
            <input v-model="f.stringValue" type="text" />
          </template>
        </div>

        <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
        <p v-if="okMsg" class="ok">{{ okMsg }}</p>
        <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page { max-width: 900px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }
.layout { display: flex; gap: 24px; margin-top: 12px; }
.list { list-style: none; padding: 0; margin: 0; width: 260px; }
.list li { padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 8px; cursor: pointer; display: flex; flex-direction: column; }
.list li.on { border-color: #0969da; background: #f0f6ff; }
.code { font-weight: 600; color: #0f172a; }
.editor { flex: 1; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 18px 20px; }
label { display: block; font-size: 13px; color: #57606a; margin: 10px 0 4px; }
input[type='text'], input[type='number'], select { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.feature { display: grid; grid-template-columns: 200px 1fr; align-items: center; gap: 12px; margin: 6px 0; }
.flabel { font-size: 13px; color: #24292f; }
.btn { margin-top: 16px; background: #0969da; color: #fff; border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; }
.error { color: #cf222e; font-size: 13px; }
.ok { color: #1a7f37; font-size: 13px; }
.muted { color: #57606a; font-size: 12px; }
</style>