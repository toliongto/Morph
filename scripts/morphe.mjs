#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
  input: fromRoot("input"),
  output: fromRoot("output"),
};

const appConfigs = {
  youtube: {
    id: "youtube",
    label: "YouTube",
    packageName: "com.google.android.youtube",
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
    case "options":
      await createOptions();
      break;
    case "tools":
      await ensureTools(flag("refresh-tools"));
      break;
    case "versions":
      await printVersions();
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
  const [cliRelease, patchesRelease, patchesList] = await Promise.all([
    githubJson("https://api.github.com/repos/MorpheApp/morphe-cli/releases/latest"),
    githubJson("https://api.github.com/repos/MorpheApp/morphe-patches/releases/latest"),
    githubJson("https://raw.githubusercontent.com/MorpheApp/morphe-patches/main/patches-list.json"),
  ]);

  console.log(`Morphe CLI latest: ${cliRelease.tag_name}`);
  console.log(`Morphe patches latest: ${patchesRelease.tag_name}`);
  console.log(`Patch list version: ${patchesList.version}`);

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
  if (existsSync(app.input)) return;

  if (app.url) {
    mkdirSync(dirname(app.input), { recursive: true });
    console.log(`Downloading private input for ${app.label}`);
    await downloadFile(app.url, app.input);
    return;
  }

  throw new Error(
    `${app.label} input is missing. Put it at ${relative(app.input)} or set ${envNameFor(app.id)}_URL.`,
  );
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

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "morph-youtube-builder",
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

function clean() {
  rmSync(fromRoot(".cache"), { recursive: true, force: true });
  console.log("Removed .cache");
}

function printHelp() {
  console.log(`Usage:
  node scripts/morphe.mjs build [--target youtube] [--target youtube-music] [-- <morphe-cli patch args>]
  node scripts/morphe.mjs options [--target youtube]
  node scripts/morphe.mjs tools [--refresh-tools]
  node scripts/morphe.mjs versions
  node scripts/morphe.mjs clean

Environment:
  BUILD_TARGETS              Comma-separated targets. Defaults to youtube,youtube-music.
  MORPHE_CLI_VERSION         Release tag such as v1.7.0, or latest.
  MORPHE_PATCHES_VERSION     Release tag such as v1.24.0, or latest.
  YOUTUBE_APK                Local input path for YouTube.
  YOUTUBE_MUSIC_APK          Local input path for YouTube Music.
  YOUTUBE_APK_URL            Private direct URL for CI input.
  YOUTUBE_MUSIC_APK_URL      Private direct URL for CI input.
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

function usableFile(file) {
  try {
    return existsSync(file) && statSync(file).size > 0;
  } catch {
    return false;
  }
}
