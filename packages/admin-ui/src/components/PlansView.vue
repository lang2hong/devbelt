<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api } from '../lib/api';
import { bytes, featNames, FEATURES } from '../lib/format';
import type { Plan } from '../types';

const plans = ref<Plan[]>([]);
const editing = ref<Plan | null>(null);

const form = reactive({
  name: '',
  priceMonth: 0,
  priceYear: 0,
  maxConnections: 0,
  quotaMb: 0,
  syncVersionRetention: 0,
  features: 0,
});

async function load() {
  const r = await api<{ plans: Plan[] }>('/admin/plans');
  plans.value = r.plans || [];
}

function openEdit(p: Plan) {
  editing.value = p;
  form.name = p.name;
  form.priceMonth = p.priceMonth;
  form.priceYear = p.priceYear;
  form.maxConnections = p.maxConnections;
  form.quotaMb = p.syncQuotaBytes === 0 ? 0 : Math.round(p.syncQuotaBytes / 1048576);
  form.syncVersionRetention = p.syncVersionRetention;
  form.features = p.features;
}

function toggleFeature(bit: number) {
  form.features ^= bit;
}

async function save() {
  if (!editing.value) return;
  const body = {
    name: form.name,
    priceMonth: form.priceMonth,
    priceYear: form.priceYear,
    maxConnections: form.maxConnections,
    syncQuotaBytes: form.quotaMb * 1048576,
    syncVersionRetention: form.syncVersionRetention,
    features: form.features,
  };
  try {
    await api('/admin/plans/' + encodeURIComponent(editing.value.code), { method: 'POST', body });
    editing.value = null;
    await load();
  } catch (ex) {
    alert(ex instanceof Error ? ex.message : String(ex));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="toolbar">
      <span class="count">{{ plans.length }} plan(s)</span>
      <button class="btn" @click="load">Refresh</button>
    </div>
    <p v-if="plans.length === 0" class="muted">No plans</p>
    <div v-else class="grid">
      <div v-for="p in plans" :key="p.code" class="card">
        <h3>{{ p.name }} <span class="muted">({{ p.code }})</span></h3>
        <div class="row"><span class="k">Monthly</span><span class="v">¥{{ p.priceMonth }}</span></div>
        <div class="row"><span class="k">Yearly</span><span class="v">¥{{ p.priceYear }}</span></div>
        <div class="row"><span class="k">Max connections</span><span class="v">{{ p.maxConnections === 0 ? '∞' : p.maxConnections }}</span></div>
        <div class="row"><span class="k">Sync quota</span><span class="v">{{ p.syncQuotaBytes === 0 ? '∞' : bytes(p.syncQuotaBytes) }}</span></div>
        <div class="row"><span class="k">Version retention</span><span class="v">{{ p.syncVersionRetention }}</span></div>
        <div class="row"><span class="k">Features</span><span class="v">{{ featNames(p.features) }}</span></div>
        <button class="btn" style="margin-top: 10px" @click="openEdit(p)">Edit</button>
      </div>
    </div>

    <div v-if="editing" class="modal" @click.self="editing = null">
      <div class="modal-body">
        <div class="modal-head">
          <h2>Edit plan</h2>
          <button class="modal-close" @click="editing = null">&times;</button>
        </div>
        <p class="muted">Edit plan <b>{{ editing.code }}</b></p>
        <div class="kv" style="margin: 12px 0">
          <span class="k">Name</span><input v-model="form.name" />
          <span class="k">Monthly (¥)</span><input v-model.number="form.priceMonth" type="number" min="0" step="1" />
          <span class="k">Yearly (¥)</span><input v-model.number="form.priceYear" type="number" min="0" step="1" />
          <span class="k">Max connections</span><input v-model.number="form.maxConnections" type="number" min="0" step="1" />
          <span class="k">Sync quota (MB)</span><input v-model.number="form.quotaMb" type="number" min="0" step="1" />
          <span class="k">Version retention</span><input v-model.number="form.syncVersionRetention" type="number" min="0" step="1" />
        </div>
        <div class="muted" style="margin-bottom: 6px">Features</div>
        <div class="feats">
          <label v-for="[name, bit] in FEATURES" :key="bit" class="feat">
            <input type="checkbox" :checked="(form.features & bit) !== 0" @change="toggleFeature(bit)" />
            {{ name }}
          </label>
        </div>
        <button class="btn primary" style="margin-top: 14px" @click="save">Save</button>
      </div>
    </div>
  </div>
</template>