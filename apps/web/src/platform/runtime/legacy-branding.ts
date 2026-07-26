import { APP_VERSION } from './app-version';

const PRODUCT_NAME = 'PureTavern';
const UPSTREAM_NAME = 'SillyTavern';
const VERSION_SELECTORS = [
  '.welcomeHeaderVersionDisplay',
  '#version_display',
  '#version_display_welcome',
].join(',');
const LOGO_SELECTORS = ['.welcomeHeaderLogo', '.splash-logo'].join(',');
const UPSTREAM_REPOSITORY_SELECTORS = [
  'a[href="https://github.com/SillyTavern/SillyTavern"]',
  'a[href="https://github.com/SillyTavern/SillyTavern/"]',
].join(',');
const UPSTREAM_DISCORD_SELECTORS = [
  'a[href="https://discord.gg/sillytavern"]',
  'a[href="https://discord.gg/sillytavern/"]',
].join(',');
const PRODUCT_REPOSITORY_URL = 'https://github.com/Lianues/PureTavern';
const PRODUCT_DISCORD_URL = 'https://discord.gg/w5kB9ahuFA';

export interface LegacyBrandingMetadata {
  version: string;
}

export function formatLegacyBrandVersion(
  version: string,
  productVersion: string = APP_VERSION,
): string {
  const upstream = version.trim();
  const product = productVersion.trim();
  const label = product ? `${PRODUCT_NAME} ${product}` : PRODUCT_NAME;
  return upstream ? `${label} (${UPSTREAM_NAME} ${upstream})` : label;
}

export function installLegacyBranding(
  upstreamMetadata: Promise<LegacyBrandingMetadata>,
): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }

  // Shows "PureTavern <version>" until the upstream metadata resolves.
  let versionLabel = formatLegacyBrandVersion('');
  const apply = (root: Document | Element) => {
    if (document.title !== PRODUCT_NAME) document.title = PRODUCT_NAME;
    for (const element of selectElements(root, VERSION_SELECTORS)) {
      if (element.textContent !== versionLabel) element.textContent = versionLabel;
    }
    for (const element of selectElements(root, LOGO_SELECTORS)) {
      if (!(element instanceof HTMLImageElement)) continue;
      if (new URL(element.src, window.location.href).pathname !== '/img/logo.png') {
        element.src = '/img/logo.png';
      }
      element.alt = `${PRODUCT_NAME} Logo`;
      element.setAttribute('aria-label', `${PRODUCT_NAME} Logo`);
      element.setAttribute('data-i18n', `[alt]${PRODUCT_NAME} Logo`);
    }
    for (const element of selectElements(root, UPSTREAM_REPOSITORY_SELECTORS)) {
      if (element instanceof HTMLAnchorElement) element.href = PRODUCT_REPOSITORY_URL;
    }
    for (const element of selectElements(root, UPSTREAM_DISCORD_SELECTORS)) {
      if (element instanceof HTMLAnchorElement) element.href = PRODUCT_DISCORD_URL;
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) apply(record.target);
      for (const node of record.addedNodes) {
        if (node instanceof Element) apply(node);
      }
    }
  });
  apply(document);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  void upstreamMetadata
    .then((metadata) => {
      versionLabel = formatLegacyBrandVersion(metadata.version);
      apply(document);
    })
    .catch(() => undefined);

  return () => observer.disconnect();
}

function selectElements(root: Document | Element, selector: string): Element[] {
  const elements = Array.from(root.querySelectorAll(selector));
  if (root instanceof Element && root.matches(selector)) elements.unshift(root);
  return elements;
}
