const HOOK_MARKER = 'data-pure-tavern-hook="bootstrap"';
const BUILD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;
const SCRIPT_ANCHOR_PATTERN =
  /<script\b[^>]*\bsrc=["']\/?lib\/polyfill\.js["'][^>]*>\s*<\/script>/giu;
const GENERATED_NOTICE =
  '<!-- GENERATED FROM legacy/upstream/public/index.html. DO NOT EDIT DIRECTLY. -->';
const HEAD_PATTERN = /<head\b[^>]*>/giu;
const TITLE_PATTERN = /<title\b[^>]*>[\s\S]*?<\/title>/giu;
const RUNTIME_MARKER = 'data-pure-tavern-runtime="build-marker"';

export function generateHookedIndex(upstreamIndex, buildId) {
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError('Pure Tavern build ID must be a safe 8-128 character identifier.');
  }
  if (upstreamIndex.includes(HOOK_MARKER)) {
    throw new Error('Upstream index unexpectedly already contains the Pure Tavern hook marker.');
  }
  const anchorMatches = upstreamIndex.match(SCRIPT_ANCHOR_PATTERN) ?? [];
  if (anchorMatches.length !== 1) {
    throw new Error(`Expected exactly one Legacy script anchor, found ${anchorMatches.length}.`);
  }

  const headMatches = upstreamIndex.match(HEAD_PATTERN) ?? [];
  if (headMatches.length !== 1) {
    throw new Error(`Expected exactly one Legacy head element, found ${headMatches.length}.`);
  }
  const titleMatches = upstreamIndex.match(TITLE_PATTERN) ?? [];
  if (titleMatches.length !== 1) {
    throw new Error(`Expected exactly one Legacy title element, found ${titleMatches.length}.`);
  }

  const hookTag = `    <script type="module" src="/__pure_tavern/legacy-hook.js?v=${buildId}" ${HOOK_MARKER}></script>`;
  const markerTag = `    <script src="/__pure_tavern/runtime-marker.js?__pt_build=${buildId}" ${RUNTIME_MARKER}></script>`;
  const withNotice = upstreamIndex.replace(/(<!doctype html>)/iu, `$1\n${GENERATED_NOTICE}`);
  const withTitle = withNotice.replace(TITLE_PATTERN, '<title>PureTavern</title>');
  const withMarker = withTitle.replace(HEAD_PATTERN, `$&\n${markerTag}`);
  return withMarker.replace(SCRIPT_ANCHOR_PATTERN, `${hookTag}\n$&`);
}
