import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

const execFileAsync = promisify(execFile);

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: unknown;
};

type GitOptions = ExecFileOptionsWithStringEncoding & {
  allowFailure?: boolean;
};

async function runCommand(
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      ...options,
    });

    return {
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
      code: 0,
    };
  } catch (error) {
    const typedError = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: (typedError.stdout ?? "").trim(),
      stderr: (typedError.stderr ?? "").trim(),
      code: typeof typedError.code === "number" ? typedError.code : 1,
      error,
    };
  }
}

export async function runGit(
  repoPath: string,
  args: string[],
  options: GitOptions = {},
): Promise<CommandResult> {
  const { allowFailure = false, ...execOptions } = options;
  const result = await runCommand("git", ["-C", repoPath, ...args], execOptions);
  if (result.code !== 0 && !allowFailure) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result;
}

export async function resolveRepoRoot(
  startPath: string = process.cwd(),
): Promise<string | null> {
  const result = await runCommand("git", [
    "-C",
    path.resolve(startPath),
    "rev-parse",
    "--show-toplevel",
  ]);

  if (result.code !== 0 || !result.stdout) {
    return null;
  }

  return path.resolve(result.stdout);
}

export async function ensureRepoRoot(
  inputPath: string = process.cwd(),
): Promise<string> {
  const repoRoot = await resolveRepoRoot(inputPath);
  if (!repoRoot) {
    throw new Error(`No git repository found from: ${path.resolve(inputPath)}`);
  }
  return repoRoot;
}

export async function getBranch(repoPath: string): Promise<string> {
  const result = await runGit(repoPath, ["branch", "--show-current"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function stageAll(repoPath: string): Promise<void> {
  await runGit(repoPath, ["add", "-A"]);
}

export async function hasStagedChanges(repoPath: string): Promise<boolean> {
  const result = await runGit(repoPath, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  return result.code === 1;
}

export async function getStagedNameStatus(repoPath: string): Promise<string> {
  const result = await runGit(repoPath, ["diff", "--cached", "--name-status"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function getStagedShortStat(repoPath: string): Promise<string> {
  const result = await runGit(repoPath, ["diff", "--cached", "--shortstat"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function commit(repoPath: string, message: string): Promise<void> {
  await runGit(repoPath, ["commit", "-m", message]);
}

export async function hasUpstream(repoPath: string): Promise<boolean> {
  const result = await runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { allowFailure: true },
  );
  return result.code === 0;
}

export async function push(repoPath: string): Promise<void> {
  await runGit(repoPath, ["push"]);
}

export async function pushSetUpstream(
  repoPath: string,
  branch: string,
): Promise<void> {
  await runGit(repoPath, ["push", "-u", "origin", branch]);
}

export async function getGitDir(repoPath: string): Promise<string> {
  const result = await runGit(repoPath, ["rev-parse", "--git-dir"]);
  return path.resolve(repoPath, result.stdout);
}

export async function isGitOperationInProgress(repoPath: string): Promise<boolean> {
  const gitDir = await getGitDir(repoPath);
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
  ];

  for (const marker of markers) {
    try {
      await fs.stat(path.join(gitDir, marker));
      return true;
    } catch {
      // not found
    }
  }

  return false;
}
