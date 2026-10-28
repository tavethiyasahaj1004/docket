"use client";

import { SignOutIcon } from "@phosphor-icons/react";
import { logoutAction } from "@/app/actions/auth";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SignOutButton({ collapsed = false }: { collapsed?: boolean }) {
  // Uses the server action (signs out server-side + audit-logs + redirects to
  // /login) rather than the client `authClient.signOut()` HTTP call.
  const button = (
    <button
      aria-label="Sign out"
      className={cn(
        "flex w-full items-center rounded-md py-1.5 text-xs font-medium text-sidebar-content transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-content",
        collapsed ? "justify-center px-0" : "gap-2 px-2.5"
      )}
      type="submit"
    >
      <SignOutIcon className="size-3.5" />
      {!collapsed && "Sign out"}
    </button>
  );

  return (
    <form action={logoutAction} className="mt-2">
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">Sign out</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </form>
  );
}
