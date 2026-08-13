<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

interface MetricPoint { time: number; value: number }
interface DashboardData {
  summary: { dbType: string; version?: string; host?: string; port?: number; currentUser?: string; database?: string };
  metrics: { activeConnections: MetricPoint[]; questions: MetricPoint[]; slowQueries: MetricPoint[]; bytesReceived: MetricPoint[]; bytesSent: MetricPoint[] };
  processList: any[];
  keyVars: { label: string; value: string }[];
}

const data = ref<DashboardData | null>(null);
const error = ref('');
const chartCanvas = ref<HTMLCanvasElement | null>(null);
let chartInstance: any = null;

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'data') {
      data.value = msg;
      error.value = '';
      void renderChart();
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => {
  cleanup?.();
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
});

async function renderChart() {
  await nextTick();
  if (!chartCanvas.value || !data.value) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const { Chart, registerables } = await import(/* @vite-ignore */ 'chart.js');
  Chart.register(...registerables);

  const isDark = document.body.classList.contains('vscode-dark');
  const textColor = isDark ? '#cccccc' : '#333333';
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  const m = data.value.metrics;
  const labels = m.activeConnections.map((p) => new Date(p.time).toLocaleTimeString());

  const config: any = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Active Connections',
          data: m.activeConnections.map((p) => p.value),
          borderColor: '#4e79a7',
          backgroundColor: 'rgba(78,121,167,0.1)',
          tension: 0.2,
          fill: true,
        },
        {
          label: 'Threads Running',
          data: m.questions.map((_p, i) => {
            const prev = i > 0 ? m.questions[i - 1].value : m.questions[i].value;
            const curr = m.questions[i].value;
            return curr - prev;
          }),
          borderColor: '#f28e2b',
          backgroundColor: 'rgba(242,142,43,0.1)',
          tension: 0.2,
          fill: false,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor } } },
      scales: {
        x: { ticks: { color: textColor, maxTicksLimit: 10 }, grid: { color: gridColor } },
        y: {
          title: { display: true, text: 'Connections', color: textColor },
          ticks: { color: textColor },
          grid: { color: gridColor },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          title: { display: true, text: 'QPS', color: textColor },
          ticks: { color: textColor },
          grid: { display: false },
          beginAtZero: true,
        },
      },
    },
  };

  chartInstance = new (Chart as any)(chartCanvas.value, config);
}

function formatBytes(n: number): string {
  if (!n) return '0B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)}${u[i]}`;
}
</script>

<template>
  <div class="dashboard">
    <div class="summary" v-if="data?.summary">
      <span class="badge">{{ data.summary.dbType }}</span>
      <span v-if="data.summary.version" class="kv"><b>Version</b> {{ data.summary.version }}</span>
      <span v-if="data.summary.currentUser" class="kv"><b>User</b> {{ data.summary.currentUser }}</span>
      <span v-if="data.summary.database" class="kv"><b>Database</b> {{ data.summary.database }}</span>
      <span class="kv live">Live</span>
    </div>
    <div class="error" v-if="error">{{ error }}</div>
    <div class="cards" v-if="data?.keyVars">
      <div class="card" v-for="kv in data.keyVars" :key="kv.key">
        <span class="card-label">{{ kv.label }}</span>
        <span class="card-value">{{ kv.value }}</span>
      </div>
    </div>
    <div class="chart-container">
      <canvas ref="chartCanvas"></canvas>
    </div>
    <div class="process-section">
      <h3>Process List ({{ data?.processList.length || 0 }})</h3>
      <table v-if="data?.processList.length">
        <thead>
          <tr>
            <th v-for="k in Object.keys(data.processList[0])" :key="k">{{ k }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in data.processList" :key="i">
            <td v-for="k in Object.keys(data.processList[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else>No processes.</p>
    </div>
  </div>
</template>

<style scoped>
.dashboard { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); overflow: auto; }
.summary { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); font-size: 12px; align-items: center; }
.summary .badge { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #ffffff); padding: 2px 8px; border-radius: 3px; font-weight: 600; }
.summary .kv b { color: var(--vscode-descriptionForeground, #808080); margin-right: 4px; font-weight: 500; }
.summary .live { color: var(--vscode-charts-green); font-weight: 500; margin-left: auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.card { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.card-label { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); }
.card-value { font-size: 13px; color: var(--vscode-foreground, #cccccc); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart-container { flex-shrink: 0; height: 250px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.chart-container canvas { width: 100% !important; height: 100% !important; }
.process-section { padding: 8px 12px; }
.process-section h3 { font-size: 13px; margin: 0 0 8px; color: var(--vscode-foreground); }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 3px 8px; text-align: left; white-space: nowrap; }
th { background: var(--vscode-editor-background, #1e1e1e); position: sticky; top: 0; }
p { padding: 12px; color: var(--vscode-descriptionForeground, #808080); }
.error { padding: 8px 12px; color: var(--vscode-errorForeground, #f48771); font-size: 12px; }
</style>