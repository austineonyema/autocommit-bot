import chokidar from "chokidar";
import path from "node:path";
import {
  commit,
  getBranch,
  hasStagedChanges,
  hasUpstream,
  isGitOperationInProgress,
  push,
  pushSetUpstream,
  stageAll,
} from "./git.js";
import { getRepoSettings, loadConfig } from "./config.js";
import { generateSummary } from "./summarizer.js";

const DEFAULT_DEBOUNCE_MS = 30000;
const IGNORED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
];

function shouldIgnore(watchPath) {
  const normalized = watchPath.replace(/\\/g, "/");
  return IGNORED_DIRS.some(
    (segment) =>
      normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`),
  );
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

export class AutoCommitDaemon {
  constructor(repoPaths, logger = console.log) {
    this.repoPaths = [...new Set(repoPaths.map((repoPath) => path.resolve(repoPath)))];
    this.logger = logger;
    this.states = new Map();
  }

  async start() {
    for (const repoPath of this.repoPaths) {
      await this.startWatcher(repoPath);
      this.logger(`[watch] ${repoPath}`);
    }
  }

  async stop() {
    const shutdown = [];
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      shutdown.push(state.watcher.close());
    }
    await Promise.allSettled(shutdown);
    this.states.clear();
  }

  async startWatcher(repoPath) {
    const config = await loadConfig();
    const settings = getRepoSettings(config, repoPath);
    const initialDebounce =
      Number(settings?.debounceMs) > 0
        ? Number(settings.debounceMs)
        : DEFAULT_DEBOUNCE_MS;

    const watcher = chokidar.watch(repoPath, {
      ignored: shouldIgnore,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 1200,
        pollInterval: 200,
      },
    });

    const state = {
      watcher,
      timer: null,
      inFlight: false,
      pending: false,
      debounceMs: initialDebounce,
    };

    watcher.on("all", (event, filePath) => {
      state.pending = true;
      this.schedule(repoPath, event, filePath);
    });
    watcher.on("error", (error) => {
      this.logger(`[watch:${path.basename(repoPath)}] watcher error: ${error.message}`);
    });

    this.states.set(repoPath, state);
  }

  schedule(repoPath, event, filePath) {
    const state = this.states.get(repoPath);
    if (!state) return;

    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(async () => {
      state.timer = null;
      await this.flush(repoPath, event, filePath);
    }, state.debounceMs);
  }

  async flush(repoPath, event, filePath) {
    const state = this.states.get(repoPath);
    if (!state) return;

    if (state.inFlight) {
      state.pending = true;
      return;
    }

    state.inFlight = true;
    state.pending = false;

    try {
      const config = await loadConfig();
      const settings = getRepoSettings(config, repoPath);
      if (!settings) {
        this.logger(`[skip:${path.basename(repoPath)}] repo is not registered`);
        return;
      }

      state.debounceMs = Number(settings.debounceMs) || DEFAULT_DEBOUNCE_MS;

      if (!settings.enabled) {
        return;
      }

      if (await isGitOperationInProgress(repoPath)) {
        this.logger(`[skip:${path.basename(repoPath)}] merge/rebase/cherry-pick in progress`);
        return;
      }

      const branch = await getBranch(repoPath);
      if (!branch) {
        this.logger(`[skip:${path.basename(repoPath)}] detached HEAD`);
        return;
      }

      await stageAll(repoPath);

      if (!(await hasStagedChanges(repoPath))) {
        return;
      }

      const summary = await generateSummary(repoPath, branch);
      const timestamp = formatTimestamp();
      const message = `${settings.commitType}(${branch}): auto [${timestamp}] AI: ${oneLine(
        summary,
      )}`;

      await commit(repoPath, message);
      this.logger(
        `[commit:${path.basename(repoPath)}] ${message} (triggered by ${event}: ${filePath})`,
      );

      if (settings.autoPush) {
        if (await hasUpstream(repoPath)) {
          await push(repoPath);
        } else {
          await pushSetUpstream(repoPath, branch);
        }
        this.logger(`[push:${path.basename(repoPath)}] pushed ${branch}`);
      }
    } catch (error) {
      this.logger(`[error:${path.basename(repoPath)}] ${error?.message ?? error}`);
    } finally {
      state.inFlight = false;
      if (state.pending) {
        this.schedule(repoPath, "pending", "pending");
      }
    }
  }
}
