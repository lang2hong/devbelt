<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

const tab = ref<'cols' | 'idx' | 'ddl'>('cols');
const columns = ref<any[]>([]);
const indexes = ref<any[]>([]);
const ddl = ref('');
const error = ref('');

const showAdd = ref(false);
const addName = ref('');
const addDef = ref('');
const editingCol = ref<{ name: string; definition: string } | null>(null);
const confirmDrop = ref<{ name: string } | null>(null);

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
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
onUnmounted(() => cleanup?.());

function esc(s: any): string {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function startAdd() {
  showAdd.value = true;
  addName.value = '';
  addDef.value = '';
}

function cancelAdd() {
  showAdd.value = false;
}

function saveAdd() {
  if (!addName.value.trim() || !addDef.value.trim()) return;
  post({ type: 'addColumn', column: addName.value.trim(), definition: addDef.value.trim() });
  showAdd.value = false;
}

function startEdit(col: any) {
  const parts: string[] = [];
  const type = col.simpleType || col.type || '';
  if (type) parts.push(type);
  if (col.isNotNull) parts.push('NOT NULL');
  if (col.isAutoIncrement) parts.push('AUTO_INCREMENT');
  editingCol.value = { name: col.name, definition: parts.join(' ') || 'VARCHAR(255)' };
}

function cancelEdit() {
  editingCol.value = null;
}

function saveEdit() {
  if (!editingCol.value) return;
  if (!editingCol.value.definition.trim()) return;
  post({ type: 'modifyColumn', column: editingCol.value.name, definition: editingCol.value.definition.trim() });
  editingCol.value = null;
}

function dropCol(col: any) {
  confirmDrop.value = { name: col.name };
}

function confirmDropCol() {
  if (!confirmDrop.value) return;
  post({ type: 'dropColumn', column: confirmDrop.value.name });
  confirmDrop.value = null;
}

function cancelDrop() {
  confirmDrop.value = null;
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
      <div v-if="tab === 'cols'">
        <div class="toolbar">
          <button class="btn" @click="startAdd">+ Add Column</button>
        </div>
        <div v-if="showAdd" class="add-row">
          <input v-model="addName" class="input" placeholder="column name" />
          <input v-model="addDef" class="input wide" placeholder="VARCHAR(255) NOT NULL" />
          <button class="btn primary" @click="saveAdd">Add</button>
          <button class="btn" @click="cancelAdd">Cancel</button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Key</th><th>Default</th><th>Extra</th><th class="act-col">Actions</th></tr></thead>
          <tbody>
            <tr v-for="c in columns" :key="c.name">
              <template v-if="editingCol && editingCol.name === c.name">
                <td>{{ c.name }}</td>
                <td><input v-model="editingCol.definition" class="input" placeholder="VARCHAR(255)" /></td>
                <td colspan="4"></td>
                <td>
                  <button class="btn primary" @click="saveEdit">Save</button>
                  <button class="btn" @click="cancelEdit">Cancel</button>
                </td>
              </template>
              <template v-else>
                <td>{{ c.name }}</td>
                <td>{{ c.simpleType || c.type }}</td>
                <td>{{ c.nullable === 'NO' || c.isNotNull ? 'NO' : 'YES' }}</td>
                <td>{{ c.isPrimary ? 'PK' : (c.key || '') }}</td>
                <td>{{ c.defaultValue ?? '' }}</td>
                <td>{{ c.extra ?? '' }}</td>
                <td>
                  <button class="btn" @click="startEdit(c)">Edit</button>
                  <button class="btn danger" @click="dropCol(c)">Del</button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
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
    <div v-if="confirmDrop" class="modal-mask" @click.self="cancelDrop">
      <div class="modal">
        <div class="modal-title">Delete column</div>
        <div class="modal-body">Delete column "{{ confirmDrop.name }}"? This cannot be undone.</div>
        <div class="modal-actions">
          <button class="btn" @click="cancelDrop">Cancel</button>
          <button class="btn danger" @click="confirmDropCol">Delete</button>
        </div>
      </div>
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
.toolbar { margin-bottom: 8px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.danger { background: var(--vscode-errorForeground); color: #fff; }
.input { font-size: 12px; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.input.wide { width: 280px; }
.add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.add-row .input { flex: 1; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { background: var(--vscode-editor-background); position: sticky; top: 0; }
.act-col { width: 120px; }
pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 13px; }
.error { padding: 12px; color: var(--vscode-errorForeground); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 16px; min-width: 320px; }
.modal-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.modal-body { font-size: 12px; color: var(--vscode-foreground); margin-bottom: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>