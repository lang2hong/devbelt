<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import type { AuditRow, AuditResponse } from '../types';

/**
 * 管理操作留痕（只读）。
 *
 * 有这个页面才让 admin_audit_log 真正可用 —— 否则「谁把这个账号提成了 admin」
 * 只能靠上生产库 SELECT，而那件事本身就该尽量避免。
 */
const rows = ref<AuditRow[]>([]);
const total = ref(0);
const page = ref(1);
const PAGE_SIZE = 50;
const filter = ref('');
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const offset = (page.value - 1) * PAGE_SIZE;
    const r = await api<AuditResponse>(`/admin/audit?limit=${PAGE_SIZE}&offset=${offset}`);
    rows.value = r.entries || [];
    total.value = r.total || 0;
  } catch (ex) {
    error.value = ex instanceof Error ? ex.message : String(ex);
  } finally {
    loading.value = false;
  }
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 过滤只作用于当前页（服务端不支持按 action 查，翻页量级下够用） */
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) => r.action.toLowerCase().includes(q)
      || (r.actorEmail || '').toLowerCase().includes(q)
      || r.targetId.toLowerCase().includes(q),
  );
});

async function goPage(d: number) {
  const next = Math.min(totalPages.value, Math.max(1, page.value + d));
  if (next === page.value) return;
  page.value = next;
  await load();
}

/**
 * detail 渲染成 `field: from → to`，其余形状退回紧凑 JSON。
 *
 * 刻意不用 `<pre>{{ JSON.stringify(detail, null, 2) }}</pre>`：审计表最常见的
 * 用法是"扫一眼谁改了什么"，多行 JSON 会把每行撑到十几行高，反而看不下去。
 */
function describe(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail || {})) {
    if (v && typeof v === 'object' && 'from' in (v as any) && 'to' in (v as any)) {
      const d = v as { from: unknown; to: unknown };
      parts.push(`${k}: ${format(d.from)} → ${format(d.to)}`);
    } else {
      parts.push(`${k}: ${format(v)}`);
    }
  }
  return parts.join('; ') || '—';
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <input v-model="filter" placeholder="Filter this page by action / actor / target…" />
      <span class="count">Total {{ total }} entr{{ total === 1 ? 'y' : 'ies' }}</span>
      <button class="btn" :disabled="loading" @click="load">Refresh</button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <table>
      <thead>
        <tr>
          <th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Change</th><th>IP</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="shown.length === 0"><td colspan="6" class="muted">No entries</td></tr>
        <tr v-for="r in shown" :key="r.id">
          <td>{{ fmt(r.createTime) }}</td>
          <td>{{ r.actorEmail || ('#' + r.actorUserId) }}</td>
          <td><span class="badge">{{ r.action }}</span></td>
          <td>{{ r.targetType }} {{ r.targetId }}</td>
          <td>{{ describe(r.detail) }}</td>
          <td>{{ r.ip || '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div class="pager" v-if="totalPages > 1">
      <button class="btn" :disabled="page <= 1" @click="goPage(-1)">Prev</button>
      <span class="muted">Page {{ page }} / {{ totalPages }}</span>
      <button class="btn" :disabled="page >= totalPages" @click="goPage(1)">Next</button>
    </div>
  </div>
</template>
