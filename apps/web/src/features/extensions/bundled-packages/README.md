# Bundled extension snapshots

These archives are immutable upstream Release snapshots used only for PureTavern's one-time,
offline extension import. They are copied to the generated runtime by `runtime-assets.json`;
no file is added to or changed under the read-only SillyTavern upstream snapshot.

| Extension          | Release  | Commit                                     | Upstream                                                           |
| ------------------ | -------- | ------------------------------------------ | ------------------------------------------------------------------ |
| JS-Slash-Runner    | `4.8.19` | `0e965f2f6be878031dbbfd0c2171fa49de10ecca` | <https://github.com/N0VI028/JS-Slash-Runner/releases/tag/4.8.19>   |
| ST-Prompt-Template | `1.16`   | `191ba3bbe0cf47771c3fd2632a9e45730ef92121` | <https://github.com/zonde306/ST-Prompt-Template/releases/tag/1.16> |

`manifest.json` pins each archive's byte length and SHA-256. The Legacy runtime preparation step
validates those pins and the extension's own root `manifest.json` before copying the assets.
Original package files and upstream license files, where provided by the upstream project, remain
inside each archive and are imported unchanged.
