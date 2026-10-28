import { beforeEach, describe, expect, it, vi } from "vitest";
import * as limitsModule from "@/lib/tickets/attachment-limits";
import {
  ATTACHMENT_LIMIT_BOUNDS,
  checkTicketStorage,
  DEFAULT_ATTACHMENT_LIMITS,
  mbToBytes,
  resolveAttachmentLimits,
  ticketStorageError,
  validateAttachmentLimitInput,
} from "@/lib/tickets/attachment-limits";

const storageMock = vi.hoisted(() => ({
  upload: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ storage: storageMock }));

import {
  decodeBase64Attachments,
  uploadDecodedAttachments,
} from "@/lib/tickets/api-attachments";

const valid = { maxPerMessage: 5, maxFileSizeMb: 10, maxPerTicketSizeMb: 250 };

describe("resolveAttachmentLimits", () => {
  it("defaults to 5 per message, 10 MB per file, 250 MB per ticket", () => {
    for (const raw of [undefined, null, {}]) {
      expect(resolveAttachmentLimits(raw)).toEqual({
        maxPerMessage: 5,
        maxFileSizeMb: 10,
        maxFileSizeBytes: 10 * 1024 * 1024,
        maxPerTicketSizeMb: 250,
        maxPerTicketSizeBytes: 250 * 1024 * 1024,
      });
    }
    expect(DEFAULT_ATTACHMENT_LIMITS).toEqual({
      maxPerMessage: 5,
      maxFileSizeMb: 10,
      maxPerTicketSizeMb: 250,
    });
  });

  it("uses valid saved values", () => {
    expect(
      resolveAttachmentLimits({
        attachmentMaxPerMessage: 3,
        attachmentMaxFileSizeMb: 2,
        attachmentMaxPerTicketSizeMb: 40,
      })
    ).toEqual({
      maxPerMessage: 3,
      maxFileSizeMb: 2,
      maxFileSizeBytes: 2 * 1024 * 1024,
      maxPerTicketSizeMb: 40,
      maxPerTicketSizeBytes: 40 * 1024 * 1024,
    });
  });

  it("falls back per field on invalid persisted values", () => {
    const r = resolveAttachmentLimits({
      attachmentMaxPerMessage: 0,
      attachmentMaxFileSizeMb: "abc",
    });
    expect(r.maxPerMessage).toBe(5);
    expect(r.maxFileSizeMb).toBe(10);
    for (const bad of [-3, 101, 2.5, null, Number.NaN]) {
      expect(
        resolveAttachmentLimits({ attachmentMaxFileSizeMb: bad }).maxFileSizeMb
      ).toBe(10);
    }
    expect(
      resolveAttachmentLimits({ attachmentMaxPerMessage: 21 }).maxPerMessage
    ).toBe(5);
    for (const bad of [0, -5, 10_001, 1.5, "250", null, Number.NaN]) {
      expect(
        resolveAttachmentLimits({ attachmentMaxPerTicketSizeMb: bad })
          .maxPerTicketSizeMb
      ).toBe(250);
    }
    expect(
      resolveAttachmentLimits({ attachmentMaxPerTicketSizeMb: 10_000 })
        .maxPerTicketSizeMb
    ).toBe(10_000);
  });

  it("ignores the legacy per-ticket column entirely", () => {
    const r = resolveAttachmentLimits({
      attachmentMaxPerMessage: 4,
      attachmentMaxPerTicket: 1,
    } as never);
    expect(r.maxPerMessage).toBe(4);
    expect("maxPerTicket" in r).toBe(false);
  });

  it("converts MB to bytes", () => {
    expect(mbToBytes(1)).toBe(1_048_576);
    expect(mbToBytes(25)).toBe(26_214_400);
    expect(
      resolveAttachmentLimits({ attachmentMaxPerTicketSizeMb: 1 })
        .maxPerTicketSizeBytes
    ).toBe(1_048_576);
  });
});

describe("no per-ticket attachment ceiling", () => {
  it("exports no ticket-wide limit helpers", () => {
    expect("remainingAttachmentSlots" in limitsModule).toBe(false);
    expect("exceedsTicketCeiling" in limitsModule).toBe(false);
    expect("MAX_ATTACHMENTS_PER_TICKET" in limitsModule).toBe(false);
  });
});

describe("validateAttachmentLimitInput", () => {
  it("accepts the defaults and the bounds", () => {
    expect(validateAttachmentLimitInput(valid)).toEqual({});
    expect(
      validateAttachmentLimitInput({
        maxPerMessage: 1,
        maxFileSizeMb: 1,
        maxPerTicketSizeMb: 1,
      })
    ).toEqual({});
    expect(
      validateAttachmentLimitInput({
        maxPerMessage: ATTACHMENT_LIMIT_BOUNDS.maxPerMessage.max,
        maxFileSizeMb: ATTACHMENT_LIMIT_BOUNDS.maxFileSizeMb.max,
        maxPerTicketSizeMb: ATTACHMENT_LIMIT_BOUNDS.maxPerTicketSizeMb.max,
      })
    ).toEqual({});
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["decimal", 2.5],
    ["NaN/empty", Number.NaN],
    ["huge", 1_000_000],
    ["string", "5"],
    ["undefined", undefined],
  ])("rejects %s", (_label, bad) => {
    expect(
      validateAttachmentLimitInput({ ...valid, maxFileSizeMb: bad })
        .maxFileSizeMb
    ).toBeTruthy();
    expect(
      validateAttachmentLimitInput({ ...valid, maxPerMessage: bad })
        .maxPerMessage
    ).toBeTruthy();
    expect(
      validateAttachmentLimitInput({ ...valid, maxPerTicketSizeMb: bad })
        .maxPerTicketSizeMb
    ).toBeTruthy();
  });

  it("rejects 10001 MB and a ticket cap below the per-file cap", () => {
    expect(
      validateAttachmentLimitInput({ ...valid, maxPerTicketSizeMb: 10_001 })
        .maxPerTicketSizeMb
    ).toBeTruthy();
    expect(
      validateAttachmentLimitInput({
        ...valid,
        maxFileSizeMb: 20,
        maxPerTicketSizeMb: 10,
      }).maxPerTicketSizeMb
    ).toContain("smaller");
    expect(
      validateAttachmentLimitInput({
        ...valid,
        maxFileSizeMb: 20,
        maxPerTicketSizeMb: 20,
      })
    ).toEqual({});
  });
});

describe("decodeBase64Attachments (per-message count + per-file size)", () => {
  const file = (bytes: number, name = "a.txt") => ({
    filename: name,
    mimeType: "text/plain",
    data: Buffer.alloc(bytes, 1).toString("base64"),
  });

  it("accepts a file exactly at the size limit, rejects one byte over", () => {
    const max = mbToBytes(1);
    expect(decodeBase64Attachments([file(max)], 5, max).ok).toBe(true);
    const over = decodeBase64Attachments([file(max + 1)], 5, max);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toContain("1 MB");
    }
  });

  it("enforces the per-message count at the boundary", () => {
    const max = mbToBytes(1);
    expect(decodeBase64Attachments([file(1), file(1)], 2, max).ok).toBe(true);
    const over = decodeBase64Attachments([file(1), file(1), file(1)], 2, max);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toContain("up to 2");
    }
  });

  it("depends on nothing about the ticket: valid messages always pass", () => {
    // The decoder takes no ticket attachment count at all, so a ticket holding
    // 26, 50 or 100+ files accepts the same valid message as an empty one.
    const max = mbToBytes(10);
    for (const _existing of [0, 26, 50, 100, 500]) {
      const r = decodeBase64Attachments(
        [file(1), file(2), file(3), file(4), file(5)],
        5,
        max
      );
      expect(r.ok).toBe(true);
    }
  });

  it("keeps rejecting disallowed types", () => {
    const r = decodeBase64Attachments(
      [
        {
          filename: "x.exe",
          mimeType: "application/x-msdownload",
          data: "AA==",
        },
      ],
      5,
      mbToBytes(10)
    );
    expect(r.ok).toBe(false);
  });
});

describe("uploadDecodedAttachments cleanup", () => {
  beforeEach(() => {
    storageMock.upload.mockReset();
    storageMock.delete.mockReset();
    storageMock.delete.mockResolvedValue(undefined);
  });

  const decoded = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      buffer: Buffer.from("x"),
      filename: `f${i}.txt`,
      fileSize: 1,
      mimeType: "text/plain",
    }));

  it("on a mid-request failure deletes only this request's uploads", async () => {
    storageMock.upload
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(uploadDecodedAttachments("t1", decoded(3))).rejects.toThrow(
      "disk full"
    );
    const uploadedKeys = storageMock.upload.mock.calls
      .slice(0, 2)
      .map((c) => c[0] as string);
    const deletedKeys = storageMock.delete.mock.calls.map((c) => c[0]);
    expect(deletedKeys.sort()).toEqual([...uploadedKeys].sort());
    for (const k of deletedKeys) {
      expect(k).toMatch(/^tickets\/t1\//);
    }
    expect(deletedKeys).toHaveLength(2);
  });

  it("deletes nothing on success", async () => {
    storageMock.upload.mockResolvedValue(undefined);
    const out = await uploadDecodedAttachments("t1", decoded(2));
    expect(out).toHaveLength(2);
    expect(storageMock.delete).not.toHaveBeenCalled();
  });
});

describe("checkTicketStorage (combined attachment size per ticket)", () => {
  const MB = 1024 * 1024;
  const limit = 250 * MB;

  it("accepts uploads that stay below the limit", () => {
    expect(
      checkTicketStorage({
        usedBytes: 100 * MB,
        incomingBytes: 10 * MB,
        limitBytes: limit,
      })
    ).toEqual({ ok: true });
  });

  it("accepts an upload that reaches the limit exactly", () => {
    expect(
      checkTicketStorage({
        usedBytes: 240 * MB,
        incomingBytes: 10 * MB,
        limitBytes: limit,
      })
    ).toEqual({ ok: true });
    expect(
      checkTicketStorage({
        usedBytes: 0,
        incomingBytes: limit,
        limitBytes: limit,
      })
    ).toEqual({ ok: true });
  });

  it("rejects an upload one byte over the limit", () => {
    const r = checkTicketStorage({
      usedBytes: 240 * MB,
      incomingBytes: 10 * MB + 1,
      limitBytes: limit,
    });
    expect(r).toEqual({
      ok: false,
      reason: "exceeds",
      remainingBytes: 10 * MB,
    });
    expect(
      checkTicketStorage({
        usedBytes: 0,
        incomingBytes: limit + 1,
        limitBytes: limit,
      })
    ).toMatchObject({ ok: false, reason: "exceeds" });
  });

  it("counts existing attachments against the allowance", () => {
    const r = checkTicketStorage({
      usedBytes: 200 * MB,
      incomingBytes: 60 * MB,
      limitBytes: limit,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "exceeds",
      remainingBytes: 50 * MB,
    });
  });

  it("treats a ticket at or above the limit as full (e.g. after a merge)", () => {
    expect(
      checkTicketStorage({
        usedBytes: limit,
        incomingBytes: 1,
        limitBytes: limit,
      })
    ).toEqual({ ok: false, reason: "full", remainingBytes: 0 });
    expect(
      checkTicketStorage({
        usedBytes: 300 * MB,
        incomingBytes: 1,
        limitBytes: limit,
      })
    ).toEqual({ ok: false, reason: "full", remainingBytes: 0 });
  });

  it("recovers once usage drops back under the limit", () => {
    expect(
      checkTicketStorage({
        usedBytes: 300 * MB,
        incomingBytes: MB,
        limitBytes: limit,
      }).ok
    ).toBe(false);
    expect(
      checkTicketStorage({
        usedBytes: 100 * MB,
        incomingBytes: MB,
        limitBytes: limit,
      }).ok
    ).toBe(true);
  });

  it("does not limit attachment count, only size", () => {
    // 5,000 tiny existing files (~5 MB total) never block a new file.
    expect(
      checkTicketStorage({
        usedBytes: 5000 * 1024,
        incomingBytes: 1024,
        limitBytes: limit,
      }).ok
    ).toBe(true);
  });

  it("a message with no attachments is never blocked, even on a full ticket", () => {
    expect(
      checkTicketStorage({
        usedBytes: 999 * MB,
        incomingBytes: 0,
        limitBytes: limit,
      })
    ).toEqual({ ok: true });
  });

  it("a new ticket's combined attachments over the limit are rejected", () => {
    // usedBytes is 0 for a new ticket; 3 x 100 MB > 250 MB.
    expect(
      checkTicketStorage({
        usedBytes: 0,
        incomingBytes: 300 * MB,
        limitBytes: limit,
      })
    ).toMatchObject({ ok: false, reason: "exceeds", remainingBytes: limit });
  });

  it("produces clear user-facing messages", () => {
    const full = checkTicketStorage({
      usedBytes: limit,
      incomingBytes: 1,
      limitBytes: limit,
    });
    const exceeds = checkTicketStorage({
      usedBytes: 245 * MB,
      incomingBytes: 10 * MB,
      limitBytes: limit,
    });
    if (!(full.ok || exceeds.ok)) {
      expect(ticketStorageError(full, 1, limit)).toContain(
        "reached its attachment storage limit"
      );
      const m = ticketStorageError(exceeds, 10 * MB, limit);
      expect(m).toContain("combined size");
      expect(m).toContain("10 MB");
      expect(m).toContain("5 MB of 250 MB");
    }
  });
});
