<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { unlockDekBrowser, DekSession, totpWeb, openCipherRecord, type CipherRecord, type SmpKdfDto, type SmpKdfParams } from '@devbelt/auth-client';
import { getE2eeParams, getSyncRecords } from '../api/sync';

/**
 * P6-S5c：网页端验证器（只读展示）。
 * 主密码解锁 → Argon2id(Worker) → DEK（仅内存）→ 解密密文 records → 展示/复制口令。
 * 不做写操作；登出/离开页面即清 DEK。
 */
const props = defineProps<{ user: { userId: string } | null }>();

interface Row { issuer: string; account?: string; algorithm: 'SHA1' | 'SHA256' | 'SHA512'; digits: 6 | 8; period: 30 | 60; secret: string; code: string; secondsLeft: number; }

const smp = ref('');
const busy = ref(false);
const err = ref('');
const unlocked = ref(false);
const rows = ref<Row[]>([]);
const session = new DekSession();
let timer: ReturnType<typeof setInterval> | undefined;

function stopTimer(): void { if (timer !== undefined) { clearInterval(timer); timer = undefined; } }

async function deriveKekViaWorker(smpValue: string, params: SmpKdfParams): Promise<Uint8Array> {
  const worker = new Worker(new URL('../workers/argon2.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { ok: boolean; kek?: Uint8Array; error?: string };
        if (d.ok && d.kek) resolve(new Uint8Array(d.kek));
        else reject(new Error(d.error || 'Argon2id failed'));
      };
      worker.onerror = () => reject(new Error('Argon2id worker error'));
      worker.postMessage({ smp: smpValue, params });
    });
  } finally {
    worker.terminate();
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  for (const r of rows.value) {
    try {
      const { code, secondsLeft } = await totpWeb(r.secret, now, r.period, r.digits, r.algorithm);
      r.code = code;
      r.secondsLeft = secondsLeft;
    } catch { r.code = '------'; r.secondsLeft = 0; }
  }
}

async function loadEntries(keyEpoch: string): Promise<void> {
  const recs: CipherRecord[] = [];
  let after = '0';
  for (let i = 0; i < 50; i++) {
    const page = await getSyncRecords(after, 256);
    if (page.kind !== 'ok') throw new Error('拉取密文失败');
    recs.push(...page.value.records);
    if (!page.value.nextAfter) break;
    after = page.value.nextAfter;
  }
  const dek = session.get();
  if (!dek) throw new Error('未解锁');
  const out: Row[] = [];
  for (const rec of recs) {
    const payload = await openCipherRecord(dek, rec, { userId: props.user!.userId, keyEpoch });
    if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'authenticatorEntry') {
      const e = payload as { issuer: string; account?: string; algorithm: Row['algorithm']; digits: Row['digits']; period: Row['period']; secret: string };
      out.push({ issuer: e.issuer, account: e.account, algorithm: e.algorithm, digits: e.digits, period: e.period, secret: e.secret, code: '', secondsLeft: 0 });
    }
  }
  rows.value = out;
  await tick();
}

async function unlock(): Promise<void> {
  if (!props.user) { err.value = '请先登录。'; return; }
  busy.value = true;
  err.value = '';
  try {
    const params = await getE2eeParams();
    if (params.kind !== 'ok') throw new Error('无法获取同步材料');
    const v = params.value;
    if (!v.initialized || !v.smpKdf || !v.envelopeSmp || !v.keyEpoch) throw new Error('该账号未初始化同步');
    const dek = await unlockDekBrowser(
      props.user.userId, v.keyEpoch, smp.value,
      v.smpKdf as unknown as SmpKdfDto, v.envelopeSmp as unknown as never, deriveKekViaWorker,
    );
    session.set(dek);
    unlocked.value = true;
    await loadEntries(v.keyEpoch);
    stopTimer();
    timer = setInterval(() => { void tick(); }, 1000);
  } catch (e) {
    session.clear();
    unlocked.value = false;
    rows.value = [];
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function lock(): void {
  stopTimer();
  session.clear();
  unlocked.value = false;
  rows.value = [];
  smp.value = '';
}

async function copy(r: Row): Promise<void> {
  try { await navigator.clipboard.writeText(r.code); } catch { /* 剪贴板不可用时忽略 */ }
}

watch(() => props.user?.userId, () => lock());
onUnmounted(() => { stopTimer(); session.clear(); });
</script>

<template>
  <section class="page">
    <header class="head">
      <h2>验证器</h2>
      <p class="sub">内容端到端加密：主密码仅在本机内存中解锁，服务端看不到密钥或口令。</p>
    </header>

    <div v-if="!unlocked" class="unlock">
      <input v-model="smp" type="password" autocomplete="off" placeholder="同步主密码（SMP）" @keyup.enter="unlock" />
      <button class="btn" :disabled="busy" @click="unlock">{{ busy ? '解锁中…' : '解锁' }}</button>
    </div>
    <p v-if="err" class="error">{{ err }}</p>

    <template v-if="unlocked">
      <p class="muted">{{ rows.length }} 个条目 <button class="btn secondary small" @click="lock">锁定</button></p>
      <table v-if="rows.length" class="table">
        <thead><tr><th>发行方</th><th>账号</th><th>口令</th><th></th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="i">
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
