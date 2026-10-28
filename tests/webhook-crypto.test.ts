import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  signWebhookPayload,
} from "@/lib/crypto";

// Two separate jobs live in this module:
//   - the signature receivers verify (a public contract we must not break)
//   - encryption at rest for endpoint secrets

describe("signWebhookPayload", () => {
  const SECRET = "whsec_test";
  const BODY = '{"event":"ticket.created"}';
  const TS = 1_760_000_000;

  it("matches the algorithm published in docs/webhooks.md", () => {
    // Receivers have already written this exact computation against our docs.
    // If this test fails, their verification starts rejecting our deliveries.
    const expected = createHmac("sha256", SECRET)
      .update(`${TS}.${BODY}`)
      .digest("hex");
    expect(signWebhookPayload(SECRET, TS, BODY)).toBe(expected);
  });

  it("is stable for the same inputs", () => {
    expect(signWebhookPayload(SECRET, TS, BODY)).toBe(
      signWebhookPayload(SECRET, TS, BODY)
    );
  });

  it("changes when the body changes", () => {
    expect(signWebhookPayload(SECRET, TS, BODY)).not.toBe(
      signWebhookPayload(SECRET, TS, `${BODY} `)
    );
  });

  it("changes when the timestamp changes", () => {
    // This is what makes a captured delivery non-replayable: the receiver
    // rejects an old timestamp, and the attacker cannot re-sign a fresh one.
    expect(signWebhookPayload(SECRET, TS, BODY)).not.toBe(
      signWebhookPayload(SECRET, TS + 1, BODY)
    );
  });

  it("changes when the secret changes", () => {
    expect(signWebhookPayload(SECRET, TS, BODY)).not.toBe(
      signWebhookPayload("whsec_other", TS, BODY)
    );
  });

  it("produces a hex digest a receiver can timing-safe compare", () => {
    const sig = signWebhookPayload(SECRET, TS, BODY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHmac("sha256", SECRET)
      .update(`${TS}.${BODY}`)
      .digest("hex");
    expect(timingSafeEqual(Buffer.from(sig), Buffer.from(expected))).toBe(true);
  });

  it("cannot be forged by moving the separator", () => {
    // "12.34" + body must not collide with "1" + "2.34" + body.
    expect(signWebhookPayload(SECRET, 12, `34.${BODY}`)).not.toBe(
      signWebhookPayload(SECRET, 1234, BODY)
    );
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    const secret = generateWebhookSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each time", () => {
    // A fresh IV per encryption. Identical ciphertext for identical input
    // would leak which endpoints share a secret.
    const secret = "whsec_same";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("does not leave the plaintext visible in the stored value", () => {
    const secret = "whsec_do_not_leak_me";
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it("refuses to decrypt tampered ciphertext", () => {
    // AES-GCM is authenticated; flipping a byte must fail loudly rather than
    // return garbage that then gets used as a signing key.
    const encrypted = encryptSecret("whsec_test");
    const [iv, tag, ciphertext] = encrypted.split(":");
    const flipped = ciphertext.startsWith("a")
      ? `b${ciphertext.slice(1)}`
      : `a${ciphertext.slice(1)}`;
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it("refuses to decrypt with a tampered auth tag", () => {
    const encrypted = encryptSecret("whsec_test");
    const [iv, tag, ciphertext] = encrypted.split(":");
    const flipped = tag.startsWith("a")
      ? `b${tag.slice(1)}`
      : `a${tag.slice(1)}`;
    expect(() => decryptSecret(`${iv}:${flipped}:${ciphertext}`)).toThrow();
  });
});

describe("generateWebhookSecret", () => {
  it("is prefixed and long enough to be unguessable", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(secret.length).toBeGreaterThan(40);
  });

  it("never repeats", () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => generateWebhookSecret())
    );
    expect(seen.size).toBe(500);
  });
});
