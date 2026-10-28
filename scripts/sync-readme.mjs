#!/usr/bin/env node
// Keeps README.md's version-naming prose in step with package.json's `version`,
// the same field release.yml derives image tags from — so the two can never
// disagree, as they did when the README advertised tags that were never
// published. Run bare to rewrite the generated blocks, `--check` to fail CI.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");

// Lowercase, and matching release.yml's `images:` — registries reject capitals,
// and that workflow lowercases github.repository for the same reason.
const IMAGE = "ghcr.io/stack256org/docket";

const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
);

// The same shape release.yml enforces before it will tag anything. Checking it
// here too means a malformed version is caught by a lint-speed local command
// rather than after CI has run the full build.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version '${version}' is not X.Y.Z`);
  process.exit(1);
}

const major = version.split(".")[0];
const minor = version.split(".").slice(0, 2).join(".");

/** One entry per generated region: key = the name in the marker comment, value =
 * the exact text between the markers. Edit the prose HERE — anything typed into
 * README.md between the markers is what gets overwritten. */
const blocks = {
  // The tag ladder and the pinned-version example. `latest`, `main` and
  // `sha-<short>` are fixed names, but the ladder is entirely version-derived,
  // which is what drifted.
  "image-tags": `Pin a version in production, because \`latest\` moves with every release:

\`\`\`bash
IMAGE_TAG=${version} docker compose up -d
\`\`\`

Available tags are \`latest\`, the \`${major}\` / \`${minor}\` / \`${version}\` ladder, \`main\` (rebuilt on
every change, expect rough edges), and a fixed \`sha-<short>\` per build. Each carries builds
for both Intel and ARM machines:

\`\`\`bash
docker pull ${IMAGE}:${version}
\`\`\``,
};

const original = readFileSync(readmePath, "utf8");
let updated = original;

for (const [name, body] of Object.entries(blocks)) {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;

  // A missing marker means someone deleted it while editing the prose around
  // it. Failing loudly beats silently generating nothing and reporting success,
  // which would let the drift this script exists to prevent come straight back.
  if (!original.includes(begin) || !original.includes(end)) {
    console.error(`README.md is missing the ${begin} / ${end} markers.`);
    process.exit(1);
  }

  // Non-greedy, and anchored on the literal markers, so a second generated
  // block later in the file cannot be swallowed by this one's replacement.
  const region = new RegExp(
    `${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`
  );
  updated = updated.replace(region, `${begin}\n${body}\n${end}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const checkOnly = process.argv.includes("--check");

if (updated === original) {
  console.log(`README.md is in step with package.json (${version}).`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `::error file=README.md::README.md is out of date for version ${version}. Run 'pnpm docs:sync' and commit the result.`
  );
  process.exit(1);
}

writeFileSync(readmePath, updated);
console.log(`README.md updated for version ${version}.`);
