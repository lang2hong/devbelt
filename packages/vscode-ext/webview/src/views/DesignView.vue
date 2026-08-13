<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

const tab = ref<'cols' | 'idx' | 'ddl'>('cols');
const columns = ref<any[]>([]);
const indexes = ref<any[]>([]);
const ddl = ref('');
const error = ref('');

const canReorder = ref(false);
const dbType = ref('');

// 列编辑/新增状态
interface ColForm { name: string; type: string; notNull: boolean; defaultVal: string; comment: string; }
const editingCol = ref<ColForm | null>(null);
const editingName = ref('');
const newRow = ref<ColForm>({ name: '', type: 'VARCHAR(255)', notNull: false, defaultVal: '', comment: '' });
const confirmDrop = ref<{ name: string } | null>(null);

// 索引编辑/新增状态
interface IdxForm { oldName?: string; name: string; cols: Record<string, boolean>; unique: boolean; }
const showIdxForm = ref(false);
const idxForm = ref<IdxForm>({ name: '', cols: {}, unique: false });
const confirmDropIdx = ref<{ name: string } | null>(null);

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      dbType.value = msg.dbType;
      canReorder.value = msg.dbType === 'MYSQL';
    } else if (msg.type === 'data') {
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

function startEdit(col: any) {
  editingName.value = col.name;
  editingCol.value = {
    name: col.name,
    type: col.type || col.simpleType || 'VARCHAR(255)',
    notNull: !!col.isNotNull || col.nullable === 'NO',
    defaultVal: col.defaultValue ?? '',
    comment: col.comment ?? '',
  };
}

function cancelEdit() {
  editingCol.value = null;
  editingName.value = '';
}

function saveEdit() {
  const f = editingCol.value;
  if (!f || !f.type.trim()) return;
  post({ type: 'modifyColumn', column: f.name, definition: buildDef(f) });
  editingCol.value = null;
  editingName.value = '';
}

function saveAdd() {
  const f = newRow.value;
  if (!f.name.trim() || !f.type.trim()) return;
  post({ type: 'addColumn', column: f.name.trim(), definition: buildDef(f) });
  newRow.value = { name: '', type: 'VARCHAR(255)', notNull: false, defaultVal: '', comment: '' };
}

function moveColumn(col: any, dir: 'up' | 'down') {
  if (!canReorder.value) return;
  const idx = columns.value.findIndex((c: any) => c.name === col.name);
  if (idx < 0) return;
  const len = columns.value.length;
  if (dir === 'up' && idx === 0) return;
  if (dir === 'down' && idx >= len - 1) return;
  const afterColumn = dir === 'up'
    ? (idx - 1 <= 0 ? null : columns.value[idx - 2].name)
    : columns.value[idx + 1].name;
  post({ type: 'reorderColumn', column: col.name, afterColumn });
}

function dropCol(col: any) {
  confirmDrop.value = { name: col.name };
}
function confirmDropCol() {
  if (!confirmDrop.value) return;
  post({ type: 'dropColumn', column: confirmDrop.value.name });
  confirmDrop.value = null;
}

function buildDef(f: ColForm): string {
  let s = f.type.trim();
  s += f.notNull ? ' NOT NULL' : ' NULL';
  const dv = f.defaultVal.trim();
  if (dv !== '') {
    const raw = /^-?\d+(\.\d+)?$/.test(dv) || /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL)$/i.test(dv);
    s += ` DEFAULT ${raw ? dv : `'${dv.replace(/'/g, "''")}'`}`;
  }
  if (f.comment.trim()) s += ` COMMENT '${f.comment.trim().replace(/'/g, "''")}'`;
  return s;
}

// ── 索引 ──
function startAddIdx() {
  showIdxForm.value = true;
  const cols: Record<string, boolean> = {};
  for (const c of columns.value) cols[c.name] = false;
  idxForm.value = { name: '', cols, unique: false };
}

function startEditIdx(i: any) {
  showIdxForm.value = true;
  const cols: Record<string, boolean> = {};
  for (const c of columns.value) cols[c.name] = (i.columns || []).includes(c.name);
  idxForm.value = { oldName: i.name, name: i.name, cols, unique: !!i.isUnique };
}

function cancelIdxForm() {
  showIdxForm.value = false;
  idxForm.value = { name: '', cols: {}, unique: false };
}

function saveIdxForm() {
  const f = idxForm.value;
  const name = f.name.trim();
  const cols = Object.keys(f.cols).filter((c) => f.cols[c]);
  if (!name || !cols.length) return;
  if (f.oldName) {
    post({ type: 'editIndex', oldName: f.oldName, name, columns: cols, isUnique: f.unique });
  } else {
    post({ type: 'addIndex', name, columns: cols, isUnique: f.unique });
  }
  showIdxForm.value = false;
}

function dropIdx(i: any) {
  confirmDropIdx.value = { name: i.name };
}
function confirmDropIdxHandler() {
  if (!confirmDropIdx.value) return;
  post({ type: 'dropIndex', name: confirmDropIdx.value.name });
  confirmDropIdx.value = null;
}

const idxSelectedCols = computed(() => Object.keys(idxForm.value.cols).filter((c) => idxForm.value.cols[c]));
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
        <table class="grid">
          <thead>
            <tr>
              <th class="c-name">Name</th>
              <th class="c-type">Type</th>
              <th class="c-chk">Not Null</th>
              <th class="c-def">Default</th>
              <th class="c-cmt">Comment</th>
              <th class="c-act">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, idx) in columns" :key="c.name">
              <template v-if="editingName === c.name && editingCol">
                <td class="mono">{{ c.name }}</td>
                <td><input v-model="editingCol.type" class="input" list="mysqlTypes" placeholder="VARCHAR(255)" /></td>
                <td><input type="checkbox" v-model="editingCol.notNull" /></td>
                <td><input v-model="editingCol.defaultVal" class="input" placeholder="NULL" /></td>
                <td><input v-model="editingCol.comment" class="input" /></td>
                <td>
                  <button class="btn primary" @click="saveEdit">Save</button>
                  <button class="btn" @click="cancelEdit">Cancel</button>
                </td>
              </template>
              <template v-else>
                <td class="mono">{{ c.name }}</td>
                <td class="mono">{{ c.type || c.simpleType }}</td>
                <td>{{ c.isNotNull || c.nullable === 'NO' ? 'YES' : 'NO' }}</td>
                <td class="mono">{{ c.defaultValue ?? '' }}</td>
                <td>{{ c.comment ?? '' }}</td>
                <td>
                  <button v-if="canReorder" class="btn sm" :disabled="idx === 0" @click="moveColumn(c, 'up')" title="Move up">▲</button>
                  <button v-if="canReorder" class="btn sm" :disabled="idx === columns.length - 1" @click="moveColumn(c, 'down')" title="Move down">▼</button>
                  <button class="btn" @click="startEdit(c)">Edit</button>
                  <button class="btn danger" @click="dropCol(c)">Del</button>
                </td>
              </template>
            </tr>
            <tr class="new-row">
              <td><input v-model="newRow.name" class="input" placeholder="new column" /></td>
              <td><input v-model="newRow.type" class="input" list="mysqlTypes" placeholder="VARCHAR(255)" /></td>
              <td><input type="checkbox" v-model="newRow.notNull" /></td>
              <td><input v-model="newRow.defaultVal" class="input" placeholder="NULL" /></td>
              <td><input v-model="newRow.comment" class="input" /></td>
              <td><button class="btn primary" @click="saveAdd">+ Add</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- Indexes -->
      <div v-else-if="tab === 'idx'">
        <div class="toolbar">
          <button class="btn" @click="startAddIdx">+ Add Index</button>
        </div>
        <table class="grid">
          <thead><tr><th class="c-name">Name</th><th>Columns</th><th class="c-chk">Unique</th><th class="c-chk">Primary</th><th class="c-act">Actions</th></tr></thead>
          <tbody>
            <tr v-for="i in indexes" :key="i.name">
              <td class="mono">{{ i.name }}</td>
              <td class="mono">{{ (i.columns || []).join(', ') }}</td>
              <td>{{ i.isUnique ? 'YES' : 'NO' }}</td>
              <td>{{ i.isPrimary ? 'YES' : 'NO' }}</td>
                <td>
                  <button class="btn" :disabled="!!i.isPrimary" @click="startEditIdx(i)">Edit</button>
                  <button class="btn danger" :disabled="!!i.isPrimary" @click="dropIdx(i)">Del</button>
                </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- DDL -->
      <pre v-else>{{ ddl }}</pre>
    </div>
    <datalist id="mysqlTypes">
      <option value="INT"></option>
      <option value="BIGINT"></option>
      <option value="SMALLINT"></option>
      <option value="TINYINT"></option>
      <option value="MEDIUMINT"></option>
      <option value="INT UNSIGNED"></option>
      <option value="BIGINT UNSIGNED"></option>
      <option value="DECIMAL(10,2)"></option>
      <option value="FLOAT"></option>
      <option value="DOUBLE"></option>
      <option value="VARCHAR(255)"></option>
      <option value="CHAR(36)"></option>
      <option value="TEXT"></option>
      <option value="MEDIUMTEXT"></option>
      <option value="LONGTEXT"></option>
      <option value="TINYTEXT"></option>
      <option value="JSON"></option>
      <option value="BLOB"></option>
      <option value="MEDIUMBLOB"></option>
      <option value="LONGBLOB"></option>
      <option value="DATE"></option>
      <option value="DATETIME"></option>
      <option value="TIMESTAMP"></option>
      <option value="TIME"></option>
      <option value="YEAR"></option>
      <option value="ENUM('a','b')"></option>
    </datalist>

    <!-- 索引编辑/新增弹窗 -->
    <div v-if="showIdxForm" class="modal-mask" @click.self="cancelIdxForm">
      <div class="modal idx-modal">
        <div class="modal-title">{{ idxForm.oldName ? 'Edit Index' : 'Add Index' }}</div>
        <div class="form-row">
          <label>Index Name</label>
          <input v-model="idxForm.name" class="input" placeholder="index name" />
        </div>
        <div class="form-row">
          <label class="chk"><input type="checkbox" v-model="idxForm.unique" /> Unique</label>
        </div>
        <div class="form-row col-pick">
          <label>Columns ({{ idxSelectedCols.length }})</label>
          <div class="col-list">
            <label v-for="c in columns" :key="c.name" class="chk col-item">
              <input type="checkbox" v-model="idxForm.cols[c.name]" /> {{ c.name }}
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="cancelIdxForm">Cancel</button>
          <button class="btn primary" @click="saveIdxForm">{{ idxForm.oldName ? 'Save' : 'Add' }}</button>
        </div>
      </div>
    </div>

    <div v-if="confirmDrop" class="modal-mask" @click.self="confirmDrop = null">
      <div class="modal">
        <div class="modal-title">Delete column</div>
        <div class="modal-body">Delete column "{{ confirmDrop.name }}"? This cannot be undone.</div>
        <div class="modal-actions">
          <button class="btn" @click="confirmDrop = null">Cancel</button>
          <button class="btn danger" @click="confirmDropCol">Delete</button>
        </div>
      </div>
    </div>
    <div v-if="confirmDropIdx" class="modal-mask" @click.self="confirmDropIdx = null">
      <div class="modal">
        <div class="modal-title">Delete index</div>
        <div class="modal-body">Delete index "{{ confirmDropIdx.name }}"? This cannot be undone.</div>
        <div class="modal-actions">
          <button class="btn" @click="confirmDropIdx = null">Cancel</button>
          <button class="btn danger" @click="confirmDropIdxHandler">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); }
.tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.tabs button { padding: 6px 16px; font-size: 12px; cursor: pointer; border: none; background: none;
  color: var(--vscode-foreground, #cccccc); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder, #007fd4); color: var(--vscode-textLink-foreground, #4daafc); }
.content { flex: 1; overflow: auto; padding: 8px; }
.toolbar { margin-bottom: 8px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.sm { padding: 2px 6px; }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
.btn.danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
.input { font-size: 12px; padding: 3px 6px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; width: 100%; box-sizing: border-box; }
.grid { border-collapse: collapse; font-size: 13px; width: 100%; table-layout: fixed; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 8px; text-align: left; overflow: hidden; text-overflow: ellipsis; }
th { background: var(--vscode-editor-background, #1e1e1e); position: sticky; top: 0; z-index: 1; }
.mono { font-family: var(--vscode-editor-font-family, monospace); }
.c-name { width: 20%; }
.c-type { width: 22%; }
.c-chk { width: 8%; text-align: center; }
.c-def { width: 15%; }
.c-cmt { width: 20%; }
.c-act { width: 15%; white-space: nowrap; }
.new-row { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 4px; padding: 16px; min-width: 320px; }
.modal-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
.modal-body { font-size: 12px; color: var(--vscode-foreground, #cccccc); margin-bottom: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.idx-modal { min-width: 360px; }
.form-row { margin-bottom: 10px; }
.form-row label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-foreground, #cccccc); }
.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.col-pick .col-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; padding: 4px; }
.col-item { display: flex; padding: 2px 4px; }
pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
.error { padding: 12px; color: var(--vscode-errorForeground, #f48771); }
</style>
