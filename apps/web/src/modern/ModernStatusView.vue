<script setup lang="ts">
import { computed, inject } from 'vue';

import { bootstrapStateKey } from '@/app/bootstrap/bootstrap-state';

const bootstrapState = inject(bootstrapStateKey);
const databaseStatus = computed(() => bootstrapState?.database.status ?? 'unavailable');
</script>

<template>
  <main class="modern-status">
    <section class="modern-status__card">
      <p class="modern-status__eyebrow">Pure Frontend Tavern</p>
      <h1>现代模块诊断入口</h1>
      <p>
        当前产品首页由原版 SillyTavern DOM、CSS 和交互脚本负责。此页面仅承载后续 Vue
        功能岛与基础设施诊断，不会复制或接管原版 DOM。
      </p>

      <dl class="modern-status__facts">
        <div>
          <dt>IndexedDB</dt>
          <dd :data-status="databaseStatus">{{ databaseStatus }}</dd>
        </div>
        <div>
          <dt>Legacy UI</dt>
          <dd>根路径运行</dd>
        </div>
        <div>
          <dt>可选后端</dt>
          <dd>当前未启用</dd>
        </div>
      </dl>

      <a class="modern-status__link" href="/">返回原版 UI</a>
    </section>
  </main>
</template>
