<script setup lang="ts">
import type { Copy } from '../lib/copy';
import { URLS } from '../lib/copy';
import { INSTALL_CMD } from '../lib/copy';

defineProps<{ t: Copy; loggedIn: boolean }>();
</script>

<template>
  <section class="hero">
    <div class="wrap">
      <div class="eyebrow">
        <span class="v">{{ t.hero.eyebrowLabel }}</span>
        <span>· {{ t.hero.eyebrowDesc }}</span>
      </div>
      <h1 v-html="t.hero.h1Html" />
      <p class="lead">{{ t.hero.lead }}</p>
      <div class="cta">
        <template v-if="loggedIn">
          <a class="btn primary" :href="URLS.console">{{ t.hero.primaryConsole }}</a>
          <a class="btn ghost" :href="URLS.docs">{{ t.hero.secondary }}</a>
        </template>
        <template v-else>
          <a class="btn primary" :href="URLS.ext" target="_blank" rel="noopener noreferrer">{{ t.hero.primary }}</a>
          <a class="btn ghost" :href="URLS.docs">{{ t.hero.secondary }}</a>
        </template>
      </div>
    </div>
    <figure class="hero-shot">
      <img
        src="/screenshots/01-sql-workbench-focus.png"
        :alt="t.hero.alt"
        loading="eager"
        width="1600"
        height="360"
      />
    </figure>
    <div class="wrap">
      <p class="hero-caption">{{ t.hero.caption }}</p>
      <p class="cmd">
        <code>{{ INSTALL_CMD }}</code>
      </p>
    </div>
  </section>
</template>

<style scoped>
.hero {
  padding: 72px 0 36px;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--muted);
  margin-bottom: 18px;
}
.eyebrow .v {
  color: var(--accent2);
  font-weight: 600;
}
.hero h1 {
  font-size: clamp(2.1rem, 4.6vw, 3.4rem);
  line-height: 1.15;
  margin: 0 0 16px;
  letter-spacing: -0.03em;
  max-width: 880px;
}
.hero h1 :deep(.accent) {
  background: linear-gradient(135deg, var(--accent), var(--accent2) 60%, var(--ok));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lead {
  color: var(--muted);
  font-size: 1.12rem;
  max-width: 720px;
  margin: 0 0 28px;
}
.cta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: 10px;
  font-weight: 600;
  font-size: 0.96rem;
  transition: transform 0.05s ease, border-color 0.15s ease, background 0.15s ease;
  border: 1px solid transparent;
}
.btn:hover {
  transform: translateY(-1px);
}
.btn.primary {
  background: var(--accent);
  color: #fff;
}
.btn.primary:hover {
  background: var(--accent2);
}
.btn.ghost {
  border-color: var(--line);
  color: var(--fg);
  background: rgba(19, 26, 48, 0.5);
}
.btn.ghost:hover {
  border-color: var(--accent);
}
.hero-shot {
  width: min(1400px, calc(100% - 48px));
  margin: 8px auto 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  overflow: hidden;
  box-shadow: var(--shadow-hero);
  background: var(--panel);
}
.hero-shot img {
  width: 100%;
  height: auto;
  display: block;
}
.hero-caption {
  color: var(--dim);
  font-size: 0.85rem;
  margin-top: 10px;
  text-align: center;
}
.cmd {
  text-align: center;
  margin: 14px 0 0;
}
.cmd code {
  font-family: var(--font-mono);
  background: var(--panel);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.88rem;
  color: var(--muted);
  border: 1px solid var(--line);
  display: inline-block;
}
@media (max-width: 600px) {
  .hero {
    padding: 44px 0 24px;
  }
}
</style>
