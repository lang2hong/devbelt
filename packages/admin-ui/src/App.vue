<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api, onUnauthorized, getToken, setToken } from './lib/api';
import type { MeResponse, UserInfo } from './types';
import LoginView from './components/LoginView.vue';
import UsersView from './components/UsersView.vue';
import SubscriptionsView from './components/SubscriptionsView.vue';
import PlansView from './components/PlansView.vue';
import TrafficView from './components/TrafficView.vue';
import RateLimitView from './components/RateLimitView.vue';

const me = ref<UserInfo | null>(null);
const activeTab = ref<'users' | 'subs' | 'plans' | 'traffic' | 'limits'>('users');

onUnauthorized(() => {
  me.value = null;
});

onMounted(async () => {
  if (!getToken()) return;
  try {
    const r = await api<MeResponse>('/api/me');
    if (r.user && r.user.role === 'admin') me.value = r.user;
    else setToken(null);
  } catch (e) {
    setToken(null);
  }
});

function onLoggedIn(user: UserInfo) {
  me.value = user;
}

function logout() {
  setToken(null);
  me.value = null;
}
</script>

<template>
  <LoginView v-if="!me" @logged-in="onLoggedIn" />
  <div v-else>
    <header>
      <span class="brand">DB Client Admin</span>
      <nav>
        <button :class="{ active: activeTab === 'users' }" @click="activeTab = 'users'">Users</button>
        <button :class="{ active: activeTab === 'subs' }" @click="activeTab = 'subs'">Subscriptions</button>
        <button :class="{ active: activeTab === 'plans' }" @click="activeTab = 'plans'">Plans</button>
        <button :class="{ active: activeTab === 'traffic' }" @click="activeTab = 'traffic'">Traffic</button>
        <button :class="{ active: activeTab === 'limits' }" @click="activeTab = 'limits'">Limits</button>
      </nav>
      <span class="whoami">{{ me.email }}</span>
      <button id="logout" @click="logout">Logout</button>
    </header>
    <main>
      <UsersView v-show="activeTab === 'users'" />
      <SubscriptionsView v-show="activeTab === 'subs'" />
      <PlansView v-show="activeTab === 'plans'" />
      <!--
        这两个用 v-if 而不是 v-show：TrafficView 挂载即请求，而且开了 auto
        还会起定时器。用 v-show 的话切到别的标签页它仍在后台轮询。
      -->
      <TrafficView v-if="activeTab === 'traffic'" />
      <RateLimitView v-if="activeTab === 'limits'" />
    </main>
  </div>
</template>