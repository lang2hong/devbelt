<script setup lang="ts">
import type { Copy } from '../lib/copy';

defineProps<{ t: Copy }>();
</script>

<template>
  <section id="showcase" class="section">
    <div class="wrap">
      <h2>{{ t.showcase.title }}</h2>
      <p class="sub">{{ t.showcase.sub }}</p>
    </div>
    <div class="showcase">
      <article v-for="(s, i) in t.showcase.items" :key="i" class="ss">
        <div class="wrap">
          <div class="text">
            <h3>{{ s.title }}</h3>
            <p v-for="(p, j) in s.paras" :key="j">{{ p }}</p>
            <ul>
              <li v-for="(b, k) in s.bullets" :key="k">{{ b }}</li>
            </ul>
          </div>
        </div>
        <figure class="shot">
          <img
            :src="s.img"
            :alt="s.alt"
            :width="s.w"
            :height="s.h"
            :loading="i === 0 ? 'eager' : 'lazy'"
          />
        </figure>
      </article>
    </div>
  </section>
</template>

<style scoped>
.section {
  padding: 64px 0 24px;
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
  margin: 0 0 44px;
  max-width: 720px;
}

.showcase {
  display: grid;
  gap: 64px;
}

/* 图文上下排列：文字与正文同宽，截图出血到 ~1400px 以保证可读性 */
.ss .text h3 {
  margin: 0 0 10px;
  font-size: 1.4rem;
  letter-spacing: -0.01em;
}
.ss .text p {
  color: var(--muted);
  margin: 0 0 12px;
  max-width: 820px;
}
.ss .text ul {
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
  display: grid;
  gap: 4px 24px;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  max-width: 900px;
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

/* 截图：比正文宽，居中；宽度随视口收缩，永不溢出 */
.ss .shot {
  width: min(1400px, calc(100% - 48px));
  margin: 22px auto 0;
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  box-shadow: 0 16px 50px -22px rgba(0, 0, 0, 0.7);
}
.ss .shot img {
  width: 100%;
  height: auto;
  display: block;
}

@media (max-width: 600px) {
  .section {
    padding: 48px 0 16px;
  }
  .showcase {
    gap: 48px;
  }
  .ss .shot {
    width: calc(100% - 36px);
    margin-top: 16px;
    border-radius: 12px;
  }
  .ss .text ul {
    grid-template-columns: 1fr;
  }
}
</style>