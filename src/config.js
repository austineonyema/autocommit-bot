import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".autocommit-bot");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  enabled: true,
  autoPush: false,
  debounceMs: 30000,
  commitType: "feat",
};

function normalizeRepoKey(repoPath) {
  const resolved = path.resolve(repoPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function getConfigPath() {
  return CONFIG_PATH;
}

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      defaults: { ...DEFAULTS, ...(parsed.defaults ?? {}) },
      repos: parsed.repos ?? {},
    };
  } catch {
    return { defaults: { ...DEFAULTS }, repos: {} };
  }
}

export async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function getRepoSettings(config, repoPath) {
  const key = normalizeRepoKey(repoPath);
  const repo = config.repos[key];
  if (!repo) {
    return null;
  }
  return {
    path: repo.path,
    enabled: repo.enabled ?? config.defaults.enabled,
    autoPush: repo.autoPush ?? config.defaults.autoPush,
    debounceMs: repo.debounceMs ?? config.defaults.debounceMs,
    commitType: repo.commitType ?? config.defaults.commitType,
  };
}

export async function ensureRepo(config, repoPath) {
  const key = normalizeRepoKey(repoPath);
  if (!config.repos[key]) {
    config.repos[key] = {
      path: path.resolve(repoPath),
      enabled: config.defaults.enabled,
      autoPush: config.defaults.autoPush,
      debounceMs: config.defaults.debounceMs,
      commitType: config.defaults.commitType,
    };
  }
  return config.repos[key];
}

export async function registerRepo(repoPath) {
  const config = await loadConfig();
  await ensureRepo(config, repoPath);
  await saveConfig(config);
  return getRepoSettings(config, repoPath);
}

export async function updateRepoSettings(repoPath, patch) {
  const config = await loadConfig();
  const current = await ensureRepo(config, repoPath);
  config.repos[normalizeRepoKey(repoPath)] = {
    ...current,
    ...patch,
    path: path.resolve(repoPath),
  };
  await saveConfig(config);
  return getRepoSettings(config, repoPath);
}

export async function removeRepo(repoPath) {
  const config = await loadConfig();
  delete config.repos[normalizeRepoKey(repoPath)];
  await saveConfig(config);
}

export function listRepoSettings(config) {
  return Object.values(config.repos).map((repo) => ({
    path: repo.path,
    enabled: repo.enabled ?? config.defaults.enabled,
    autoPush: repo.autoPush ?? config.defaults.autoPush,
    debounceMs: repo.debounceMs ?? config.defaults.debounceMs,
    commitType: repo.commitType ?? config.defaults.commitType,
  }));
}
