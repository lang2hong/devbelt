<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listOrganizations, createOrganization, type OrgSummary } from '../api/organizations';
import { ensureCsrf, setAccessToken } from '@devkit/auth-client';
import { navigate, withBase } from '../lib/router';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';

const orgs = ref<OrgSummary[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const name = ref('');
const creating = ref(false);

const createWrite = useIdempotencyKey();

async function load(): Promise<void> {
  state.value = 'loading';
  const r = await listOrganizations();
  if (r.kind === 'ok') {
    orgs.value = r.value;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') {
    setAccessToken(null);
    window.location.assign('/login');
  } else {
    state.value = 'error';
  }
}

onMounted(load);

async function create(): Promise<void> {
  if (creating.value || !name.value.trim()) return;
  creating.value = true;
  error.value = '';
  try {
    const value = name.value.trim();
    const tag = `create:${value}`;
    const csrf = await ensureCsrf();
    const r = await createOrganization(value, createWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      createWrite.reset(tag);
      navigate(`/organizations/${r.value.organizationId}`);
    } else if (r.kind === 'unauthorized') {
      createWrite.reset(tag);
      setAccessToken(null);
      window.location.assign('/login');
    } else if (isRetryableFailure(r.kind)) {
      error.value = '创建失败，请重试。';
    } else {
      createWrite.reset(tag);
      error.value = '创建失败，请重试。';
    }
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>组织</h2>
      <p class="sub">创建并管理你的协作组织。</p>
    </header>

    <div class="card">
      <h3>创建组织</h3>
      <div class="inline">
        <input v-model="name" type="text" maxlength="100" placeholder="组织名称" />
        <button class="btn accent" :disabled="creating" @click="create">{{ creating ? '创建中…' : '创建' }}</button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败，请刷新重试。</p>

    <ul v-if="state === 'ready'" class="list">
      <li v-for="o in orgs" :key="o.organizationId" class="item">
        <a class="link" @click.prevent="navigate('/organizations/' + o.organizationId)">
          <strong>{{ o.name }}</strong>
          <span class="muted">{{ o.role }}<span v-if="o.status !== 'active'"> · 已关闭</span></span>
        </a>
      </li>
      <li v-if="orgs.length === 0" class="muted">暂无组织。</li>
    </ul>
  </section>
</template>

<style scoped>
.page { max-width: 640px; margin: 0 auto; }
.head { margin-bottom: 20px; }
.head h2 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
.card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 20px 22px; margin-bottom: 16px; }
h3 { font-size: 14px; font-weight: 600; color: var(--c-text); margin: 0 0 12px; }
.inline { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
input { width: 100%; box-sizing: border-box; }
.btn { height: 34px; padding: 0 16px; background: var(--c-success); color: #fff; border: none; border-radius: var(--r-md); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn.accent { background: var(--c-accent); }
.btn:disabled { opacity: 0.6; cursor: default; }
.item { transition: border-color .15s; }
.item:hover { border-color: var(--c-accent); }
.list { list-style: none; padding: 0; margin: 0; }
.item { background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; margin-bottom: 10px; }
.link { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; cursor: pointer; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
</style>