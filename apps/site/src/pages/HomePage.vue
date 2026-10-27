<script setup lang="ts">
import Hero from '../components/Hero.vue';
import FeatureGrid from '../components/FeatureGrid.vue';
import ShowcaseSection from '../components/ShowcaseSection.vue';
import WhatsNew from '../components/WhatsNew.vue';
import InstallSection from '../components/InstallSection.vue';
import type { Copy } from '../lib/copy';

defineProps<{ t: Copy; loggedIn: boolean }>();
</script>

<template>
  <main>
    <Hero :t="t" :logged-in="loggedIn" />
    <FeatureGrid :t="t" />
    <ShowcaseSection :t="t" />
    <WhatsNew :t="t" />
    <InstallSection :t="t" />
  </main>
</template>
