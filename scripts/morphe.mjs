#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawArgs = process.argv.slice(2);
const command = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : "build";
const passthroughIndex = rawArgs.indexOf("--");
const commandArgs = passthroughIndex === -1 ? rawArgs : rawArgs.slice(0, passthroughIndex);
const passthroughArgs = passthroughIndex === -1
  ? parseJsonArrayEnv("MORPHE_EXTRA_ARGS_JSON")
  : rawArgs.slice(passthroughIndex + 1);

const paths = {
  tools: fromRoot(".cache/tools"),
  tmp: fromRoot(".cache/tmp"),
  apkpure: fromRoot(".cache/apkpure"),
  input: fromRoot("input"),
  output: fromRoot("output"),
};

const appConfigs = {
  youtube: {
    id: "youtube",
    label: "YouTube",
    packageName: "com.google.android.youtube",
    apkpureSlug: "youtube-2025",
    apkpurePage: "https://apkpure.com/youtube-2025/com.google.android.youtube",
    input: envPath("YOUTUBE_APK", "input/youtube.apk"),
    url: env("YOUTUBE_APK_URL"),
    output: envPath("YOUTUBE_OUT", "output/youtube-patched.apk"),
    options: envPath("YOUTUBE_OPTIONS", "config/youtube-options.json"),
    result: envPath("YOUTUBE_RESULT", "output/youtube-result.json"),
  },
  "youtube-music": {
    id: "youtube-music",
    label: "YouTube Music",
    packageName: "com.google.android.apps.youtube.music",
    apkpureSlug: "youtube-music",
    apkpurePage: "https://apkpure.com/youtube-music/com.google.android.apps.youtube.music",
    input: envPath("YOUTUBE_MUSIC_APK", "input/youtube-music.apk"),
    url: env("YOUTUBE_MUSIC_APK_URL"),
    output: envPath("YOUTUBE_MUSIC_OUT", "output/youtube-music-patched.apk"),
    options: envPath("YOUTUBE_MUSIC_OPTIONS", "config/youtube-music-options.json"),
    result: envPath("YOUTUBE_MUSIC_RESULT", "output/youtube-music-result.json"),
  },
};

const releaseAssets = {
  cli: {
    repo: "MorpheApp/morphe-cli",
    versionEnv: "MORPHE_CLI_VERSION",
    assetPattern: /^morphe-cli-.+-all\.jar$/,
    output: fromRoot(".cache/tools/morphe-cli.jar"),
    meta: fromRoot(".cache/tools/morphe-cli.json"),
  },
  patches: {
    repo: "MorpheApp/morphe-patches",
    versionEnv: "MORPHE_PATCHES_VERSION",
    assetPattern: /^patches-.+\.mpp$/,
    output: fromRoot(".cache/tools/patches.mpp"),
    meta: fromRoot(".cache/tools/patches.json"),
  },
};

main().catch((error) => {
  console.error(`\nerror: ${error.message}`);
  process.exit(1);
});

async function main() {
  switch (command) {
    case "build":
      await build();
      break;
    case "download":
      await downloadApks({ force: flag("force-download") });
      break;
    case "options":
      await createOptions();
      break;
    case "tools":
      await ensureTools(flag("refresh-tools"));
      break;
    case "versions":
      await printVersions();
      break;
    case "release-notes":
      await printReleaseNotes();
      break;
    case "clean":
      clean();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command "${command}". Run "node scripts/morphe.mjs help".`);
  }
}

async function build() {
  checkJava();
  const tools = await ensureTools(flag("refresh-tools"));
  mkdirSync(paths.output, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });

  for (const app of selectedApps()) {
    await ensureInput(app);

    const args = [
      "-jar",
      tools.cli,
      "patch",
      "--patches",
      tools.patches,
      "--out",
      app.output,
      "--result-file",
      app.result,
      "--temporary-files-path",
      fromRoot(`.cache/tmp/${app.id}`),
      "--purge",
    ];

    appendSigningArgs(args);

    if (existsSync(app.options)) {
      args.push("--options-file", app.options);
      if (truthy(env("MORPHE_OPTIONS_UPDATE"))) args.push("--options-update");
    }

    args.push(...passthroughArgs, app.input);

    console.log(`\n==> Building ${app.label}`);
    run("java", args);
  }
}

async function downloadApks({ force = false } = {}) {
  for (const app of selectedApps()) {
    await downloadApkpureLatest(app, { force });
  }
}

async function createOptions() {
  checkJava();
  const tools = await ensureTools(flag("refresh-tools"));

  for (const app of selectedApps()) {
    mkdirSync(dirname(app.options), { recursive: true });
    console.log(`\n==> Creating options for ${app.label}`);
    run("java", [
      "-jar",
      tools.cli,
      "options-create",
      "--patches",
      tools.patches,
      "--out",
      app.options,
      "--filter-package-name",
      app.packageName,
    ]);
  }
}

async function ensureTools(force = false) {
  mkdirSync(paths.tools, { recursive: true });

  const [cli, patches] = await Promise.all([
    downloadReleaseAsset(releaseAssets.cli, force),
    downloadReleaseAsset(releaseAssets.patches, force),
  ]);

  return { cli, patches };
}

async function downloadReleaseAsset(config, force) {
  if (!force && usableFile(config.output)) {
    return config.output;
  }

  const version = env(config.versionEnv) || "latest";
  const releaseUrl = version === "latest"
    ? `https://api.github.com/repos/${config.repo}/releases/latest`
    : `https://api.github.com/repos/${config.repo}/releases/tags/${normalizeTag(version)}`;
  const release = await githubJson(releaseUrl);
  const asset = release.assets.find((item) => config.assetPattern.test(item.name));

  if (!asset) {
    throw new Error(`No matching release asset found for ${config.repo} ${release.tag_name}`);
  }

  console.log(`Downloading ${config.repo} ${release.tag_name}: ${asset.name}`);
  await downloadFile(asset.browser_download_url, config.output);
  await writeJson(config.meta, {
    repo: config.repo,
    tag: release.tag_name,
    asset: asset.name,
    downloadedAt: new Date().toISOString(),
  });

  return config.output;
}

async function printVersions() {
  const [cliRelease, patchesRelease, patchesList, youtubeLatest, musicLatest] = await Promise.all([
    githubJson("https://api.github.com/repos/MorpheApp/morphe-cli/releases/latest"),
    githubJson("https://api.github.com/repos/MorpheApp/morphe-patches/releases/latest"),
    githubJson("https://raw.githubusercontent.com/MorpheApp/morphe-patches/main/patches-list.json"),
    inspectApkpureLatest(appConfigs.youtube),
    inspectApkpureLatest(appConfigs["youtube-music"]),
  ]);

  console.log(`Morphe CLI latest: ${cliRelease.tag_name}`);
  console.log(`Morphe patches latest: ${patchesRelease.tag_name}`);
  console.log(`Patch list version: ${patchesList.version}`);
  console.log(`APKPure latest YouTube: ${youtubeLatest.version || "unknown"} (${youtubeLatest.size || "unknown size"})`);
  console.log(`APKPure latest YouTube Music: ${musicLatest.version || "unknown"} (${musicLatest.size || "unknown size"})`);

  const packages = new Map();
  for (const patch of patchesList.patches) {
    if (!patch.compatiblePackages) continue;
    for (const [packageName, versions] of Object.entries(patch.compatiblePackages)) {
      if (!packages.has(packageName)) packages.set(packageName, new Set());
      for (const version of versions ?? []) packages.get(packageName).add(version);
    }
  }

  for (const [packageName, versions] of [...packages.entries()].sort()) {
    console.log(`${packageName}: ${[...versions].sort().reverse().join(", ")}`);
  }
}

async function printReleaseNotes() {
  const apps = selectedApps();
  const cliMeta = await readJson(releaseAssets.cli.meta);
  const patchesMeta = await readJson(releaseAssets.patches.meta);
  const patchArgs = parseJsonArrayEnv("MORPHE_EXTRA_ARGS_JSON");
  const lines = [];

  lines.push("Automated patched APK build.");
  lines.push("");
  lines.push("## Build Summary");
  lines.push("");
  lines.push(`- Targets: ${apps.map((app) => app.label).join(", ")}`);
  lines.push(`- Morphe CLI: ${cliMeta?.tag || env("MORPHE_CLI_VERSION") || "latest"}`);
  lines.push(`- Morphe patches: ${patchesMeta?.tag || env("MORPHE_PATCHES_VERSION") || "latest"}`);
  lines.push(`- Patch args: ${patchArgs.length ? patchArgs.join(" ") : "none"}`);
  lines.push("");

  for (const app of apps) {
    const result = await readJson(app.result);
    const apkMeta = await readJson(fromRoot(".cache/apkpure", `${app.id}.json`));
    const apkVersion = result?.packageVersion || apkMeta?.version || "unknown";
    const packageName = result?.packageName || app.packageName;
    const applied = patchesFrom(result?.appliedPatches);
    const failed = failedPatchesFrom(result?.failedPatches);
    const stepFailures = stepFailuresFrom(result?.patchingSteps);
    const buildResult = result
      ? result.success === false ? "completed with patch failures" : "successful"
      : "unknown; result file missing";

    lines.push(`## ${app.label}`);
    lines.push("");
    lines.push(`- APK version: ${apkVersion}`);
    lines.push(`- Package: ${packageName}`);
    if (apkMeta?.filename) lines.push(`- Source APK: ${apkMeta.filename}${apkMeta.size ? ` (${apkMeta.size})` : ""}`);
    lines.push(`- Build result: ${buildResult}`);
    lines.push(`- Successful patches (${applied.length}): ${applied.length ? applied.join(", ") : "none"}`);
    lines.push(`- Failed patches (${failed.length}): ${failed.length ? failed.map(formatFailedPatch).join("; ") : "none"}`);
    if (stepFailures.length) {
      lines.push(`- Failed build steps: ${stepFailures.join("; ")}`);
    }
    lines.push("");
  }

  lines.push("Review the attached `*-result.json` files for full patching details.");
  lines.push("");
  lines.push("Warning: `--continue-on-error` can produce a partially patched APK if any patch fails.");

  console.log(lines.join("\n"));
}

function selectedApps() {
  const explicitTargets = optionValues("target").concat(optionValues("targets"));
  const targets = (explicitTargets.length
    ? explicitTargets
    : splitTargets(env("BUILD_TARGETS") || "youtube,youtube-music"))
    .filter(Boolean);

  const uniqueTargets = [...new Set(targets)];
  const unknown = uniqueTargets.filter((target) => !appConfigs[target]);
  if (unknown.length) {
    throw new Error(`Unknown target(s): ${unknown.join(", ")}. Valid targets: ${Object.keys(appConfigs).join(", ")}`);
  }

  return uniqueTargets.map((target) => appConfigs[target]);
}

async function ensureInput(app) {
  const apkpureMode = (env("APK_SOURCE") || "apkpure").toLowerCase();
  if (existsSync(app.input) && !(apkpureMode === "apkpure" && truthy(env("AUTO_UPDATE_APKS")))) return;

  if (app.url) {
    mkdirSync(dirname(app.input), { recursive: true });
    console.log(`Downloading private input for ${app.label}`);
    await downloadFile(app.url, app.input);
    return;
  }

  if (apkpureMode === "apkpure") {
    await downloadApkpureLatest(app, { force: truthy(env("AUTO_UPDATE_APKS")) });
    return;
  }

  throw new Error(
    `${app.label} input is missing. Put it at ${relative(app.input)}, set ${envNameFor(app.id)}_URL, or set APK_SOURCE=apkpure.`,
  );
}

async function downloadApkpureLatest(app, { force = false } = {}) {
  mkdirSync(paths.apkpure, { recursive: true });
  mkdirSync(dirname(app.input), { recursive: true });

  const latest = await inspectApkpureLatest(app);
  const metadataFile = fromRoot(".cache/apkpure", `${app.id}.json`);
  const existing = await readJson(metadataFile);

  if (
    !force &&
    existsSync(app.input) &&
    latest.version &&
    existing?.version === latest.version &&
    existing?.destination === app.input
  ) {
    console.log(`${app.label} ${latest.version} already downloaded at ${relative(app.input)}`);
    return;
  }

  if (!force && existsSync(app.input) && !existing?.version) {
    console.log(`${app.label} input already exists at ${relative(app.input)}; keeping it. Use --force-download or AUTO_UPDATE_APKS=1 to refresh.`);
    return;
  }

  console.log(`Downloading APKPure latest ${app.label}${latest.version ? ` ${latest.version}` : ""}`);
  const tempFile = `${app.input}.download`;
  rmSync(tempFile, { force: true });
  await downloadFile(apkpureLatestUrl(app), tempFile, apkpureHeaders());
  renameSync(tempFile, app.input);

  await writeJson(metadataFile, {
    app: app.id,
    packageName: app.packageName,
    sourcePage: app.apkpurePage,
    directUrl: apkpureLatestUrl(app),
    destination: app.input,
    version: latest.version,
    size: latest.size,
    filename: latest.filename,
    downloadedAt: new Date().toISOString(),
  });
}

async function inspectApkpureLatest(app) {
  const response = await fetch(apkpureLatestUrl(app), {
    method: "HEAD",
    redirect: "follow",
    headers: apkpureHeaders(),
  });

  if (!response.ok) {
    throw new Error(`APKPure latest check failed for ${app.label} (${response.status})`);
  }

  const contentDisposition = response.headers.get("content-disposition") || "";
  const filename = parseHeaderFilename(contentDisposition);

  return {
    version: parseApkpureVersion(filename),
    filename,
    size: formatBytes(Number(response.headers.get("content-length") || 0)),
  };
}

function appendSigningArgs(args) {
  const keystoreFile = env("KEYSTORE_FILE");
  if (keystoreFile) args.push("--keystore", resolveMaybeRoot(keystoreFile));

  const keystorePassword = env("KEYSTORE_PASSWORD");
  if (keystorePassword) args.push("--keystore-password", keystorePassword);

  const alias = env("KEYSTORE_ALIAS");
  if (alias) args.push("--keystore-entry-alias", alias);

  const entryPassword = env("KEYSTORE_ENTRY_PASSWORD");
  if (entryPassword) args.push("--keystore-entry-password", entryPassword);

  const signer = env("SIGNER_NAME");
  if (signer) args.push("--signer", signer);

  if (truthy(env("UNSIGNED"))) args.push("--unsigned");
}

function checkJava() {
  const result = spawnSync("java", ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error("Java is required. Install Java 17+ or run this through GitHub Actions.");
  }
}

function run(commandName, args) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandName} exited with status ${result.status}`);
  }
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "morph-youtube-builder",
      ...(env("GITHUB_TOKEN") ? { Authorization: `Bearer ${env("GITHUB_TOKEN")}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

async function downloadFile(url, destination, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "morph-youtube-builder",
      ...headers,
      ...(env("GITHUB_TOKEN") && url.includes("github.com")
        ? { Authorization: `Bearer ${env("GITHUB_TOKEN")}` }
        : {}),
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status})`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function writeJson(file, data) {
  const { writeFile } = await import("node:fs/promises");
  mkdirSync(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function readJson(file) {
  if (!existsSync(file)) return null;
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function clean() {
  rmSync(fromRoot(".cache"), { recursive: true, force: true });
  console.log("Removed .cache");
}

function printHelp() {
  console.log(`Usage:
  node scripts/morphe.mjs build [--target youtube] [--target youtube-music] [-- <morphe-cli patch args>]
  node scripts/morphe.mjs download [--target youtube] [--force-download]
  node scripts/morphe.mjs options [--target youtube]
  node scripts/morphe.mjs tools [--refresh-tools]
  node scripts/morphe.mjs versions
  node scripts/morphe.mjs release-notes
  node scripts/morphe.mjs clean

Environment:
  BUILD_TARGETS              Comma-separated targets. Defaults to youtube,youtube-music.
  MORPHE_CLI_VERSION         Release tag such as v1.7.0, or latest.
  MORPHE_PATCHES_VERSION     Release tag such as v1.24.0, or latest.
  YOUTUBE_APK                Local input path for YouTube.
  YOUTUBE_MUSIC_APK          Local input path for YouTube Music.
  YOUTUBE_APK_URL            Private direct URL for CI input.
  YOUTUBE_MUSIC_APK_URL      Private direct URL for CI input.
  APK_SOURCE                 apkpure or local. Defaults to apkpure.
  AUTO_UPDATE_APKS           Set to 1 to refresh existing APKPure downloads during build.
  KEYSTORE_FILE              Optional signing keystore path.
  MORPHE_EXTRA_ARGS_JSON     Optional JSON array of extra patch args.`);
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    if (commandArgs[index] === `--${name}` && commandArgs[index + 1]) {
      values.push(commandArgs[index + 1]);
      index += 1;
    }
  }
  return values.flatMap(splitTargets);
}

function optionValue(name) {
  return optionValues(name)[0] ?? "";
}

function flag(name) {
  return commandArgs.includes(`--${name}`);
}

function splitTargets(value) {
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseJsonArrayEnv(name) {
  const value = env(name);
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(`${name} must be a JSON string array, for example ["--disable","Custom branding"]`);
}

function normalizeTag(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

function env(name) {
  return process.env[name]?.trim();
}

function envPath(name, fallback) {
  return resolveMaybeRoot(env(name) || fallback);
}

function resolveMaybeRoot(value) {
  return /^[a-zA-Z]:[\\/]|^\//.test(value) ? value : fromRoot(value);
}

function fromRoot(...segments) {
  return resolve(root, ...segments);
}

function relative(file) {
  return file.replace(`${root}\\`, "").replace(`${root}/`, "");
}

function envNameFor(id) {
  return id === "youtube" ? "YOUTUBE_APK" : "YOUTUBE_MUSIC_APK";
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes((value || "").toLowerCase());
}

function patchesFrom(patches) {
  return Array.isArray(patches)
    ? patches.map(patchName).filter(Boolean)
    : [];
}

function failedPatchesFrom(patches) {
  return Array.isArray(patches)
    ? patches.map((entry) => ({
        name: patchName(entry?.patch),
        reason: firstReasonLine(entry?.reason),
      })).filter((entry) => entry.name)
    : [];
}

function patchName(patch) {
  if (patch?.name) return patch.name;
  if (Number.isInteger(patch?.index)) return `#${patch.index}`;
  return "";
}

function stepFailuresFrom(steps) {
  return Array.isArray(steps)
    ? steps
        .filter((step) => step?.success === false)
        .map((step) => `${step.step}${step.message ? `: ${firstReasonLine(step.message)}` : ""}`)
    : [];
}

function formatFailedPatch(entry) {
  return entry.reason ? `${entry.name} (${entry.reason})` : entry.name;
}

function firstReasonLine(reason) {
  return String(reason || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function apkpureLatestUrl(app) {
  return `https://d.apkpure.net/b/APK/${encodeURIComponent(app.packageName)}?version=latest`;
}

function apkpureHeaders() {
  return {
    "Accept": "application/vnd.android.package-archive,*/*",
    "Referer": "https://apkpure.net/",
    "User-Agent": "Mozilla/5.0 morph-youtube-builder",
  };
}

function parseHeaderFilename(contentDisposition) {
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ""));

  const asciiMatch = contentDisposition.match(/filename="([^"]+)"/i) || contentDisposition.match(/filename=([^;]+)/i);
  return asciiMatch ? asciiMatch[1].trim().replace(/^"|"$/g, "") : "";
}

function parseApkpureVersion(filename) {
  const match = filename.match(/_(\d+(?:\.\d+)+)_APKPure\.(?:apk|xapk|apks)$/i);
  return match?.[1] || "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function usableFile(file) {
  try {
    return existsSync(file) && statSync(file).size > 0;
  } catch {
    return false;
  }
}
