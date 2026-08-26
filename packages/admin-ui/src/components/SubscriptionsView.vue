<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '../lib/api';
import { fmt } from '../lib/format';
import type { SubscriptionRow, Plan } from '../types';

const subs = ref<SubscriptionRow[]>([]);
const plans = ref<Plan[]>([]);

async function load() {
  const [sR, pR] = await Promise.all([
    api<{ subscriptions: SubscriptionRow[] }>('/admin/subscriptions'),
    api<{ plans: Plan[] }>('/admin/plans'),
  ]);
  subs.value = sR.subscriptions || [];
  plans.value = pR.plans || [];
}

const planName = computed(() => {
  const m = new Map<number, string>();
  for (const p of plans.value) m.set(p.id, p.name);
  return (id: number) => m.get(id) ?? String(id);
});

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
          <th>Org</th><th>Org name</th><th>Plan</th><th>Status</th><th>Period end</th>
          <th>Trial end</th><th>Cancel time</th><th>Provider</th><th>External ID</th><th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="subs.length === 0"><td colspan="10" class="muted">No subscriptions</td></tr>
        <tr v-for="s in subs" :key="s.id">
          <td>#{{ s.organizationId }}</td>
          <td>{{ s.organizationName || '—' }}</td>
          <td>{{ planName(s.planId) }}</td>
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