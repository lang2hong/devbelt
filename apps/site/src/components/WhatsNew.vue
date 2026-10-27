<script setup lang="ts">
import type { Copy } from '../lib/copy';
import { URLS } from '../lib/copy';

defineProps<{ t: Copy }>();
</script>

<template>
  <section id="new" class="section">
    <div class="wrap">
      <div class="whatsnew">
        <h3>
          <span class="badge">{{ t.news.badge }}</span>
          {{ t.news.title }}
        </h3>
        <ul>
          <li v-for="(n, i) in t.news.items" :key="i">
            <strong>{{ n.h }}{{ t.news.colon }}</strong>{{ n.t }}
          </li>
        </ul>
        <p class="more">
          <a class="btn ghost" :href="URLS.changelog" target="_blank" rel="noopener noreferrer">
            {{ t.news.changelog }}
          </a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section {
  padding: 32px 0 64px;
  border-top: 1px solid var(--line);
}
.whatsnew {
  padding: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  background: linear-gradient(180deg, rgba(61, 107, 255, 0.08), rgba(58, 210, 154, 0.05));
}
.whatsnew h3 {
  margin: 0 0 14px;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  gap: 10px;
}
.whatsnew .badge {
  font-size: 0.72rem;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
}
.whatsnew ul {
  margin: 0;
  padding-left: 20px;
  color: var(--muted);
}
.whatsnew ul li {
  padding: 4px 0;
}
.whatsnew ul li strong {
  color: var(--fg);
  font-weight: 600;
}
.more {
  margin: 18px 0 0;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-radius: 10px;
  font-weight: 600;
  font-size: 0.94rem;
  border: 1px solid var(--line);
  color: var(--fg);
  background: rgba(19, 26, 48, 0.5);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.btn:hover {
  border-color: var(--accent);
}
@media (max-width: 600px) {
  .section {
    padding: 24px 0 48px;
  }
  .whatsnew {
    padding: 22px;
  }
}
</style>
