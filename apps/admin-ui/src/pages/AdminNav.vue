<script setup lang="ts">
import { router, navigate, withBase } from '../lib/router';

const links = [
  { name: 'admin-users', path: '/users', label: '用户' },
  { name: 'admin-orders', path: '/orders', label: '订单' },
  { name: 'admin-invoices', path: '/invoices', label: '发票' },
  { name: 'admin-audit', path: '/audit', label: '审计' },
  { name: 'admin-plans', path: '/plans', label: '套餐' },
  { name: 'admin-ai-topup', path: '/ai-topup', label: 'AI 加油包' },
  { name: 'admin-version', path: '/version', label: '系统状态' },
];
</script>

<template>
  <nav class="admin-nav">
    <a
      v-for="l in links"
      :key="l.name"
      :href="withBase(l.path)"
      @click.prevent="navigate(l.path)"
      :class="{ on: router.name === l.name }"
    >{{ l.label }}</a>
  </nav>
</template>

<style scoped>
.admin-nav {
  position: sticky; top: 54px; z-index: 9;
  display: flex; gap: 4px; margin: 0 0 20px; padding: 6px;
  background: var(--c-surface); border: 1px solid var(--c-border);
  border-radius: var(--r-md); width: 100%;
}
.admin-nav a {
  color: var(--c-text-muted); text-decoration: none; font-size: 13px;
  padding: 6px 14px; border-radius: var(--r-sm);
}
.admin-nav a:hover { background: var(--c-surface); color: var(--c-text); }
.admin-nav a.on { color: var(--c-text); background: var(--c-surface); box-shadow: var(--shadow-sm); font-weight: 600; }
</style>
