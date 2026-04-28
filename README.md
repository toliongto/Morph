# Morph YouTube Builder

Automation for patching user-provided YouTube and YouTube Music APKs with the upstream Morphe CLI and Morphe patch bundle.

This repository does not store, download, or redistribute Google APKs. You provide the original APKs yourself, either locally or through private GitHub Actions secrets.

## What It Uses

- [Morphe CLI](https://github.com/MorpheApp/morphe-cli), the command-line patching tool.
- [Morphe patches](https://github.com/MorpheApp/morphe-patches), the `.mpp` patch bundle source.
- The latest stable releases discovered while scaffolding this repo on 2026-04-28 were `morphe-cli` `v1.7.0` and `morphe-patches` `v1.24.0`.

Current package versions listed by the upstream patch metadata:

- YouTube, `com.google.android.youtube`: `20.47.62`, `20.45.36`, `20.40.45`, `20.31.42`, `20.21.37`
- YouTube Music, `com.google.android.apps.youtube.music`: `8.47.56`, `8.44.54`, `8.40.54`, `8.10.52`, `7.29.52`

Check again any time:

```bash
node scripts/morphe.mjs versions
```

## Local Build

Requirements:

- Node.js 20+
- Java 17+
- Internet access, or original APKs you are legally allowed to patch

By default, the build script downloads the latest APKPure APKs when the input files are missing:

```bash
node scripts/morphe.mjs download
node scripts/morphe.mjs build
```

The downloader uses APKPure's public download host for:

- [YouTube](https://apkpure.com/youtube-2025/com.google.android.youtube)
- [YouTube Music](https://apkpure.com/youtube-music/com.google.android.apps.youtube.music)

The YouTube Music URL is normalized to `com.google.android.apps.youtube.music`, which is the package used by the current YouTube Music app and Morphe's patch metadata.

To refresh an existing APKPure download:

```bash
node scripts/morphe.mjs download --force-download
```

To use your own APKs instead, place them here:

```text
input/youtube.apk
input/youtube-music.apk
```

Then keep those files by disabling the APKPure source:

```bash
APK_SOURCE=local node scripts/morphe.mjs build
```

Build both targets:

```bash
node scripts/morphe.mjs build
```

Build one target:

```bash
BUILD_TARGETS=youtube node scripts/morphe.mjs build
```

PowerShell equivalent:

```powershell
$env:BUILD_TARGETS = "youtube"
node scripts/morphe.mjs build
```

Outputs are written to:

```text
output/youtube-patched.apk
output/youtube-music-patched.apk
```

## Patch Options

Generate editable options files for the compatible patches:

```bash
node scripts/morphe.mjs options
```

That creates:

```text
config/youtube-options.json
config/youtube-music-options.json
```

After editing those JSON files, `node scripts/morphe.mjs build` will automatically pass them to Morphe CLI.

You can pass extra Morphe CLI patch arguments after `--`:

```bash
node scripts/morphe.mjs build --target youtube -- --disable "Custom branding"
```

## GitHub Actions

The workflow at `.github/workflows/build.yml` downloads the latest APKPure APKs automatically in the clean CI workspace.

You can still override APKPure with private APK URLs. Add these repository secrets:

- `YOUTUBE_APK_URL`: optional private direct URL to your original YouTube APK.
- `YOUTUBE_MUSIC_APK_URL`: optional private direct URL to your original YouTube Music APK.

Optional signing secrets:

- `APK_KEYSTORE_B64`: base64-encoded keystore file.
- `APK_KEYSTORE_PASSWORD`
- `APK_KEYSTORE_ALIAS`
- `APK_KEYSTORE_ENTRY_PASSWORD`

Then run **Actions -> Build patched APKs -> Run workflow**.

The workflow artifact retention is intentionally set to `1` day. Avoid using a public repository or public release uploads for patched proprietary APKs unless you have the rights to distribute them.

## Compatibility Note

`node scripts/morphe.mjs download` follows APKPure's latest APK, while Morphe patches only support the versions listed by the patch bundle. On 2026-04-28 APKPure latest was newer than Morphe's listed compatible versions. If patching fails due to version compatibility, provide a compatible APK manually or pass Morphe's `--force` after `--`:

```bash
node scripts/morphe.mjs build -- --force
```

## Legal Notes

Morphe CLI and Morphe patches are GPL-licensed upstream projects with additional GPLv3 Section 7 conditions. The patch repository states that visible attribution is required when using the code, and that derivative works must not use the name "Morphe" as their identity.

This repository is only an automation wrapper. It is not affiliated with Google, YouTube, APKPure, or Morphe. Make sure your use of downloaded APKs follows the relevant terms and laws for your location.
