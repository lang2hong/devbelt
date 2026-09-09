<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  getOrganization,
  listFolders,
  listResources,
  type Folder,
  type ResourceSummary,
  type OrgSummary,
} from '../api/organizations';
import { setAccessToken } from '../api/consoleAuth';
import { navigate } from '../lib/router';

const props = defineProps<{ organizationId: string }>();

const state = ref<'loading' | 'ready' | 'error'>('loading');
const org = ref<OrgSummary | null>(null);
const folders = ref<Folder[]>([]);
const resources = ref<ResourceSummary[]>([]);

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function invalidContext(): void {
  navigate('/console/organizations');
}

async function load(): Promise<void> {
  state.value = 'loading';
  const o = await getOrganization(props.organizationId);
  if (o.kind !== 'ok') {
    if (o.kind === 'unauthorized') return relogin();
    if (o.kind === 'forbidden' || o.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  org.value = o.value;

  const f = await listFolders(props.organizationId);
  if (f.kind !== 'ok') {
    if (f.kind === 'unauthorized') return relogin();
    if (f.kind === 'forbidden' || f.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  folders.value = f.value;

  const r = await listResources(props.organizationId);
  if (r.kind !== 'ok') {
    if (r.kind === 'unauthorized') return relogin();
    if (r.kind === 'forbidden' || r.kind === 'not-found') return invalidContext();
    state.value = 'error';
    return;
  }
  resources.value = r.value;

  state.value = 'ready';
}

onMounted(load);
watch(() => props.organizationId, () => void load());
</script>

<template>
  <section class="page">
    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。<button class="link" @click="load">重试</button></p>

    <template v-if="state === 'ready' && org">
      <header class="head">
        <h2>资源 · {{ org.name }}</h2>
        <a class="back" @click.prevent="navigate('/console/organizations/' + props.organizationId)">返回组织</a>
      </header>

      <div class="card">
        <h3>目录</h3>
        <ul class="list">
          <li v-for="f in folders" :key="f.folderId" class="item">
            <strong>{{ f.name }}</strong>
          </li>
          <li v-if="folders.length === 0" class="muted">暂无目录。</li>
        </ul>
      </div>

      <div class="card">
        <h3>资源</h3>
        <ul class="list">
          <li v-for="r in resources" :key="r.resourceId" class="item">
            <strong>{{ r.name }}</strong>
            <span class="muted">{{ r.resourceType }} · v{{ r.version }}</span>
          </li>
          <li v-if="resources.length === 0" class="muted">暂无资源。</li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 680px; margin: 0 auto; }
.head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0; }
h3 { font-size: 15px; font-weight: 600; color: #0f172a; margin: 0 0 12px; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
.list { list-style: none; padding: 0; margin: 0; }
.item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eaeef2; }
.item:last-child { border-bottom: none; }
.back { color: #0969da; cursor: pointer; font-size: 14px; }
.link { background: none; border: none; color: #0969da; cursor: pointer; padding: 0; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
</style>