<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

const tab = ref<'cols' | 'idx' | 'ddl'>('cols');
const columns = ref<any[]>([]);
const indexes = ref<any[]>([]);
const ddl = ref('');
const error = ref('');

onMounted(() => {
  onMessage((msg: any) => {
    if (msg.type === 'data') {
      columns.value = msg.columns || [];
      indexes.value = msg.indexes || [];
      ddl.value = msg.ddl || '-- No DDL';
      error.value = '';
    } else if (msg.type === 'error') {
      error.value = msg.message;
    }
  });
  post({ type: 'ready' });
});

function esc(s: any): string {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
</script>

<template>
  <div class="app">
    <div class="tabs">
      <button :class="{ active: tab === 'cols' }" @click="tab = 'cols'">Columns</button>
      <button :class="{ active: tab === 'idx' }" @click="tab = 'idx'">Indexes</button>
      <button :class="{ active: tab === 'ddl' }" @click="tab = 'ddl'">DDL</button>
    </div>
    <div class="error" v-if="error">{{ error }}</div>
    <div class="content" v-else>
      <!-- Columns -->
      <table v-if="tab === 'cols'">
        <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Key</th><th>Default</th><th>Extra</th></tr></thead>
        <tbody>
          <tr v-for="c in columns" :key="c.name">
            <td>{{ c.name }}</td>
            <td>{{ c.simpleType || c.type }}</td>
            <td>{{ c.nullable === 'NO' || c.isNotNull ? 'NO' : 'YES' }}</td>
            <td>{{ c.isPrimary ? 'PK' : (c.key || '') }}</td>
            <td>{{ c.defaultValue ?? '' }}</td>
            <td>{{ c.extra ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <!-- Indexes -->
      <table v-else-if="tab === 'idx'">
        <thead><tr><th>Name</th><th>Columns</th><th>Unique</th><th>Primary</th></tr></thead>
        <tbody>
          <tr v-for="i in indexes" :key="i.name">
            <td>{{ i.name }}</td>
            <td>{{ (i.columns || []).join(', ') }}</td>
            <td>{{ i.isUnique ? 'YES' : 'NO' }}</td>
            <td>{{ i.isPrimary ? 'YES' : 'NO' }}</td>
          </tr>
        </tbody>
      </table>
      <!-- DDL -->
      <pre v-else>{{ ddl }}</pre>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); }
.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
.tabs button { padding: 6px 16px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
.content { flex: 1; overflow: auto; padding: 8px; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { background: var(--vscode-editor-background); position: sticky; top: 0; }
pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 13px; }
.error { padding: 12px; color: var(--vscode-errorForeground); }
</style>
