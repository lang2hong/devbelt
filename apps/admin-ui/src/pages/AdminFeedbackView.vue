<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { navigate } from '../lib/router';
import {
  getFeedbackDetail,
  queryFeedback,
  replyFeedback,
  setFeedbackStatus,
  type AdminFeedback,
  type AdminFeedbackDetail,
  type FeedbackEmailTarget,
} from '../api/admin';
import { ensureCsrf, setAccessToken } from '@devbelt/auth-client';
import { useIdempotencyKey, isRetryableFailure } from '../lib/idempotentWrite';
import { formatDateTime } from '../lib/formatTime';
import Modal from '../components/Modal.vue';
import Pager from '../components/Pager.vue';
import { useCursorPages } from '../lib/useCursorPages';

const items = ref<AdminFeedback[]>([]);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const loadError = ref('');
const error = ref('');
const statusFilter = ref('');
const categoryFilter = ref('');
const userId = ref('');

const CATEGORY_LABEL: Record<string, string> = { bug: 'Bug', feature: '建议', other: '其他' };
const STATUS_LABEL: Record<string, string> = { new: '待处理', triaged: '已分类', done: '已处理', rejected: '已拒绝' };
const STATUS_OPTIONS = ['new', 'triaged', 'done', 'rejected'];
const CATEGORY_OPTIONS = ['bug', 'feature', 'other'];

const saveWrite = useIdempotencyKey();
const detail = ref<AdminFeedback | null>(null);
const editStatus = ref<'new' | 'triaged' | 'done' | 'rejected'>('new');
const editNote = ref('');
const busy = ref(false);

function relogin(): void {
  setAccessToken(null);
  window.location.assign('/login');
}

function goUser(uid: string | null): void {
  if (uid) navigate(`/users/${uid}`);
}

let loadSeq = 0;
const { page, pageSize, total, hasNext, cursor, reset: resetPager, apply: applyPage, next: nextPage, prev: prevPage, setPageSize } = useCursorPages();

async function load(): Promise<void> {
  const seq = ++loadSeq;
  state.value = 'loading';
  loadError.value = '';
  const rawUserId = userId.value.trim();
  if (rawUserId && (!/^[0-9]+$/.test(rawUserId) || !Number.isSafeInteger(Number(rawUserId)))) {
    state.value = 'error';
    loadError.value = '用户 ID 必须为正整数。';
    return;
  }
  const r = await queryFeedback({
    status: statusFilter.value || undefined,
    category: categoryFilter.value || undefined,
    userId: rawUserId || undefined,
    cursor: cursor.value,
    limit: pageSize.value,
  });
  if (seq !== loadSeq) return;
  if (r.kind === 'ok') {
    items.value = r.value.items;
    applyPage({ nextCursor: r.value.nextCursor, total: r.value.total });
    state.value = 'ready';
    return;
  }
  if (r.kind === 'unauthorized') { relogin(); return; }
  state.value = 'error';
  loadError.value = r.kind === 'forbidden' ? '需要平台管理员权限。' : '加载失败，请稍后重试。';
}

function search(): void {
  resetPager();
  void load();
}

function goNext(): void { if (nextPage()) void load(); }
function goPrev(): void { if (prevPage()) void load(); }
function changePageSize(n: number): void { setPageSize(n); resetPager(); void load(); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_STATUS_LABEL: Record<string, string> = { skipped: '未发邮件', pending: '发送中', sent: '邮件已发送', failed: '邮件发送失败' };

const replyWrite = useIdempotencyKey();
const extra = ref<AdminFeedbackDetail | null>(null);
const extraState = ref<'loading' | 'ready' | 'error'>('loading');
const replyBody = ref('');
const replyTarget = ref<FeedbackEmailTarget>('none');
const replyError = ref('');
const replyOk = ref('');
const replying = ref(false);

const contactIsEmail = computed(() => EMAIL_RE.test((detail.value?.contact ?? '').trim()));

async function loadExtra(id: string): Promise<void> {
  extraState.value = 'loading';
  const r = await getFeedbackDetail(id);
  if (detail.value?.id !== id) return;
  if (r.kind === 'ok') {
    extra.value = r.value;
    extraState.value = 'ready';
    return;
  }
  if (r.kind === 'unauthorized') { relogin(); return; }
  extraState.value = 'error';
}

function openDetail(f: AdminFeedback, focusReply = false): void {
  detail.value = f;
  editStatus.value = f.status;
  editNote.value = f.adminNote ?? '';
  error.value = '';
  extra.value = null;
  replyBody.value = '';
  replyTarget.value = 'none';
  replyError.value = '';
  replyOk.value = '';
  void loadExtra(f.id);
  if (focusReply) void focusReplyBox();
}

/** 从「回复」入口打开：等弹窗挂载后把回复框滚入视野并聚焦（Modal 自己会先聚焦对话框，故延后一帧）。 */
async function focusReplyBox(): Promise<void> {
  await nextTick();
  await nextTick();
  const box = document.getElementById('reply-body');
  if (!box) return;
  box.scrollIntoView({ block: 'nearest' });
  box.focus({ preventScroll: true });
}

function closeDetail(): void {
  if (busy.value || replying.value) return;
  detail.value = null;
}

async function sendReply(): Promise<void> {
  if (!detail.value || replying.value) return;
  const f = detail.value;
  const text = replyBody.value.trim();
  if (!text) { replyError.value = '请填写回复内容。'; return; }
  const tag = `reply:${f.id}:${replyTarget.value}:${text}`;
  replying.value = true;
  replyError.value = '';
  replyOk.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await replyFeedback(f.id, { body: text, emailTarget: replyTarget.value }, replyWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      replyWrite.reset(tag);
      replyBody.value = '';
      replyOk.value = r.value.emailStatus === 'failed'
        ? '回复已保存，但邮件发送失败。'
        : r.value.emailStatus === 'sent' ? '回复已保存，邮件已发送。' : '回复已保存。';
      replyTarget.value = 'none';
      await loadExtra(f.id);
      await load();
    } else if (r.kind === 'unauthorized') {
      replyWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      replyError.value = '发送失败，请重试。';
    } else {
      replyWrite.reset(tag);
      replyError.value = r.message ? `发送失败：${r.message}` : '发送失败。';
    }
  } finally {
    replying.value = false;
  }
}

async function save(): Promise<void> {
  if (!detail.value || busy.value) return;
  const f = detail.value;
  const note = editNote.value.trim();
  const tag = `feedback:${f.id}:${editStatus.value}:${note}`;
  busy.value = true;
  error.value = '';
  try {
    const csrf = await ensureCsrf();
    const r = await setFeedbackStatus(f.id, { status: editStatus.value, adminNote: note || null }, saveWrite.ensure(tag), csrf);
    if (r.kind === 'ok') {
      saveWrite.reset(tag);
      detail.value = null;
      await load();
    } else if (r.kind === 'unauthorized') {
      saveWrite.reset(tag);
      relogin();
    } else if (isRetryableFailure(r.kind)) {
      error.value = '操作失败，请重试。';
    } else {
      saveWrite.reset(tag);
      error.value = '操作失败：记录可能已被删除。';
    }
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="head">
      <div>
        <h2>反馈</h2>
        <p class="sub">用户在扩展内直接提交的反馈（允许匿名）。处理状态与备注仅后台可见。</p>
      </div>
    </header>

    <div class="bar">
      <input v-model="userId" type="text" placeholder="用户ID（可选）" @keyup.enter="search" />
      <select v-model="statusFilter" @change="search">
        <option value="">全部状态</option>
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
      <select v-model="categoryFilter" @change="search">
        <option value="">全部分类</option>
        <option v-for="c in CATEGORY_OPTIONS" :key="c" :value="c">{{ CATEGORY_LABEL[c] }}</option>
      </select>
      <button class="btn" @click="search">查询</button>
    </div>

    <p class="muted" v-if="state === 'loading'">加载中…</p>
    <p class="error" v-if="state === 'error'">{{ loadError }}</p>
    <p v-if="error" class="error">{{ error }}</p>

    <table v-if="state === 'ready'" class="table">
      <thead>
        <tr><th>ID</th><th>分类</th><th>内容</th><th>用户</th><th>版本 / OS</th><th>状态</th><th>提交时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="f in items" :key="f.id">
          <td class="mono">{{ f.id }}</td>
          <td><span class="badge">{{ CATEGORY_LABEL[f.category] ?? f.category }}</span></td>
          <td class="content"><div class="content-clamp" :title="f.content">{{ f.content }}</div></td>
          <td class="mono">
            <a v-if="f.userId" class="user-link" href="#" @click.prevent="goUser(f.userId)">{{ f.userId }}</a>
            <span v-else class="muted">匿名</span>
          </td>
          <td class="muted small">{{ f.appVersion ?? '—' }}<br />{{ f.os ?? '—' }}</td>
          <td><span class="badge" :class="f.status">{{ STATUS_LABEL[f.status] ?? f.status }}</span></td>
          <td class="muted small">{{ formatDateTime(f.createTime) }}</td>
          <td class="actions">
            <button v-if="f.status === 'new'" class="btn small" data-testid="feedback-reply" @click="openDetail(f, true)">回复</button>
            <button v-else class="btn small ghost" data-testid="feedback-view" @click="openDetail(f)">查看</button>
          </td>
        </tr>
        <tr v-if="items.length === 0"><td colspan="8" class="muted">暂无反馈。</td></tr>
      </tbody>
    </table>

    <Pager
      v-if="state === 'ready'"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :count="items.length"
      :has-next="hasNext"
      :loading="state === 'loading'"
      @prev="goPrev"
      @next="goNext"
      @update:page-size="changePageSize"
    />

    <Modal v-if="detail" title="反馈详情" size="lg" :closable="!busy" @close="closeDetail">
      <div class="detail-grid">
      <div class="col-main">
      <table class="kv">
        <tbody>
          <tr><th>分类</th><td>{{ CATEGORY_LABEL[detail.category] ?? detail.category }}</td></tr>
          <tr>
            <th>用户</th>
            <td class="mono">
              <a v-if="detail.userId" class="user-link" href="#" @click.prevent="goUser(detail.userId)">{{ detail.userId }}</a>
              <span v-else>匿名</span>
              <span v-if="extra?.userEmail" class="small muted"> · {{ extra.userEmail }}</span>
            </td>
          </tr>
          <tr><th>安装 ID</th><td class="mono small">{{ detail.installId ?? '—' }}</td></tr>
          <tr><th>联系方式</th><td class="mono">{{ detail.contact ?? '—' }}</td></tr>
          <tr><th>版本 / OS</th><td class="mono">{{ detail.appVersion ?? '—' }} / {{ detail.os ?? '—' }}</td></tr>
          <tr><th>来源 IP</th><td class="mono small">{{ detail.sourceIp ?? '—' }}</td></tr>
          <tr><th>提交时间</th><td>{{ formatDateTime(detail.createTime) }}</td></tr>
        </tbody>
      </table>
      <label>内容</label>
      <pre class="content-box content-full">{{ detail.content }}</pre>

      <label>状态</label>
      <select v-model="editStatus">
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
      </select>
      <label>处理备注（可选）</label>
      <textarea v-model="editNote" rows="3" maxlength="1000"></textarea>
      </div>

      <div class="col-side">
      <section class="replies" aria-labelledby="replies-title">
        <div class="replies-head">
          <h3 id="replies-title">回复</h3>
          <span v-if="extra" class="small" :class="extra.inAppDeliverable ? 'ok' : 'warn'">
            {{ extra.inAppDeliverable ? '插件内可见' : '插件内不可见（旧反馈无回复凭证），仅可邮件送达' }}
          </span>
        </div>
        <p v-if="extraState === 'loading'" class="muted">加载中…</p>
        <p v-else-if="extraState === 'error'" class="error">回复历史加载失败。</p>
        <template v-else-if="extra">
          <p v-if="extra.replies.length === 0" class="muted">还没有回复。</p>
          <ul v-else class="reply-list">
            <li v-for="r in extra.replies" :key="r.id">
              <div class="reply-meta small muted">
                <span>{{ formatDateTime(r.createTime) }}</span>
                <span :class="['email-status', r.emailStatus]">
                  {{ EMAIL_STATUS_LABEL[r.emailStatus] ?? r.emailStatus }}<template v-if="r.emailTo"> · {{ r.emailTo }}</template>
                </span>
              </div>
              <pre class="content-box reply-body">{{ r.body }}</pre>
              <p v-if="r.emailError" class="small error">{{ r.emailError }}</p>
            </li>
          </ul>
        </template>

        <label for="reply-body">回复内容（用户可见）</label>
        <textarea id="reply-body" v-model="replyBody" rows="4" maxlength="4000" :disabled="replying"></textarea>
        <fieldset class="email-target" :disabled="replying">
          <legend>同时发送邮件</legend>
          <label class="radio"><input v-model="replyTarget" type="radio" value="none" /> 不发送</label>
          <label class="radio" :class="{ disabled: !extra?.userEmail }">
            <input v-model="replyTarget" type="radio" value="account" :disabled="!extra?.userEmail" />
            账号邮箱<span v-if="extra?.userEmail" class="mono small"> {{ extra.userEmail }}</span><span v-else class="small muted">（未关联账号）</span>
          </label>
          <label class="radio" :class="{ disabled: !contactIsEmail }">
            <input v-model="replyTarget" type="radio" value="contact" :disabled="!contactIsEmail" />
            联系邮箱<span v-if="contactIsEmail" class="mono small"> {{ detail.contact }}</span>
            <span v-if="contactIsEmail" class="small warn">（用户自填，未验证）</span>
            <span v-else class="small muted">（未填写邮箱）</span>
          </label>
        </fieldset>
        <p v-if="replyError" class="error" role="alert">{{ replyError }}</p>
        <p v-if="replyOk" class="ok small" role="status">{{ replyOk }}</p>
        <div class="modal-actions">
          <button class="btn" :disabled="replying || !replyBody.trim()" @click="sendReply">{{ replying ? '发送中…' : '发送回复' }}</button>
        </div>
      </section>
      </div>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="modal-actions">
        <button class="btn" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存状态与备注' }}</button>
        <button class="btn ghost" :disabled="busy" @click="closeDetail">关闭</button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h2 { margin: 0 0 4px; font-size: 20px; }
.sub { margin: 0; color: var(--c-text-muted); font-size: 13px; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; }
.bar input, .bar select, textarea { padding: 7px 10px; border: 1px solid var(--c-border-strong); border-radius: 6px; background: var(--c-surface); color: var(--c-text); font-size: 13px; }
.bar input { width: 160px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--c-border-strong); vertical-align: top; }
.table th { color: var(--c-text-muted); font-weight: 600; font-size: 12px; }
.content { max-width: 560px; }
.content-clamp { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
.badge { display: inline-block; padding: 1px 7px; border: 1px solid var(--c-border-strong); border-radius: 5px; font-size: 12px; }
.badge.new { border-color: var(--c-accent); color: var(--c-accent); }
.badge.done { border-color: #3aa675; color: #3aa675; }
.badge.rejected { border-color: var(--c-danger); color: var(--c-danger); }
.mono { font-family: var(--c-font-mono, monospace); }
.small { font-size: 12px; }
.muted { color: var(--c-text-muted); font-size: 13px; }
.error { color: var(--c-danger); font-size: 13px; }
.btn { background: var(--c-accent); color: var(--c-surface); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn.ghost { background: transparent; border: 1px solid var(--c-border-strong); color: var(--c-text); }
.btn:disabled { opacity: 0.6; cursor: default; }
.user-link { color: var(--c-accent); }
.kv { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
.kv th { text-align: left; width: 110px; color: var(--c-text-muted); font-weight: 500; padding: 4px 0; font-size: 12px; }
.kv td { padding: 4px 0; font-size: 13px; }
.content-box { margin: 4px 0 12px; padding: 10px 12px; border: 1px solid var(--c-border-strong); border-radius: 6px; background: var(--c-surface); white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; font-size: 13px; }
.content-full { max-height: 50vh; min-height: 96px; }
label { display: block; margin: 10px 0 4px; font-size: 12px; color: var(--c-text-muted); }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.replies { margin: 0; }
.replies-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.replies-head h3 { margin: 0; font-size: 14px; }
.reply-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.reply-meta { display: flex; justify-content: space-between; gap: 8px; }
.reply-body { margin: 4px 0 0; max-height: 160px; }
.email-target { border: 1px solid var(--c-border-strong); border-radius: 6px; margin: 10px 0 0; padding: 8px 10px; }
.email-target legend { padding: 0 4px; font-size: 12px; color: var(--c-text-muted); }
.radio { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 13px; color: var(--c-text); }
.radio.disabled { color: var(--c-text-muted); }
.ok { color: #3aa675; }
.warn { color: var(--c-warn-text, #9a6700); }
.email-status.failed { color: var(--c-danger); }
.email-status.sent { color: #3aa675; }
.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
.col-main, .col-side { min-width: 0; }
.col-side { padding-left: 24px; border-left: 1px solid var(--c-border-strong); }
@media (max-width: 720px) {
  .detail-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .col-side { padding-left: 0; border-left: none; padding-top: 12px; border-top: 1px solid var(--c-border-strong); }
}
</style>