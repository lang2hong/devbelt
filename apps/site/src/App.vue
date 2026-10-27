<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import NavHeader from './components/NavHeader.vue';
import SiteFooter from './components/SiteFooter.vue';
import { setLocale, detectLocaleFromPath } from './lib/locale';
import { t } from './lib/locale';

const route = useRoute();
const router = useRouter();

function applyLocaleFromPath(path: string) {
  const l = detectLocaleFromPath(path);
  setLocale(l);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
    const title = l === 'en'
      ? 'DevBelt — Database development inside VS Code'
      : 'DevBelt — 在 VS Code 内完成数据库开发';
    document.title = title;
  }
}

applyLocaleFromPath(route.fullPath);

watch(
  () => route.fullPath,
  (p) => applyLocaleFromPath(p),
);

onMounted(() => {
  // read server-injected state (currently only loggedIn; future meta goes here)
  const state = (window as unknown as { __INITIAL_STATE__?: { loggedIn?: boolean } }).__INITIAL_STATE__;
  if (state && typeof state.loggedIn === 'boolean') {
    loggedIn.value = state.loggedIn;
  }
});

import { ref } from 'vue';
const loggedIn = ref(false);

function switchLocale() {
  const cur = route.meta.locale as string | undefined;
  if (cur === 'en') {
    router.push('/');
  } else {
    router.push('/en');
  }
}
</script>

<template>
  <div class="page">
    <NavHeader :logged-in="loggedIn" :t="t" @switch-locale="switchLocale" />
    <router-view :t="t" :logged-in="loggedIn" />
    <SiteFooter :t="t" @switch-locale="switchLocale" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
:deep(section:last-of-type) {
  flex: 1;
}
</style>
