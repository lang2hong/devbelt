<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import type { TrafficReport } from '../types';

/**
 * 流量视图。
 *
 * 刻意**不做任何聚合**：错误率、补零、排序全部由服务端 TrafficReporter
 * 算好（那边有 vitest 覆盖，这个包没有测试运行器）。这里只负责把数字画出来。
 *
 * 图表用纯 CSS 柱状条而不是引图表库 —— 加一个依赖只为画两条曲线不划算，
 * 而 flex + height% 已经够看趋势了。
 */

const report = ref<TrafficReport | null>(null);
const hours = ref(24);
const loading = ref(false);
const error = ref('');
/** 实时曲线自动刷新，默认关。开着会一直打 /admin/traffic */
const autoRefresh = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    report.value = await api<TrafficReport>(`/admin/traffic?hours=${hours.value}`);
  } catch (ex) {
    error.value = ex instanceof Error ? ex.message : String(ex);
  } finally {
    loading.value = false;
  }
}

/** 柱高按窗口内最大值归一化，空窗口时避免除零 */
const minuteMax = computed(() =>
  Math.max(1, ...(report.value?.minutes ?? []).map((m) => m.total)),
);
const hourMax = computed(() =>
  Math.max(1, ...(report.value?.hourly ?? []).map((h) => h.total)),
);

/** 最近 60 分钟的合计，回答「现在忙不忙」 */
const lastHourTotal = computed(() =>
  (report.value?.minutes ?? []).reduce((s, m) => s + m.total, 0),
);

const errorTotal = computed(() =>
  (report.value?.routes ?? []).reduce((s, r) => s + r.clientError + r.serverError, 0),
);

function pct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}

function minuteLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hourLabel(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit' });
}

/** 一根柱子里 4xx/5xx 的占比，用来染色 */
function errShare(byClass: Record<number, number>, total: number): number {
  if (total === 0) return 0;
  return ((byClass[4] ?? 0) + (byClass[5] ?? 0)) / total;
}

function toggleAuto() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    timer = setInterval(load, 15_000);
  } else if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

// 组件卸载时必须清掉定时器，否则切走标签页还在轮询
onUnmounted(() => {
  if (timer) clearInterval(timer);
});

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <label class="muted">Window</label>
      <select v-model.number="hours" @change="load">
        <option :value="1">1 hour</option>
        <option :value="6">6 hours</option>
        <option :value="24">24 hours</option>
        <option :value="72">3 days</option>
        <option :value="168">7 days</option>
        <option :value="720">30 days</option>
      </select>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
      <button class="btn" :class="{ primary: autoRefresh }" @click="toggleAuto">
        Auto {{ autoRefresh ? 'on' : 'off' }}
      </button>
      <span v-if="report" class="count">
        {{ report.total }} requests / {{ report.hours }}h · {{ errorTotal }} errors
      </span>
    </div>

    <p v-if="error" class="muted" style="color: var(--danger)">{{ error }}</p>
    <p v-else-if="!report" class="muted">Loading…</p>

    <template v-else>
      <div class="grid" style="margin-bottom: 18px">
        <div class="card">
          <h3>Last 60 min</h3>
          <div class="row"><span class="k">Requests</span><span class="v">{{ lastHourTotal }}</span></div>
          <div class="row"><span class="k">Window total</span><span class="v">{{ report.total }}</span></div>
          <div class="row"><span class="k">Errors</span><span class="v">{{ errorTotal }}</span></div>
          <div class="row">
            <span class="k">Rate limited</span>
            <span class="v" :style="report.blockedTotal > 0 ? 'color: var(--warn)' : ''">
              {{ report.blockedTotal }}
            </span>
          </div>
        </div>
        <div class="card" style="grid-column: span 2">
          <h3>Realtime (per minute, in-memory)</h3>
          <div class="spark">
            <div
              v-for="m in report.minutes"
              :key="m.minuteTs"
              class="spark-bar"
              :class="{ err: errShare(m.byClass, m.total) > 0.2 }"
              :style="{ height: Math.max(2, (m.total / minuteMax) * 100) + '%' }"
              :title="`${minuteLabel(m.minuteTs)} — ${m.total} req`"
            />
          </div>
          <p class="muted" style="margin: 6px 0 0; font-size: 12px">
            Resets on server restart. Bars turn amber when 4xx+5xx exceeds 20%.
          </p>
        </div>
      </div>

      <h3 class="section-title">Hourly ({{ report.hours }}h)</h3>
      <div class="spark tall">
        <div
          v-for="h in report.hourly"
          :key="h.bucketTime"
          class="spark-bar"
          :class="{ err: errShare(h.byClass, h.total) > 0.2 }"
          :style="{ height: Math.max(2, (h.total / hourMax) * 100) + '%' }"
          :title="`${hourLabel(h.bucketTime)} — ${h.total} req`"
        />
      </div>

      <h3 class="section-title">By route</h3>
      <p v-if="report.routes.length === 0" class="muted">No traffic recorded yet</p>
      <table v-else>
        <thead>
          <tr>
            <th>Route</th>
            <th>Total</th>
            <th>2xx/3xx</th>
            <th>4xx</th>
            <th>5xx</th>
            <th>Error rate</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in report.routes" :key="r.route">
            <td><code>{{ r.route }}</code></td>
            <td>{{ r.total }}</td>
            <td>{{ r.ok }}</td>
            <td :class="{ warnText: r.clientError > 0 }">{{ r.clientError }}</td>
            <td :class="{ dangerText: r.serverError > 0 }">{{ r.serverError }}</td>
            <td>
              <span
                class="badge"
                :class="r.errorRate > 0.2 ? 'canceled' : r.errorRate > 0.05 ? 'expired' : 'active'"
              >
                {{ pct(r.errorRate) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">
        Rate limited requests
        <span class="muted" style="font-weight: 400; font-size: 13px">
          — if legitimate users show up here, raise the bucket threshold or allowlist their IP
        </span>
      </h3>
      <p v-if="report.blocked.length === 0" class="muted">None</p>
      <table v-else>
        <thead>
          <tr><th>Time</th><th>IP</th><th>Route</th><th>Bucket</th></tr>
        </thead>
        <tbody>
          <tr v-for="(b, i) in report.blocked" :key="i">
            <td>{{ fmt(b.createTime) }}</td>
            <td><code>{{ b.ip }}</code></td>
            <td><code>{{ b.route }}</code></td>
            <td><span class="badge admin">{{ b.bucket }}</span></td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.section-title {
  margin: 22px 0 10px;
  color: var(--accent);
  font-size: 15px;
}
.spark {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 70px;
  padding: 6px 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.spark.tall { height: 120px; }
.spark-bar {
  flex: 1;
  min-width: 2px;
  background: var(--accent);
  opacity: 0.75;
  border-radius: 1px 1px 0 0;
}
.spark-bar:hover { opacity: 1; }
.spark-bar.err { background: var(--warn); }
.warnText { color: var(--warn); }
.dangerText { color: var(--danger); }
code { font-size: 12px; color: var(--muted); }
</style>
