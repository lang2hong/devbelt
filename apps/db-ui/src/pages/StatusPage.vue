<script setup lang="ts">
import { withBase } from '../lib/router';

const props = defineProps<{ code: number }>();

const content: Record<number, { title: string; message: string }> = {
  401: { title: '未登录', message: '会话已失效，请重新登录。' },
  403: { title: '无权限', message: '你没有访问该内容的权限。' },
  404: { title: '未找到', message: '页面或资源不存在。' },
  500: { title: '服务异常', message: '服务器开小差了，请稍后重试。' },
};
const c = content[props.code] ?? content[404];
</script>

<template>
  <section class="page">
    <h1>{{ props.code }}</h1>
    <h2>{{ c.title }}</h2>
    <p>{{ c.message }}</p>
    <a :href="withBase('/account')">返回账户</a>
  </section>
</template>

<style scoped>
.page { max-width: 620px; margin: 120px auto; text-align: center; }
h1 { font-size: 56px; font-weight: 700; color: var(--c-border-strong); margin: 0; }
h2 { font-size: 22px; color: var(--c-text); }
p { color: var(--c-text-muted); }
a { color: var(--c-accent); }
</style>