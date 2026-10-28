"use client";

import {
  ArrowLeft,
  ChartBar,
  Envelope,
  SignOut,
  Stack,
  Users,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { PRODUCT_NAME } from "@/config/platform";

const navItems = [
  { href: "/orbit", label: "Overview", icon: ChartBar, exact: true },
  { href: "/orbit/users", label: "Users", icon: Users, exact: false },
  { href: "/orbit/queues", label: "Queues", icon: Stack, exact: false },
  { href: "/orbit/email", label: "Email", icon: Envelope, exact: false },
];

export function AdminSidebar({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-content">
      {/* Brand */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-5">
        <span className="grid size-9 shrink-0 place-items-center bg-sidebar-primary font-black text-sidebar-primary-content text-xs">
          KR
        </span>
        <div className="min-w-0">
          <p className="font-black text-sm leading-none">{PRODUCT_NAME}</p>
          <p className="mt-1 text-2xs font-semibold uppercase tracking-ui text-sidebar-content/40">
            Admin Panel
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-5">
        <p className="mb-2 px-3 text-2xs font-semibold uppercase tracking-ui text-sidebar-content/30">
          Navigation
        </p>
        <div className="space-y-0.5">
          {navItems.map(({ href, label, icon: Icon, exact }) => {
            const isActive = exact
              ? pathname === href
              : pathname.startsWith(href);
            return (
              <Link
                className={`flex items-center gap-3 border-l-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-ui transition-colors ${
                  isActive
                    ? "border-sidebar-content bg-sidebar-accent text-sidebar-content"
                    : "border-transparent text-sidebar-content/50 hover:border-sidebar-content/20 hover:bg-sidebar-accent hover:text-sidebar-content"
                }`}
                href={href}
                key={href}
              >
                <Icon size={15} weight={isActive ? "fill" : "regular"} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="space-y-2 border-t border-sidebar-border p-4">
        <p className="truncate px-1 text-2xs font-semibold uppercase tracking-ui text-sidebar-content/30">
          {email}
        </p>
        <Button
          asChild
          className="w-full justify-start gap-2"
          size="sm"
          variant="secondary"
        >
          <Link href="/dashboard">
            <ArrowLeft size={14} />
            Dashboard
          </Link>
        </Button>
        <form action={logoutAction}>
          <Button
            className="w-full justify-start gap-2"
            size="sm"
            type="submit"
            variant="secondary"
          >
            <SignOut size={14} />
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );
}
