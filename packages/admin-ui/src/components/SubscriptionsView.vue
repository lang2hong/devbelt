<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import type { SubscriptionRow } from '../types';

const subs = ref<SubscriptionRow[]>([]);

async function load() {
  const r = await api<{ subscriptions: SubscriptionRow[] }>('/admin/subscriptions');
  subs.value = r.subscriptions || [];
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <span class="count">Total {{ subs.length }} subscription(s)</span>
      <button class="btn" @click="load">Refresh</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>User</th><th>Email</th><th>Plan</th><th>Status</th><th>Period end</th>
          <th>Trial end</th><th>Cancel time</th><th>Provider</th><th>External ID</th><th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="subs.length === 0"><td colspan="10" class="muted">No subscriptions</td></tr>
        <tr v-for="s in subs" :key="s.id">
          <td>{{ s.userId }}</td>
          <td>{{ s.email }}</td>
          <td>{{ s.planCode }}</td>
          <td><span class="badge" :class="s.status">{{ s.status }}</span></td>
          <td>{{ fmt(s.periodEndTime) }}</td>
          <td>{{ fmt(s.trialEndTime) }}</td>
          <td>{{ fmt(s.cancelTime) }}</td>
          <td>{{ s.provider }}</td>
          <td>{{ s.externalId }}</td>
          <td>{{ fmt(s.createTime) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>