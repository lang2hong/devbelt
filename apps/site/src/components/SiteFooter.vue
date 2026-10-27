<script setup lang="ts">
import type { Copy } from '../lib/copy';
import { URLS } from '../lib/copy';
import { VERSION } from '../lib/copy';

defineProps<{ t: Copy }>();
const emit = defineEmits<{ (e: 'switch-locale'): void }>();
</script>

<template>
  <footer class="footer">
    <div class="wrap fgrid">
      <div class="brand-col">
        <div class="brand">
          <span class="brand-dot" />
          DevBelt
        </div>
        <p class="tagline">{{ t.footer.tagline }}</p>
        <div class="ver">{{ t.footer.ver(VERSION) }}</div>
      </div>
      <div>
        <h5>{{ t.footer.productHead }}</h5>
        <ul>
          <li>
            <router-link :to="(t.htmlLang === 'en' ? '/en' : '/') + '#features'">{{ t.footer.product.features }}</router-link>
          </li>
          <li>
            <router-link :to="(t.htmlLang === 'en' ? '/en' : '/') + '#new'">{{ t.footer.product.new }}</router-link>
          </li>
          <li><a :href="URLS.plans">{{ t.footer.product.plans }}</a></li>
        </ul>
      </div>
      <div>
        <h5>{{ t.footer.resourcesHead }}</h5>
        <ul>
          <li><a :href="URLS.docs">{{ t.footer.resources.docs }}</a></li>
          <li>
            <a :href="URLS.changelog" target="_blank" rel="noopener noreferrer">{{ t.footer.resources.changelog }}</a>
          </li>
          <li>
            <a :href="URLS.github" target="_blank" rel="noopener noreferrer">{{ t.footer.resources.github }}</a>
          </li>
        </ul>
      </div>
      <div>
        <h5>{{ t.footer.getHead }}</h5>
        <ul>
          <li>
            <a :href="URLS.ext" target="_blank" rel="noopener noreferrer">{{ t.footer.get.vsc }}</a>
          </li>
          <li>
            <a :href="URLS.ovsx" target="_blank" rel="noopener noreferrer">{{ t.footer.get.ovsx }}</a>
          </li>
        </ul>
      </div>
      <div class="legal">
        <span>{{ t.footer.rights }} · {{ t.footer.license }}</span>
        <span><button type="button" @click="emit('switch-locale')">{{ t.nav.langSwitch }}</button></span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  color: var(--muted);
  font-size: 0.88rem;
  padding: 36px 0 48px;
  border-top: 1px solid var(--line);
  margin-top: 24px;
}
.fgrid {
  display: flex;
  flex-wrap: wrap;
  gap: 24px 48px;
  justify-content: space-between;
  align-items: flex-start;
}
.brand-col {
  min-width: 240px;
  flex: 1 1 280px;
}
.brand {
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--fg);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.tagline {
  margin: 4px 0 0;
  color: var(--dim);
  font-size: 0.86rem;
  max-width: 320px;
}
.ver {
  font-size: 0.78rem;
  color: var(--dim);
  margin-top: 10px;
}
h5 {
  margin: 0 0 8px;
  color: var(--dim);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
ul a,
.legal button {
  color: var(--muted);
  text-decoration: none;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 0.88rem;
  cursor: pointer;
  font-family: inherit;
}
ul a:hover,
.legal button:hover {
  color: var(--fg);
}
.legal {
  width: 100%;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  margin-top: 24px;
  font-size: 0.82rem;
  color: var(--dim);
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
