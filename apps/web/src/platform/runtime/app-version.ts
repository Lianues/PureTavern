declare const __PURE_TAVERN_VERSION__: string;

/**
 * Injected from apps/web/package.json at bundle time so the release version is
 * never duplicated in source. Empty outside a bundled build (dev server, tests),
 * where consumers fall back to an unversioned label.
 */
export const APP_VERSION =
  typeof __PURE_TAVERN_VERSION__ === 'string' ? __PURE_TAVERN_VERSION__ : '';
