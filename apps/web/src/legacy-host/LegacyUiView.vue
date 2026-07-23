<script setup lang="ts">
import { onMounted, ref } from 'vue';

const legacyFrame = ref<HTMLIFrameElement | null>(null);
const legacyDocument = ref('');
const loadState = ref<'preparing' | 'loading' | 'ready' | 'error'>('preparing');
const legacyScriptState = ref<'pending' | 'removed' | 'unexpected-execution'>('pending');

function rewriteLegacyDocument(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  const base = document.querySelector('base') ?? document.createElement('base');
  base.setAttribute('href', '/legacy/');
  if (!base.isConnected) document.head.prepend(base);

  document.querySelectorAll('script').forEach((script) => script.remove());
  legacyScriptState.value = 'removed';

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

async function prepareLegacyUi() {
  try {
    const response = await fetch('/legacy/index.html');
    if (!response.ok) {
      throw new Error(`Legacy index request failed with HTTP ${response.status}.`);
    }

    legacyDocument.value = rewriteLegacyDocument(await response.text());
    loadState.value = 'loading';
  } catch (error) {
    loadState.value = 'error';
    console.error('Unable to prepare the Legacy UI static preview.', error);
  }
}

function revealStaticLegacyUi() {
  const frame = legacyFrame.value;
  const document = frame?.contentDocument;
  const legacyWindow = frame?.contentWindow;
  if (!document || !legacyWindow) {
    loadState.value = 'error';
    return;
  }

  if (Reflect.has(legacyWindow, 'jQuery')) {
    legacyScriptState.value = 'unexpected-execution';
    loadState.value = 'error';
    console.error('Legacy sandbox violation: jQuery executed inside the static UI preview.');
    return;
  }

  document.documentElement.dataset.pureTavernLegacyMode = 'static-preview';
  document.getElementById('preloader')?.style.setProperty('display', 'none', 'important');
  loadState.value = 'ready';
}

onMounted(prepareLegacyUi);
</script>

<template>
  <main
    class="legacy-host"
    :data-load-state="loadState"
    :data-legacy-script-state="legacyScriptState"
  >
    <iframe
      v-if="legacyDocument"
      ref="legacyFrame"
      class="legacy-host__frame"
      title="SillyTavern 1.18.0 Legacy UI static preview"
      :srcdoc="legacyDocument"
      sandbox="allow-same-origin"
      @load="revealStaticLegacyUi"
      @error="loadState = 'error'"
    />
    <div v-if="loadState === 'preparing' || loadState === 'loading'" class="legacy-host__status">
      正在载入 Legacy UI…
    </div>
    <div v-else-if="loadState === 'error'" class="legacy-host__status legacy-host__status--error">
      Legacy UI 静态资源载入失败，请查看浏览器控制台。
    </div>
  </main>
</template>
