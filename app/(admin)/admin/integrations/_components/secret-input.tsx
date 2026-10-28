"use client";

import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import * as React from "react";
import { Input } from "@/components/ui/input";

interface Props {
  disabled?: boolean;
  hasSavedValue: boolean;
  id: string;
  onChange: (value: string) => void;
  value: string;
}

/** Password-style input for a secret field. Left blank, a save leaves the
 * stored value untouched — see the "Save" handlers in the sibling forms. */
export function SecretInput({
  id,
  value,
  onChange,
  hasSavedValue,
  disabled,
}: Props) {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        autoComplete="off"
        className="pr-10"
        disabled={disabled}
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hasSavedValue ? "Saved — leave blank to keep" : "Not set"}
        type={visible ? "text" : "password"}
        value={value}
      />
      <button
        aria-label={visible ? "Hide" : "Show"}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-base-content-muted hover:text-base-content transition-colors"
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
        type="button"
      >
        {visible ? (
          <EyeSlashIcon className="size-4" />
        ) : (
          <EyeIcon className="size-4" />
        )}
      </button>
    </div>
  );
}
