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
import AuditView from './components/AuditView.vue';

const me = ref<UserInfo | null>(null);
const activeTab = ref<'users' | 'subs' | 'plans' | 'traffic' | 'limits' | 'audit'>('users');

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

/**
 * 登出必须撤销服务端会话，不能只清 localStorage。
 *
 * 只清前端的话，签发这个 access token 的 refresh token 行在服务端仍然有效
 * （默认 90 天），会话也照样出现在 /sessions 列表里。共享电脑或临时借用的
 * 机器上，"退出"之后凭据其实还活着 —— 这不是登出，只是把界面藏起来。
 *
 * 后台不持有 refresh token（放进浏览器存储只会把 15 分钟的泄露窗口扩成
 * 90 天），所以不传 refreshToken；服务端以 access token 里的 sid 为权威判据
 * 撤销当前会话。
 *
 * 请求失败也要清本地状态：网络断了、服务端挂了都不该让用户卡在已登录界面。
 * 代价是那种情况下服务端会话仍在 —— 但这是「尽力而为」与「完全不做」的区别。
 */
async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch {
    // 忽略：本地状态无论如何都要清掉
  }
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
        <button :class="{ active: activeTab === 'audit' }" @click="activeTab = 'audit'">Audit</button>
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
      <!-- v-if：留痕列表每次进来都该拉最新的，不该显示上次打开时的快照 -->
      <AuditView v-if="activeTab === 'audit'" />
    </main>
  </div>
</template>