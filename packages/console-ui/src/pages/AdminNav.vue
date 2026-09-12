<script setup lang="ts">
import { router, navigate } from '../lib/router';

const links = [
  { name: 'admin-users', path: '/console/admin/users', label: '用户' },
  { name: 'admin-organizations', path: '/console/admin/organizations', label: '组织' },
  { name: 'admin-orders', path: '/console/admin/orders', label: '订单' },
  { name: 'admin-audit', path: '/console/admin/audit', label: '审计' },
  { name: 'admin-version', path: '/console/admin/version', label: '系统状态' },
];
</script>

<template>
  <nav class="admin-nav">
    <a
      v-for="l in links"
      :key="l.name"
      :href="l.path"
      @click.prevent="navigate(l.path)"
      :class="{ on: router.name === l.name }"
    >{{ l.label }}</a>
  </nav>
</template>

<style scoped>
.admin-nav { display: flex; gap: 16px; margin: 8px 0 20px; padding: 8px 0; border-bottom: 1px solid #eaeef2; }
.admin-nav a { color: #57606a; text-decoration: none; font-size: 14px; padding: 2px 0; }
.admin-nav a:hover { color: #0969da; }
.admin-nav a.on { color: #0969da; font-weight: 600; border-bottom: 2px solid #0969da; }
</style>