<script setup lang="ts" generic="Step extends string">
import { ref, computed } from 'vue';

const props = defineProps<{
  steps: Step[];
  stepTitles: Record<Step, string>;
}>();

const emit = defineEmits<{
  (e: 'finish'): void;
  (e: 'cancel'): void;
}>();

const currentStepIndex = ref(0);
const currentStep = computed(() => props.steps[currentStepIndex.value]);
const isFirst = computed(() => currentStepIndex.value === 0);
const isLast = computed(() => currentStepIndex.value === props.steps.length - 1);
const progress = computed(() => ((currentStepIndex.value + 1) / props.steps.length) * 100);

function next() {
  if (currentStepIndex.value < props.steps.length - 1) {
    currentStepIndex.value++;
  }
}

function prev() {
  if (currentStepIndex.value > 0) {
    currentStepIndex.value--;
  }
}

function finish() {
  emit('finish');
}

function cancel() {
  emit('cancel');
}
</script>

<template>
  <div class="wizard">
    <div class="wizard-progress">
      <div class="wizard-progress-bar" :style="{ width: progress + '%' }"></div>
    </div>
    <div class="wizard-steps">
      <div
        v-for="(step, index) in steps"
        :key="step as string"
        :class="['wizard-step', { active: index === currentStepIndex, done: index < currentStepIndex }]"
      >
        <span class="step-number">{{ index + 1 }}</span>
        <span class="step-title">{{ stepTitles[step] }}</span>
      </div>
    </div>
    <div class="wizard-body">
      <slot :name="currentStep as string"></slot>
    </div>
    <div class="wizard-actions">
      <button class="btn" @click="cancel">Cancel</button>
      <div class="wizard-actions-right">
        <button v-if="!isFirst" class="btn" @click="prev">Back</button>
        <button v-if="!isLast" class="btn primary" @click="next">Next</button>
        <button v-else class="btn primary" @click="finish">Finish</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard { display: flex; flex-direction: column; height: 100%; padding: 16px; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #cccccc); }
.wizard-progress { height: 4px; background: var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 2px; margin-bottom: 16px; }
.wizard-progress-bar { height: 100%; background: var(--vscode-focusBorder, #007fd4); border-radius: 2px; transition: width 0.3s; }
.wizard-steps { display: flex; gap: 8px; margin-bottom: 16px; }
.wizard-step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground, #808080); }
.wizard-step.active { color: var(--vscode-focusBorder, #007fd4); }
.wizard-step.done { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
.step-number { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; background: var(--vscode-input-background, #3c3c3c); }
.wizard-step.active .step-number { background: var(--vscode-focusBorder, #007fd4); color: #fff; }
.wizard-step.done .step-number { background: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); color: #fff; }
.wizard-body { flex: 1; overflow-y: auto; padding: 8px 0; }
.wizard-actions { display: flex; justify-content: space-between; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.wizard-actions-right { display: flex; gap: 8px; }
.btn { padding: 4px 12px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
</style>