<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt, bytes, featNames } from '../lib/format';
import type { AdminUserDetail, Device, ConnectionMeta, Plan } from '../types';

const props = defineProps<{ userId: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const detail = ref<AdminUserDetail | null>(null);
const extras = ref<{ devices: Device[]; connections: ConnectionMeta[] }>({
  devices: [],
  connections: [],
});

const activeTab = ref<'overview' | 'devices' | 'sessions' | 'connections'>('overview');

const renewState = ref(false);
const renewForm = reactive({ planCode: 'free', period: 'month' });
const planCodes = ref<string[]>([]);

async function load() {
  const id = props.userId;
  detail.value = await api<AdminUserDetail>('/admin/users/' + id);
  const pR = await api<{ plans: Plan[] }>('/admin/plans');
  planCodes.value = (pR.plans || []).map((p) => p.code);
  const next = { devices: [] as Device[], connections: [] as ConnectionMeta[] };
  try {
    const [devR, connR] = await Promise.all([
      api<{ devices: Device[] }>('/admin/users/' + id + '/devices'),
      api<{ connections: ConnectionMeta[] }>('/admin/users/' + id + '/connections'),
    ]);
    next.devices = devR.devices || [];
    next.connections = connR.connections || [];
  } catch {
    /* extras are best-effort */
  }
  extras.value = next;
}

async function revoke(sid: number) {
  if (!confirm('Revoke device + all sessions for #' + sid + '?')) return;
  try {
    await api('/admin/users/' + props.userId + '/sessions/' + sid, { method: 'DELETE' });
    await load();
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

function openRenew() {
  renewForm.planCode = detail.value?.plan?.code ?? 'free';
  renewForm.period = 'month';
  renewState.value = true;
}

async function submitRenew() {
  const orgId = detail.value?.subscription?.organizationId;
  if (!orgId) {
    alert('This user has no organization subscription to renew.');
    return;
  }
  try {
    await api('/admin/organizations/' + orgId + '/renew', {
      method: 'POST',
      body: { planCode: renewForm.planCode, period: renewForm.period },
    });
    renewState.value = false;
    await load();
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

onMounted(load);
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="modal-body">
      <div class="modal-head">
        <h2>User #{{ userId }}</h2>
        <button class="modal-close" @click="emit('close')">&times;</button>
      </div>

      <div v-if="detail">
        <div class="dtabs">
          <button class="dtab" :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">Overview</button>
          <button class="dtab" :class="{ active: activeTab === 'devices' }" @click="activeTab = 'devices'">Devices</button>
          <button class="dtab" :class="{ active: activeTab === 'sessions' }" @click="activeTab = 'sessions'">Sessions</button>
          <button class="dtab" :class="{ active: activeTab === 'connections' }" @click="activeTab = 'connections'">Connections</button>
        </div>

        <!-- Overview -->
        <div v-if="activeTab === 'overview'">
          <div class="kv">
            <span class="k">Email</span><span>{{ detail.user.email }}</span>
            <span class="k">Role</span><span>{{ detail.user.role }}</span>
            <span class="k">Status</span><span>{{ detail.user.status }}</span>
            <span class="k">Current plan</span><span>{{ detail.plan.name }} ({{ detail.plan.code }})</span>
            <span class="k">Last login</span><span>{{ fmt(detail.user.lastLoginTime) }}</span>
            <span class="k">Created</span><span>{{ fmt(detail.user.createTime) }}</span>
          </div>

          <div class="section">
            <h4>Plan quotas ({{ detail.plan.name }})</h4>
            <div class="kv">
              <span class="k">Max private connections</span><span>{{ detail.plan.perUserMaxPrivateConnections === 0 ? 'unlimited' : detail.plan.perUserMaxPrivateConnections }}</span>
              <span class="k">Max open connections</span><span>{{ detail.plan.perUserMaxOpenConnections === 0 ? 'unlimited' : detail.plan.perUserMaxOpenConnections }}</span>
              <span class="k">Max devices / seat</span><span>{{ detail.plan.perSeatMaxDevices === 0 ? 'unlimited' : detail.plan.perSeatMaxDevices }}</span>
              <span class="k">Included seats</span><span>{{ detail.plan.includedSeats }}</span>
              <span class="k">Sync quota</span><span>{{ detail.plan.perUserPrivateSyncQuotaBytes === 0 ? 'unlimited' : bytes(detail.plan.perUserPrivateSyncQuotaBytes) }}</span>
              <span class="k">Version retention</span><span>{{ detail.plan.perUserSyncVersionRetention }}</span>
              <span class="k">Features</span><span>{{ featNames(detail.plan.features) }}</span>
            </div>
          </div>

          <div class="section">
            <h4>Subscription</h4>
            <div v-if="detail.subscription" class="kv">
              <span class="k">Plan</span><span>{{ detail.plan.name }}</span>
              <span class="k">Status</span><span><span class="badge" :class="detail.subscription.status">{{ detail.subscription.status }}</span></span>
              <span class="k">Period end</span><span>{{ fmt(detail.subscription.periodEndTime) }}</span>
              <span class="k">Trial end</span><span>{{ fmt(detail.subscription.trialEndTime) }}</span>
              <span class="k">Cancel time</span><span>{{ fmt(detail.subscription.cancelTime) }}</span>
              <span class="k">Provider</span><span>{{ detail.subscription.provider }}</span>
              <span class="k">External ID</span><span>{{ detail.subscription.externalId }}</span>
              <span class="k">Organization</span><span>#{{ detail.subscription.organizationId }}</span>
            </div>
            <p v-else class="muted">No subscription</p>
            <button class="btn primary" style="margin-top: 8px" :disabled="!detail.subscription" @click="openRenew">Renew</button>
          </div>

          <div class="section" v-if="detail.memberships?.length">
            <h4>Organizations</h4>
            <table style="margin-top: 4px">
              <tr><th>Org</th><th>Role</th><th>Status</th></tr>
              <tr v-for="m in detail.memberships" :key="m.organizationId">
                <td>{{ m.organizationName }} (#{{ m.organizationId }})</td>
                <td>{{ m.role }}</td>
                <td><span class="badge" :class="m.status">{{ m.status }}</span></td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="kv">
              <span class="k">Active devices</span><span>{{ detail.usage.devices }}</span>
              <span class="k">Total sync (cipher)</span><span>{{ bytes(detail.usage.syncBytes) }}</span>
            </div>
            <table v-if="detail.usage.sections.length" style="margin-top: 8px">
              <thead><tr><th>Section</th><th>Version</th><th>Bytes (cipher)</th><th>Updated</th></tr></thead>
              <tbody>
                <tr v-for="sec in detail.usage.sections" :key="sec.section">
                  <td>{{ sec.section }}</td><td>{{ sec.version }}</td><td>{{ bytes(sec.bytes) }}</td><td>{{ fmt(sec.updateTime) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted">No sync data</p>
            <p class="muted">Note: history section content is E2E encrypted; connection metadata is visible to the server for quota accounting.</p>
          </div>
        </div>

        <!-- Devices -->
        <div v-else-if="activeTab === 'devices'">
          <table v-if="extras.devices.length">
            <thead><tr><th>Host</th><th>OS</th><th>App</th><th>Version</th><th>Remote</th><th>Lang</th><th>Last seen</th></tr></thead>
            <tbody>
              <tr v-for="dev in extras.devices" :key="dev.id">
                <td>{{ dev.hostname || dev.deviceId }}</td>
                <td>{{ dev.os || '' }}{{ dev.arch ? ' ' + dev.arch : '' }}</td>
                <td>{{ dev.appName || '' }}</td>
                <td>{{ dev.appVersion || '' }}</td>
                <td>{{ dev.remoteName || 'local' }}</td>
                <td>{{ dev.language || '' }}</td>
                <td>{{ fmt(dev.lastSeenTime) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No devices</p>
        </div>

        <!-- Sessions -->
        <div v-else-if="activeTab === 'sessions'">
          <table v-if="detail.sessions.length">
            <thead><tr><th>ID</th><th>Device</th><th>IP</th><th>Created</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              <tr v-for="sess in detail.sessions" :key="sess.id">
                <td>{{ sess.id }}</td>
                <td>{{ sess.deviceName }}</td>
                <td>{{ sess.ip }}</td>
                <td>{{ fmt(sess.createTime) }}</td>
                <td>{{ fmt(sess.lastUsedTime) }}</td>
                <td><button class="btn danger" @click="revoke(sess.id)">Revoke</button></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No active sessions</p>
        </div>

        <!-- Connections -->
        <div v-else-if="activeTab === 'connections'">
          <table v-if="extras.connections.length">
            <thead><tr><th>Type</th><th>Name</th><th>Group</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead>
            <tbody>
              <tr v-for="c in extras.connections" :key="c.id">
                <td>{{ c.type }}</td>
                <td>{{ c.name }}</td>
                <td>{{ c.groupName }}</td>
                <td>
                  <span v-if="c.enabled" class="badge active">active</span>
                  <span v-else class="badge disabled">disabled</span>
                </td>
                <td>{{ fmt(c.clientCreatedAt) }}</td>
                <td>{{ fmt(c.clientUpdatedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No connection metadata (push to sync)</p>
        </div>
      </div>

      <p v-else class="muted">Loading…</p>
    </div>

    <!-- renew modal -->
    <div v-if="renewState" class="modal" @click.self="renewState = false">
      <div class="modal-body">
        <div class="modal-head">
          <h2>Renew</h2>
          <button class="modal-close" @click="renewState = false">&times;</button>
        </div>
        <p class="muted">Renew subscription for organization #{{ detail?.subscription?.organizationId }}.</p>
        <div class="kv" style="margin: 12px 0">
          <span class="k">Plan</span>
          <select v-model="renewForm.planCode">
            <option v-for="c in planCodes" :key="c" :value="c">{{ c }}</option>
          </select>
          <span class="k">Period</span>
          <select v-model="renewForm.period">
            <option value="month">month</option>
            <option value="year">year</option>
          </select>
        </div>
        <button class="btn primary" @click="submitRenew">Renew</button>
      </div>
    </div>
  </div>
</template>