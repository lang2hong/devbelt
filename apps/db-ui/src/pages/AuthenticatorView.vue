<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { unlockDekBrowser, DekSession, totpWeb, type SmpKdfDto, type SmpKdfParams } from '@devbelt/auth-client';
import { getE2eeParams, getSyncRecords } from '../api/sync';
import { collectAuthenticatorRows, type AuthenticatorRow, type FeedPage } from '../lib/authenticatorView';

/**
 * P6-S5c：网页端验证器（只读展示）。
 * 主密码解锁 → Argon2id(Worker) → DEK（仅内存）→ 解密密文 records → 展示/复制口令。
 * 不做写操作；登出/离开页面即清 DEK（并用解锁令牌作废在途解锁）。
 */
const props = defineProps<{ user: { userId: string } | null }>();

const smp = ref('');
const busy = ref(false);
const err = ref('');
const unlocked = ref(false);
const rows = ref<AuthenticatorRow[]>([]);
const truncated = ref(false);
const session = new DekSession();
let timer: ReturnType<typeof setInterval> | undefined;
/** 解锁令牌：lock()/登出时自增，令在途的 unlock() 在下一个 await 后放弃。 */
let unlockAttempt = 0;
let disposed = false;
let ticking = false;

const ARGON2_TIMEOUT_MS = 30_000;

function stopTimer(): void { if (timer !== undefined) { clearInterval(timer); timer = undefined; } }

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
    const now = Date.now();
    for (const r of rows.value) {
      try {
        const { code, secondsLeft } = await totpWeb(r.secret, now, r.period, r.digits, r.algorithm);
        r.code = code;
        r.secondsLeft = secondsLeft;
      } catch { r.code = '------'; r.secondsLeft = 0; }
    }
  } finally {
    ticking = false;
  }
}

/** 服务端 `smpKdf`（unknown）→ 严格 DTO；非法即抛错（fail-closed）。 */
function toSmpKdfDto(raw: Record<string, unknown>): SmpKdfDto {
  const { alg, version, memoryKiB, iterations, parallelism, salt, outputBytes } = raw;
  if (alg !== 'argon2id' || version !== 1 || outputBytes !== 32 ||
      typeof memoryKiB !== 'number' || typeof iterations !== 'number' || typeof parallelism !== 'number' || typeof salt !== 'string') {
    throw new Error('同步 KDF 参数不完整');
  }
  return { alg, version, memoryKiB, iterations, parallelism, salt, outputBytes };
}

/** 服务端 `envelopeSmp`（unknown）→ EnvelopeDto；字段缺失即抛错。 */
function toEnvelopeDto(raw: Record<string, unknown>): Parameters<typeof unlockDekBrowser>[4] {
  const { envelopeVersion, nonce, ciphertext, tag } = raw;
  if (typeof envelopeVersion !== 'string' || !envelopeVersion ||
      typeof nonce !== 'string' || !nonce ||
      typeof ciphertext !== 'string' || !ciphertext ||
      typeof tag !== 'string' || !tag) {
    throw new Error('同步信封字段不完整');
  }
  return { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion, nonce, ciphertext, tag };
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
    unlocked.value = true;
    const { rows: loaded, truncated: cut } = await collectAuthenticatorRows(
      dek, { userId: user.userId, keyEpoch: v.keyEpoch }, fetchPage,
    );
    if (disposed || attempt !== unlockAttempt) { lock(); return; }
    rows.value = loaded;
    truncated.value = cut;
    await tick();
    if (disposed || attempt !== unlockAttempt) { lock(); return; }
    stopTimer();
    timer = setInterval(() => { void tick(); }, 1000);
  } catch (e) {
    if (attempt === unlockAttempt) {
      session.clear();
      unlocked.value = false;
      rows.value = [];
      truncated.value = false;
      err.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (attempt === unlockAttempt) busy.value = false;
  }
}

/** 清空所有解锁态并使在途解锁作废（登出/离开/主动锁定共用）。 */
function lock(): void {
  unlockAttempt++;
  busy.value = false;
  stopTimer();
  session.clear();
  unlocked.value = false;
  rows.value = [];
  truncated.value = false;
  smp.value = '';
}

async function copy(r: AuthenticatorRow): Promise<void> {
  if (!r.code || r.code === '------') return;
  try { await navigator.clipboard.writeText(r.code); } catch { /* 剪贴板不可用时忽略 */ }
}

watch(() => props.user?.userId, () => lock());
onUnmounted(() => { disposed = true; lock(); });
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>验证器</h2>
      <p class="sub">内容端到端加密：主密码仅在本机内存中解锁，服务端看不到密钥或口令。</p>
    </header>

    <div v-if="!unlocked" class="unlock">
      <input v-model="smp" type="password" autocomplete="off" :disabled="busy" placeholder="同步主密码（SMP）" @keyup.enter="unlock" />
      <button class="btn" :disabled="busy" @click="unlock">{{ busy ? '解锁中…' : '解锁' }}</button>
    </div>
    <p v-if="err" class="error">{{ err }}</p>

    <template v-if="unlocked">
      <p class="muted">{{ rows.length }} 个条目 <button class="btn secondary small" @click="lock">锁定</button></p>
      <p v-if="truncated" class="muted">条目较多，当前仅显示前 {{ rows.length }} 条。</p>
      <table v-if="rows.length" class="table">
        <thead><tr><th>发行方</th><th>账号</th><th>口令</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.recordId">
            <td>{{ r.issuer || '—' }}</td>
            <td>{{ r.account || '—' }}</td>
            <td><code>{{ r.code }}</code> <span class="muted">{{ r.secondsLeft }}s</span></td>
            <td><button class="btn secondary small" @click="copy(r)">复制</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">暂无验证器条目。</p>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 960px; margin: 0 auto; }
h2 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.unlock { display: flex; gap: 8px; margin: 16px 0; }
input { box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; background: var(--c-surface); border: 1px solid var(--c-border-strong); border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 14px; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.small { padding: 5px 10px; font-size: 13px; }
.btn.secondary { background: var(--c-surface-muted); color: var(--c-text); border: 1px solid var(--c-border-strong); }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.head h2 { margin: 0; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; font-size: 13px; color: var(--c-text-muted); }
</style>
