import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileUrlExpiresAt,
  parseFileKey,
  signFileUrl,
  verifyFileSignature,
} from "@/lib/file-access";

const KEY = "tickets/t1/abc123.png";
const at = (h: number, m = 0, s = 0, ms = 0) =>
  Date.UTC(2026, 9, 28, h, m, s, ms);

// Pulls exp and sig back out of a minted link.
function parts(url: string) {
  const u = new URL(url, "http://localhost");
  return { exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
}

describe("fileUrlExpiresAt", () => {
  it.each([
    [at(10, 0, 0, 0), at(12)],
    [at(10, 59), at(12)],
    [at(10, 59, 59, 999), at(12)],
    [at(11, 0, 0, 0), at(13)],
  ])("a link minted at %i expires at %i", (minted, expires) => {
    expect(fileUrlExpiresAt(minted)).toBe(expires);
  });

  it("lives more than one hour and at most two", () => {
    for (const minted of [at(10), at(10, 30), at(10, 59, 59, 999)]) {
      const life = fileUrlExpiresAt(minted) - minted;
      expect(life).toBeGreaterThan(60 * 60 * 1000);
      expect(life).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
    }
  });

  describe("in a non-UTC process time zone", () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it("uses the same whole UTC hours", () => {
      process.env.TZ = "Asia/Kolkata"; // +05:30
      expect(fileUrlExpiresAt(at(10, 59))).toBe(at(12));
      expect(fileUrlExpiresAt(at(11, 0))).toBe(at(13));
    });
  });
});

describe("signFileUrl", () => {
  it("points at /api/files with exp and sig", () => {
    const url = signFileUrl(KEY, at(10, 5));
    expect(url).toMatch(
      /^\/api\/files\/tickets\/t1\/abc123\.png\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/
    );
    expect(parts(url).exp).toBe(String(at(12) / 1000));
  });

  it("is byte-identical for one key within a clock hour", () => {
    expect(signFileUrl(KEY, at(10, 5))).toBe(signFileUrl(KEY, at(10, 55)));
    expect(signFileUrl(KEY, at(10, 59, 59, 999))).not.toBe(
      signFileUrl(KEY, at(11, 0))
    );
  });

  it("differs per key", () => {
    expect(parts(signFileUrl(KEY, at(10))).sig).not.toBe(
      parts(signFileUrl("tickets/t1/other.png", at(10))).sig
    );
  });

  it("encodes each key segment, and the decoded key verifies", () => {
    const odd = "tickets/t1/abc.p#g x";
    const url = signFileUrl(odd, at(10));
    expect(url.startsWith("/api/files/tickets/t1/abc.p%23g%20x?")).toBe(true);
    const { exp, sig } = parts(url);
    expect(verifyFileSignature(odd, exp, sig, at(10))).toBe(true);
  });
});

describe("verifyFileSignature", () => {
  const minted = at(10, 59);
  const { exp, sig } = parts(signFileUrl(KEY, minted));

  it("accepts a fresh link", () => {
    expect(verifyFileSignature(KEY, exp, sig, minted)).toBe(true);
  });

  it("accepts until the expiry instant and refuses from it", () => {
    expect(verifyFileSignature(KEY, exp, sig, at(11, 59, 59, 999))).toBe(true);
    expect(verifyFileSignature(KEY, exp, sig, at(12, 0, 0, 0))).toBe(false);
    expect(verifyFileSignature(KEY, exp, sig, at(15))).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const flipped = `${sig?.[0] === "A" ? "B" : "A"}${sig?.slice(1)}`;
    expect(verifyFileSignature(KEY, exp, flipped, minted)).toBe(false);
  });

  it("refuses a changed expiry, later or earlier, without re-signing", () => {
    const later = String(Number(exp) + 3600);
    const earlier = String(Number(exp) - 3600);
    expect(verifyFileSignature(KEY, later, sig, minted)).toBe(false);
    expect(verifyFileSignature(KEY, earlier, sig, minted)).toBe(false);
  });

  it("refuses a signature for another key", () => {
    expect(verifyFileSignature("tickets/t1/other.png", exp, sig, minted)).toBe(
      false
    );
  });

  it.each([
    [null, "x".repeat(43)],
    ["123", null],
    ["", "x".repeat(43)],
    ["12a", "x".repeat(43)],
    ["-1", "x".repeat(43)],
    ["1".repeat(16), "x".repeat(43)],
  ])("refuses malformed exp %j", (e, s) => {
    expect(verifyFileSignature(KEY, e, s, minted)).toBe(false);
  });

  it("refuses malformed signatures", () => {
    for (const bad of [
      "",
      "short",
      `${sig}=`,
      `${sig?.slice(0, 42)}+`,
      `${sig?.slice(0, 42)}/`,
      `${sig}A`,
    ]) {
      expect(verifyFileSignature(KEY, exp, bad, minted)).toBe(false);
    }
  });

  it("refuses a signature made with APP_SECRET or another derived key", () => {
    const secret = process.env.APP_SECRET ?? "";
    const raw = createHmac("sha256", secret)
      .update(`${exp}:${KEY}`)
      .digest("base64url");
    const sha = createHmac(
      "sha256",
      createHash("sha256").update(secret).digest()
    )
      .update(`${exp}:${KEY}`)
      .digest("base64url");
    expect(verifyFileSignature(KEY, exp, raw, minted)).toBe(false);
    expect(verifyFileSignature(KEY, exp, sha, minted)).toBe(false);
  });
});

describe("parseFileKey", () => {
  it("accepts ticket and branding keys", () => {
    expect(parseFileKey(["tickets", "t1", "abc.png"])).toEqual({
      key: "tickets/t1/abc.png",
      scope: "tickets",
    });
    expect(parseFileKey(["branding", "logo-x.png"])).toEqual({
      key: "branding/logo-x.png",
      scope: "branding",
    });
  });

  it.each([
    [["tickets"]],
    [["branding"]],
    [[]],
    [["uploads", "x.png"]],
    [["Tickets", "t1", "x.png"]],
    [["..", "etc", "passwd"]],
    [["tickets", "..", "..", "etc", "passwd"]],
    [["tickets", "t1", ".."]],
    [["tickets", ".", "x.png"]],
    [["branding", "..", "secret"]],
    [["tickets", "", "x.png"]],
    [["tickets", "t1/../x", "y"]],
    [["tickets", "t1", "..\\..\\x"]],
    [["tickets", "t1", "x\0.png"]],
  ])("refuses %j", (segments) => {
    expect(parseFileKey(segments)).toBeNull();
  });
});
