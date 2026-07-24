import libraries, { lodash } from '../legacy/upstream/public/lib.js';

// SillyTavern's long-lived extension ecosystem includes bundles that externalize
// lodash as the historical `_` global instead of importing it from /lib.js.
if (typeof globalThis._ === 'undefined') {
  globalThis._ = lodash;
}

export * from '../legacy/upstream/public/lib.js';
export default libraries;
