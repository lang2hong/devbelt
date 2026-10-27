<script setup lang="ts">
import type { Copy } from '../lib/copy';

defineProps<{ t: Copy }>();
</script>

<template>
  <section id="features" class="section">
    <div class="wrap">
      <h2>{{ t.features.title }}</h2>
      <p class="sub">{{ t.features.sub }}</p>
      <div class="feature-grid">
        <div v-for="f in t.features.items" :key="f.title" class="feature">
          <h3>
            <span class="icon">{{ f.icon }}</span>
            {{ f.title }}
          </h3>
          <p>{{ f.desc }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section {
  padding: 64px 0;
  border-top: 1px solid var(--line);
}
h2 {
  font-size: clamp(1.5rem, 2.6vw, 2rem);
  margin: 0 0 10px;
  letter-spacing: -0.02em;
}
.sub {
  color: var(--muted);
  font-size: 1.02rem;
  margin: 0 0 36px;
  max-width: 720px;
}
.feature-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
.feature {
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, var(--panel), var(--panel2));
}
.feature h3 {
  margin: 0 0 8px;
  font-size: 1.08rem;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.feature .icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(61, 107, 255, 0.14);
  color: var(--accent2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  flex-shrink: 0;
  font-weight: 700;
}
.feature p {
  margin: 0;
  color: var(--muted);
  font-size: 0.93rem;
}
@media (max-width: 600px) {
  .section {
    padding: 48px 0;
  }
}
</style>
