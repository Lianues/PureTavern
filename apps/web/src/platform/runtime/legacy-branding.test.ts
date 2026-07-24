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
      <a id="github-link" href="https://github.com/SillyTavern/SillyTavern">GitHub</a>
      <a id="discord-link" href="https://discord.gg/sillytavern">Discord</a>
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
    expect(splash?.getAttribute('data-i18n')).toBe('[alt]PureTavern Logo');
    expect(document.querySelector<HTMLAnchorElement>('#github-link')?.href).toBe(
      'https://github.com/Lianues/PureTavern',
    );
    expect(document.querySelector<HTMLAnchorElement>('#discord-link')?.href).toBe(
      'https://discord.gg/w5kB9ahuFA',
    );

    const panel = document.createElement('div');
    panel.innerHTML = `
      <img class="welcomeHeaderLogo" src="img/logo.png" alt="SillyTavern Logo" data-i18n="[alt]SillyTavern Logo">
      <span class="welcomeHeaderVersionDisplay">SillyTavern 1.18.0 'legacy-hook' (local)</span>
      <a class="dynamic-github-link" href="https://github.com/SillyTavern/SillyTavern/">GitHub</a>
      <a class="dynamic-discord-link" href="https://discord.gg/sillytavern/">Discord</a>
    `;
    document.body.append(panel);
    await flushMutationObserver();

    expect(panel.querySelector('.welcomeHeaderVersionDisplay')?.textContent).toBe(
      'PureTavern (SillyTavern 1.18.0)',
    );
    const logo = panel.querySelector<HTMLImageElement>('.welcomeHeaderLogo');
    expect(new URL(logo?.src ?? '', window.location.href).pathname).toBe('/img/logo.png');
    expect(logo?.alt).toBe('PureTavern Logo');
    expect(logo?.getAttribute('data-i18n')).toBe('[alt]PureTavern Logo');
    expect(panel.querySelector<HTMLAnchorElement>('.dynamic-github-link')?.href).toBe(
      'https://github.com/Lianues/PureTavern',
    );
    expect(panel.querySelector<HTMLAnchorElement>('.dynamic-discord-link')?.href).toBe(
      'https://discord.gg/w5kB9ahuFA',
    );
    dispose();
  });
});

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
