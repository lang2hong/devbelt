<script setup lang="ts">
import type { Copy } from '../lib/copy';
import { URLS } from '../lib/copy';

defineProps<{ t: Copy; loggedIn: boolean }>();
const emit = defineEmits<{ (e: 'switch-locale'): void }>();
</script>

<template>
  <header class="top">
    <div class="wrap inner">
      <router-link class="brand" :to="t.htmlLang === 'en' ? '/en' : '/'">
        <span class="brand-dot" />
        DevBelt
      </router-link>
      <span class="spacer" />
      <nav>
        <router-link class="primary-link" :to="(t.htmlLang === 'en' ? '/en' : '/') + '#install'">{{ t.nav.install }}</router-link>
        <a :href="URLS.docs">{{ t.nav.docs }}</a>
        <a :href="URLS.github" target="_blank" rel="noopener noreferrer">{{ t.nav.github }}</a>
        <router-link :to="(t.htmlLang === 'en' ? '/en' : '/') + '#features'">{{ t.nav.features }}</router-link>
        <a :href="URLS.plans">{{ t.nav.plans }}</a>
        <span class="sep" />
        <button class="lang" type="button" @click="emit('switch-locale')">{{ t.nav.langSwitch }}</button>
        <span class="sep" />
        <template v-if="loggedIn">
          <a class="console" :href="URLS.console">{{ t.nav.console }}</a>
        </template>
        <template v-else>
          <a :href="URLS.login">{{ t.nav.login }}</a>
        </template>
      </nav>
    </div>
  </header>
</template>

<style scoped>
.top {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(11, 16, 32, 0.75);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 24px;
}
@media (max-width: 600px) {
  .inner {
    padding: 14px 18px;
  }
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 1.1rem;
  letter-spacing: -0.01em;
  color: inherit;
}
.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.spacer {
  flex: 1;
}
nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
nav a,
nav button {
  color: var(--muted);
  background: transparent;
  border: none;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 0.92rem;
  cursor: pointer;
  font-family: inherit;
}
nav a:hover,
nav button:hover {
  color: var(--fg);
  background: var(--panel);
}
nav a.cta,
nav a.console {
  color: #fff;
  background: var(--accent);
}
nav a.cta:hover,
nav a.console:hover {
  background: var(--accent2);
}
nav .lang {
  border: 1px solid var(--line);
  padding: 5px 10px;
}
.sep {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 6px;
}
@media (max-width: 600px) {
  nav a,
  nav button {
    padding: 5px 8px;
    font-size: 0.86rem;
  }
  .sep {
    display: none;
  }
}
</style>
