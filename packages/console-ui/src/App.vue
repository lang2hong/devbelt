<script setup lang="ts">
import VerifyEmail from './pages/VerifyEmail.vue';

// 本片不引入 router：仅按 window.location.pathname 分支渲染。
// /verify-email → 邮箱验证落地点；其余路径给最小「页面不存在」占位，
// 不伪装为 /console/* 管理台。
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const isVerifyEmail = path === '/verify-email';
</script>

<template>
  <VerifyEmail v-if="isVerifyEmail" />
  <main v-else class="placeholder">
    <h1>页面不存在</h1>
    <p>未找到请求的页面。</p>
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