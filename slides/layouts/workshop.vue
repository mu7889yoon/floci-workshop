<script setup lang="ts">
import { computed } from 'vue'
import { useNav } from '@slidev/client/composables/useNav.ts'

const nav = useNav()
const hasWorkbench = computed(() => nav.currentFrontmatter.value.exercise === 'basic' || nav.currentFrontmatter.value.exercise === 'advanced')
</script>

<template>
  <div class="slidev-layout workshop-layout" :class="{ 'has-workbench': hasWorkbench, 'title-slide': nav.currentPage.value === 1 }">
    <main class="workshop-copy" :class="{ compact: hasWorkbench }">
      <slot />
    </main>
  </div>
</template>

<style>
.slidev-layout.workshop-layout {
  --yoon-font-title: 42px;
  --yoon-font-large: 40px;
  --yoon-font-medium: 35px;
  --yoon-font-body: 29px;
  --yoon-font-small: 24px;
  --yoon-font-caption: 22px;
  --yoon-font-note: 18px;
  display: block;
  height: 100%;
  padding: 0;
  overflow: hidden;
  isolation: isolate;
  color: #1a1a1a;
  background-color: #fafafa;
  background-image:
    repeating-linear-gradient(0deg, rgba(26, 26, 26, 0.04) 0 1px, transparent 1px 45.94px),
    repeating-linear-gradient(90deg, rgba(26, 26, 26, 0.04) 0 1px, transparent 1px 45.94px),
    radial-gradient(circle at 85% 20%, rgba(51, 51, 51, 0.12) 0 153px, transparent 154px),
    radial-gradient(circle at 10% 80%, rgba(51, 51, 51, 0.12) 0 115px, transparent 116px),
    linear-gradient(135deg, #fafafa, #f0f0f0);
}

.slidev-layout.workshop-layout::before {
  position: absolute;
  z-index: 40;
  inset: 0 0 auto;
  height: 4.59px;
  background: linear-gradient(90deg, #333 0%, #333 50%, transparent 100%);
  content: "";
  pointer-events: none;
}

.workshop-copy {
  position: absolute;
  inset: 0 0 auto;
  height: 100%;
  overflow: auto;
  padding: 7.81% 4.69% 3%;
  color: #1a1a1a;
}

.workshop-copy.compact {
  height: 40%;
  overflow: hidden;
  padding: 1.4% 3.2% 0.7%;
}

.workshop-copy h1 {
  margin: 0 0 4.59px;
  color: #1a1a1a;
  font-size: var(--yoon-font-title);
  line-height: 1.15;
  font-weight: 600;
}

.workshop-layout:not(.title-slide) .workshop-copy:not(.compact) > h1:first-child {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  width: 100%;
  height: 80px;
  margin: 0;
  padding-left: 40px;
}

.workshop-copy h2 {
  font-size: var(--yoon-font-large);
  line-height: 1.15;
}

.workshop-copy h3 {
  font-size: var(--yoon-font-medium);
  line-height: 1.21;
}

.workshop-copy h1 + p {
  margin: 0 0 6.13px;
  color: inherit;
  font-size: var(--yoon-font-body);
  line-height: 1.5;
  opacity: 1;
}

.workshop-copy > p,
.workshop-copy li {
  color: #1a1a1a;
  font-size: var(--yoon-font-body);
  line-height: 1.5;
}

.workshop-copy > p {
  margin: 0 0 6.13px;
}

.workshop-copy ul,
.workshop-copy ol {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2em 2em;
  margin: 0.65em 0 0;
  padding-left: 1.1em;
}

.workshop-copy li {
  margin: 0;
  padding-left: 0.15em;
}

.workshop-copy .flow-line {
  margin: 1.05em 0 0.75em;
  padding: 0.7em 0;
  border-top: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-bottom: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  font-size: var(--yoon-font-small);
  font-family: var(--slidev-code-font-family);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.workshop-copy .supporting {
  font-size: var(--yoon-font-note);
  opacity: 0.7;
}

.workshop-copy .source-line {
  margin-top: 1em;
  color: #666;
  font-size: var(--yoon-font-note);
  opacity: 1;
}

.workshop-copy a {
  color: #333;
  text-decoration-color: #999;
  text-underline-offset: 0.12em;
}

.slidev-layout.workshop-layout .workshop-copy :not(pre) > code {
  padding: 0.08em 0.28em;
  border-radius: 0.2em;
  color: #1a1a1a !important;
  background-color: #e6e6e6 !important;
}

.workshop-copy pre {
  font-size: var(--yoon-font-small);
  border: 1px solid #d6d6d6;
  border-radius: 8px;
  background: #e6e6e6;
}

.workshop-copy .command-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 1.3em 0;
  font-size: var(--yoon-font-small);
}

.workshop-copy .command-flow code {
  padding: 0.45em 0.7em;
  border-radius: 0.35em;
  border: 1px solid #d6d6d6;
  color: #1a1a1a;
  background: #e6e6e6;
}

.workshop-copy .architecture {
  margin: 1.4em 0 1.2em;
  padding: 1.2em 1em;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 0.7em;
  background: color-mix(in srgb, currentColor 3%, transparent);
}

.workshop-copy .architecture-main {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 0.3em;
}

.workshop-copy .service {
  min-width: 0;
  flex: 1;
  padding: 0.55em 0.35em;
  border: 1px solid color-mix(in srgb, currentColor 23%, transparent);
  border-radius: 0.5em;
  font-size: 0.9em;
  font-weight: 700;
  text-align: center;
}

.workshop-copy .service small {
  font-size: 0.75em;
  font-weight: 400;
  opacity: 0.75;
}

.workshop-copy .arrow {
  color: #333;
  flex: 0 0 auto;
  font-size: var(--yoon-font-small);
  font-weight: 700;
}

.workshop-copy .architecture-note {
  margin-top: 0.9em;
  color: color-mix(in srgb, currentColor 75%, transparent);
  font-size: var(--yoon-font-note);
  text-align: center;
}

.workshop-copy.compact h1 {
  margin-bottom: 0.25em;
  font-size: var(--yoon-font-title);
}

.workshop-copy.compact h1 + p,
.workshop-copy.compact > p {
  margin: 0.25em 0;
  font-size: 23px;
  line-height: 1.3;
}

.workshop-layout.title-slide .workshop-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 15.31px;
  padding: 10.94% 4.69%;
  text-align: left;
}

.slidev-layout.workshop-layout.title-slide {
  background-image:
    radial-gradient(circle at 85% 20%, rgba(51, 51, 51, 0.12) 0 168px, transparent 169px),
    radial-gradient(circle at 10% 80%, rgba(51, 51, 51, 0.12) 0 122px, transparent 123px),
    linear-gradient(135deg, #fafafa, #f0f0f0);
}

.workshop-layout.title-slide .workshop-copy h1 {
  position: static;
  width: 100%;
  margin: 0;
  font-size: 56px;
  line-height: 1.12;
  font-weight: 700;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.workshop-layout.title-slide .workshop-copy h2 {
  margin: 0;
  font-size: 30px;
  line-height: 1.3;
  font-weight: 500;
}

.workshop-layout.title-slide .workshop-copy > p {
  margin: 6.13px 0 0;
  color: #666;
  font-size: var(--yoon-font-small);
}

@media (max-height: 720px) {
  .workshop-copy { padding-top: 7.81%; }
  .workshop-copy.compact { padding-top: 1.4%; }
}
</style>
