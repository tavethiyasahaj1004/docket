// Guided first-run setup (`pnpm setup`): validates env vars, runs migrations,
// seeds the default statuses and categories. Safe to re-run. Creating the first
// admin is a separate `pnpm create:admin` on purpose, so its success or failure
// is visible in your terminal rather than buried in a detached container.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile();
}

function run(cmd: string) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

const REQUIRED = ["DATABASE_URL", "APP_SECRET", "NEXT_PUBLIC_APP_URL"] as const;
const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `\n✗ Missing required environment variables: ${missing.join(", ")}\n` +
      "  Copy .env.example to .env and fill these in (APP_SECRET must be at least 32 characters)."
  );
  process.exit(1);
}

console.log("→ Running database migrations…");
run("pnpm db:migrate");

console.log("\n→ Seeding default statuses & categories…");
run("pnpm db:seed");

console.log(
  "\n✅ Setup complete. Start the app with `pnpm start` (and the worker with " +
    "`pnpm worker:start`), then open it in your browser — the first-run setup " +
    "wizard at /setup walks you through creating your admin account.\n" +
    "\nPrefer the command line? You can still run:\n" +
    '  pnpm create:admin you@example.com "Your Name" "a-strong-password"'
);
