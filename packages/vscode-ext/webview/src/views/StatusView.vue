<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();
const tab = ref<'process' | 'status' | 'vars'>('process');
const processList = ref<any[]>([]);
const statusVars = ref<any[]>([]);
const serverVars = ref<any[]>([]);
const summary = ref<any>(null);
const error = ref('');
const search = ref('');

onMounted(() => {
  onMessage((msg: any) => {
    if (msg.type === 'data') {
      processList.value = msg.processList || [];
      statusVars.value = msg.statusVars || [];
      serverVars.value = msg.serverVars || [];
      summary.value = msg.summary || null;
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});

const filteredStatus = computed(() => {
  if (!search.value) return statusVars.value;
  return statusVars.value.filter(r => JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()));
});
const filteredVars = computed(() => {
  if (!search.value) return serverVars.value;
  return serverVars.value.filter(r => JSON.stringify(r).toLowerCase().includes(search.value.toLowerCase()));
});
</script>

<template>
  <div class="app">
    <div class="summary" v-if="summary">
      <span class="badge">{{ summary.dbType }}</span>
      <span v-if="summary.version" class="kv"><b>Version</b> {{ summary.version }}</span>
      <span v-if="summary.host" class="kv"><b>Host</b> {{ summary.host }}<template v-if="summary.port">:{{ summary.port }}</template></span>
      <span v-if="summary.currentUser" class="kv"><b>User</b> {{ summary.currentUser }}</span>
      <span v-if="summary.database" class="kv"><b>Database</b> {{ summary.database }}</span>
    </div>
    <div class="tabs">
      <button :class="{ active: tab === 'process' }" @click="tab = 'process'">Process ({{ processList.length }})</button>
      <button :class="{ active: tab === 'status' }" @click="tab = 'status'">Status ({{ statusVars.length }})</button>
      <button :class="{ active: tab === 'vars' }" @click="tab = 'vars'">Variables ({{ serverVars.length }})</button>
    </div>
    <div class="search" v-if="tab !== 'process'">
      <input v-model="search" placeholder="Filter..." class="input" />
    </div>
    <div class="error" v-if="error">{{ error }}</div>
    <div class="content" v-else>
      <!-- Process List -->
      <table v-if="tab === 'process' && processList.length">
        <thead><tr><th v-for="k in Object.keys(processList[0])" :key="k">{{ k }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in processList" :key="i">
            <td v-for="k in Object.keys(processList[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'process'">No processes.</p>
      <!-- Status Variables -->
      <table v-if="tab === 'status' && filteredStatus.length">
        <thead><tr><th v-for="k in Object.keys(filteredStatus[0])" :key="k">{{ k }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in filteredStatus" :key="i">
            <td v-for="k in Object.keys(filteredStatus[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'status'">No status variables. (MySQL only)</p>
      <!-- Server Variables -->
      <table v-if="tab === 'vars' && filteredVars.length">
        <thead><tr><th v-for="k in Object.keys(filteredVars[0])" :key="k">{{ k }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in filteredVars" :key="i">
            <td v-for="k in Object.keys(filteredVars[0])" :key="k">{{ row[k] }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="tab === 'vars'">No variables.</p>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); }
.summary { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; align-items: center; }
.summary .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 3px; font-weight: 600; }
.summary .kv b { color: var(--vscode-descriptionForeground); margin-right: 4px; font-weight: 500; }
.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
.tabs button { padding: 6px 16px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
.search { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.input { width: 100%; box-sizing: border-box; font-size: 12px; padding: 4px 8px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.content { flex: 1; overflow: auto; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { background: var(--vscode-editor-background); position: sticky; top: 0; }
p { padding: 12px; color: var(--vscode-descriptionForeground); }
.error { padding: 12px; color: var(--vscode-errorForeground); }
</style>
