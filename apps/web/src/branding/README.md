# PureTavern branding assets

These committed browser-ready assets are generated from the workspace source artwork and copied by
`scripts/prepare-legacy-runtime.mjs` after the read-only upstream public tree:

- `pure-tavern-icon.png`: optimized 512×512 transparent master derived from
  `limerence_chroma_keyed.png`;
- `pure-tavern-favicon.ico`: 16/32/48/64/128/256 favicon directory;
- `apple-icon-*`: exact-size touch icons;
- `pure-tavern-logo-330.png`: 330×330 replacement for upstream `img/logo.png`;
- `pure-tavern-system-avatar.png`: 400×600 replacement for upstream `img/five.png`.

The system avatar samples the four near-black source corners, removes only the connected outside
background, retains the central circular portrait, and places its 400×400 result in the vertical
center of the original 400×600 transparent canvas. Build code copies these files; it never edits
`legacy/upstream/**`.
