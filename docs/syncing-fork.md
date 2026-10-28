# Syncing This Fork with Upstream

This repo is a fork (`origin` = `rajdhokai0928/docket`) tracking the original
project (`upstream` = `stack256org/docket`). Use this to pull upstream changes
into local `main` without asking for the steps each time.

## One-time setup (already done)

```bash
git remote add upstream https://github.com/stack256org/docket.git
```

Verify with `git remote -v` — you should see both `origin` and `upstream`.

## Pulling upstream changes

```bash
git fetch upstream
git log --oneline main..upstream/main   # preview incoming commits
git merge upstream/main --ff-only       # fast-forward local main
```

- `--ff-only` only works if local `main` has no commits upstream doesn't have.
  If it fails, local `main` has diverged (e.g. commits pushed only to
  `origin`) — stop and decide whether to rebase or merge instead of forcing.
- This updates local `main` only. `origin/main` (your fork on GitHub) is
  untouched until you explicitly push:

```bash
git push origin main
```

Confirm with the user before pushing to `origin`, since it's a shared/visible
change.
