"use client";

import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  code: string;
  label?: string;
}

export function CodeBlock({ code, label }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="rounded-lg border border-base-300 bg-secondary overflow-hidden">
      {label && (
        <div className="flex items-center justify-between border-b border-base-300/60 px-3 py-1.5">
          <span className="text-2xs font-medium text-base-content-muted uppercase tracking-wide">
            {label}
          </span>
        </div>
      )}
      <div className="relative">
        <pre className="overflow-x-auto p-3.5 pr-10 text-xs leading-relaxed text-base-content">
          <code>{code}</code>
        </pre>
        <button
          className={cn(
            "absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-md text-base-content-muted transition-colors hover:bg-base-300 hover:text-base-content",
            copied && "text-green-600"
          )}
          onClick={handleCopy}
          title="Copy"
          type="button"
        >
          {copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
