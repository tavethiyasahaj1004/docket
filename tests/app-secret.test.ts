import { afterEach, describe, expect, it, vi } from "vitest";
import { warnIfWeakAppSecret } from "@/lib/app-secret";

describe("warnIfWeakAppSecret", () => {
  it("warns for a secret under 32 characters, without printing it", () => {
    const warn = vi.fn();
    const secret = "short-secret-31-characters-long";
    expect(secret).toHaveLength(31);
    expect(warnIfWeakAppSecret(secret, warn)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("APP_SECRET is shorter than 32 characters");
    expect(message).not.toContain(secret);
  });

  it("stays quiet for 32 characters or more", () => {
    const warn = vi.fn();
    expect(warnIfWeakAppSecret("x".repeat(32), warn)).toBe(false);
    expect(warnIfWeakAppSecret("x".repeat(64), warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a missing secret to env validation", () => {
    const warn = vi.fn();
    expect(warnIfWeakAppSecret(undefined, warn)).toBe(false);
    expect(warnIfWeakAppSecret("", warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("instrumentation register()", () => {
  const saved = {
    runtime: process.env.NEXT_RUNTIME,
    secret: process.env.APP_SECRET,
  };
  afterEach(() => {
    process.env.NEXT_RUNTIME = saved.runtime;
    process.env.APP_SECRET = saved.secret;
    vi.restoreAllMocks();
  });

  it("warns at server start when APP_SECRET is short, and boot goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.APP_SECRET = "too-short";
    const { register } = await import("@/instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toContain("too-short");
  });

  it("logs nothing for a long enough secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.APP_SECRET = "x".repeat(40);
    const { register } = await import("@/instrumentation");
    await register();
    expect(warn).not.toHaveBeenCalled();
  });
});
