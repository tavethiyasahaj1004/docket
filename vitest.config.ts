import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolves the "@/..." aliases from tsconfig.json, so tests import modules
    // by the same specifier the app uses.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/integration/**"],
    // lib/env.ts validates process.env at module load, and most of what is
    // worth testing imports it transitively. These are throwaway values;
    // nothing in this suite opens a database connection or a network socket.
    // DATABASE_URL points at a dead port (1) so nothing can reach a real server.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
      APP_SECRET: "test-only-secret-at-least-32-characters-long",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
  },
});
