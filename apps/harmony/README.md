# PureTavern HarmonyOS NEXT shell

This directory is a platform-only ArkTS Stage-model shell for HarmonyOS NEXT. It does not contain PureTavern feature logic. The shell consumes the production output from `apps/web/dist`.

## SDK products

The project intentionally provides two products:

- `default`: DevEco Studio local development with HarmonyOS 6.1.1/API 24. It keeps `compatibleSdkVersion` at HarmonyOS 6.1.0/API 23.
- `ci`: hosted unsigned builds with the pinned Linux CLI and HarmonyOS 6.1.0/API 23.

DevEco Studio's normal **Run/Debug** action uses `product=default`. The GitHub workflow sets `HARMONY_PRODUCT=ci`; do not switch the local IDE configuration to `ci` unless API 23 is also installed.

The Harmony rawfile sync injects a small platform marker before the Legacy runtime. The page runs at the secure `https://puretavern.local/` origin. Normal page requests use the Web component interceptor, while Service Worker network requests use ArkWeb's process-wide `setServiceWorkerWebSchemeHandler` bridge after `initializeWebEngine()`. Both paths resolve the same packaged `rawfile/web` assets, which keeps dynamic avatar, thumbnail, and third-party extension routes on the normal Service Worker implementation. A normal `200` scheme response must not call `WebSchemeHandlerResponse.setUrl()`, because ArkWeb treats that field as a redirect and Service Worker scripts reject redirected registration. This bridge is confined to the Harmony shell; browser, desktop, Android, iOS, and VS Code builds retain the standard Web Service Worker path unchanged.

## Local commands

Prepare the latest Web assets:

```bash
pnpm build
pnpm --dir apps/harmony sync:web
```

DevEco Studio 6.1 can then open `apps/harmony` and run the `default` product on an API 24 emulator. A local command-line HAP build can use the bundled DevEco tools:

```powershell
$env:DEVECO_SDK_HOME = 'F:\DevEco Studio\sdk'
$env:OHOS_SDK_HOME = 'F:\DevEco Studio\sdk\default'
$env:HARMONY_HVIGORW = 'F:\DevEco Studio\tools\hvigor\bin\hvigorw.js'
pnpm --dir apps/harmony build:hap
```

Override the paths when DevEco Studio is installed elsewhere. The repository validates that the selected product matches the SDK bundled beside Hvigor before building.

A temporary `Hvigor ... [assembleHap]` run configuration only builds the package; it does not deploy it. Use a HarmonyOS Application run configuration for module `entry`, or deploy the newest built HAP through `hdc`:

```powershell
$env:HARMONY_HDC = 'F:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$env:HARMONY_TARGET = '127.0.0.1:5555'
pnpm harmony:deploy
```

`HARMONY_TARGET` may be omitted when exactly one installable device is connected. The deployment script installs the newest HAP under `entry/build` and starts `com.puretavern.harmony/EntryAbility`.

## Hosted HAP

The manual **Build HarmonyOS NEXT HAP** GitHub workflow installs the pinned Linux command-line-tools package on `ubuntu-22.04`, removes invalid AppleDouble metadata from that package, verifies its bundled HarmonyOS 6.1.0/API 23 SDK against the `ci` product, builds the Web app, synchronizes rawfiles, invokes Hvigor, and uploads:

```text
PureTavern-<version>-harmonyos-next-arm64-unsigned.hap
```

The generated HAP is unsigned. Configure a HarmonyOS debug or release signing profile before installing it on a physical device or publishing it through AppGallery. Signing certificates, profiles, stores, and passwords must not be committed.
