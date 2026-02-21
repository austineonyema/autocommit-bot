import path from "node:path";
import type { RepoSettings } from "./config.js";
import {
  getConfigPath,
  getRepoSettings,
  listRepoSettings,
  loadConfig,
  registerRepo,
  removeRepo,
  updateRepoSettings,
} from "./config.js";
import { ensureRepoRoot } from "./git.js";
import { AutoCommitDaemon } from "./watcher.js";

function printHelp(): void {
  console.log(`
autocommit - branch-aware auto-commit daemon

Usage:
  autocommit watch [repoPath ...]
  autocommit register [repoPath]
  autocommit unregister [repoPath]
  autocommit repos
  autocommit status [repoPath]
  autocommit on [repoPath]
  autocommit off [repoPath]
  autocommit push on [repoPath]
  autocommit push off [repoPath]
  autocommit debounce <ms> [repoPath]
  autocommit max-interval <ms> [repoPath]
  autocommit min-interval <ms> [repoPath]
  autocommit type <commitType> [repoPath]

Notes:
  - repoPath defaults to current working directory.
  - "watch" without repoPath watches all registered repos.
  - max-interval=0 disables forced periodic commits.
  - min-interval=0 disables commit spacing guard.
  - Config file: ${getConfigPath()}
  - Set OPENAI_API_KEY to enable OpenAI-generated summary fragments.
`.trim());
}

async function resolveRepoPath(inputPath?: string): Promise<string> {
  const source = inputPath ? path.resolve(inputPath) : process.cwd();
  return ensureRepoRoot(source);
}

async function resolveManyRepoPaths(paths: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const inputPath of paths) {
    const repoRoot = await resolveRepoPath(inputPath);
    if (!resolved.includes(repoRoot)) {
      resolved.push(repoRoot);
    }
  }
  return resolved;
}

function printRepo(settings: RepoSettings): void {
  console.log(
    `${settings.path}
  enabled=${settings.enabled}
  autoPush=${settings.autoPush}
  debounceMs=${settings.debounceMs}
  maxCommitIntervalMs=${settings.maxCommitIntervalMs}
  minCommitIntervalMs=${settings.minCommitIntervalMs}
  commitType=${settings.commitType}`,
  );
}

async function commandRegister(args: string[]): Promise<void> {
  const repoPath = await resolveRepoPath(args[0]);
  const settings = await registerRepo(repoPath);
  console.log(`[register] ${settings.path}`);
  printRepo(settings);
}

async function commandUnregister(args: string[]): Promise<void> {
  const repoPath = await resolveRepoPath(args[0]);
  await removeRepo(repoPath);
  console.log(`[unregister] ${repoPath}`);
}

async function commandRepos(): Promise<void> {
  const config = await loadConfig();
  const repos = listRepoSettings(config);
  if (!repos.length) {
    console.log("No registered repos.");
    return;
  }
  for (const repo of repos) {
    printRepo(repo);
  }
}

async function commandStatus(args: string[]): Promise<void> {
  const repoPath = await resolveRepoPath(args[0]);
  const config = await loadConfig();
  const settings = getRepoSettings(config, repoPath);

  if (!settings) {
    console.log(`[status] ${repoPath} is not registered`);
    return;
  }
  printRepo(settings);
}

async function commandEnabled(enabled: boolean, args: string[]): Promise<void> {
  const repoPath = await resolveRepoPath(args[0]);
  const settings = await updateRepoSettings(repoPath, { enabled });
  console.log(`[enabled=${enabled}] ${settings.path}`);
}

async function commandPush(autoPush: boolean, args: string[]): Promise<void> {
  const repoPath = await resolveRepoPath(args[1]);
  const settings = await updateRepoSettings(repoPath, { autoPush });
  console.log(`[autoPush=${autoPush}] ${settings.path}`);
}

async function commandDebounce(args: string[]): Promise<void> {
  const debounceMs = Number(args[0]);
  if (!Number.isFinite(debounceMs) || debounceMs < 1000) {
    throw new Error("debounce must be a number >= 1000");
  }
  const repoPath = await resolveRepoPath(args[1]);
  const settings = await updateRepoSettings(repoPath, { debounceMs });
  console.log(`[debounceMs=${settings.debounceMs}] ${settings.path}`);
}

async function commandType(args: string[]): Promise<void> {
  const commitType = (args[0] ?? "").trim();
  if (!commitType) {
    throw new Error("commit type cannot be empty");
  }
  if (/\s/.test(commitType)) {
    throw new Error("commit type cannot contain spaces");
  }
  const repoPath = await resolveRepoPath(args[1]);
  const settings = await updateRepoSettings(repoPath, { commitType });
  console.log(`[commitType=${settings.commitType}] ${settings.path}`);
}

async function commandMaxInterval(args: string[]): Promise<void> {
  const maxCommitIntervalMs = Number(args[0]);
  if (!Number.isFinite(maxCommitIntervalMs) || maxCommitIntervalMs < 0) {
    throw new Error("max-interval must be a number >= 0");
  }
  const repoPath = await resolveRepoPath(args[1]);
  const settings = await updateRepoSettings(repoPath, { maxCommitIntervalMs });
  console.log(`[maxCommitIntervalMs=${settings.maxCommitIntervalMs}] ${settings.path}`);
}

async function commandMinInterval(args: string[]): Promise<void> {
  const minCommitIntervalMs = Number(args[0]);
  if (!Number.isFinite(minCommitIntervalMs) || minCommitIntervalMs < 0) {
    throw new Error("min-interval must be a number >= 0");
  }
  const repoPath = await resolveRepoPath(args[1]);
  const settings = await updateRepoSettings(repoPath, { minCommitIntervalMs });
  console.log(`[minCommitIntervalMs=${settings.minCommitIntervalMs}] ${settings.path}`);
}

async function commandWatch(args: string[]): Promise<void> {
  let repoPaths: string[] = [];

  if (args.length > 0) {
    repoPaths = await resolveManyRepoPaths(args);
    for (const repoPath of repoPaths) {
      await registerRepo(repoPath);
    }
  } else {
    const config = await loadConfig();
    repoPaths = listRepoSettings(config).map((repo) => repo.path);
    if (!repoPaths.length) {
      const repoPath = await resolveRepoPath();
      await registerRepo(repoPath);
      repoPaths = [repoPath];
    }
  }

  const daemon = new AutoCommitDaemon(repoPaths, (line) => console.log(line));
  await daemon.start();

  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[running] watching ${repoPaths.length} repo(s)`);
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "watch":
    case "start":
      await commandWatch(args);
      return;
    case "register":
      await commandRegister(args);
      return;
    case "unregister":
      await commandUnregister(args);
      return;
    case "repos":
      await commandRepos();
      return;
    case "status":
      await commandStatus(args);
      return;
    case "on":
      await commandEnabled(true, args);
      return;
    case "off":
      await commandEnabled(false, args);
      return;
    case "push":
      if (args[0] === "on") {
        await commandPush(true, args);
        return;
      }
      if (args[0] === "off") {
        await commandPush(false, args);
        return;
      }
      throw new Error("Usage: autocommit push <on|off> [repoPath]");
    case "debounce":
      await commandDebounce(args);
      return;
    case "max-interval":
      await commandMaxInterval(args);
      return;
    case "min-interval":
      await commandMinInterval(args);
      return;
    case "type":
      await commandType(args);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
