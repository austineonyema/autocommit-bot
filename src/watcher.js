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
const DEFAULT_MAX_COMMIT_INTERVAL_MS = 120000;
const DEFAULT_MIN_COMMIT_INTERVAL_MS = 20000;
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
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (state.maxIntervalTimer) clearTimeout(state.maxIntervalTimer);
      if (state.minIntervalTimer) clearTimeout(state.minIntervalTimer);
      shutdown.push(state.watcher.close());
    }
    await Promise.allSettled(shutdown);
    this.states.clear();
  }

  applyTimingSettings(state, settings) {
    const debounceMs = Number(settings.debounceMs);
    const maxCommitIntervalMs = Number(settings.maxCommitIntervalMs);
    const minCommitIntervalMs = Number(settings.minCommitIntervalMs);

    state.debounceMs = debounceMs > 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
    state.maxCommitIntervalMs =
      Number.isFinite(maxCommitIntervalMs) && maxCommitIntervalMs >= 0
        ? maxCommitIntervalMs
        : DEFAULT_MAX_COMMIT_INTERVAL_MS;
    state.minCommitIntervalMs =
      Number.isFinite(minCommitIntervalMs) && minCommitIntervalMs >= 0
        ? minCommitIntervalMs
        : DEFAULT_MIN_COMMIT_INTERVAL_MS;
  }

  async startWatcher(repoPath) {
    const config = await loadConfig();
    const settings = getRepoSettings(config, repoPath);
    const initialSettings = {
      debounceMs: settings?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxCommitIntervalMs:
        settings?.maxCommitIntervalMs ?? DEFAULT_MAX_COMMIT_INTERVAL_MS,
      minCommitIntervalMs:
        settings?.minCommitIntervalMs ?? DEFAULT_MIN_COMMIT_INTERVAL_MS,
    };

    const watcher = chokidar.watch(repoPath, {
      ignored: shouldIgnore,
      ignoreInitial: true,
      persistent: true,
    });

    const state = {
      watcher,
      idleTimer: null,
      maxIntervalTimer: null,
      minIntervalTimer: null,
      inFlight: false,
      pending: false,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      maxCommitIntervalMs: DEFAULT_MAX_COMMIT_INTERVAL_MS,
      minCommitIntervalMs: DEFAULT_MIN_COMMIT_INTERVAL_MS,
      lastCommitAt: 0,
      lastEvent: "pending",
      lastFilePath: "pending",
    };
    this.applyTimingSettings(state, initialSettings);

    watcher.on("all", (event, filePath) => {
      state.pending = true;
      state.lastEvent = event;
      state.lastFilePath = filePath;
      this.scheduleIdleFlush(repoPath, event, filePath);
      this.scheduleMaxIntervalFlush(repoPath);
    });
    watcher.on("error", (error) => {
      this.logger(`[watch:${path.basename(repoPath)}] watcher error: ${error.message}`);
    });

    this.states.set(repoPath, state);
  }

  scheduleIdleFlush(repoPath, event, filePath) {
    const state = this.states.get(repoPath);
    if (!state) return;

    if (state.idleTimer) clearTimeout(state.idleTimer);

    state.idleTimer = setTimeout(async () => {
      state.idleTimer = null;
      await this.flush(repoPath, {
        reason: "idle",
        event,
        filePath,
      });
    }, state.debounceMs);
  }

  scheduleMaxIntervalFlush(repoPath) {
    const state = this.states.get(repoPath);
    if (!state) return;

    if (state.maxCommitIntervalMs <= 0 || state.maxIntervalTimer) {
      return;
    }

    state.maxIntervalTimer = setTimeout(async () => {
      state.maxIntervalTimer = null;
      await this.flush(repoPath, {
        reason: "max-interval",
        event: state.lastEvent,
        filePath: state.lastFilePath,
      });
    }, state.maxCommitIntervalMs);
  }

  scheduleMinIntervalFlush(repoPath, waitMs) {
    const state = this.states.get(repoPath);
    if (!state || waitMs <= 0) return;

    if (state.minIntervalTimer) {
      return;
    }

    state.minIntervalTimer = setTimeout(async () => {
      state.minIntervalTimer = null;
      await this.flush(repoPath, {
        reason: "min-interval",
        event: state.lastEvent,
        filePath: state.lastFilePath,
      });
    }, waitMs);
  }

  clearMaxIntervalTimer(state) {
    if (!state.maxIntervalTimer) return;
    clearTimeout(state.maxIntervalTimer);
    state.maxIntervalTimer = null;
  }

  clearMinIntervalTimer(state) {
    if (!state.minIntervalTimer) return;
    clearTimeout(state.minIntervalTimer);
    state.minIntervalTimer = null;
  }

  async flush(repoPath, trigger) {
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

      this.applyTimingSettings(state, settings);
      if (state.maxCommitIntervalMs <= 0) {
        this.clearMaxIntervalTimer(state);
      }
      if (state.minCommitIntervalMs <= 0) {
        this.clearMinIntervalTimer(state);
      }

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

      const now = Date.now();
      if (
        state.minCommitIntervalMs > 0 &&
        state.lastCommitAt > 0 &&
        now - state.lastCommitAt < state.minCommitIntervalMs
      ) {
        const waitMs = state.minCommitIntervalMs - (now - state.lastCommitAt);
        state.pending = true;
        this.scheduleMinIntervalFlush(repoPath, waitMs);
        return;
      }

      await stageAll(repoPath);

      if (!(await hasStagedChanges(repoPath))) {
        this.clearMaxIntervalTimer(state);
        this.clearMinIntervalTimer(state);
        return;
      }

      const summary = await generateSummary(repoPath, branch);
      const timestamp = formatTimestamp();
      const message = `${settings.commitType}(${branch}): auto [${timestamp}] AI: ${oneLine(
        summary,
      )}`;

      await commit(repoPath, message);
      state.lastCommitAt = Date.now();
      this.clearMaxIntervalTimer(state);
      this.clearMinIntervalTimer(state);
      this.logger(
        `[commit:${path.basename(repoPath)}] ${message} (triggered by ${trigger.reason}: ${trigger.event} ${trigger.filePath})`,
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
        this.scheduleIdleFlush(repoPath, state.lastEvent, state.lastFilePath);
        this.scheduleMaxIntervalFlush(repoPath);
      }
    }
  }
}
