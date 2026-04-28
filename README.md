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

By default, the build script uses the latest APK versions recommended by the selected Morphe patch release. Those recommended versions come from Morphe's `patches-list.json`.

```bash
node scripts/morphe.mjs download
node scripts/morphe.mjs build
```

The downloader uses APKPure's public download host for:

- [YouTube](https://apkpure.com/youtube-2025/com.google.android.youtube)
- [YouTube Music](https://apkpure.com/youtube-music/com.google.android.apps.youtube.music)

The YouTube Music URL is normalized to `com.google.android.apps.youtube.music`, which is the package used by the current YouTube Music app and Morphe's patch metadata.

APKPure's public latest download is straightforward, but historical downloads use APKPure's own version-code identifier rather than only the visible app version. If APKPure latest does not match Morphe's recommended version, provide either a direct compatible APK URL or an APKPure version code:

- `YOUTUBE_APK_URL`
- `YOUTUBE_MUSIC_APK_URL`
- `YOUTUBE_APKPURE_VERSION_CODE`
- `YOUTUBE_MUSIC_APKPURE_VERSION_CODE`

To deliberately use APKPure latest instead of Morphe's recommended version:

```bash
APK_VERSION_SOURCE=latest node scripts/morphe.mjs build
```

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

The workflow at `.github/workflows/build.yml` downloads APKs automatically in the clean CI workspace, using Morphe's recommended versions by default.

You can still override APKPure with private APK URLs. Add these repository secrets:

- `YOUTUBE_APK_URL`: optional private direct URL to your original YouTube APK.
- `YOUTUBE_MUSIC_APK_URL`: optional private direct URL to your original YouTube Music APK.
- `YOUTUBE_APKPURE_VERSION_CODE`: optional APKPure version code for Morphe's recommended YouTube version.
- `YOUTUBE_MUSIC_APKPURE_VERSION_CODE`: optional APKPure version code for Morphe's recommended YouTube Music version.

Optional signing secrets:

- `APK_KEYSTORE_B64`: base64-encoded keystore file.
- `APK_KEYSTORE_PASSWORD`
- `APK_KEYSTORE_ALIAS`
- `APK_KEYSTORE_ENTRY_PASSWORD`

Then run **Actions -> Build patched APKs -> Run workflow**.

The workflow defaults `apk_version_source` to `recommended`, so each run uses the highest compatible YouTube and YouTube Music versions declared by the selected Morphe patch release.

By default, manual workflow runs now pass these Morphe CLI patch flags:

```text
--force --continue-on-error
```

`--force` skips Morphe's APK version compatibility gate. `--continue-on-error` lets the build finish if one patch fails, but that can produce a partially patched APK. Always check the attached `*-result.json` files.

The workflow creates a GitHub Release named like:

```text
Morph patched APKs YYYY-MM-DD #RUN_NUMBER
```

The release notes include a short bullet summary with:

- Morphe CLI and patch bundle versions
- APK version and package for each target
- Successful patch names
- Failed patch names and first error line

The release includes:

- `output/*.apk`
- `output/*-result.json`

The workflow also keeps the one-day artifact upload as a fallback. Avoid using a public repository or public release uploads for patched proprietary APKs unless you have the rights to distribute them.

## Scheduled Builds

`.github/workflows/watch-morphe-patches.yml` runs every 6 hours and checks the latest release from `MorpheApp/morphe-patches`.

When a new Morphe patch release appears, it dispatches the build workflow with:

- `patches_version` set to the new Morphe patch tag
- `apk_version_source` set to `recommended`
- release creation enabled

After the build workflow creates the Release, it stores the handled Morphe patch release in the repository variable `LAST_MORPHE_PATCHES_RELEASE`. If the build fails, the watcher will try again on a later schedule.

## Compatibility Note

Morphe patches only support the versions listed by the patch bundle. On 2026-04-28 APKPure latest was newer than Morphe's listed compatible versions. If patching fails due to version compatibility, provide a compatible APK manually or pass Morphe's `--force` after `--`:

```bash
node scripts/morphe.mjs build -- --force
```

## Legal Notes

Morphe CLI and Morphe patches are GPL-licensed upstream projects with additional GPLv3 Section 7 conditions. The patch repository states that visible attribution is required when using the code, and that derivative works must not use the name "Morphe" as their identity.

This repository is only an automation wrapper. It is not affiliated with Google, YouTube, APKPure, or Morphe. Make sure your use of downloaded APKs follows the relevant terms and laws for your location.
