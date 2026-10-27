<script setup lang="ts">
import type { Copy } from '../lib/copy';
import { URLS } from '../lib/copy';
import { INSTALL_CMD, VERSION } from '../lib/copy';

defineProps<{ t: Copy }>();
</script>

<template>
  <section id="install" class="section">
    <div class="wrap">
      <h2>{{ t.install.title }}</h2>
      <p class="sub">{{ t.install.sub }}</p>
      <div class="install-row">
        <div class="install">
          <h4>
            {{ t.install.vsc.title }}
            <span :class="['tag', t.install.vsc.tagRec]">{{ t.install.vsc.tag }}</span>
          </h4>
          <p>{{ t.install.vsc.desc }}</p>
          <p><code>{{ INSTALL_CMD }}</code></p>
          <div class="btns">
            <a class="btn primary" :href="URLS.ext" target="_blank" rel="noopener noreferrer">
              {{ t.install.vsc.btn }}
            </a>
          </div>
        </div>
        <div class="install">
          <h4>
            {{ t.install.ovsx.title }}
            <span class="tag">{{ t.install.ovsx.tag }}</span>
          </h4>
          <p>{{ t.install.ovsx.desc }}</p>
          <p class="hint">VSCodium · Gitpod · Eclipse Theia</p>
          <div class="btns">
            <a class="btn ghost" :href="URLS.ovsx" target="_blank" rel="noopener noreferrer">
              {{ t.install.ovsx.btn }}
            </a>
          </div>
        </div>
        <div class="install">
          <h4>{{ t.install.vsix.title }}</h4>
          <p>{{ t.install.vsix.desc }}</p>
          <p class="hint">{{ t.install.vsix.size }}</p>
          <div class="btns">
            <a class="btn secondary" :href="URLS.releases" target="_blank" rel="noopener noreferrer">
              {{ t.install.vsix.btn }}
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.section {
  padding: 64px 0 40px;
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
.install-row {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}
.install {
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, var(--panel), var(--panel2));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.install h4 {
  margin: 0;
  font-size: 1.05rem;
  display: flex;
  align-items: center;
  gap: 8px;
}
.install .tag {
  font-size: 0.72rem;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--accent2);
}
.install .tag.rec {
  background: var(--accent);
  color: #fff;
  border-color: transparent;
}
.install p {
  margin: 0;
  color: var(--muted);
  font-size: 0.92rem;
}
.install .hint {
  color: var(--dim);
  font-size: 0.82rem;
}
.install code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--muted);
  border: 1px solid var(--line);
  display: inline-block;
  word-break: break-all;
}
.btns {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: auto;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 9px;
  font-weight: 600;
  font-size: 0.92rem;
  border: 1px solid var(--line);
  transition: transform 0.05s ease, border-color 0.15s ease, background 0.15s ease;
}
.btn:hover {
  transform: translateY(-1px);
}
.btn.primary {
  background: var(--accent);
  color: #fff;
  border-color: transparent;
}
.btn.primary:hover {
  background: var(--accent2);
}
.btn.ghost {
  color: var(--fg);
  background: rgba(11, 16, 32, 0.4);
}
.btn.ghost:hover {
  border-color: var(--accent);
}
.btn.secondary {
  color: var(--muted);
}
.btn.secondary:hover {
  color: var(--fg);
  border-color: var(--accent);
}
@media (max-width: 600px) {
  .section {
    padding: 48px 0 32px;
  }
}
</style>
