<template>
  <nav class="admin-nav">
    <a href="/console/admin/users">用户</a>
    <a href="/console/admin/organizations">组织</a>
    <a href="/console/admin/audit">审计</a>
    <a href="/console/admin/version">系统状态</a>
  </nav>
</template>

<style scoped>
.admin-nav { display: flex; gap: 16px; margin: 8px 0 20px; padding: 8px 0; border-bottom: 1px solid #eaeef2; }
.admin-nav a { color: #57606a; text-decoration: none; font-size: 14px; }
.admin-nav a:hover { color: #0969da; }
</style>