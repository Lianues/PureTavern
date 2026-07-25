# PureTavern HarmonyOS NEXT shell

This directory is a platform-only ArkTS Stage-model shell for HarmonyOS NEXT 6.0.2(22). It does not contain PureTavern feature logic. The shell consumes the production output from `apps/web/dist`.

## Local commands

```bash
pnpm build
pnpm --dir apps/harmony sync:web
```

A HAP build additionally requires HarmonyOS command-line tools:

```bash
# Point to hvigor/ohpm discovered from DevEco or command-line-tools.
HARMONY_HVIGORW=/path/to/hvigorw \
HARMONY_OHPM=/path/to/ohpm \
pnpm --dir apps/harmony build:hap
```

The repository also provides the manual **Build HarmonyOS NEXT HAP** GitHub workflow. It installs the pinned Linux command-line-tools package on `ubuntu-22.04`, builds the Web app, synchronizes rawfiles, invokes hvigor, and uploads:

```text
PureTavern-<version>-harmonyos-next-arm64-unsigned.hap
```

The generated HAP is unsigned. Configure a HarmonyOS debug or release signing profile before installing it on a physical device or publishing it through AppGallery. Signing certificates, profiles, stores, and passwords must not be committed.
