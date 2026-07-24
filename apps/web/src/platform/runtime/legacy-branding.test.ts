import { afterEach, describe, expect, it } from 'vitest';

import { formatLegacyBrandVersion, installLegacyBranding } from './legacy-branding';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('Legacy branding runtime', () => {
  it('formats the product name while retaining the upstream version', () => {
    expect(formatLegacyBrandVersion('1.18.0')).toBe('PureTavern (SillyTavern 1.18.0)');
    expect(formatLegacyBrandVersion('  ')).toBe('PureTavern');
  });

  it('brands existing and dynamically rendered Legacy welcome elements', async () => {
    document.title = 'SillyTavern';
    document.body.innerHTML = `
      <span id="version_display">SillyTavern 1.18.0</span>
      <img class="splash-logo" src="/img/logo.png" alt="SillyTavern" data-i18n="[alt]SillyTavern Logo">
    `;
    const dispose = installLegacyBranding(Promise.resolve({ version: '1.18.0' }));
    await flushMutationObserver();

    expect(document.title).toBe('PureTavern');
    expect(document.getElementById('version_display')?.textContent).toBe(
      'PureTavern (SillyTavern 1.18.0)',
    );
    const splash = document.querySelector<HTMLImageElement>('.splash-logo');
    expect(splash?.alt).toBe('PureTavern Logo');
    expect(splash?.getAttribute('aria-label')).toBe('PureTavern Logo');
    expect(splash?.hasAttribute('data-i18n')).toBe(false);

    const panel = document.createElement('div');
    panel.innerHTML = `
      <img class="welcomeHeaderLogo" src="img/logo.png" alt="SillyTavern Logo" data-i18n="[alt]SillyTavern Logo">
      <span class="welcomeHeaderVersionDisplay">SillyTavern 1.18.0 'legacy-hook' (local)</span>
    `;
    document.body.append(panel);
    await flushMutationObserver();

    expect(panel.querySelector('.welcomeHeaderVersionDisplay')?.textContent).toBe(
      'PureTavern (SillyTavern 1.18.0)',
    );
    const logo = panel.querySelector<HTMLImageElement>('.welcomeHeaderLogo');
    expect(new URL(logo?.src ?? '', window.location.href).pathname).toBe('/img/logo.png');
    expect(logo?.alt).toBe('PureTavern Logo');
    expect(logo?.hasAttribute('data-i18n')).toBe(false);
    dispose();
  });
});

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
