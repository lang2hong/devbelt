<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api } from '../lib/api';
import type { RateLimitResponse, RateLimitRuleRow } from '../types';

/**
 * 限流规则视图。
 *
 * 阈值改动写 DB + 更新服务端内存，立即生效，不需要重启。
 *
 * 白名单存在的具体理由：限流跑在 jwtVerify 之前，拿不到用户身份，只能按 IP
 * 分桶。多个用户共用一个出口 IP（同一间办公室）时会被算成一个人 —— 这时把
 * 那个出口 IP 加进白名单，而不是把全局阈值调到形同虚设。
 */

const rules = ref<RateLimitRuleRow[]>([]);
const allowlist = ref<string[]>([]);
const error = ref('');
const saving = ref('');

const editing = ref<RateLimitRuleRow | null>(null);
const form = reactive({ maxRequests: 0, windowSeconds: 0, enabled: true });

const newIp = reactive({ ip: '', note: '' });

async function load() {
  error.value = '';
  try {
    const r = await api<RateLimitResponse>('/admin/rate-limits');
    rules.value = r.rules || [];
    allowlist.value = r.allowlist || [];
  } catch (ex) {
    error.value = ex instanceof Error ? ex.message : String(ex);
  }
}

function openEdit(r: RateLimitRuleRow) {
  editing.value = r;
  form.maxRequests = r.maxRequests;
  form.windowSeconds = r.windowSeconds;
  form.enabled = r.enabled;
}

async function save() {
  if (!editing.value) return;
  saving.value = editing.value.bucket;
  try {
    const r = await api<{ rules: RateLimitRuleRow[] }>(
      '/admin/rate-limits/' + encodeURIComponent(editing.value.bucket),
      { method: 'PATCH', body: { ...form } },
    );
    rules.value = r.rules;
    editing.value = null;
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  } finally {
    saving.value = '';
  }
}

/** 快速开关，不用进弹窗 */
async function toggle(r: RateLimitRuleRow) {
  saving.value = r.bucket;
  try {
    const res = await api<{ rules: RateLimitRuleRow[] }>(
      '/admin/rate-limits/' + encodeURIComponent(r.bucket),
      { method: 'PATCH', body: { enabled: !r.enabled } },
    );
    rules.value = res.rules;
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  } finally {
    saving.value = '';
  }
}

async function addIp() {
  if (!newIp.ip.trim()) return;
  try {
    const r = await api<{ allowlist: string[] }>('/admin/rate-limits/allowlist', {
      method: 'POST',
      body: { ip: newIp.ip.trim(), note: newIp.note.trim() || undefined },
    });
    allowlist.value = r.allowlist;
    newIp.ip = '';
    newIp.note = '';
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

async function removeIp(ip: string) {
  if (!confirm(`Remove ${ip} from the allowlist?`)) return;
  try {
    const r = await api<{ allowlist: string[] }>(
      '/admin/rate-limits/allowlist/' + encodeURIComponent(ip),
      { method: 'DELETE' },
    );
    allowlist.value = r.allowlist;
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

/** 换算成每分钟，方便和实际流量对照 */
function perMinute(r: RateLimitRuleRow): string {
  return ((r.maxRequests / r.windowSeconds) * 60).toFixed(0);
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <span class="count">{{ rules.length }} bucket(s)</span>
      <button class="btn" @click="load">Refresh</button>
    </div>

    <p v-if="error" class="muted" style="color: var(--danger)">{{ error }}</p>

    <div class="note">
      Limits are keyed by client IP because rate limiting runs before JWT verification.
      Changes take effect immediately, no restart. If a whole office shares one egress IP,
      allowlist that IP instead of loosening the global threshold.
      To disable limiting entirely (for example when a bad threshold locks you out of this page),
      set <code>RATE_LIMIT_ENABLED=false</code> and restart.
    </div>

    <table>
      <thead>
        <tr>
          <th>Bucket</th>
          <th>Limit</th>
          <th>Window</th>
          <th>≈ per min</th>
          <th>Status</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rules" :key="r.bucket">
          <td>
            <code>{{ r.bucket }}</code>
            <span v-if="!r.isDefault" class="badge admin" style="margin-left: 6px">modified</span>
          </td>
          <td>{{ r.maxRequests }}</td>
          <td>{{ r.windowSeconds }}s</td>
          <td class="muted">{{ perMinute(r) }}</td>
          <td>
            <span class="badge" :class="r.enabled ? 'active' : 'disabled'">
              {{ r.enabled ? 'enabled' : 'off' }}
            </span>
          </td>
          <td class="muted desc">{{ r.description }}</td>
          <td style="white-space: nowrap">
            <button class="btn" :disabled="saving === r.bucket" @click="openEdit(r)">Edit</button>
            <button
              class="btn"
              :class="{ danger: r.enabled }"
              :disabled="saving === r.bucket"
              style="margin-left: 6px"
              @click="toggle(r)"
            >
              {{ r.enabled ? 'Disable' : 'Enable' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">IP allowlist</h3>
    <div class="toolbar">
      <input v-model="newIp.ip" placeholder="203.0.113.9" />
      <input v-model="newIp.note" placeholder="note (e.g. HQ office)" />
      <button class="btn primary" @click="addIp">Add</button>
    </div>
    <p v-if="allowlist.length === 0" class="muted">Empty — every IP is subject to the limits above</p>
    <table v-else>
      <thead><tr><th>IP</th><th></th></tr></thead>
      <tbody>
        <tr v-for="ip in allowlist" :key="ip">
          <td><code>{{ ip }}</code></td>
          <td><button class="btn danger" @click="removeIp(ip)">Remove</button></td>
        </tr>
      </tbody>
    </table>

    <div v-if="editing" class="modal" @click.self="editing = null">
      <div class="modal-body">
        <div class="modal-head">
          <h2>Edit bucket</h2>
          <button class="modal-close" @click="editing = null">&times;</button>
        </div>
        <p class="muted"><b>{{ editing.bucket }}</b> — {{ editing.description }}</p>
        <div class="kv" style="margin: 12px 0">
          <span class="k">Max requests</span>
          <input v-model.number="form.maxRequests" type="number" min="1" step="1" />
          <span class="k">Window (seconds)</span>
          <input v-model.number="form.windowSeconds" type="number" min="1" max="86400" step="1" />
          <span class="k">Enabled</span>
          <label><input v-model="form.enabled" type="checkbox" /> apply this bucket</label>
        </div>
        <p class="muted" style="font-size: 12px">
          ≈ {{ ((form.maxRequests / Math.max(1, form.windowSeconds)) * 60).toFixed(0) }} requests
          per minute per IP.
        </p>
        <button class="btn primary" style="margin-top: 12px" @click="save">Save</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.section-title { margin: 24px 0 10px; color: var(--accent); font-size: 15px; }
.note {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 16px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}
.note code { color: var(--accent); }
.desc { font-size: 12px; max-width: 380px; line-height: 1.5; }
code { font-size: 12px; }
</style>
