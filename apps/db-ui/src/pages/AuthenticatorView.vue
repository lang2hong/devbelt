<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { unlockDekBrowser, DekSession, type SmpKdfParams } from '@devbelt/auth-client';
import { getE2eeParams, getSyncRecords } from '../api/sync';
import {
  collectAuthenticatorRows, createTotpCache, decodeDekCache, encodeDekCache, refreshCodes, toEnvelopeDto, toSmpKdfDto,
  DEK_CACHE_KEY, DEK_CACHE_TTL_MS,
  type AuthenticatorRow, type FeedPage, type TotpCache,
} from '../lib/authenticatorView';

/**
 * P6-S5c：网页端验证器（只读展示）。
 * 主密码解锁 → Argon2id(Worker) → DEK（仅内存）→ 解密密文 records → 展示/复制口令。
 * 不做写操作；登出/主动锁定即清 DEK 与本地缓存；离开页面清内存态但按「记住解锁」保留缓存。
 */
const props = defineProps<{ user: { userId: string } | null }>();

const smp = ref('');
const busy = ref(false);
const loading = ref(false);
const err = ref('');
const unlocked = ref(false);
const rows = ref<AuthenticatorRow[]>([]);
const truncated = ref(false);
const copiedId = ref('');
const remember = ref(true);
const session = new DekSession();
const totpCache: TotpCache = createTotpCache();
let timer: ReturnType<typeof setInterval> | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
/** 解锁令牌：lock()/登出时自增，令在途的 unlock() 在下一个 await 后放弃。 */
let unlockAttempt = 0;
let disposed = false;
let ticking = false;

const ARGON2_TIMEOUT_MS = 30_000;

function stopTimer(): void { if (timer !== undefined) { clearInterval(timer); timer = undefined; } }
function clearCopyTimer(): void { if (copyTimer !== undefined) { clearTimeout(copyTimer); copyTimer = undefined; } }

/** Worker 内执行 Argon2id；挂死时超时终止，避免 busy 永久卡住 / Worker 泄漏。 */
async function deriveKekViaWorker(smpValue: string, params: SmpKdfParams): Promise<Uint8Array> {
  const worker = new Worker(new URL('../workers/argon2.worker.ts', import.meta.url), { type: 'module' });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Argon2id 计算超时'));
      }, ARGON2_TIMEOUT_MS);
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { ok: boolean; kek?: Uint8Array; error?: string };
        if (d.ok && d.kek) resolve(new Uint8Array(d.kek));
        else reject(new Error(d.error || 'Argon2id failed'));
      };
      worker.onerror = () => reject(new Error('Argon2id worker error'));
      worker.postMessage({ smp: smpValue, params });
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    worker.terminate();
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await refreshCodes(rows.value, Date.now(), totpCache);
  } finally {
    ticking = false;
  }
}

async function fetchPage(after: string, limit: number): Promise<FeedPage> {
  const page = await getSyncRecords(after, limit);
  if (page.kind !== 'ok') throw new Error('拉取密文失败');
  return { records: page.value.records, nextAfter: page.value.nextAfter };
}

async function unlock(): Promise<void> {
  if (busy.value) return;
  const user = props.user;
  if (!user) { err.value = '请先登录。'; return; }
  const attempt = ++unlockAttempt;
  busy.value = true;
  err.value = '';
  try {
    const params = await getE2eeParams();
    if (disposed || attempt !== unlockAttempt) return;
    if (params.kind !== 'ok') throw new Error('无法获取同步材料');
    const v = params.value;
    if (!v.initialized || !v.smpKdf || !v.envelopeSmp || !v.keyEpoch) throw new Error('该账号未初始化同步');
    const dek = await unlockDekBrowser(user.userId, v.keyEpoch, smp.value, toSmpKdfDto(v.smpKdf), toEnvelopeDto(v.envelopeSmp), deriveKekViaWorker);
    if (disposed || attempt !== unlockAttempt) { dek.fill(0); return; }
    session.set(dek);
    dek.fill(0); // session 已持副本；原始 buffer 立即清零
    const key = session.get();
    if (!key) throw new Error('未解锁');
    if (remember.value) saveCachedDek(key, v.keyEpoch);
    unlocked.value = true;
    loading.value = true;
    const { rows: loaded, truncated: cut } = await collectAuthenticatorRows(
      key, { userId: user.userId, keyEpoch: v.keyEpoch }, fetchPage,
    );
    if (disposed || attempt !== unlockAttempt) { lock(); return; }
    rows.value = loaded;
    truncated.value = cut;
    loading.value = false;
    await tick();
    if (disposed || attempt !== unlockAttempt) { lock(); return; }
    stopTimer();
    timer = setInterval(() => { void tick(); }, 1000);
  } catch (e) {
    if (attempt === unlockAttempt) {
      session.clear();
      unlocked.value = false;
      loading.value = false;
      rows.value = [];
      truncated.value = false;
      err.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (attempt === unlockAttempt) busy.value = false;
  }
}

function clearCachedDek(): void {
  try { localStorage.removeItem(DEK_CACHE_KEY); } catch { /* 隐私模式等忽略 */ }
}

/** 已有缓存且 userId 匹配、未过期 → 返回 DEK 与 keyEpoch。 */
function loadCachedDek(): { dek: Uint8Array; keyEpoch: string } | undefined {
  const user = props.user;
  if (!user) return undefined;
  let raw: string | null = null;
  try { raw = localStorage.getItem(DEK_CACHE_KEY); } catch { return undefined; }
  const entry = decodeDekCache(raw, Date.now(), user.userId);
  if (!entry) { clearCachedDek(); return undefined; }
  return { dek: entry.dek, keyEpoch: entry.keyEpoch };
}

function saveCachedDek(dek: Uint8Array, keyEpoch: string): void {
  const user = props.user;
  if (!user) return;
  try {
    localStorage.setItem(DEK_CACHE_KEY, encodeDekCache({ dek, userId: user.userId, keyEpoch, exp: Date.now() + DEK_CACHE_TTL_MS }));
  } catch { /* 配额/隐私模式等忽略 */ }
}

/** 只复位内存态（不清缓存）。登出/离开/切号/主动锁定共用。 */
function resetState(): void {
  unlockAttempt++;
  busy.value = false;
  loading.value = false;
  stopTimer();
  clearCopyTimer();
  copiedId.value = '';
  totpCache.clear();
  session.clear();
  unlocked.value = false;
  rows.value = [];
  truncated.value = false;
  smp.value = '';
}

/** 主动锁定 / 登出：内存态与本地缓存一并清除。 */
function lock(): void {
  resetState();
  clearCachedDek();
}

function pctLeft(r: AuthenticatorRow): number {
  const period = r.period || 30;
  return Math.max(0, Math.min(100, (r.secondsLeft / period) * 100));
}

async function copy(r: AuthenticatorRow): Promise<void> {
  if (!r.code || r.code === '------') return;
  try {
    await navigator.clipboard.writeText(r.code);
    copiedId.value = r.recordId;
    clearCopyTimer();
    copyTimer = setTimeout(() => { copiedId.value = ''; copyTimer = undefined; }, 1500);
  } catch { /* 剪贴板不可用时忽略 */ }
}

/** 命中本地缓存时直接解锁（跳过 Argon2id/SMP），失败则清缓存回退到输密码。 */
async function restoreFromCache(): Promise<void> {
  if (disposed || unlocked.value || busy.value) return;
  const user = props.user;
  if (!user) return;
  const cached = loadCachedDek();
  if (!cached) return;
  const attempt = ++unlockAttempt;
  busy.value = true;
  try {
    session.set(cached.dek);
    cached.dek.fill(0);
    const key = session.get();
    if (!key) throw new Error('未解锁');
    unlocked.value = true;
    loading.value = true;
    const { rows: loaded, truncated: cut } = await collectAuthenticatorRows(
      key, { userId: user.userId, keyEpoch: cached.keyEpoch }, fetchPage,
    );
    if (disposed || attempt !== unlockAttempt) { resetState(); return; }
    rows.value = loaded;
    truncated.value = cut;
    loading.value = false;
    await tick();
    if (disposed || attempt !== unlockAttempt) { resetState(); return; }
    stopTimer();
    timer = setInterval(() => { void tick(); }, 1000);
  } catch {
    if (attempt === unlockAttempt) {
      clearCachedDek(); // 缓存失效（轮换/损坏）→ 回退输密码
      resetState();
    }
  } finally {
    if (attempt === unlockAttempt) busy.value = false;
  }
}

onMounted(() => { void restoreFromCache(); });
watch(() => props.user?.userId, (uid) => {
  resetState();
  if (!uid) { clearCachedDek(); return; } // 登出清缓存
  void restoreFromCache();
});
onUnmounted(() => { disposed = true; resetState(); }); // 离开页面保留缓存
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>验证器</h2>
      <p class="sub">内容端到端加密：主密码仅在本机内存中解锁，服务端看不到密钥或口令。</p>
    </header>

    <div v-if="!unlocked" class="unlock">
      <input v-model="smp" type="password" autocomplete="new-password" :disabled="busy" placeholder="同步主密码（SMP）" @keyup.enter="unlock" />
      <button class="btn" :disabled="busy" @click="unlock">{{ busy ? '解锁中…' : '解锁' }}</button>
      <label class="remember"><input v-model="remember" type="checkbox" :disabled="busy" /> 记住解锁（30 天）</label>
    </div>
    <p v-if="err" class="error">{{ err }}</p>

    <template v-if="unlocked">
      <div class="toolbar">
        <span class="muted">{{ rows.length }} 个条目</span>
        <span class="spacer" />
        <button class="btn secondary small" @click="lock">锁定</button>
      </div>
      <p v-if="truncated" class="muted">条目较多，当前仅显示前 {{ rows.length }} 条。</p>
      <ul v-if="rows.length" class="grid">
        <li
          v-for="r in rows"
          :key="r.recordId"
          class="card"
          :class="{ warn: r.secondsLeft > 0 && r.secondsLeft <= 5 }"
          role="button"
          tabindex="0"
          @click="copy(r)"
          @keydown.enter.self.prevent="copy(r)"
        >
          <div class="meta">
            <div class="issuer">{{ r.issuer || '—' }}</div>
            <div v-if="r.account" class="account">{{ r.account }}</div>
          </div>
          <div class="code-area">
            <div class="code-row">
              <span class="code">{{ r.code }}</span>
              <span class="secs">{{ r.secondsLeft }}s</span>
            </div>
            <div class="meter"><span :style="{ width: pctLeft(r) + '%' }" /></div>
          </div>
          <span v-if="copiedId === r.recordId" class="copied">已复制</span>
        </li>
      </ul>
      <p v-else-if="loading" class="muted">正在解密…</p>
      <p v-else class="muted">暂无验证器条目。</p>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 980px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
.head h2 { margin: 0; letter-spacing: -0.01em; }
.unlock { display: flex; align-items: center; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
.remember { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text-muted); }
input { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.toolbar { display: flex; align-items: center; gap: 8px; margin: 12px 0 8px; }
.toolbar .spacer { flex: 1; }
/* 自适应多列：宽屏 2+ 列，窄屏 1 列 */
.grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--c-border-strong); border-radius: 8px; background: var(--c-surface); cursor: pointer; user-select: none; -webkit-user-select: none; }
.card:hover { background: var(--c-surface-muted); }
.card:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; }
.meta { min-width: 0; display: flex; flex-direction: column; }
.issuer { font-weight: 600; color: var(--c-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account { font-size: 12px; color: var(--c-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-area { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex-shrink: 0; }
.code-row { display: flex; align-items: baseline; gap: 10px; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 19px; letter-spacing: 2px; font-variant-numeric: tabular-nums; color: var(--c-text); }
.card.warn .code { color: var(--c-danger); }
.meter { width: 128px; height: 3px; border-radius: 2px; background: var(--c-border-strong); overflow: hidden; }
.meter > span { display: block; height: 100%; background: var(--c-accent); transition: width 0.9s linear; }
.card.warn .meter > span { background: var(--c-danger); }
.secs { font-size: 11px; color: var(--c-text-muted); min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }
.copied { position: absolute; top: 6px; right: 8px; font-size: 11px; color: var(--c-text-muted); }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
</style>
