// Pure decision logic for the reply composer's Enter key, extracted out of
// components/common/rich-text-editor.tsx's Tiptap `handleKeyDown` so it can
// be unit tested without a DOM/editor instance.

export interface EnterKeyState {
  /** Whether an `onSubmit` callback was passed to the editor at all — canned
   * responses/email templates/the ticket description field never pass one,
   * so Enter always behaves as a normal newline for them regardless of the
   * user's preference. */
  hasSubmit: boolean;
  /** True mid-IME composition (e.g. composing Japanese/Chinese input) — Enter
   * confirms the composition and must never submit or insert a newline. */
  isComposing: boolean;
  /** The user's personal "Send reply on Enter" preference. Ignored unless
   * `hasSubmit` is true. */
  sendOnEnter: boolean;
  shiftKey: boolean;
}

/** True when this Enter keypress should submit the composer; false when it
 * should be left to insert a newline (or, if `hasSubmit` is false, left
 * entirely to the editor's default handling). */
export function shouldSendOnEnter({
  hasSubmit,
  isComposing,
  sendOnEnter,
  shiftKey,
}: EnterKeyState): boolean {
  if (isComposing || shiftKey) {
    return false;
  }
  return hasSubmit && sendOnEnter;
}

/** Resolves the saved sendReplyOnEnter row into the effective preference —
 * defaults to true (Enter sends) when the agent has no saved row yet, so
 * upgrades from versions predating this preference keep their prior
 * behavior. */
export function resolveSendReplyOnEnterPref(
  row: { sendReplyOnEnter: boolean } | undefined
): boolean {
  return row?.sendReplyOnEnter ?? true;
}
