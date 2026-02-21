import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runCommand(command, args, options = {}) {
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
    return {
      stdout: (error.stdout ?? "").trim(),
      stderr: (error.stderr ?? "").trim(),
      code: typeof error.code === "number" ? error.code : 1,
      error,
    };
  }
}

export async function runGit(repoPath, args, options = {}) {
  const result = await runCommand("git", ["-C", repoPath, ...args], options);
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result;
}

export async function resolveRepoRoot(startPath = process.cwd()) {
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

export async function ensureRepoRoot(inputPath = process.cwd()) {
  const repoRoot = await resolveRepoRoot(inputPath);
  if (!repoRoot) {
    throw new Error(`No git repository found from: ${path.resolve(inputPath)}`);
  }
  return repoRoot;
}

export async function getBranch(repoPath) {
  const result = await runGit(repoPath, ["branch", "--show-current"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function stageAll(repoPath) {
  await runGit(repoPath, ["add", "-A"]);
}

export async function hasStagedChanges(repoPath) {
  const result = await runGit(repoPath, ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  return result.code === 1;
}

export async function getStagedNameStatus(repoPath) {
  const result = await runGit(repoPath, ["diff", "--cached", "--name-status"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function getStagedShortStat(repoPath) {
  const result = await runGit(repoPath, ["diff", "--cached", "--shortstat"], {
    allowFailure: true,
  });
  return result.stdout;
}

export async function commit(repoPath, message) {
  await runGit(repoPath, ["commit", "-m", message]);
}

export async function hasUpstream(repoPath) {
  const result = await runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { allowFailure: true },
  );
  return result.code === 0;
}

export async function push(repoPath) {
  await runGit(repoPath, ["push"]);
}

export async function pushSetUpstream(repoPath, branch) {
  await runGit(repoPath, ["push", "-u", "origin", branch]);
}

export async function getGitDir(repoPath) {
  const result = await runGit(repoPath, ["rev-parse", "--git-dir"]);
  return path.resolve(repoPath, result.stdout);
}

export async function isGitOperationInProgress(repoPath) {
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
