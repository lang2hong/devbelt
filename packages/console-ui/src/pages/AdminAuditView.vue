<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { queryAudit, exportAudit, type AdminAuditEvent } from '../api/admin';
import { ensureCsrf, setAccessToken } from '../api/consoleAuth';
import { useIdempotencyKey } from '../lib/idempotentWrite';
import AdminNav from './AdminNav.vue';

const events = ref<AdminAuditEvent[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const fromTime = ref('');
const toTime = ref('');
const eventType = ref('');
const actorUserId = ref('');
const targetType = ref('');
const organizationId = ref('');
const nextCursor = ref<string | null>(null);

const exportWrite = useIdempotencyKey();

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

async function load(reset = true): Promise<void> {
  state.value = 'loading';
  const r = await queryAudit({
    fromTime: fromTime.value || undefined,
    toTime: toTime.value || undefined,
    eventType: eventType.value || undefined,
    actorUserId: actorUserId.value || undefined,
    targetType: targetType.value || undefined,
    organizationId: organizationId.value || undefined,
    cursor: reset ? undefined : (nextCursor.value ?? undefined),
  });
  if (r.kind === 'ok') {
    events.value = reset ? r.value.items : [...events.value, ...r.value.items];
    nextCursor.value = r.value.nextCursor;
    state.value = 'ready';
  } else if (r.kind === 'unauthorized') relogin();
  else state.value = 'error';
}

onMounted(() => load());

function search(): void {
  events.value = [];
  nextCursor.value = null;
  void load(true);
}

async function doExport(format: 'csv' | 'json'): Promise<void> {
  // tag 纳入有效过滤条件：变更筛选即新业务意图，避免「同 key 异 body」触发 KEY_REUSED。
  const tag = `export:${format}:${fromTime.value}|${toTime.value}|${eventType.value}|${actorUserId.value}|${targetType.value}|${organizationId.value}`;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await exportAudit(format, {
      fromTime: fromTime.value || undefined,
      toTime: toTime.value || undefined,
      eventType: eventType.value || undefined,
      actorUserId: actorUserId.value || undefined,
      targetType: targetType.value || undefined,
      organizationId: organizationId.value || undefined,
    }, exportWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      exportWrite.reset(tag);
      const blob = new Blob([r.value], { type: format === 'json' ? 'application/json' : 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } else if (r.kind === 'unauthorized') {
      exportWrite.reset(tag);
      relogin();
    } else {
      error.value = r.kind === 'failure' ? '导出失败，请重试。' : '导出失败。';
    }
  } catch {
    error.value = '导出失败，请重试。';
  }
}
</script>

<template>
  <section class="page">
    <AdminNav />
    <h2>审计日志</h2>

    <div class="bar">
      <input v-model="fromTime" type="text" placeholder="起始时间(ISO)" />
      <input v-model="toTime" type="text" placeholder="结束时间(ISO)" />
      <input v-model="eventType" type="text" placeholder="eventType" />
      <input v-model="actorUserId" type="text" placeholder="actorUserId" />
      <input v-model="targetType" type="text" placeholder="targetType" />
      <input v-model="organizationId" type="text" placeholder="organizationId" />
      <button class="btn" @click="search">查询</button>
      <button class="btn secondary" @click="doExport('json')">导出 JSON</button>
      <button class="btn secondary" @click="doExport('csv')">导出 CSV</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">加载失败。</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>时间</th><th>actor</th><th>eventType</th><th>target</th><th>result</th></tr>
      </thead>
      <tbody>
        <tr v-for="e in events" :key="e.eventId">
          <td>{{ new Date(e.eventTime).toLocaleString() }}</td>
          <td>{{ e.actorRole ?? '-' }}#{{ e.actorUserId ?? '-' }}</td>
          <td>{{ e.eventType }}</td>
          <td>{{ e.targetType ?? '' }}:{{ e.targetId ?? '' }}</td>
          <td>{{ e.result }}</td>
        </tr>
        <tr v-if="events.length === 0"><td colspan="5" class="muted">无匹配记录。</td></tr>
      </tbody>
    </table>

    <p v-if="nextCursor" class="load-more"><button class="btn secondary" @click="load(false)">加载更多</button></p>
  </section>
</template>

<style scoped>
.page { max-width: 960px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
.bar { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
input { box-sizing: border-box; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 13px; }
.btn { background: #0969da; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn.secondary { background: #f6f8fa; color: #24292f; border: 1px solid #d0d7de; }
.muted { color: #57606a; font-size: 13px; }
.error { color: #cf222e; font-size: 13px; }
.load-more { margin: 16px 0; }
</style>