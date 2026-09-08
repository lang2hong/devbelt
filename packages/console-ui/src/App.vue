<script setup lang="ts">
// 控制台 SPA 根（切片 3 起用）。本片仅保留最小占位，不渲染邮件落地点
// （邮件页是独立 entry verify-email.html），也不伪装为任何管理台页面。
</script>

<template>
  <main class="placeholder">
    <h1>DB Client Console</h1>
    <p>控制台暂未开放。</p>
  </main>
</template>

<style>
html,
body {
  margin: 0;
  padding: 0;
  background: #f6f8fa;
  color: #1f2328;
  font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
    'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.placeholder {
  max-width: 480px;
  margin: 80px auto;
  text-align: center;
}

.placeholder h1 {
  font-size: 20px;
  font-weight: 700;
}
</style>