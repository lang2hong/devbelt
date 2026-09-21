<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { withBase } from '../lib/router';
import { ensureCsrf } from '@devbelt/auth-client';
import { listPlans, updatePlan, upsertFeatureDef, type AdminFeatureDef, type AdminPlan } from '../api/admin';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

/**
 * 套餐管理：顶部标签页（套餐 / 特性定义）。
 * - 套餐：分段切换个人/组织 → 套餐胶囊选择 → 全宽表单（基本信息 / 特性）→ 粘性保存栏。
 * - 特性定义：表格列出，选中后在下方编辑 en/zh 标签、类型、单位、排序。
 * 保存为整组事务替换 + 乐观锁；兜底档（free/organization_free）不可归档。
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

const tab = ref<'plans' | 'defs'>('plans');
const kindTab = ref<'personal' | 'organization'>('personal');

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

const editingDef = ref(false);
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

const plansOfKind = computed(() => plans.value.filter((p) => p.kind === kindTab.value));
const selected = computed(() => plans.value.find((p) => p.id === selectedId.value) ?? null);
const isFallback = computed(() => selected.value != null && ['free', 'organization_free'].includes(selected.value.code));
const defsOfKind = computed(() => featureDefs.value.filter((d) => d.kind === 'both' || d.kind === kindTab.value));

function labelOf(f: { label?: { en: string; zh: string }; key: string }): string {
  return f.label?.zh || f.label?.en || f.key;
}

function toEditable(plan: AdminPlan): EditableFeature[] {
  return featureDefs.value
    .filter((d) => (d.kind === 'both' || d.kind === plan.kind) && d.key in plan.features)
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
  kindTab.value = plan.kind === 'organization' ? 'organization' : 'personal';
  name.value = plan.name;
  priceYuan.value = plan.priceCents / 100;
  sortOrder.value = plan.sortOrder;
  status.value = plan.status === 'archived' ? 'archived' : 'active';
  features.value = toEditable(plan);
  errorMsg.value = '';
  okMsg.value = '';
}

function switchKind(kind: 'personal' | 'organization'): void {
  kindTab.value = kind;
  const first = plans.value.find((p) => p.kind === kind);
  if (first) select(first);
}

function toggleStatus(e: Event): void {
  status.value = (e.target as HTMLInputElement).checked ? 'active' : 'archived';
}

function isEngineFeature(f: EditableFeature): boolean {
  return ENGINE_KEYS.has(f.key);
}

function toggleEngine(f: EditableFeature, engine: string): void {
  f.engines = f.engines.includes(engine) ? f.engines.filter((e) => e !== engine) : [...f.engines, engine];
}

function featureValue(f: EditableFeature): unknown {
  if (f.valueType === 'bool') return f.boolValue;
  if (f.valueType === 'bytes') return Math.round(Number(f.numberValue) * (f.bytesUnit === 'GiB' ? BYTES_PER_GIB : BYTES_PER_MIB));
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
  if (state.value === 'ready' && plans.value.length > 0) select(plans.value.find((p) => p.kind === 'personal') ?? plans.value[0]);
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

function startNewDef(): void {
  editingDef.value = true;
  defKey.value = '';
  defKind.value = kindTab.value;
  defEn.value = '';
  defZh.value = '';
  defType.value = 'number';
  defUnit.value = '';
  defSort.value = 0;
  defMsg.value = '';
  defError.value = '';
}

function editDef(d: AdminFeatureDef): void {
  editingDef.value = true;
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
      editingDef.value = false;
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

    <header class="head">
      <div>
        <h1>套餐</h1>
        <p class="sub">配置各套餐的价格与能力。特性改动会立即作用于对应订阅者。</p>
      </div>
      <div class="tabs">
        <button :class="{ on: tab === 'plans' }" @click="tab = 'plans'">套餐</button>
        <button :class="{ on: tab === 'defs' }" @click="tab = 'defs'">特性定义</button>
      </div>
    </header>

    <p v-if="state === 'loading'" class="muted">加载中…</p>
    <p v-else-if="state === 'error'" class="error">加载失败。</p>

    <!-- ── 套餐 ── -->
    <template v-else-if="tab === 'plans'">
      <div class="toolbar">
        <div class="segmented">
          <button :class="{ on: kindTab === 'personal' }" @click="switchKind('personal')">个人</button>
          <button :class="{ on: kindTab === 'organization' }" @click="switchKind('organization')">组织</button>
        </div>
        <div class="pills">
          <button
            v-for="p in plansOfKind"
            :key="p.id"
            class="pill"
            :class="{ on: p.id === selectedId }"
            @click="select(p)"
          >
            <span class="dot" :class="p.status"></span>{{ p.name }}
          </button>
        </div>
      </div>

      <template v-if="selected">
        <section class="card">
          <div class="card-head">基本信息</div>
          <div class="grid">
            <div class="field">
              <label>名称</label>
              <input v-model="name" type="text" maxlength="64" />
            </div>
            <div class="field">
              <label>价格</label>
              <div class="suffix">
                <input v-model.number="priceYuan" type="number" min="0" step="0.01" />
                <span>元 / {{ selected.billingUnit === 'seat-month' ? '席·月' : '月' }}</span>
              </div>
            </div>
            <div class="field">
              <label>排序</label>
              <input v-model.number="sortOrder" type="number" />
            </div>
            <div class="field">
              <label>状态</label>
              <label class="switch">
                <input type="checkbox" :checked="status === 'active'" :disabled="isFallback" @change="toggleStatus" />
                <span class="track"><span class="thumb"></span></span>
                <span class="switch-label">{{ status === 'active' ? '上架' : '下架' }}</span>
              </label>
            </div>
            <div class="field span2">
              <label>变更原因（审计）</label>
              <input v-model="reason" type="text" maxlength="500" data-testid="reason" />
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">特性</div>
          <div class="rows">
            <div v-for="f in features" :key="f.key" class="row">
              <div class="row-label">
                <span class="row-name">{{ labelOf(f) }}</span>
                <span class="row-key">{{ f.key }}<template v-if="f.unit"> · {{ f.unit }}</template></span>
              </div>
              <div class="row-control">
                <div v-if="isEngineFeature(f)" class="chips">
                  <button
                    v-for="e in f.engineOptions"
                    :key="e"
                    class="chip"
                    :class="{ on: f.engines.includes(e) }"
                    @click="toggleEngine(f, e)"
                  >{{ e }}</button>
                </div>

                <label v-else-if="f.valueType === 'bool'" class="switch">
                  <input type="checkbox" v-model="f.boolValue" />
                  <span class="track"><span class="thumb"></span></span>
                  <span class="switch-label">{{ f.boolValue ? '允许' : '不允许' }}</span>
                </label>

                <div v-else-if="f.valueType === 'bytes'" class="suffix narrow">
                  <input v-model.number="f.numberValue" type="number" min="0" step="1" />
                  <select v-model="f.bytesUnit"><option value="MiB">MiB</option><option value="GiB">GiB</option></select>
                </div>

                <div v-else-if="f.valueType === 'number'" class="suffix narrow">
                  <input v-model.number="f.numberValue" type="number" min="0" step="1" />
                  <span>{{ f.numberValue === 0 ? '不限' : '' }}</span>
                </div>

                <input v-else-if="f.valueType === 'stringList'" v-model="f.listValue" type="text" placeholder="逗号分隔" />

                <input v-else v-model="f.stringValue" type="text" />
              </div>
            </div>
          </div>
        </section>

        <div class="savebar">
          <span v-if="errorMsg" class="error">{{ errorMsg }}</span>
          <span v-else-if="okMsg" class="ok">{{ okMsg }}</span>
          <span v-else class="muted">版本 v{{ selected.version }}</span>
          <span class="spacer"></span>
          <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </template>
    </template>

    <!-- ── 特性定义 ── -->
    <template v-else>
      <div class="toolbar">
        <div class="segmented">
          <button :class="{ on: kindTab === 'personal' }" @click="switchKind('personal')">个人</button>
          <button :class="{ on: kindTab === 'organization' }" @click="switchKind('organization')">组织</button>
        </div>
        <span class="spacer"></span>
        <button class="btn ghost" @click="startNewDef">新增特性</button>
      </div>

      <div class="card table-wrap">
        <table class="table">
          <thead>
            <tr><th>标签</th><th>key</th><th>类型</th><th>单位</th><th>排序</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="d in defsOfKind" :key="d.key" :class="{ on: d.key === defKey && editingDef }">
              <td>{{ labelOf(d) }}</td>
              <td class="mono">{{ d.key }}</td>
              <td>{{ d.valueType }}</td>
              <td>{{ d.unit ?? '—' }}</td>
              <td>{{ d.sortOrder }}</td>
              <td><button class="link" @click="editDef(d)">编辑</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <section v-if="editingDef" class="card">
        <div class="card-head">{{ defKey ? `编辑：${defKey}` : '新增特性' }}</div>
        <div class="grid">
          <div class="field">
            <label>key</label>
            <input v-model="defKey" type="text" maxlength="64" />
          </div>
          <div class="field">
            <label>适用档位</label>
            <select v-model="defKind"><option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option></select>
          </div>
          <div class="field">
            <label>中文标签</label>
            <input v-model="defZh" type="text" maxlength="64" />
          </div>
          <div class="field">
            <label>英文标签</label>
            <input v-model="defEn" type="text" maxlength="64" />
          </div>
          <div class="field">
            <label>值类型</label>
            <select v-model="defType"><option v-for="t in VALUE_TYPES" :key="t" :value="t">{{ t }}</option></select>
          </div>
          <div class="field">
            <label>单位（可空）</label>
            <input v-model="defUnit" type="text" maxlength="16" />
          </div>
          <div class="field">
            <label>排序</label>
            <input v-model.number="defSort" type="number" />
          </div>
          <div class="field">
            <label>变更原因（审计）</label>
            <input v-model="defReason" type="text" maxlength="500" />
          </div>
        </div>
        <div class="savebar inline">
          <span v-if="defError" class="error">{{ defError }}</span>
          <span v-else-if="defMsg" class="ok">{{ defMsg }}</span>
          <span class="spacer"></span>
          <button class="btn ghost" @click="editingDef = false">取消</button>
          <button class="btn" :disabled="defSaving" @click="saveDef">{{ defSaving ? '保存中…' : '保存' }}</button>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 960px; margin: 0 auto; color: #1f2328; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 8px 0 16px; }
h1 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }

.tabs { display: inline-flex; gap: 4px; background: #eaeef2; padding: 3px; border-radius: 8px; }
.tabs button { border: none; background: transparent; padding: 6px 14px; border-radius: 6px; font-size: 13px; color: var(--c-text-muted); cursor: pointer; }
.tabs button.on { background: var(--c-surface); color: #1f2328; box-shadow: 0 1px 2px rgba(31,35,40,.12); font-weight: 600; }

.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.segmented { display: inline-flex; gap: 4px; background: #eaeef2; padding: 3px; border-radius: 8px; }
.segmented button { border: none; background: transparent; padding: 5px 14px; border-radius: 6px; font-size: 13px; color: var(--c-text-muted); cursor: pointer; }
.segmented button.on { background: var(--c-surface); color: #1f2328; box-shadow: 0 1px 2px rgba(31,35,40,.12); font-weight: 600; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--c-border-strong); background: var(--c-surface); color: var(--c-text); padding: 6px 14px; border-radius: 999px; font-size: 13px; cursor: pointer; }
.pill.on { border-color: var(--c-accent); background: var(--c-accent-bg); color: var(--c-accent-text); font-weight: 600; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-subtle); }
.dot.active { background: var(--c-success-text); }

.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
.card-head { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field.span2 { grid-column: 1 / -1; }
.field label { font-size: 12px; color: var(--c-text-muted); }
input[type='text'], input[type='number'], select { width: 100%; box-sizing: border-box; height: 34px; padding: 0 11px; border: 1px solid var(--c-border-strong); border-radius: 7px; font-size: 13px; background: var(--c-surface); color: inherit; }
input:focus, select:focus { outline: none; border-color: var(--c-accent); box-shadow: 0 0 0 3px rgba(9,105,218,.15); }
.suffix { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }
.suffix > span { font-size: 12px; color: var(--c-text-muted); white-space: nowrap; }
.suffix.narrow { max-width: 280px; }
.suffix select { width: 92px; }

.rows { border: 1px solid var(--c-border); border-radius: 8px; overflow: hidden; }
.row { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(280px, 1.2fr); gap: 16px; align-items: center; padding: 12px 16px; }
.row + .row { border-top: 1px solid #eaeef2; }
.row-label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-name { font-size: 13px; font-weight: 500; }
.row-key { font-size: 11px; color: var(--c-text-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.row-control { display: flex; justify-content: flex-end; }
.row-control > input { max-width: 280px; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--c-border-strong); background: var(--c-surface); color: var(--c-text-muted); padding: 4px 12px; border-radius: 999px; font-size: 12px; cursor: pointer; }
.chip.on { border-color: var(--c-accent); background: var(--c-accent-bg); color: var(--c-accent-text); font-weight: 600; }

.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--c-text); }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch .track { width: 36px; height: 20px; border-radius: 999px; background: #cfd8e3; position: relative; transition: background .15s; flex: none; }
.switch .thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--c-surface); box-shadow: 0 1px 2px rgba(31,35,40,.25); transition: transform .15s; }
.switch input:checked + .track { background: var(--c-success); }
.switch input:checked + .track .thumb { transform: translateX(16px); }
.switch input:disabled + .track { opacity: .5; }

.savebar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 12px 0; margin-top: 4px; background: linear-gradient(var(--c-surface-muted)00, var(--c-surface-muted) 40%); }
.savebar.inline { position: static; margin-top: 16px; background: none; }
.spacer { flex: 1; }
.btn { background: var(--c-success); color: var(--c-surface); border: none; height: 34px; padding: 0 18px; border-radius: 7px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn:hover { background: var(--c-success-text); }
.btn:disabled { opacity: .6; cursor: default; }
.btn.ghost { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); font-weight: 500; }

.table-wrap { padding: 0; overflow: hidden; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-weight: 600; color: var(--c-text-muted); font-size: 12px; padding: 10px 16px; background: var(--c-surface-muted); border-bottom: 1px solid var(--c-border); }
.table td { padding: 11px 16px; border-bottom: 1px solid #eaeef2; }
.table tr:last-child td { border-bottom: none; }
.table tr.on td { background: var(--c-accent-bg); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--c-text-muted); }
.link { border: none; background: none; color: var(--c-accent); cursor: pointer; font-size: 13px; padding: 0; }
.error { color: var(--c-danger); font-size: 13px; }
.ok { color: var(--c-success-text); font-size: 13px; }
.muted { color: var(--c-text-muted); font-size: 12px; }
</style>