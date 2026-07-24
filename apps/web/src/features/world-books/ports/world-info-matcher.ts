import type { WorldBookDocument } from '../domain/world-book';

export interface WorldInfoMatchRequest {
  document: WorldBookDocument;
  /** Matcher-specific context such as chat messages, character data and scan settings. */
  context: Readonly<Record<string, unknown>>;
}

export interface WorldInfoMatchResult {
  /** Opaque matcher output so a future Worker adapter can preserve Legacy result fields. */
  [key: string]: unknown;
}

/** Replaceable boundary for a future Worker/new matching engine. */
export interface WorldInfoMatcher {
  match(request: WorldInfoMatchRequest): Promise<WorldInfoMatchResult>;
}

/**
 * M07 deliberately keeps the proven matcher in the retained Legacy browser script.
 * This descriptor documents the active adapter without duplicating its algorithm.
 */
export const LEGACY_WORLD_INFO_MATCHER = Object.freeze({
  id: 'world-books.matcher.legacy-browser.v1',
  implementation: 'legacy-browser',
  script: '/scripts/world-info.js',
  entryPoints: ['checkWorldInfo', 'getWorldInfoPrompt'],
  repositoryTransport: '/api/worldinfo/get',
});
