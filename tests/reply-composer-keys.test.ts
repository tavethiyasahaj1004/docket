import { describe, expect, it } from "vitest";
import {
  resolveSendReplyOnEnterPref,
  shouldSendOnEnter,
} from "@/lib/reply-composer-keys";

// The reply composer (components/common/rich-text-editor.tsx) delegates its
// Tiptap `handleKeyDown` submit-vs-newline decision to shouldSendOnEnter, so
// this exercises the exact same logic without needing a DOM/editor instance.

describe("shouldSendOnEnter", () => {
  it("sends on plain Enter when the preference is on (default behavior)", () => {
    expect(
      shouldSendOnEnter({
        hasSubmit: true,
        isComposing: false,
        sendOnEnter: true,
        shiftKey: false,
      })
    ).toBe(true);
  });

  it("does not send on plain Enter when the preference is off — creates a newline instead", () => {
    expect(
      shouldSendOnEnter({
        hasSubmit: true,
        isComposing: false,
        sendOnEnter: false,
        shiftKey: false,
      })
    ).toBe(false);
  });

  it("never sends on Shift+Enter, regardless of the preference", () => {
    expect(
      shouldSendOnEnter({
        hasSubmit: true,
        isComposing: false,
        sendOnEnter: true,
        shiftKey: true,
      })
    ).toBe(false);
    expect(
      shouldSendOnEnter({
        hasSubmit: true,
        isComposing: false,
        sendOnEnter: false,
        shiftKey: true,
      })
    ).toBe(false);
  });

  it("never sends while composing an IME input, even with the preference on", () => {
    expect(
      shouldSendOnEnter({
        hasSubmit: true,
        isComposing: true,
        sendOnEnter: true,
        shiftKey: false,
      })
    ).toBe(false);
  });

  it("never sends when the composer has no onSubmit handler (e.g. canned responses, email templates)", () => {
    expect(
      shouldSendOnEnter({
        hasSubmit: false,
        isComposing: false,
        sendOnEnter: true,
        shiftKey: false,
      })
    ).toBe(false);
  });
});

describe("resolveSendReplyOnEnterPref", () => {
  it("defaults to true when the agent has no saved preference row yet", () => {
    expect(resolveSendReplyOnEnterPref(undefined)).toBe(true);
  });

  it("respects a saved true value", () => {
    expect(resolveSendReplyOnEnterPref({ sendReplyOnEnter: true })).toBe(true);
  });

  it("respects a saved false value", () => {
    expect(resolveSendReplyOnEnterPref({ sendReplyOnEnter: false })).toBe(
      false
    );
  });
});
