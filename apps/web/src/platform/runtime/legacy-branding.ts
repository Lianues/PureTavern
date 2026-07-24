const PRODUCT_NAME = 'PureTavern';
const UPSTREAM_NAME = 'SillyTavern';
const VERSION_SELECTORS = [
  '.welcomeHeaderVersionDisplay',
  '#version_display',
  '#version_display_welcome',
].join(',');
const LOGO_SELECTORS = ['.welcomeHeaderLogo', '.splash-logo'].join(',');

export interface LegacyBrandingMetadata {
  version: string;
}

export function formatLegacyBrandVersion(version: string): string {
  const normalized = version.trim();
  return normalized ? `${PRODUCT_NAME} (${UPSTREAM_NAME} ${normalized})` : PRODUCT_NAME;
}

export function installLegacyBranding(
  upstreamMetadata: Promise<LegacyBrandingMetadata>,
): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }

  let versionLabel = PRODUCT_NAME;
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
      element.removeAttribute('data-i18n');
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
