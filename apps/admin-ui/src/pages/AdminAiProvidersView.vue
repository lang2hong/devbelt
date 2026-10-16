<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  createAdminAiProvider,
  listAdminAiProviders,
  updateAdminAiProvider,
  type AdminAiProvider,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatModelLines, parseModelLines } from '../lib/providerModels';
import Modal from '../components/Modal.vue';
import FormField from '../components/FormField.vue';

/**
 * AI 模型厂商目录（自带 Key 预设）：运营维护厂商 / baseUrl / 模型列表；
 * 用户在扩展里选厂商后只需填 API Key。baseUrl 强制 https（Key 会发往该地址）。
 */

const providers = ref<AdminAiProvider[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const busy = ref(false);
const error = ref('');
const notice = ref('');
const write = useIdempotencyKey();

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function load(): Promise<void> {
  state.value = 'loading';
  const r = await listAdminAiProviders();
  if (r.kind === 'ok') {
    providers.value = r.value.items;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else state.value = 'error';
}
onMounted(() => void load());

// ── 新增 / 编辑表单 ──

interface Form {
  mode: 'create' | 'edit';
  code: string;
  nameZh: string;
  nameEn: string;
  baseUrl: string;
  modelsText: string;
  sortOrder: string;
  reason: string;
}
const form = ref<Form | null>(null);

function openCreate(): void {
  const maxSort = providers.value.reduce((m, p) => Math.max(m, p.sortOrder), 0);
  form.value = { mode: 'create', code: '', nameZh: '', nameEn: '', baseUrl: 'https://', modelsText: '', sortOrder: String(maxSort + 10), reason: '' };
  error.value = '';
}

function openEdit(p: AdminAiProvider): void {
  form.value = {
    mode: 'edit',
    code: p.code,
    nameZh: p.name.zh,
    nameEn: p.name.en,
    baseUrl: p.baseUrl,
    modelsText: formatModelLines(p.models),
    sortOrder: String(p.sortOrder),
    reason: '',
  };
  error.value = '';
}

function closeForm(): void {
  if (busy.value) return;
  form.value = null;
}

function failMessage(kind: string, code?: string): string {
  if (code === 'CONFLICT') return '厂商 code 已存在。';
  if (kind === 'failure' && code === 'VALIDATION_FAILED') return '参数非法（baseUrl 须为 https，且不含账号/查询串）。';
  return '操作失败，请重试。';
}

async function submit(): Promise<void> {
  const f = form.value;
  if (!f || busy.value) return;
  const parsed = parseModelLines(f.modelsText);
  if (parsed.error) {
    error.value = parsed.error;
    return;
  }
  const reason = f.reason.trim();
  if (!reason) {
    error.value = '请填写变更原因。';
    return;
  }
  const sortOrder = Number(f.sortOrder);
  if (!Number.isSafeInteger(sortOrder)) {
    error.value = '排序必须是整数。';
    return;
  }
  const name = { zh: f.nameZh.trim(), en: f.nameEn.trim() };
  if (!name.zh || !name.en) {
    error.value = '中英文名称均必填。';
    return;
  }
  const baseUrl = f.baseUrl.trim();
  if (!/^https:\/\//i.test(baseUrl)) {
    error.value = 'baseUrl 必须以 https:// 开头。';
    return;
  }
  const tag = `provider:${f.mode}:${f.code}`;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const r =
      f.mode === 'create'
        ? await createAdminAiProvider({ code: f.code.trim(), name, baseUrl, models: parsed.models, sortOrder }, reason, write.ensure(tag), csrf)
        : await updateAdminAiProvider(f.code, { name, baseUrl, models: parsed.models, sortOrder }, reason, write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      form.value = null;
      notice.value = `厂商 ${f.code.trim()} 已${f.mode === 'create' ? '新增' : '更新'}。`;
      await load();
    } else if (r.kind === 'unauthorized') {
      write.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      write.reset(tag);
      error.value = failMessage(r.kind, 'code' in r ? r.code : undefined);
    }
  } finally {
    busy.value = false;
  }
}

async function toggleStatus(p: AdminAiProvider): Promise<void> {
  if (busy.value) return;
  const to = p.status === 'active' ? 'disabled' : 'active';
  const tag = `provider-toggle:${p.code}:${to}`;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await updateAdminAiProvider(p.code, { status: to }, to === 'disabled' ? '运营停用' : '运营启用', write.ensure(tag), csrf);
    if (r.kind === 'ok') {
      write.reset(tag);
      notice.value = `厂商 ${p.code} 已${to === 'disabled' ? '停用' : '启用'}。`;
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
        <h2>AI 模型厂商</h2>
        <p class="sub">维护预设的模型厂商列表：用户在客户端选好厂商后，只需填自己的 API Key 即可使用。</p>
      </div>
      <div class="head-actions"><button class="btn" :disabled="busy" @click="openCreate">新增厂商</button></div>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error && !form" class="error">{{ error }}</p>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>
    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>标识</th><th>名称</th><th>接口地址</th><th>可用模型</th><th>状态</th><th>排序</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in providers" :key="p.code">
          <td class="mono">{{ p.code }}</td>
          <td>{{ p.name.zh }}<span class="muted"> / {{ p.name.en }}</span></td>
          <td class="mono">{{ p.baseUrl }}</td>
          <td class="mono">{{ p.models.map((m) => (m.default ? `${m.id}*` : m.id)).join(', ') }}</td>
          <td><span class="badge" :class="p.status">{{ p.status === 'active' ? '启用' : '停用' }}</span></td>
          <td>{{ p.sortOrder }}</td>
          <td class="actions">
            <button class="btn small" :disabled="busy" @click="openEdit(p)">编辑</button>
            <button class="btn small secondary" :disabled="busy" @click="toggleStatus(p)">{{ p.status === 'active' ? '停用' : '启用' }}</button>
          </td>
        </tr>
        <tr v-if="providers.length === 0"><td colspan="7" class="muted">暂无厂商。</td></tr>
      </tbody>
    </table>

    <Modal v-if="form" :title="form.mode === 'create' ? '新增厂商' : `编辑厂商 · ${form.code}`" :closable="!busy" @close="closeForm">
      <FormField v-if="form.mode === 'create'" label="厂商标识" required hint="小写字母开头，创建后不可改，如 acme。">
        <input v-model="form.code" type="text" maxlength="32" placeholder="acme" />
      </FormField>
      <FormField label="中文名称" required>
        <input v-model="form.nameZh" type="text" maxlength="64" placeholder="如 Acme 云" />
      </FormField>
      <FormField label="英文名称">
        <input v-model="form.nameEn" type="text" maxlength="64" placeholder="Acme Cloud" />
      </FormField>
      <FormField label="接口地址" required hint="必须以 https 开头——用户的 API Key 会发往这个地址。">
        <input v-model="form.baseUrl" type="text" maxlength="255" placeholder="https://api.acme.com/v1" />
      </FormField>
      <FormField label="可用模型" required hint="一行一个。可在行首加 * 标记默认模型；也可以写「模型 ID | 显示名」。">
        <textarea v-model="form.modelsText" rows="6" placeholder="*gpt-5&#10;gpt-5-mini | Mini"></textarea>
      </FormField>
      <FormField label="排序" hint="整数，数字越小排越前。">
        <input v-model="form.sortOrder" type="text" placeholder="如 100" />
      </FormField>
      <FormField label="变更原因" required hint="必填，会记录到审计日志。">
        <input v-model="form.reason" type="text" maxlength="500" placeholder="例如：新增官方厂商目录" />
      </FormField>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="submit">保存</button>
        <button class="btn secondary" :disabled="busy" @click="closeForm">取消</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: var(--sp-4); }
.head-actions { display: flex; gap: 8px; }
.page { max-width: 1040px; margin: 0 auto; }
input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; margin-bottom: 8px; font-family: inherit; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
.badge.active { background: #dafbe1; color: var(--c-success-text); }
.badge.disabled { background: #ffebe9; color: var(--c-danger); }
.notice { color: var(--c-success-text); font-size: 13px; }
</style>
