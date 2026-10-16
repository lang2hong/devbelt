<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import {
  chatEndpointOf,
  isKnownProviderHost,
  normalizeBaseUrl,
  type CatalogProvider,
  type CustomVendor,
  type ModelAccessSyncPrefs,
  type ModelAccessTestResult,
} from '../../../../src/ai/modelAccess';

/**
 * 模型接入弹层（自带 Key / 服务端代理）：一个入口配齐 模式 / 厂商 / 地址 / 模型 / API Key /
 * 同步项。保存与测试由根组件派发到宿主（宿主写设置 + SecretStorage + 同步记录；密钥只在
 * 上行出现一次，永不回显）。
 */
const props = defineProps<{
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: CustomVendor[];
  customModels: Record<string, string[]>;
  hasKey: boolean;
  prefs: ModelAccessSyncPrefs;
  catalog: CatalogProvider[];
  saveError?: string;
  testResult?: ModelAccessTestResult | null;
  testing?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [payload: {
    mode: 'server-proxy' | 'openai-compatible';
    vendorId: string;
    baseUrl: string;
    model: string;
    customVendors: CustomVendor[];
    customModels: Record<string, string[]>;
    apiKey: string;
    clearKey: boolean;
    prefs: ModelAccessSyncPrefs;
  }];
  test: [payload: { baseUrl: string; model: string; apiKey: string }];
}>();

const { t } = useI18n();

/** 动态键改显式映射（i18n 静态扫描只认 t('字面量')；映射值均在 catalog 中）。 */
const SAVE_ERROR_KEYS: Record<string, string> = {
  baseUrl: 'wv.ai.ma.saveError.baseUrl',
  insecure: 'wv.ai.ma.saveError.insecure',
  model: 'wv.ai.ma.saveError.model',
  vendors: 'wv.ai.ma.saveError.vendors',
  invalid: 'wv.ai.ma.saveError.invalid',
};
const TEST_ERROR_KEYS: Record<string, string> = {
  auth: 'wv.ai.ma.test.auth',
  model: 'wv.ai.ma.test.model',
  network: 'wv.ai.ma.test.network',
  timeout: 'wv.ai.ma.test.timeout',
  rate: 'wv.ai.ma.test.rate',
  server: 'wv.ai.ma.test.server',
  nokey: 'wv.ai.ma.test.nokey',
  unknown: 'wv.ai.ma.test.unknown',
};

const mode = ref(props.mode);
const vendorId = ref(props.vendorId || '');
const baseUrl = ref(props.baseUrl || '');
const model = ref(props.model || '');
const apiKey = ref('');
const showKey = ref(false);
const clearKey = ref(false);
const vendorName = ref('');
const prefs = ref<ModelAccessSyncPrefs>({ ...props.prefs });
/** 编辑副本（保存时整体上行；新增厂商/模型就地写入）。 */
const customVendors = ref<CustomVendor[]>(props.customVendors.map((v) => ({ ...v, models: [...v.models] })));
const customModels = ref<Record<string, string[]>>(JSON.parse(JSON.stringify(props.customModels ?? {})));
/** 表单已编辑 → 宿主快照刷新（保存回显/同步到达）不覆盖输入。 */
let touched = false;
const mark = () => { touched = true; };
watch([mode, vendorId, baseUrl, model, apiKey, clearKey, prefs, vendorName], mark);

const NEW_VENDOR = '__new__';
const CUSTOM_MODEL = '__custom__';

const preset = computed(() => props.catalog.find((p) => p.code === vendorId.value));
const currentVendor = computed(() => customVendors.value.find((v) => v.id === vendorId.value));

/** 当前厂商的可选模型：预设模型 ∪ 自定义模型 ∪ 自建厂商自带模型。 */
const vendorModels = computed<string[]>(() => {
  const list = new Set<string>();
  if (preset.value) for (const m of preset.value.models) list.add(m.id);
  if (currentVendor.value) for (const m of currentVendor.value.models) list.add(m.id);
  for (const m of customModels.value[vendorId.value] ?? []) list.add(m);
  return [...list];
});

const modelIsCustom = computed(() => !!model.value && !vendorModels.value.includes(model.value));
/** 用户显式选择「自定义模型…」（model 可为空，等输入）。 */
const customModelSelected = ref(!!props.model && !vendorModels.value.includes(props.model));
const modelSelect = computed({
  get: () => (customModelSelected.value || modelIsCustom.value ? CUSTOM_MODEL : model.value),
  set: (v: string) => {
    if (v === CUSTOM_MODEL) {
      customModelSelected.value = true;
      mark();
      return;
    }
    customModelSelected.value = false;
    model.value = v;
    mark();
  },
});

const endpoint = computed(() => {
  const base = normalizeBaseUrl(baseUrl.value);
  return base.ok ? chatEndpointOf(base.url) : baseUrl.value;
});
const unknownHost = computed(
  () => mode.value === 'openai-compatible' && !!baseUrl.value && !isKnownProviderHost(baseUrl.value, props.catalog, customVendors.value),
);
const baseUrlInvalid = computed(() => mode.value === 'openai-compatible' && !!baseUrl.value && !normalizeBaseUrl(baseUrl.value).ok);
const isNewVendor = computed(() => vendorId.value === NEW_VENDOR);

function onVendorChange(code: string): void {
  vendorId.value = code;
  customModelSelected.value = false;
  if (code === NEW_VENDOR) {
    vendorName.value = '';
    baseUrl.value = 'https://';
    model.value = '';
    return;
  }
  const p = props.catalog.find((x) => x.code === code);
  if (p) {
    baseUrl.value = p.baseUrl;
    model.value = p.models.find((m) => m.default)?.id ?? p.models[0]?.id ?? '';
    return;
  }
  const v = customVendors.value.find((x) => x.id === code);
  if (v) {
    baseUrl.value = v.baseUrl;
    model.value = (customModels.value[code] ?? [])[0] ?? v.models[0] ?? '';
  }
}

function canSave(): boolean {
  if (mode.value === 'server-proxy') return true;
  if (!model.value.trim() || baseUrlInvalid.value) return false;
  if (isNewVendor.value && (!vendorName.value.trim() || !normalizeBaseUrl(baseUrl.value).ok)) return false;
  return true;
}

function save(): void {
  if (!canSave()) return;
  const vendors = [...customVendors.value];
  let vid = vendorId.value;
  if (isNewVendor.value) {
    vid = `cv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    vendors.push({ id: vid, name: vendorName.value.trim(), baseUrl: normalizeBaseUrl(baseUrl.value)!.ok ? (normalizeBaseUrl(baseUrl.value) as { ok: true; url: string }).url : baseUrl.value, models: [] });
  }
  if (vid && model.value.trim() && !vendorModels.value.includes(model.value.trim())) {
    const list = customModels.value[vid] ?? [];
    if (!list.includes(model.value.trim())) customModels.value[vid] = [...list, model.value.trim()];
  }
  emit('save', {
    mode: mode.value,
    vendorId: vid,
    baseUrl: mode.value === 'openai-compatible' ? (normalizeBaseUrl(baseUrl.value).ok ? (normalizeBaseUrl(baseUrl.value) as { ok: true; url: string }).url : baseUrl.value.trim()) : '',
    model: model.value.trim(),
    customVendors: vendors,
    customModels: customModels.value,
    apiKey: apiKey.value.trim(),
    clearKey: clearKey.value,
    prefs: { ...prefs.value },
  });
}

function test(): void {
  if (mode.value !== 'openai-compatible' || !canSave()) return;
  emit('test', { baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value.trim() });
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="ai-ma-overlay" @click.self="emit('close')">
    <div class="ai-ma-dialog" role="dialog" :aria-label="t('wv.ai.ma.title')">
      <div class="ai-ma-head">
        <span class="ai-ma-title">{{ t('wv.ai.ma.title') }}</span>
        <button class="ai-btn" :aria-label="t('wv.ai.cancel')" @click="emit('close')">✕</button>
      </div>

      <label class="ai-ma-label"><input v-model="mode" type="radio" value="server-proxy" /> {{ t('wv.ai.ma.serverProxy') }}</label>
      <label class="ai-ma-label"><input v-model="mode" type="radio" value="openai-compatible" /> {{ t('wv.ai.ma.byok') }}</label>

      <template v-if="mode === 'openai-compatible'">
        <label class="ai-ma-label" for="ai-ma-vendor">{{ t('wv.ai.ma.vendor') }}</label>
        <select id="ai-ma-vendor" :value="vendorId" @change="onVendorChange(($event.target as HTMLSelectElement).value)">
          <option v-if="!vendorId" value=""></option>
          <option v-for="p in catalog" :key="p.code" :value="p.code">{{ p.name.zh }}</option>
          <option v-for="v in customVendors" :key="v.id" :value="v.id">{{ v.name }}（{{ t('wv.ai.ma.customVendorTag') }}）</option>
          <option :value="NEW_VENDOR">＋ {{ t('wv.ai.ma.vendorNew') }}</option>
        </select>

        <template v-if="isNewVendor">
          <label class="ai-ma-label" for="ai-ma-vname">{{ t('wv.ai.ma.vendorName') }}</label>
          <input id="ai-ma-vname" v-model="vendorName" type="text" maxlength="64" :placeholder="t('wv.ai.ma.vendorName')" />
        </template>

        <label class="ai-ma-label" for="ai-ma-url">{{ t('wv.ai.ma.baseUrl') }}</label>
        <input id="ai-ma-url" v-model="baseUrl" type="text" maxlength="255" placeholder="https://api.example.com/v1" />
        <div v-if="baseUrlInvalid" class="ai-ma-warn">{{ t('wv.ai.ma.baseUrlInvalid') }}</div>
        <div class="ai-ma-endpoint">{{ t('wv.ai.ma.endpoint', { url: endpoint }) }}</div>
        <div v-if="unknownHost && !baseUrlInvalid" class="ai-ma-warn">{{ t('wv.ai.ma.unknownHost') }}</div>

        <label class="ai-ma-label" for="ai-ma-model">{{ t('wv.ai.ma.model') }}</label>
        <select id="ai-ma-model" v-model="modelSelect">
          <option v-if="!model" value=""></option>
          <option v-for="m in vendorModels" :key="m" :value="m">{{ m }}</option>
          <option :value="CUSTOM_MODEL">{{ t('wv.ai.ma.modelCustom') }}</option>
        </select>
        <input
          v-if="customModelSelected || modelIsCustom"
          v-model="model"
          class="ai-ma-model-input"
          type="text"
          maxlength="128"
          :placeholder="t('wv.ai.ma.modelPlaceholder')"
        />

        <label class="ai-ma-label" for="ai-ma-key">{{ t('wv.ai.ma.apiKey') }}</label>
        <div class="ai-ma-keyrow">
          <input
            id="ai-ma-key"
            v-model="apiKey"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            maxlength="512"
            :placeholder="hasKey ? t('wv.ai.ma.apiKeySaved') : t('wv.ai.ma.apiKeyPlaceholder')"
          />
          <button class="ai-btn" type="button" @click="showKey = !showKey">{{ showKey ? t('wv.ai.ma.hideKey') : t('wv.ai.ma.showKey') }}</button>
        </div>
        <label v-if="hasKey" class="ai-ma-check"><input v-model="clearKey" type="checkbox" /> {{ t('wv.ai.ma.clearKey') }}</label>
      </template>

      <div class="ai-ma-sep"></div>
      <div class="ai-ma-label">{{ t('wv.ai.ma.syncTitle') }}</div>
      <label class="ai-ma-check"><input v-model="prefs.selection" type="checkbox" /> {{ t('wv.ai.ma.syncSelection') }}</label>
      <label class="ai-ma-check"><input v-model="prefs.custom" type="checkbox" /> {{ t('wv.ai.ma.syncCustom') }}</label>
      <label class="ai-ma-check"><input v-model="prefs.key" type="checkbox" /> {{ t('wv.ai.ma.syncKey') }}</label>
      <div v-if="prefs.key" class="ai-ma-subwarn">{{ t('wv.ai.ma.syncKeyWarn') }}</div>

      <div v-if="saveError" class="ai-ma-warn">{{ t(SAVE_ERROR_KEYS[saveError] ?? 'wv.ai.ma.saveError.invalid') }}</div>
      <div v-if="testResult" class="ai-ma-test" :class="{ ok: testResult.ok }">
        <template v-if="testResult.ok">{{ t('wv.ai.ma.testOk', { ms: testResult.latencyMs }) }}</template>
        <template v-else>{{ t(TEST_ERROR_KEYS[testResult.code] ?? 'wv.ai.ma.test.unknown') }}<template v-if="testResult.detail"> · {{ testResult.detail }}</template></template>
      </div>

      <div class="ai-ma-footer">
        <button class="ai-btn" :disabled="testing" @click="emit('close')">{{ t('wv.ai.cancel') }}</button>
        <button v-if="mode === 'openai-compatible'" class="ai-btn" :disabled="testing || !canSave()" @click="test">{{ testing ? t('wv.ai.ma.testing') : t('wv.ai.ma.test') }}</button>
        <button class="ai-btn ai-ma-primary" :disabled="!canSave()" @click="save">{{ t('wv.ai.notes.save') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-ma-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.ai-ma-dialog {
  position: relative;
  width: min(560px, 94vw);
  max-height: 90vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ai-ma-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--vscode-foreground); }
.ai-ma-title { font-weight: 600; }
.ai-ma-label { margin-top: 6px; color: var(--vscode-foreground); }
.ai-ma-dialog input[type='text'],
.ai-ma-dialog input[type='password'],
.ai-ma-dialog select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 4px 6px;
  font-family: inherit;
  font-size: inherit;
}
.ai-ma-model-input { margin-top: 4px; }
.ai-ma-keyrow { display: flex; gap: 6px; }
.ai-ma-keyrow input { flex: 1; }
.ai-ma-check { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: var(--vscode-foreground); }
.ai-ma-sep { height: 1px; background: var(--vscode-panel-border); margin: 8px 0 2px; }
.ai-ma-endpoint {
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}
.ai-ma-warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
.ai-ma-subwarn { color: var(--vscode-descriptionForeground); font-size: 11.5px; margin-left: 18px; }
.ai-ma-test { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; word-break: break-all; }
.ai-ma-test.ok { color: var(--vscode-testing-iconPassed, #4caf50); }
.ai-ma-footer { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.ai-ma-primary:not(:disabled) { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.ai-ma-primary:disabled, .ai-ma-footer .ai-btn:disabled { opacity: 0.5; cursor: default; }
</style>
