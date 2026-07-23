const HOOK_MARKER = 'data-pure-tavern-hook="bootstrap"';
const HOOK_TAG = `    <script type="module" src="/__pure_tavern/legacy-hook.js" ${HOOK_MARKER}></script>`;
const SCRIPT_ANCHOR_PATTERN =
  /<script\b[^>]*\bsrc=["']\/?lib\/polyfill\.js["'][^>]*>\s*<\/script>/giu;
const GENERATED_NOTICE =
  '<!-- GENERATED FROM legacy/upstream/public/index.html. DO NOT EDIT DIRECTLY. -->';

export function generateHookedIndex(upstreamIndex) {
  if (upstreamIndex.includes(HOOK_MARKER)) {
    throw new Error('Upstream index unexpectedly already contains the Pure Tavern hook marker.');
  }
  const anchorMatches = upstreamIndex.match(SCRIPT_ANCHOR_PATTERN) ?? [];
  if (anchorMatches.length !== 1) {
    throw new Error(`Expected exactly one Legacy script anchor, found ${anchorMatches.length}.`);
  }

  const withNotice = upstreamIndex.replace(/(<!doctype html>)/iu, `$1\n${GENERATED_NOTICE}`);
  return withNotice.replace(SCRIPT_ANCHOR_PATTERN, `${HOOK_TAG}\n$&`);
}
