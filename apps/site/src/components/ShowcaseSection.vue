<script setup lang="ts">
import type { Copy } from '../lib/copy';

defineProps<{ t: Copy }>();
</script>

<template>
  <section id="showcase" class="section">
    <div class="wrap">
      <h2>{{ t.showcase.title }}</h2>
      <p class="sub">{{ t.showcase.sub }}</p>
      <div class="showcase">
        <div v-for="(s, i) in t.showcase.items" :key="i" :class="['ss', { reverse: s.reverse }]">
          <div class="text">
            <h3>{{ s.title }}</h3>
            <p v-for="(p, j) in s.paras" :key="j">{{ p }}</p>
            <ul>
              <li v-for="(b, k) in s.bullets" :key="k">{{ b }}</li>
            </ul>
          </div>
          <div class="shot">
            <img :src="s.img" :alt="s.alt" :loading="i === 0 ? 'eager' : 'lazy'" width="1600" height="920" />
          </div>
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
.showcase {
  display: grid;
  gap: 56px;
}
.ss {
  display: grid;
  gap: 28px;
  align-items: center;
  grid-template-columns: 1fr;
}
.ss .text h3 {
  margin: 0 0 10px;
  font-size: 1.4rem;
  letter-spacing: -0.01em;
}
.ss .text p {
  color: var(--muted);
  margin: 0 0 12px;
}
.ss .text ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.ss .text li {
  color: var(--muted);
  font-size: 0.93rem;
  padding: 5px 0 5px 22px;
  position: relative;
}
.ss .text li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 13px;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--accent);
  transform: rotate(45deg);
}
.ss .shot {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--panel);
  box-shadow: var(--shadow-card);
}
@media (min-width: 860px) {
  .ss {
    grid-template-columns: 5fr 6fr;
    gap: 48px;
  }
  .ss.reverse {
    grid-template-columns: 6fr 5fr;
  }
  .ss.reverse .shot {
    order: -1;
  }
}
@media (max-width: 600px) {
  .section {
    padding: 48px 0;
  }
  .showcase {
    gap: 40px;
  }
}
</style>
