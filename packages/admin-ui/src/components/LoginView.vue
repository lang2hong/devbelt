<script setup lang="ts">
import { ref } from 'vue';
import { api, setToken } from '../lib/api';
import type { LoginResponse, UserInfo } from '../types';

const emit = defineEmits<{ (e: 'logged-in', user: UserInfo): void }>();

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const r = await api<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    });
    if (r.user.role !== 'admin') {
      error.value = 'This account is not an admin.';
      return;
    }
    setToken(r.accessToken);
    emit('logged-in', r.user);
  } catch (ex) {
    error.value = ex instanceof Error ? ex.message : String(ex);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <h1>DB Client Admin</h1>
    <p class="sub">Sign in with an admin account</p>
    <form @submit.prevent="submit">
      <input v-model="email" type="email" placeholder="Email" autocomplete="username" required />
      <input v-model="password" type="password" placeholder="Password" autocomplete="current-password" required />
      <button type="submit" :disabled="loading">Sign in</button>
      <div class="error">{{ error }}</div>
    </form>
  </div>
</template>