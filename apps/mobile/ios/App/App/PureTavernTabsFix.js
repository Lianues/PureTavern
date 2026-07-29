(() => {
  'use strict';

  // iOS-only workaround for a duplicated Legacy UI.
  //
  // Capacitor loads the app from `capacitor://localhost` - an origin whose href carries NO path
  // and no trailing slash. `index.html` declares `<base href="/">`, so a link written as
  // `href="#tab"` resolves against the base to `capacitor://localhost/#tab`.
  //
  // jQuery UI 1.13.2 decides whether a tab is an in-page panel or a remote URL by comparing those
  // two values as strings with the fragment stripped:
  //
  //     anchor:   "capacitor://localhost/"   <- has the base's slash
  //     location: "capacitor://localhost"    <- no path at all
  //
  // They differ, so `_isLocal()` returns false and jQuery UI classifies an ordinary in-page tab
  // (`#bg_tabs`) as a REMOTE tab. It then AJAX-loads the anchor's href, which is the app root, and
  // injects the response into a generated `#ui-id-N` panel. The root serves the whole Legacy
  // document, so a second copy of `#top-settings-holder` - and therefore of every element id
  // inside it - lands inside the tab strip.
  //
  // The consequences are the reported bugs: `document.querySelector('#…')` and jQuery selectors
  // resolve to whichever copy comes first in document order, which is the injected invisible
  // clone. Startup handlers bind to the clone and writes land in the clone, so the character
  // detail panel and world book entry list look empty and taps on the visible controls do nothing.
  //
  // The fix replaces jQuery UI's own predicate with an origin+path comparison that ignores the
  // trailing-slash difference. Two earlier approaches were rejected on real devices:
  //
  //   * A document-start `history.replaceState` to give the document a "/" path. That landed
  //     between WebKit blanking the view for an unpainted commit and the rendering update that
  //     clears it, so WebKit treated the same-document navigation as a fresh commit and never
  //     un-blanked - a permanent grey screen.
  //   * Pinning Capacitor's server URL (or `appStartPath`) so the first load already carries a
  //     path. That changed the document URL the whole app boots against and wedged startup.
  //
  // Patching the predicate touches nothing but jQuery UI's tab classification, leaves the document
  // URL exactly as Capacitor produced it, and starts no navigation, so neither failure mode
  // applies. It is also a no-op wherever the comparison already succeeds.
  const isSameDocument = (anchor) => {
    try {
      const anchorUrl = new URL(anchor.href, document.baseURI);
      const here = new URL(location.href);
      // Normalise the empty path that capacitor://localhost reports so "" and "/" compare equal.
      const path = (url) => (url.pathname === '' ? '/' : url.pathname);
      return anchorUrl.origin === here.origin && path(anchorUrl) === path(here);
    } catch {
      return false;
    }
  };

  const patch = () => {
    const jq = globalThis.jQuery;
    const tabs = jq?.ui?.tabs;
    const proto = tabs?.prototype;
    if (typeof proto?._isLocal !== 'function') return false;
    if (proto.__pureTavernIsLocalPatched) return true;

    const original = proto._isLocal;
    proto._isLocal = function pureTavernIsLocal(anchor) {
      // Trust jQuery UI when it already agrees; only rescue the trailing-slash mismatch.
      return original.call(this, anchor) || isSameDocument(anchor);
    };
    proto.__pureTavernIsLocalPatched = true;
    return true;
  };

  if (patch()) return;

  // jQuery UI is loaded by the Legacy bundle after this script runs, so retry briefly. The tab
  // widget is only initialised well into startup, so a short poll is comfortably early enough.
  let attempts = 0;
  const timer = setInterval(() => {
    if (patch() || ++attempts > 600) clearInterval(timer);
  }, 50);
})();
