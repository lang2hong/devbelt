<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';

const { post, onMessage } = useVsCode();

const isZh = ref(false);
const editingId = ref('');
const groups = ref<{ id: string; name: string }[]>([]);
const status = ref('');
const statusOk = ref(true);

const defaultForm = {
  dbType: 'MYSQL',
  name: '',
  groupId: '',
  host: 'localhost',
  port: '3306',
  user: 'root',
  password: '',
  database: '',
  dbPath: '',
  schema: '',
  timezone: '',
  sqliteCommand: '',
  environment: 'development',
  readOnly: false,
  useConnectionString: false,
  connectionUrl: '',
  useSSL: false,
  caPath: '',
  clientCertPath: '',
  clientKeyPath: '',
  connectTimeout: '5000',
  requestTimeout: '30000',
  socketPath: '',
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshPassword: '',
  sshPrivateKeyPath: '',
  sshPassphrase: '',
};
const form = reactive({ ...defaultForm });

const showPassword = ref(false);
const showSshPassword = ref(false);
const showSshPassphrase = ref(false);

const isSqlite = computed(() => form.dbType === 'SQLITE');
const isPg = computed(() => form.dbType === 'PG');

const I18N: Record<string, Record<'en' | 'zh', string>> = {
  title: { en: 'New Connection', zh: '新建连接' },
  editTitle: { en: 'Edit Connection', zh: '编辑连接' },
  dbType: { en: 'Database Type', zh: '数据库类型' },
  name: { en: 'Name', zh: '名称' },
  group: { en: 'Group', zh: '分组' },
  noGroup: { en: 'No group', zh: '无分组' },
  host: { en: 'Host', zh: '主机' },
  port: { en: 'Port', zh: '端口' },
  user: { en: 'User', zh: '用户' },
  password: { en: 'Password', zh: '密码' },
  database: { en: 'Database', zh: '数据库' },
  schema: { en: 'Schema', zh: 'Schema' },
  sqlitePath: { en: 'SQLite File Path', zh: 'SQLite 文件路径' },
  ssh: { en: 'SSH Tunnel (optional)', zh: 'SSH 隧道（可选）' },
  sshHost: { en: 'SSH Host', zh: 'SSH 主机' },
  sshPort: { en: 'SSH Port', zh: 'SSH 端口' },
  sshUser: { en: 'SSH User', zh: 'SSH 用户' },
  sshPass: { en: 'SSH Password', zh: 'SSH 密码' },
  sshKey: { en: 'SSH Private Key Path', zh: 'SSH 私钥路径' },
  sshPhrase: { en: 'SSH Key Passphrase', zh: 'SSH 私钥密码' },
  advanced: { en: 'Advanced Connection Settings', zh: '高级连接设置' },
  env: { en: 'Environment', zh: '环境' },
  envDev: { en: 'Development', zh: '开发' },
  envTest: { en: 'Test', zh: '测试' },
  envStaging: { en: 'Staging', zh: '预发布' },
  envProd: { en: 'Production', zh: '生产' },
  readOnly: { en: 'Read-only', zh: '只读' },
  useConnUrl: { en: 'Use connection URL', zh: '使用连接串' },
  useSsl: { en: 'Use SSL/TLS', zh: '使用 SSL/TLS' },
  caCert: { en: 'CA certificate path', zh: 'CA 证书路径' },
  clientCert: { en: 'Client certificate path', zh: '客户端证书路径' },
  clientKey: { en: 'Client key path', zh: '客户端密钥路径' },
  connTimeout: { en: 'Connect timeout (ms)', zh: '连接超时 (ms)' },
  reqTimeout: { en: 'Request timeout (ms)', zh: '请求超时 (ms)' },
  socketPath: { en: 'Socket path', zh: 'Socket 路径' },
  test: { en: 'Test Connection', zh: '测试连接' },
  save: { en: 'Save', zh: '保存' },
  testing: { en: 'Testing...', zh: '测试中...' },
  show: { en: 'Show', zh: '显示' },
  hide: { en: 'Hide', zh: '隐藏' },
};
const t = (key: string): string => (I18N[key]?.[isZh.value ? 'zh' : 'en'] ?? key);

function syncType(): void {
  if (form.dbType === 'PG') form.port = '5432';
  else if (form.dbType === 'MYSQL') form.port = '3306';
  if (isSqlite.value) form.host = '';
}

function collect(): Record<string, unknown> {
  const result: Record<string, unknown> = { id: editingId.value };
  for (const key of Object.keys(form)) {
    result[key] = (form as any)[key];
  }
  return result;
}

function prefill(c: Record<string, any>): void {
  editingId.value = c.id || '';
  for (const key of Object.keys(form)) {
    const val = c[key];
    const defVal = (defaultForm as any)[key];
    if (typeof defVal === 'boolean') {
      (form as any)[key] = !!val;
    } else if (val !== undefined && val !== null) {
      (form as any)[key] = val;
    } else {
      (form as any)[key] = defVal;
    }
  }
  syncType();
}

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      isZh.value = !!msg.isZh;
      groups.value = Array.isArray(msg.groups) ? msg.groups : [];
    } else if (msg.type === 'prefill' && msg.conn) {
      prefill(msg.conn);
    } else if (msg.type === 'reset') {
      Object.assign(form, defaultForm);
      editingId.value = '';
      syncType();
    } else if (msg.type === 'presetGroup' && msg.groupId) {
      form.groupId = msg.groupId;
    } else if (msg.type === 'testResult') {
      status.value = msg.message || '';
      statusOk.value = !!msg.ok;
    }
  });
  post({ type: 'ready' });
});

onUnmounted(() => cleanup?.());

function test(): void {
  status.value = t('testing');
  statusOk.value = true;
  post({ type: 'test', payload: collect() });
}

function save(): void {
  post({ type: 'save', payload: collect() });
}
</script>

<template>
  <div class="container">
    <h2>{{ editingId ? t('editTitle') : t('title') }}</h2>

    <div class="field">
      <label>{{ t('dbType') }}</label>
      <select v-model="form.dbType" @change="syncType">
        <option value="MYSQL">MySQL</option>
        <option value="PG">PostgreSQL</option>
        <option value="SQLITE">SQLite</option>
      </select>
    </div>

    <div class="row">
      <div class="field">
        <label>{{ t('name') }}</label>
        <input v-model="form.name" placeholder="My Database">
      </div>
      <div class="field">
        <label>{{ t('group') }}</label>
        <select v-model="form.groupId">
          <option value="">{{ t('noGroup') }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
      </div>
    </div>

    <div v-if="!isSqlite" class="row">
      <div class="field">
        <label>{{ t('host') }}</label>
        <input v-model="form.host">
      </div>
      <div class="field">
        <label>{{ t('port') }}</label>
        <input v-model="form.port">
      </div>
    </div>

    <div v-if="!isSqlite" class="row">
      <div class="field">
        <label>{{ t('user') }}</label>
        <input v-model="form.user">
      </div>
      <div class="field">
        <label>{{ t('password') }}</label>
        <div class="pw">
          <input :type="showPassword ? 'text' : 'password'" v-model="form.password">
          <button type="button" class="toggle" @click="showPassword = !showPassword">{{ showPassword ? t('hide') : t('show') }}</button>
        </div>
      </div>
    </div>

    <div v-if="!isSqlite" class="row">
      <div class="field">
        <label>{{ t('database') }}</label>
        <input v-model="form.database" placeholder="default">
      </div>
      <div v-if="isPg" class="field">
        <label>{{ t('schema') }}</label>
        <input v-model="form.schema" placeholder="public">
      </div>
    </div>

    <div v-if="isSqlite" class="field">
      <label>{{ t('sqlitePath') }}</label>
      <input v-model="form.dbPath" placeholder="/path/to/db.sqlite">
    </div>

    <details class="ssh-section" v-if="!isSqlite">
      <summary>{{ t('ssh') }}</summary>
      <div class="field"><label>{{ t('sshHost') }}</label><input v-model="form.sshHost"></div>
      <div class="field"><label>{{ t('sshPort') }}</label><input v-model="form.sshPort" type="number"></div>
      <div class="field"><label>{{ t('sshUser') }}</label><input v-model="form.sshUser"></div>
      <div class="field"><label>{{ t('sshPass') }}</label>
        <div class="pw"><input :type="showSshPassword ? 'text' : 'password'" v-model="form.sshPassword"><button type="button" class="toggle" @click="showSshPassword = !showSshPassword">{{ showSshPassword ? t('hide') : t('show') }}</button></div>
      </div>
      <div class="field"><label>{{ t('sshKey') }}</label><input v-model="form.sshPrivateKeyPath"></div>
      <div class="field"><label>{{ t('sshPhrase') }}</label>
        <div class="pw"><input :type="showSshPassphrase ? 'text' : 'password'" v-model="form.sshPassphrase"><button type="button" class="toggle" @click="showSshPassphrase = !showSshPassphrase">{{ showSshPassphrase ? t('hide') : t('show') }}</button></div>
      </div>
    </details>

    <details class="ssh-section">
      <summary>{{ t('advanced') }}</summary>
      <div class="row">
        <div class="field"><label>{{ t('env') }}</label>
          <select v-model="form.environment">
            <option value="development">{{ t('envDev') }}</option>
            <option value="test">{{ t('envTest') }}</option>
            <option value="staging">{{ t('envStaging') }}</option>
            <option value="production">{{ t('envProd') }}</option>
          </select>
        </div>
        <div class="field"><label><input v-model="form.readOnly" type="checkbox" style="width:auto"> {{ t('readOnly') }}</label></div>
      </div>
      <div class="field"><label><input v-model="form.useConnectionString" type="checkbox" style="width:auto"> {{ t('useConnUrl') }}</label><input v-model="form.connectionUrl" placeholder="mysql://user:password@host:3306/database"></div>
      <div class="field"><label><input v-model="form.useSSL" type="checkbox" style="width:auto"> {{ t('useSsl') }}</label></div>
      <div class="field"><label>{{ t('caCert') }}</label><input v-model="form.caPath"></div>
      <div class="row">
        <div class="field"><label>{{ t('clientCert') }}</label><input v-model="form.clientCertPath"></div>
        <div class="field"><label>{{ t('clientKey') }}</label><input v-model="form.clientKeyPath"></div>
      </div>
      <div class="row">
        <div class="field"><label>{{ t('connTimeout') }}</label><input v-model="form.connectTimeout" type="number"></div>
        <div class="field"><label>{{ t('reqTimeout') }}</label><input v-model="form.requestTimeout" type="number"></div>
      </div>
      <div class="field"><label>{{ t('socketPath') }}</label><input v-model="form.socketPath"></div>
    </details>

    <div class="actions">
      <button id="btnTest" class="secondary" @click="test">{{ t('test') }}</button>
      <button id="btnSave" @click="save">{{ t('save') }}</button>
    </div>
    <div id="status" :class="statusOk ? 'ok' : 'err'">{{ status }}</div>
  </div>
</template>

<style scoped>
.container {
  max-width: 480px; margin: 40px auto; padding: 24px 28px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
  border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}
h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
.field { margin-bottom: 14px; }
label { display: block; font-size: 12px; margin-bottom: 5px; color: var(--vscode-descriptionForeground, #808080); font-weight: 500; }
input, select {
  width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 13px;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px;
}
input:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder, #007fd4); }
.row { display: flex; gap: 12px; }
.row .field { flex: 1; }
.pw { display: flex; gap: 6px; align-items: center; }
.pw input { flex: 1; }
.pw .toggle { flex: 0 0 auto; padding: 7px 10px; cursor: pointer; border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15)); border-radius: 4px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); font-size: 12px; }
.pw .toggle:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.actions { margin-top: 24px; display: flex; gap: 10px; }
button {
  flex: 1; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
  font-size: 13px; font-weight: 500;
  background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff);
}
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
#status { margin-top: 14px; font-size: 12px; min-height: 18px; }
#status.ok { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
#status.err { color: var(--vscode-errorForeground, #f48771); }
</style>
