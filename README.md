# Morph YouTube Builder

Automation for building Morphe-patched YouTube and YouTube Music APKs.

The builder downloads the selected Morphe CLI and patch bundle, gets source APKs from APKPure when needed, then runs the Morphe patch command for each target.

## What It Uses

- [Morphe CLI](https://github.com/MorpheApp/morphe-cli), the command-line patching tool.
- [Morphe patches](https://github.com/MorpheApp/morphe-patches), the patch bundle source.
- [apkpure](https://pypi.org/project/apkpure/), used for APKPure version lookup and APK downloads.

## Local Build

Requirements:

- Node.js 20+
- Python 3.12+
- Java 17+
- Internet access

Install Python dependencies:

```bash
python -m pip install -r requirements.txt
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

## APK Selection

By default, the script reads the selected Morphe patch metadata and tries to download the top recommended APK version for each target.

If APKPure does not provide that exact version, the script downloads APKPure latest for that target and adds Morphe's `--force` flag for patching.

You can provide your own source APK files instead:

```text
input/youtube.apk
input/youtube-music.apk
```

Then build with local APKs:

```bash
APK_SOURCE=local node scripts/morphe.mjs build
```

## Patch Options

Generate editable options files:

```bash
node scripts/morphe.mjs options
```

That creates:

```text
config/youtube-options.json
config/youtube-music-options.json
```

After editing those JSON files, `node scripts/morphe.mjs build` passes them to Morphe CLI automatically.

You can pass extra Morphe CLI patch arguments after `--`:

```bash
node scripts/morphe.mjs build --target youtube -- --disable "Custom branding"
```

## Legal Notes

Morphe CLI and Morphe patches are GPL-licensed upstream projects with additional GPLv3 Section 7 conditions. The patch repository states that visible attribution is required when using the code, and that derivative works must not use the name "Morphe" as their identity.

This repository is only an automation wrapper. It is not affiliated with Google, YouTube, APKPure, or Morphe. Make sure your use of downloaded APKs follows the relevant terms and laws for your location.
