# Releasing

Everything ships from GitHub. Two workflows do the work, and neither needs a secret you
have to create: the built-in `GITHUB_TOKEN` covers all of it.

| Workflow | Runs on | What it does |
|----------|---------|--------------|
| [`ci.yml`](../.github/workflows/ci.yml) | Pull requests, pushes to `main` | Typecheck, lint, tests, build, plus migrations against a real PostgreSQL |
| [`release.yml`](../.github/workflows/release.yml) | A **successful** `ci.yml` run on `main` | Builds and publishes the image. If the version in `package.json` is new, also creates the tag and the GitHub Release. |

The two never run at the same time. `release.yml` is chained to CI's completion with a
`workflow_run` trigger, so on a push to `main` you get CI first, then Release — and a red
CI publishes nothing at all.

---

## Cutting a release

There is no tagging step. Once CI is green on `main`, `release.yml` reads the `version`
field in `package.json`. If no tag exists for it yet, that push is a release.

```bash
# 1. Bump the version
$EDITOR package.json          # "version": "0.2.0"

# 2. Write the notes. The section heading must match the version exactly,
#    because its contents become the body of the GitHub Release.
$EDITOR CHANGELOG.md          # ## [0.2.0] - 2026-08-14

# 3. Bring the README's tag ladder along with it. CI fails if you skip this.
pnpm docs:sync

# 4. Commit and push. That is the whole release.
git commit -am "Docket 0.2.0"
git push

# 5. Watch it. 10 to 20 minutes, because the ARM build is emulated.
gh run watch
```

That single push produces:

- the image, built for `linux/amd64` and `linux/arm64`
- image tags `0.2.0`, `0.2`, `0`, `latest`, `main` and `sha-<short>`
- the `v0.2.0` git tag
- the GitHub Release, with the changelog section as its body

Push to `main` **without** changing the version and you get an ordinary edge build: `main`
and `sha-<short>` only. No tag, no release, and `latest` stays where it was.

### Guard rails

The workflow stops before publishing anything if:

- the version is not plain `X.Y.Z`, so a typo cannot create a tag that then has to be
  deleted from a public repository
- `CHANGELOG.md` has no `## [<version>]` section, because a release with an empty body is
  worse than a failed build
- CI's **README is in step with the version** step fails, because `README.md`'s generated
  tag ladder no longer matches `package.json`. Run `pnpm docs:sync` and commit the result.

And after publishing, the **Anyone can pull it** job asks `ghcr.io` — anonymously, with no
credentials at all — whether a customer could actually pull what was just pushed. It does
not block the tag or the release, since the image is already published by then; it turns
the run red so a private package is caught here instead of by a customer.

---

## One-time setup

### 1. Make the package public, after the first successful build

This is the step that is easy to miss, and it is easy to miss because every signal a
maintainer sees is identical either way: the build is green, the tags exist, the release is
published. A new GitHub Packages entry is **private**, even in a public repository, so
`docker pull` fails for anyone who is not signed in — which for 0.1.0 meant every customer
following the README's own commands got a bare `403 Forbidden`.

1. Repository main page → **Packages** in the right-hand sidebar.
2. Click **docket**.
3. **Package settings → Danger Zone → Change visibility → Public.**

The **Anyone can pull it** job now fails the release run until this is done, so it is no
longer something you have to remember — but it still has to be done by hand once. GitHub
exposes no API for package visibility; the REST API covers only get, delete and restore, so
the web UI is the only way.

Use **Connect repository** while you are there if the package is not already linked. That
is what puts the README on the package page and the package in the repository sidebar.

Check it from a signed-out shell:

```bash
docker logout ghcr.io
docker pull ghcr.io/stack256org/docket:main
```

### 2. Check the owner name matches

The workflow itself needs no editing, because it uses `github.repository`. Everywhere else
the owner is written out as `stack256org`, so a fork under a different name has to update
it. `grep -rIn stack256org .` is the reliable check; at the time of writing that is:

| File | What to check |
|------|---------------|
| [`docker-compose.yml`](../docker-compose.yml), [`docker-compose.external-db.yml`](../docker-compose.external-db.yml), [`docker-compose.build.yml`](../docker-compose.build.yml) | the `x-image` default |
| [`README.md`](../README.md) | badge URLs, `git clone`, the `curl -O` quick-starts and the `ghcr.io/...` examples |
| [`Dockerfile`](../Dockerfile) | the OCI `org.opencontainers.image.*` label URLs |
| [`package.json`](../package.json) | `repository`, `bugs` and `homepage` |
| [`SECURITY.md`](../SECURITY.md), [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) | advisory and issue links |
| [`CHANGELOG.md`](../CHANGELOG.md) | the compare/tag link definitions at the foot |

The owner must also be **lowercase** in every `ghcr.io/...` reference. Container registries
reject capitals, which is what the `x-image` defaults and the `docker pull` examples feed.

---

## Checking a published release

```bash
docker pull ghcr.io/stack256org/docket:0.2.0
docker image inspect ghcr.io/stack256org/docket:0.2.0 --format '{{.Config.User}}'
# expect: node

# both architectures present?
docker buildx imagetools inspect ghcr.io/stack256org/docket:0.2.0 | grep -A1 Platform

# end to end, on the published image
curl -O https://raw.githubusercontent.com/stack256org/docket/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/stack256org/docket/main/.env.docker.example
# set APP_SECRET, then:
IMAGE_TAG=0.2.0 docker compose up -d
curl -s localhost:3000/api/health
# {"status":"ok","database":"ok","version":"0.2.0"}
```

The `version` in that health response comes from the `APP_VERSION` build argument, which
the workflow sets from the released version. It is the quickest way to confirm which build
a container is actually running. Edge builds report `main-<sha>` instead.

---

## Things that will bite you

- **A new package is private.** Covered above, and worth repeating because the symptom is
  confusing: the build goes green, the package page exists, and strangers still get
  `denied` or `manifest unknown` when they pull.
- **Do not split tag-then-build into two workflows.** A git tag pushed by a workflow using
  the built-in `GITHUB_TOKEN` does **not** trigger other workflows; GitHub blocks that to
  prevent recursion. A separate "tag it" workflow feeding a separate "build on tag"
  workflow looks tidier and quietly never builds anything. That is why `release.yml` does
  the build, the tag and the release in one run. (Chaining `release.yml` off `ci.yml` is
  fine and different: `workflow_run` fires on a workflow *completing*, not on a pushed tag.)
- **Never use bare `github.sha` in `release.yml`.** On a `workflow_run` event it points at
  the head of the default branch, not at the commit CI actually tested — so under a race it
  would tag and build the wrong commit. Every checkout, the `sha-` image tag and the release
  `--target` use `github.event.workflow_run.head_sha` instead.
- **Lowercase the image name.** Container registries reject uppercase repository names, and
  `github.repository` preserves whatever case the org was created with.
  `docker/metadata-action` quietly lowercases its `images:` input, so `--tag` values look
  fine while a raw `${{ github.repository }}` in `cache-from`/`cache-to` fails the build with
  `invalid reference format: repository name must be lowercase`. `release.yml` lowercases
  once into a step output and every consumer reads that.
- **`NEXT_PUBLIC_*` values are compiled in at build time.** The published image is built
  with the Pusher keys empty on purpose, because those values end up in the browser code
  and baking one operator's keys into a public image would hand them to everyone who
  downloads it. Do not "fix" this by adding them to the workflow's `build-args`.
- **ARM builds are slow**, because they run under emulation rather than on native
  hardware. The registry-backed build cache makes reruns much faster. Do not switch it to
  `type=gha`, which is capped at 10 GB per repository and evicts aggressively.
- **Re-releasing a version does nothing.** Once `v0.2.0` is tagged, pushing again with the
  same version in `package.json` produces an edge build and no release. To re-cut it you
  have to delete the tag and the release first, which is worth avoiding on a public
  repository.
- **Schema changes need their migration committed.** CI fails the migrations job
  otherwise, because that combination breaks the one-off `migrate` step on every fresh
  install.
- **Do not rename the `docket_pgdata` or `docket_uploads` volumes**, or the
  `docket` database, in a release. Renaming quietly orphans existing users' data. It
  is not deleted, just invisible to the new container, which is worse than an error.
