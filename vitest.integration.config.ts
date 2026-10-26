import { defineConfig } from "vitest/config";

// Evaluated before anything else runs: no TEST_DATABASE_URL, no run.
// There is deliberately no fallback to any other connection variable.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Integration tests need an explicit disposable database (see pnpm test:db:start)."
  );
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // Pinned: the snapshots must not depend on the machine time zone.
      TZ: "UTC",
      DATABASE_URL: testDatabaseUrl,
      APP_SECRET: "test-only-secret-at-least-32-characters-long",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
  },
});
