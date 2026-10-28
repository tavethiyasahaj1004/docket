"use client";

import { useActionState, useEffect, useState } from "react";
import {
  type ActionState,
  changeEmailAction,
  deleteAccountAction,
  updateNameAction,
} from "@/app/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: ActionState = {};

function ActionMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="rounded-md bg-success-subtle px-3 py-2 text-sm text-success-content">
        {state.success}
      </p>
    );
  }
  return null;
}

export function AccountIdentityForms({
  email,
  name,
}: {
  email: string;
  name: string;
}) {
  const [nameState, nameAction, namePending] = useActionState(
    updateNameAction,
    initialState
  );
  const [emailState, emailAction, emailPending] = useActionState(
    changeEmailAction,
    initialState
  );

  const [nameValue, setNameValue] = useState(name);
  const [savedName, setSavedName] = useState(name);
  // useActionState gives back a NEW state object exactly once per completed
  // submission — using it (not .success) as the effect dependency means this
  // only fires right after a save, never while the user keeps typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nameValue is read at the moment nameState changes, not tracked continuously — see comment above.
  useEffect(() => {
    if (nameState.success) {
      setSavedName(nameValue);
    }
  }, [nameState]);
  const nameChanged = nameValue.trim() !== savedName.trim();

  const [emailValue, setEmailValue] = useState(email);
  const [savedEmail, setSavedEmail] = useState(email);
  // biome-ignore lint/correctness/useExhaustiveDependencies: same as above, keyed on emailState.
  useEffect(() => {
    if (emailState.success) {
      setSavedEmail(emailValue);
    }
  }, [emailState]);
  const emailChanged =
    emailValue.trim().toLowerCase() !== savedEmail.trim().toLowerCase();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Display Name
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Shown in navigation, audit logs, and admin views.
          </p>
        </div>
        <form action={nameAction} className="space-y-3">
          <label className="block" htmlFor="name">
            <span className="mb-1.5 block text-xs font-medium text-base-content-muted">
              Name
            </span>
            <Input
              id="name"
              maxLength={100}
              name="name"
              onChange={(e) => setNameValue(e.target.value)}
              value={nameValue}
            />
          </label>
          <ActionMessage state={nameState} />
          <Button
            disabled={namePending || !nameChanged || !nameValue.trim()}
            type="submit"
          >
            {namePending ? "Saving…" : "Save name"}
          </Button>
        </form>
      </div>

      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-base-content">
            Email Address
          </h2>
          <p className="text-xs text-base-content-muted mt-0.5">
            Password and magic-link sign-in both use this address.
          </p>
        </div>
        <form action={emailAction} className="space-y-3">
          <label className="block" htmlFor="email">
            <span className="mb-1.5 block text-xs font-medium text-base-content-muted">
              Email
            </span>
            <Input
              id="email"
              name="email"
              onChange={(e) => setEmailValue(e.target.value)}
              required
              type="email"
              value={emailValue}
            />
          </label>
          <ActionMessage state={emailState} />
          <Button
            disabled={emailPending || !emailChanged || !emailValue.trim()}
            type="submit"
          >
            {emailPending ? "Saving…" : "Update email"}
          </Button>
        </form>
      </div>
    </div>
  );
}

export function DeleteAccountForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(
    deleteAccountAction,
    initialState
  );
  const [confirmEmail, setConfirmEmail] = useState("");
  const confirmed = confirmEmail.trim().toLowerCase() === email.toLowerCase();

  return (
    <div className="bg-base-100 rounded-xl border border-red-200 shadow-soft p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-red-600">Delete Account</h2>
        <p className="text-xs text-base-content-muted mt-0.5">
          Permanently delete your user, sessions, and linked sign-in methods.
          Audit records remain for operator history. This can&apos;t be undone.
        </p>
      </div>
      <form action={action} className="space-y-3">
        <label className="block" htmlFor="confirmEmail">
          <span className="mb-1.5 block text-xs font-medium text-base-content-muted">
            Type your email to confirm
          </span>
          <Input
            autoComplete="off"
            id="confirmEmail"
            name="confirmEmail"
            onChange={(e) => setConfirmEmail(e.target.value)}
            placeholder={email}
            value={confirmEmail}
          />
        </label>
        <ActionMessage state={state} />
        <Button
          disabled={pending || !confirmed}
          type="submit"
          variant="destructive"
        >
          {pending ? "Deleting…" : "Delete my account"}
        </Button>
      </form>
    </div>
  );
}
