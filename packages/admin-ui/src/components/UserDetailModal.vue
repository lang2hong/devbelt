<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt, bytes, featNames } from '../lib/format';
import type {
  AdminUserDetail, Device, ConnectionMeta, SyncEvent, UsageEvent, DeviceEvent,
} from '../types';

const props = defineProps<{ userId: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const detail = ref<AdminUserDetail | null>(null);
const extras = ref<{
  devices: Device[];
  connections: ConnectionMeta[];
  syncEvents: SyncEvent[];
  usageEvents: UsageEvent[];
}>({ devices: [], connections: [], syncEvents: [], usageEvents: [] });

const activeTab = ref<'overview' | 'devices' | 'sessions' | 'connections' | 'syncevents' | 'usage'>('overview');
const deviceEvents = ref<DeviceEvent[] | null>(null);
const deviceEventsTitle = ref('');

async function load() {
  const id = props.userId;
  detail.value = await api<AdminUserDetail>('/admin/users/' + id);
  const next = { devices: [] as Device[], connections: [] as ConnectionMeta[], syncEvents: [] as SyncEvent[], usageEvents: [] as UsageEvent[] };
  try {
    const [devR, connR, evR, uR] = await Promise.all([
      api<{ devices: Device[] }>('/admin/users/' + id + '/devices'),
      api<{ connections: ConnectionMeta[] }>('/admin/users/' + id + '/connections'),
      api<{ syncEvents: SyncEvent[] }>('/admin/users/' + id + '/sync-events'),
      api<{ usageEvents: UsageEvent[] }>('/admin/users/' + id + '/usage-events'),
    ]);
    next.devices = devR.devices || [];
    next.connections = connR.connections || [];
    next.syncEvents = evR.syncEvents || [];
    next.usageEvents = uR.usageEvents || [];
  } catch (e) {
    /* extras are best-effort */
  }
  extras.value = next;
}

async function revoke(sid: number) {
  if (!confirm('Revoke session #' + sid + '?')) return;
  try {
    await api('/admin/users/' + props.userId + '/sessions/' + sid, { method: 'DELETE' });
    await load();
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

async function showDeviceEvents(did: string) {
  try {
    const r = await api<{ events: DeviceEvent[] }>(
      '/admin/users/' + props.userId + '/devices/' + encodeURIComponent(did) + '/events',
    );
    deviceEventsTitle.value = 'Device events';
    deviceEvents.value = r.events || [];
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

const usageTotals = computed(() => {
  let opens = 0;
  let queries = 0;
  for (const e of extras.value.usageEvents) {
    if (e.kind === 'connection_open') opens += e.count;
    else queries += e.count;
  }
  return { opens, queries };
});

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
          <button class="dtab" :class="{ active: activeTab === 'syncevents' }" @click="activeTab = 'syncevents'">Sync events</button>
          <button class="dtab" :class="{ active: activeTab === 'usage' }" @click="activeTab = 'usage'">Usage</button>
        </div>

        <!-- Overview -->
        <div v-if="activeTab === 'overview'">
          <div class="kv">
            <span class="k">Email</span><span>{{ detail.user.email }}</span>
            <span class="k">Role</span><span>{{ detail.user.role }}</span>
            <span class="k">Status</span><span>{{ detail.user.status }}</span>
            <span class="k">Current plan</span><span>{{ detail.user.planCode }}</span>
            <span class="k">Last login</span><span>{{ fmt(detail.user.lastLoginTime) }}</span>
            <span class="k">Created</span><span>{{ fmt(detail.user.createTime) }}</span>
          </div>

          <div class="section">
            <h4>Plan quotas ({{ detail.plan.name }})</h4>
            <div class="kv">
              <span class="k">Max connections</span><span>{{ detail.plan.maxConnections === 0 ? 'unlimited' : detail.plan.maxConnections }}</span>
              <span class="k">Sync quota</span><span>{{ detail.plan.syncQuotaBytes === 0 ? 'unlimited' : bytes(detail.plan.syncQuotaBytes) }}</span>
              <span class="k">Version retention</span><span>{{ detail.plan.syncVersionRetention }}</span>
              <span class="k">Features</span><span>{{ featNames(detail.plan.features) }}</span>
            </div>
          </div>

          <div class="section">
            <h4>Subscription</h4>
            <div v-if="detail.subscription" class="kv">
              <span class="k">Plan</span><span>{{ detail.subscription.planCode }}</span>
              <span class="k">Status</span><span><span class="badge" :class="detail.subscription.status">{{ detail.subscription.status }}</span></span>
              <span class="k">Period end</span><span>{{ fmt(detail.subscription.periodEndTime) }}</span>
              <span class="k">Trial end</span><span>{{ fmt(detail.subscription.trialEndTime) }}</span>
              <span class="k">Cancel time</span><span>{{ fmt(detail.subscription.cancelTime) }}</span>
              <span class="k">Provider</span><span>{{ detail.subscription.provider }}</span>
              <span class="k">External ID</span><span>{{ detail.subscription.externalId }}</span>
            </div>
            <p v-else class="muted">No subscription</p>
          </div>

          <div class="section">
            <h4>Sync usage</h4>
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
            <p class="muted">Note: connections/history counts are end-to-end encrypted and invisible to the server.</p>
          </div>
        </div>

        <!-- Devices -->
        <div v-else-if="activeTab === 'devices'">
          <table v-if="extras.devices.length">
            <thead><tr><th>Host</th><th>OS</th><th>App</th><th>Version</th><th>Remote</th><th>Lang</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              <tr v-for="dev in extras.devices" :key="dev.id">
                <td>{{ dev.hostname || dev.deviceId }}</td>
                <td>{{ dev.os || '' }}{{ dev.arch ? ' ' + dev.arch : '' }}</td>
                <td>{{ dev.appName || '' }}</td>
                <td>{{ dev.appVersion || '' }}</td>
                <td>{{ dev.remoteName || 'local' }}</td>
                <td>{{ dev.language || '' }}</td>
                <td>{{ fmt(dev.lastSeenTime) }}</td>
                <td><button class="btn" @click="showDeviceEvents(dev.deviceId)">Events</button></td>
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
                  <span v-if="c.deleted" class="badge canceled">deleted</span>
                  <span v-else-if="c.enabled" class="badge active">active</span>
                  <span v-else class="badge disabled">disabled</span>
                </td>
                <td>{{ fmt(c.createdAt) }}</td>
                <td>{{ fmt(c.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No connection metadata (push to sync)</p>
        </div>

        <!-- Sync events -->
        <div v-else-if="activeTab === 'syncevents'">
          <table v-if="extras.syncEvents.length">
            <thead><tr><th>Direction</th><th>Section</th><th>Bytes</th><th>Items</th><th>Time</th></tr></thead>
            <tbody>
              <tr v-for="e in extras.syncEvents" :key="e.id">
                <td>{{ e.direction }}</td><td>{{ e.section }}</td><td>{{ bytes(e.bytes) }}</td><td>{{ e.itemCount }}</td><td>{{ fmt(e.createTime) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No sync events</p>
        </div>

        <!-- Usage -->
        <div v-else-if="activeTab === 'usage'">
          <template v-if="extras.usageEvents.length">
            <div class="kv">
              <span class="k">Connections opened</span><span>{{ usageTotals.opens }}</span>
              <span class="k">Queries executed</span><span>{{ usageTotals.queries }}</span>
            </div>
            <table style="margin-top: 8px">
              <thead><tr><th>Kind</th><th>Count</th><th>Time</th></tr></thead>
              <tbody>
                <tr v-for="e in extras.usageEvents" :key="e.id">
                  <td>{{ e.kind }}</td><td>{{ e.count }}</td><td>{{ fmt(e.createTime) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <p v-else class="muted">No usage events</p>
        </div>
      </div>

      <p v-else class="muted">Loading…</p>
    </div>

    <!-- nested device events modal -->
    <div v-if="deviceEvents" class="modal" @click.self="deviceEvents = null">
      <div class="modal-body">
        <div class="modal-head">
          <h2>{{ deviceEventsTitle }}</h2>
          <button class="modal-close" @click="deviceEvents = null">&times;</button>
        </div>
        <table>
          <thead><tr><th>Event</th><th>App</th><th>Version</th><th>OS</th><th>OS ver</th><th>Time</th></tr></thead>
          <tbody>
            <tr v-for="x in deviceEvents" :key="x.id">
              <td>{{ x.event }}</td><td>{{ x.appName }}</td><td>{{ x.appVersion }}</td><td>{{ x.os }}</td><td>{{ x.osVersion }}</td><td>{{ fmt(x.createTime) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>