<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { confirmEmail } from '../api/verifyEmail';

// 文案抽为常量，与验证邮件正文语言一致（本片不做双语切换）。
const TEXT = {
  title: '验证你的邮箱',
  intent: '点击下方按钮完成邮箱验证。',
  confirm: '验证邮箱',
  processing: '正在验证…',
  success: '邮箱验证成功。',
  invalid: '验证链接无效或已过期，请重新发送验证邮件。',
  failure: '验证失败，请检查网络后重试。',
  retry: '重试',
  noTokenTitle: '无效的验证链接',
  noToken: '链接缺少验证参数，请通过邮件中的完整链接访问。',
} as const;

type PageState = 'no-token' | 'idle' | 'processing' | 'success' | 'invalid' | 'failure';

const token = readToken();
const state = ref<PageState>(token ? 'idle' : 'no-token');

onMounted(() => {
  if (token) {
    // 读后立即从地址栏清除 query，减少一次性 token 落在浏览器历史/截图/复制链接中的暴露面。
    // token 仅在内存保留到请求完成，之后不再被本组件使用。
    history.replaceState(null, '', window.location.pathname);
  }
});

async function onConfirm() {
  if (!token || state.value === 'processing') return;
  state.value = 'processing';
  const result = await confirmEmail(token);
  state.value = result.kind === 'success' ? 'success' : result.kind === 'invalid' ? 'invalid' : 'failure';
}

function readToken(): string | null {
  const raw = new URLSearchParams(window.location.search).get('token');
  return raw && raw.trim() !== '' ? raw.trim() : null;
}
</script>

<template>
  <div class="card">
    <template v-if="state === 'no-token'">
      <h1>{{ TEXT.noTokenTitle }}</h1>
      <p class="muted">{{ TEXT.noToken }}</p>
    </template>

    <template v-else>
      <h1>{{ TEXT.title }}</h1>

      <template v-if="state === 'idle' || state === 'failure'">
        <p class="muted">{{ state === 'failure' ? TEXT.failure : TEXT.intent }}</p>
        <button class="primary" :disabled="state === 'processing'" @click="onConfirm">
          {{ state === 'failure' ? TEXT.retry : TEXT.confirm }}
        </button>
      </template>

      <template v-else-if="state === 'processing'">
        <p class="muted">{{ TEXT.processing }}</p>
      </template>

      <template v-else-if="state === 'success'">
        <p class="success">{{ TEXT.success }}</p>
      </template>

      <template v-else-if="state === 'invalid'">
        <p class="error">{{ TEXT.invalid }}</p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.card {
  max-width: 480px;
  margin: 80px auto;
  padding: 28px 32px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
}

h1 {
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
  margin: 0 0 4px;
}

.muted {
  color: #57606a;
  font-size: 14px;
  line-height: 1.7;
  margin: 12px 0 0;
}

.success {
  color: #1a7f37;
  font-size: 15px;
  margin: 12px 0 0;
}

.error {
  color: #cf222e;
  font-size: 15px;
  margin: 12px 0 0;
}

button.primary {
  display: block;
  margin: 22px 0;
  background: #0969da;
  color: #ffffff;
  border: none;
  padding: 12px 32px;
  border-radius: 6px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

button.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>