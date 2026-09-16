<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ensureCsrf } from '../api/consoleAuth';
import { listPlans, updatePlan, upsertFeatureDef, type AdminFeatureDef, type AdminPlan } from '../api/admin';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import AdminNav from './AdminNav.vue';

/**
 * 套餐管理：编辑 name/价格/上下架/排序 + 特性值（按 value_type 渲染专用控件），
 * 以及「特性定义」目录（en/zh 标签、类型、单位、排序）的维护。
 * 保存为整组事务替换 + 乐观锁（version）；冲突提示刷新后重试。
 * 兜底档（free/organization_free）不可归档——服务端会拒，前端同时禁用归档选项。
 */

const ENGINE_KEYS = new Set(['allowedDatabaseTypes', 'allowedTemplateDatabaseTypes']);
const KNOWN_ENGINES = ['mysql', 'postgresql', 'sqlite'];
const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const VALUE_TYPES = ['bool', 'number', 'bytes', 'stringList', 'enum'];
const KINDS = ['personal', 'organization', 'both'];

interface EditableFeature {
  key: string;
  label: { en: string; zh: string };
  valueType: string;
  unit: string | null;
  boolValue: boolean;
  numberValue: number;
  listValue: string;
  stringValue: string;
  engines: string[];
  engineOptions: string[];
  bytesUnit: 'MiB' | 'GiB';
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

// 特性定义编辑
const defKey = ref('');
const defKind = ref('personal');
const defEn = ref('');
const defZh = ref('');
const defType = ref('number');
const defUnit = ref('');
const defSort = ref(0);
const defReason = ref('admin console feature def');
const defSaving = ref(false);
const defMsg = ref('');
const defError = ref('');

const idem = useIdempotencyKey();
const defIdem = useIdempotencyKey();

const selected = computed(() => plans.value.find((p) => p.id === selectedId.value) ?? null);
const isFallback = computed(() => selected.value != null && ['free', 'organization_free'].includes(selected.value.code));

function labelOf(f: { label?: { en: string; zh: string }; key: string }): string {
  return f.label?.zh || f.label?.en || f.key;
}

function defsForPlan(plan: AdminPlan): AdminFeatureDef[] {
  return featureDefs.value.filter((d) => d.kind === 'both' || d.kind === plan.kind);
}

function toEditable(plan: AdminPlan): EditableFeature[] {
  return defsForPlan(plan)
    .filter((d) => d.key in plan.features)
    .map((d) => {
      const v = plan.features[d.key];
      const engines = ENGINE_KEYS.has(d.key) && Array.isArray(v) ? (v as string[]) : [];
      const extra = engines.filter((e) => !KNOWN_ENGINES.includes(e));
      return {
        key: d.key,
        label: d.label,
        valueType: d.valueType,
        unit: d.unit,
        boolValue: v === true,
        numberValue: d.valueType === 'bytes' && typeof v === 'number' ? v / BYTES_PER_MIB : (typeof v === 'number' ? v : 0),
        listValue: Array.isArray(v) ? v.join(', ') : '',
        stringValue: typeof v === 'string' ? v : '',
        engines,
        engineOptions: [...KNOWN_ENGINES, ...extra],
        bytesUnit: 'MiB',
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

function isEngineFeature(f: EditableFeature): boolean {
  return ENGINE_KEYS.has(f.key);
}

function toggleEngine(f: EditableFeature, engine: string): void {
  f.engines = f.engines.includes(engine) ? f.engines.filter((e) => e !== engine) : [...f.engines, engine];
}

function featureValue(f: EditableFeature): unknown {
  if (f.valueType === 'bool') return f.boolValue;
  if (f.valueType === 'bytes') {
    const factor = f.bytesUnit === 'GiB' ? BYTES_PER_GIB : BYTES_PER_MIB;
    return Math.round(Number(f.numberValue) * factor);
  }
  if (f.valueType === 'number') return Number(f.numberValue);
  if (f.valueType === 'stringList') {
    if (isEngineFeature(f)) return f.engines;
    return f.listValue.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return f.stringValue;
}

async function refresh(): Promise<void> {
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
}

async function load(): Promise<void> {
  state.value = 'loading';
  await refresh();
  if (state.value === 'ready' && plans.value.length > 0) select(plans.value[0]);
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

function editDef(d: AdminFeatureDef): void {
  defKey.value = d.key;
  defKind.value = d.kind;
  defEn.value = d.label.en;
  defZh.value = d.label.zh;
  defType.value = d.valueType;
  defUnit.value = d.unit ?? '';
  defSort.value = d.sortOrder;
  defMsg.value = '';
  defError.value = '';
}

async function saveDef(): Promise<void> {
  if (defSaving.value || !defKey.value.trim()) return;
  defSaving.value = true;
  defMsg.value = '';
  defError.value = '';
  const key = defKey.value.trim();
  try {
    const csrf = await ensureCsrf();
    const tag = `def:${key}`;
    const r = await upsertFeatureDef(
      key,
      {
        kind: defKind.value,
        label: { en: defEn.value.trim() || key, zh: defZh.value.trim() || key },
        valueType: defType.value,
        unit: defUnit.value.trim() ? defUnit.value.trim() : null,
        sortOrder: Number(defSort.value),
        reason: defReason.value.trim() || 'admin console feature def',
      },
      defIdem.ensure(tag),
      csrf,
    );
    if (r.kind === 'ok') {
      defIdem.reset(tag);
      defMsg.value = '特性定义已保存。';
      await refresh();
    } else if (r.kind === 'bad-request') {
      defIdem.reset(tag);
      defError.value = r.message ?? '校验失败。';
    } else {
      defIdem.reset(tag);
      defError.value = '保存失败。';
    }
  } finally {
    defSaving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <AdminNav />
    <h2>套餐</h2>
    <p class="muted">编辑套餐价格、上下架与特性值。兜底档（Free）不可归档。</p>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">加载失败。</p>

    <template v-else>
      <div class="layout">
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
            <span class="flabel">{{ labelOf(f) }}<span class="keyhint">{{ f.key }}</span><span class="muted" v-if="f.unit">（{{ f.unit }}）</span></span>

            <div v-if="isEngineFeature(f)" class="engines">
              <label v-for="e in f.engineOptions" :key="e" class="chk">
                <input type="checkbox" :checked="f.engines.includes(e)" @change="toggleEngine(f, e)" /> {{ e }}
              </label>
            </div>

            <input v-else-if="f.valueType === 'bool'" v-model="f.boolValue" type="checkbox" />

            <div v-else-if="f.valueType === 'bytes'" class="bytes">
              <input v-model.number="f.numberValue" type="number" min="0" step="1" />
              <select v-model="f.bytesUnit">
                <option value="MiB">MiB</option>
                <option value="GiB">GiB</option>
              </select>
            </div>

            <input v-else-if="f.valueType === 'number'" v-model.number="f.numberValue" type="number" min="0" step="1" />

            <input v-else-if="f.valueType === 'stringList'" v-model="f.listValue" type="text" placeholder="逗号分隔" />

            <input v-else v-model="f.stringValue" type="text" />
          </div>

          <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
          <p v-if="okMsg" class="ok">{{ okMsg }}</p>
          <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>

      <div class="card">
        <h3>特性定义</h3>
        <p class="muted">维护特性的中文/英文标签、类型、单位与排序。key 一旦创建不建议更改。</p>
        <div class="defLayout">
          <ul class="list defs">
            <li v-for="d in featureDefs" :key="d.key" :class="{ on: d.key === defKey }" @click="editDef(d)">
              <span class="code">{{ labelOf(d) }}</span>
              <span class="muted">{{ d.key }} · {{ d.kind }} · {{ d.valueType }}</span>
            </li>
          </ul>
          <div class="editor">
            <label>key</label>
            <input v-model="defKey" type="text" maxlength="64" />
            <label>适用档位</label>
            <select v-model="defKind"><option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option></select>
            <label>中文标签</label>
            <input v-model="defZh" type="text" maxlength="64" />
            <label>英文标签</label>
            <input v-model="defEn" type="text" maxlength="64" />
            <label>值类型</label>
            <select v-model="defType"><option v-for="t in VALUE_TYPES" :key="t" :value="t">{{ t }}</option></select>
            <label>单位（可空）</label>
            <input v-model="defUnit" type="text" maxlength="16" />
            <label>排序</label>
            <input v-model.number="defSort" type="number" />
            <label>变更原因（审计）</label>
            <input v-model="defReason" type="text" maxlength="500" />
            <p v-if="defError" class="error">{{ defError }}</p>
            <p v-if="defMsg" class="ok">{{ defMsg }}</p>
            <button class="btn" :disabled="defSaving" @click="saveDef">{{ defSaving ? '保存中…' : '保存特性定义' }}</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 900px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }
.layout, .defLayout { display: flex; gap: 24px; margin-top: 12px; }
.list { list-style: none; padding: 0; margin: 0; width: 260px; }
.list li { padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 8px; cursor: pointer; display: flex; flex-direction: column; }
.list li.on { border-color: #0969da; background: #f0f6ff; }
.code { font-weight: 600; color: #0f172a; }
.editor { flex: 1; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 18px 20px; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 18px 20px; margin-top: 24px; }
label { display: block; font-size: 13px; color: #57606a; margin: 10px 0 4px; }
input[type='text'], input[type='number'], select { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.feature { display: grid; grid-template-columns: 240px 1fr; align-items: center; gap: 12px; margin: 6px 0; }
.flabel { font-size: 13px; color: #24292f; }
.keyhint { margin-left: 8px; font-size: 11px; color: #8c959f; font-family: monospace; }
.engines { display: flex; flex-wrap: wrap; gap: 14px; }
.chk { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; color: #24292f; }
.chk input { width: auto; }
.bytes { display: grid; grid-template-columns: 1fr 110px; gap: 8px; }
.btn { margin-top: 16px; background: #0969da; color: #fff; border: none; padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.6; }
.error { color: #cf222e; font-size: 13px; }
.ok { color: #1a7f37; font-size: 13px; }
.muted { color: #57606a; font-size: 12px; }
</style>