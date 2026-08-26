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

/** 纵轴刻度缩写，避免大数字把左侧刻度列撑爆 */
function axisNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** 柱高百分比，最小 2% 让低值柱也可见 */
function barPct(total: number, max: number): number {
  return Math.max(2, (total / max) * 100);
}

/**
 * 采样下标：最多约 8 个刻度。
 *
 * 横轴标签和柱上数值共用这一套下标 —— 两边各算一套密度是上一版「布局乱」
 * 的根因（24 柱时数值画 24 个、时间标签只有 8 个，柱顶糊成一片）。
 */
function tickIndexes(n: number): number[] {
  if (n <= 0) return [];
  const step = Math.max(1, Math.ceil(n / 8));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  const last = n - 1;
  const tail = out[out.length - 1];
  // 末尾总要有刻度，但离前一个太近就顶替掉它，否则两个标签会叠在一起
  if (tail !== last) {
    if (last - tail < step / 2) out[out.length - 1] = last;
    else out.push(last);
  }
  return out;
}

/** 柱心在绘图区里的横向百分比，横轴标签按它绝对定位 */
function leftPct(i: number, n: number): number {
  return ((i + 0.5) / n) * 100;
}

/** 柱间空隙：柱很多时（如 30 天 720 柱）空隙总和会超过容器宽度，直接归零 */
function gapOf(n: number): string {
  return n > 200 ? '0px' : '1px';
}

function minuteLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hourLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
}

/** 横轴刻度：只渲染采样出来的这几个，不再给每根柱塞一个空 span */
const minuteTicks = computed(() => {
  const arr = report.value?.minutes ?? [];
  return tickIndexes(arr.length).map((i) => ({
    i,
    left: leftPct(i, arr.length),
    label: minuteLabel(arr[i].minuteTs),
  }));
});
const hourTicks = computed(() => {
  const arr = report.value?.hourly ?? [];
  return tickIndexes(arr.length).map((i) => ({
    i,
    left: leftPct(i, arr.length),
    label: hourLabel(arr[i].minuteTs),
  }));
});

/** 柱上数值只画在刻度柱上，与横轴保持同一密度 */
const minuteValAt = computed(() => new Set(minuteTicks.value.map((t) => t.i)));
const hourValAt = computed(() => new Set(hourTicks.value.map((t) => t.i)));

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
          <div class="chart">
            <div class="plot">
              <div class="y-axis">
                <div class="y-inner">
                  <span class="y-tick t100">{{ axisNum(minuteMax) }}</span>
                  <span class="y-tick t50">{{ axisNum(Math.round(minuteMax / 2)) }}</span>
                  <span class="y-tick t0">0</span>
                </div>
              </div>
              <div class="plot-area">
                <div class="gridlines"><span class="gline g0"></span><span class="gline g50"></span><span class="gline g100"></span></div>
                <div class="bars" :style="{ gap: gapOf(report.minutes.length) }">
                  <div
                    v-for="(m, i) in report.minutes"
                    :key="m.minuteTs"
                    class="bar-col"
                    :title="`${minuteLabel(m.minuteTs)} — ${m.total} req`"
                  >
                    <span
                      v-if="m.total > 0 && minuteValAt.has(i)"
                      class="bar-val"
                      :style="{ bottom: 'calc(' + barPct(m.total, minuteMax) + '% + 2px)' }"
                    >{{ axisNum(m.total) }}</span>
                    <div
                      class="spark-bar"
                      :class="{ err: errShare(m.byClass, m.total) > 0.2 }"
                      :style="{ height: barPct(m.total, minuteMax) + '%' }"
                    ></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="x-axis">
              <span class="x-pad"></span>
              <div class="x-labels">
                <span
                  v-for="t in minuteTicks"
                  :key="t.i"
                  class="x-tick"
                  :class="{ first: t.i === 0, last: t.i === report.minutes.length - 1 }"
                  :style="{ left: t.left + '%' }"
                >{{ t.label }}</span>
              </div>
            </div>
          </div>
          <p class="muted" style="margin: 6px 0 0; font-size: 12px">
            Resets on server restart. Bars turn amber when 4xx+5xx exceeds 20%.
          </p>
        </div>
      </div>

      <h3 class="section-title">Hourly ({{ report.hours }}h)</h3>
      <div class="chart">
        <div class="plot">
          <div class="y-axis">
            <div class="y-inner">
              <span class="y-tick t100">{{ axisNum(hourMax) }}</span>
              <span class="y-tick t50">{{ axisNum(Math.round(hourMax / 2)) }}</span>
              <span class="y-tick t0">0</span>
            </div>
          </div>
          <div class="plot-area hour">
            <div class="gridlines"><span class="gline g0"></span><span class="gline g50"></span><span class="gline g100"></span></div>
            <div class="bars" :style="{ gap: gapOf(report.hourly.length) }">
              <div
                v-for="(h, i) in report.hourly"
                :key="h.minuteTs"
                class="bar-col"
                :title="`${hourLabel(h.minuteTs)} — ${h.total} req`"
              >
                <span
                  v-if="h.total > 0 && hourValAt.has(i)"
                  class="bar-val"
                  :style="{ bottom: 'calc(' + barPct(h.total, hourMax) + '% + 2px)' }"
                >{{ axisNum(h.total) }}</span>
                <div
                  class="spark-bar"
                  :class="{ err: errShare(h.byClass, h.total) > 0.2 }"
                  :style="{ height: barPct(h.total, hourMax) + '%' }"
                ></div>
              </div>
            </div>
          </div>
        </div>
        <div class="x-axis">
          <span class="x-pad"></span>
          <div class="x-labels">
            <span
              v-for="t in hourTicks"
              :key="t.i"
              class="x-tick"
              :class="{ first: t.i === 0, last: t.i === report.hourly.length - 1 }"
              :style="{ left: t.left + '%' }"
            >{{ t.label }}</span>
          </div>
        </div>
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
.chart { margin: 6px 0; }
.plot { display: flex; align-items: stretch; gap: 8px; }
.y-axis {
  position: relative;
  width: 44px;
  flex-shrink: 0;
}
/*
 * 刻度带必须和 .gridlines 完全重合，所以用同一套像素偏移：
 * 上 = 绘图区 1px 边框 + 16px 数值预留，下 = 1px 边框。
 */
.y-inner {
  position: absolute;
  top: 17px;
  bottom: 1px;
  left: 0;
  right: 4px;
}
.y-tick {
  position: absolute;
  right: 0;
  /* 让文字垂直居中压在网格线上，而不是坐在线的上/下方 */
  transform: translateY(50%);
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}
.y-tick.t0 { bottom: 0; }
.y-tick.t50 { bottom: 50%; }
.y-tick.t100 { bottom: 100%; }
.plot-area {
  position: relative;
  flex: 1;
  height: 80px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.plot-area.hour { height: 130px; }
/* 不能叫 .grid —— styles.css 里有全局 .grid { display: grid } 会漏进来 */
.gridlines,
.bars {
  position: absolute;
  left: 0;
  right: 0;
  top: 16px;
  bottom: 0;
}
.gline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  opacity: 0.5;
  pointer-events: none;
}
.gline.g0 { bottom: 0; }
.gline.g50 { bottom: 50%; }
.gline.g100 { bottom: 100%; }
.bars {
  display: flex;
  align-items: stretch;
  gap: 1px;
}
.bar-col {
  flex: 1;
  min-width: 0;
  position: relative;
}
.bar-val {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 9px;
  color: var(--muted);
  white-space: nowrap;
  pointer-events: none;
}
.spark-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--accent);
  opacity: 0.75;
  border-radius: 1px 1px 0 0;
}
.bar-col:hover .spark-bar { opacity: 1; }
.spark-bar.err { background: var(--warn); }
.x-axis {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin-top: 4px;
}
.x-pad { width: 44px; flex-shrink: 0; }
.x-labels {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 13px;
}
.x-tick {
  position: absolute;
  /* left 是柱心百分比，平移半个自身宽度让标签正对柱子 */
  transform: translateX(-50%);
  font-size: 10px;
  line-height: 13px;
  color: var(--muted);
  white-space: nowrap;
}
/* 首尾贴边，避免第一个标签溢出左边、最后一个溢出右边 */
.x-tick.first { transform: none; }
.x-tick.last { transform: translateX(-100%); }
.warnText { color: var(--warn); }
.dangerText { color: var(--danger); }
code { font-size: 12px; color: var(--muted); }
</style>
