# git-autocommit-flow

Standalone, branch-aware auto-commit daemon for one or many repos.

It watches file changes, stages safely per repo, commits with timestamped AI-style summaries, and can optionally auto-push.

## Commit message format

```text
feat(<branch>): auto [YYYY-MM-DD HH:mm:ss] AI: <summary>
```

Example:

```text
feat(dashboard): auto [2026-02-21 16:48:12] AI: optimize performance exports and clean unused imports
```

## Why this avoids repo mixups

- Every git operation runs with `git -C <repoRoot> ...`.
- Watch queues are isolated per repo.
- Branch is detected right before each commit (`git branch --show-current`).

## Install

### Option 1: clone + local run

```bash
git clone <your-repo-url>
cd autocommit-bot
npm install
npm run build
node ./bin/autocommit.js --help
```

### Option 2: global install

```bash
npm install -g .
autocommit --help
```

## Commands

```bash
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
```

Notes:

- `repoPath` defaults to current directory.
- `watch` without arguments watches all registered repos.
- `max-interval=0` disables forced periodic commits.
- `min-interval=0` disables minimum spacing between commits.
- If a branch has no upstream and auto-push is on, first push uses `git push -u origin <branch>`.

## Cadence model

Commits can happen from three triggers:

- `idle`: no file changes for `debounce` duration.
- `max-interval`: long continuous activity forces checkpoint commits.
- `min-interval`: spacing guard that prevents over-frequent commits.

## OpenAI summary support (optional)

Set an API key to generate richer summary text:

```bash
export OPENAI_API_KEY=...
```

PowerShell:

```powershell
$env:OPENAI_API_KEY="..."
```

Optional model override:

```bash
export AUTO_COMMIT_OPENAI_MODEL=gpt-4o-mini
```

Without `OPENAI_API_KEY`, it falls back to a deterministic local summary.

## Config location

Global config file:

```text
~/.autocommit-bot/config.json
```

Repo-level settings are stored under each repo entry in that config.

## Quick test flow

```bash
autocommit register .
autocommit debounce 2000 .
autocommit push off .
autocommit watch .
```

Then edit a file and wait a few seconds. Verify:

```bash
git log -1 --pretty=format:"%h %s"
```

## Publish checklist

```bash
npm install
npm run check
npm run test:smoke
npm publish --access public
```
