"use client";

import {
  CaretLeftIcon,
  CaretRightIcon,
  ChartBarIcon,
  ChatTextIcon,
  ClockCounterClockwiseIcon,
  EnvelopeSimpleIcon,
  GearSixIcon,
  type Icon,
  KeyIcon,
  ListChecksIcon,
  PaintBrushIcon,
  PlugsIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
  TagIcon,
  TicketIcon,
  UsersIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/common/brand-mark";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ADMIN_ROLE } from "@/config/platform";
import { SIDEBAR_COOKIE, SIDEBAR_COOKIE_MAX_AGE } from "@/lib/sidebar";
import { cn, getInitials } from "@/lib/utils";
import { SignOutButton } from "./sign-out-button";

interface AgentSidebarProps {
  brandName: string;
  /** Server-read cookie value — renders the right width on first paint. */
  defaultCollapsed?: boolean;
  logoUrl: string | null;
  userEmail: string;
  userName: string;
  userRole: string;
}

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: SquaresFourIcon },
  { href: "/tickets", label: "All Tickets", icon: TicketIcon },
  { href: "/canned-responses", label: "Canned Responses", icon: ChatTextIcon },
  { href: "/settings", label: "Settings", icon: GearSixIcon },
];

const adminItems = [
  { href: "/admin/users", label: "Users", icon: UsersIcon },
  { href: "/admin/reports", label: "Reports", icon: ChartBarIcon },
  { href: "/admin/appearance", label: "Appearance", icon: PaintBrushIcon },
  { href: "/admin/integrations", label: "Integrations", icon: PlugsIcon },
  { href: "/admin/ticket-config", label: "Ticket Config", icon: TagIcon },
  {
    href: "/admin/custom-fields",
    label: "Custom Fields",
    icon: ListChecksIcon,
  },
  {
    href: "/admin/email-templates",
    label: "Email Templates",
    icon: EnvelopeSimpleIcon,
  },
  {
    href: "/admin/audit-log",
    label: "Audit Log",
    icon: ClockCounterClockwiseIcon,
  },
  { href: "/admin/api-keys", label: "API Keys", icon: KeyIcon },
  { href: "/admin/webhooks", label: "Webhooks", icon: WebhooksLogoIcon },
];

function NavLink({
  active,
  collapsed,
  href,
  icon: ItemIcon,
  label,
}: {
  active: boolean;
  collapsed: boolean;
  href: string;
  icon: Icon;
  label: string;
}) {
  const link = (
    <Link
      className={cn(
        "flex items-center rounded-md text-sm text-white transition-colors",
        collapsed ? "justify-center px-0 py-2" : "gap-3 px-3 py-2",
        active ? "font-medium bg-sidebar-accent" : "hover:bg-sidebar-accent",
        active && !collapsed && "border-l-2 border-sidebar-primary"
      )}
      href={href}
    >
      <ItemIcon
        className="size-4 shrink-0"
        weight={active ? "fill" : "regular"}
      />
      {!collapsed && label}
    </Link>
  );

  if (!collapsed) {
    return link;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function AgentSidebar({
  brandName,
  defaultCollapsed = false,
  logoUrl,
  userName,
  userEmail,
  userRole,
}: AgentSidebarProps) {
  const pathname = usePathname();
  const isAdmin = userRole === ADMIN_ROLE;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        // biome-ignore lint/suspicious/noDocumentCookie: the CookieStore API isn't supported in Safari/Firefox, and this is a single non-HttpOnly preference cookie
        document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "open"}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`;
      } catch {
        // Cookies may be unavailable (private mode) — the toggle still works
        // for this session, it just won't be remembered.
      }
      return next;
    });
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        className={cn(
          // `relative z-20` keeps the seam toggle painted above the top bar,
          // which is a later sibling in the layout.
          "bg-sidebar h-full flex flex-col shrink-0 relative z-20 transition-[width] duration-200 ease-out",
          collapsed ? "w-16" : "w-60"
        )}
        data-state={collapsed ? "collapsed" : "expanded"}
      >
        {/* Logo — h-14 matches the top bar so both bottom borders form one
            continuous horizontal line the toggle can sit on. */}
        <div
          className={cn(
            "h-14 shrink-0 flex items-center border-b border-sidebar-border",
            collapsed ? "justify-center px-2" : "px-4"
          )}
        >
          <Link
            className="flex items-center gap-2.5 min-w-0"
            href="/tickets"
            title={brandName}
          >
            <BrandMark
              fallbackIcon={
                <div className="size-7 rounded-md bg-sidebar-accent flex items-center justify-center shrink-0">
                  <TicketIcon
                    className="size-4 text-sidebar-accent-content"
                    weight="fill"
                  />
                </div>
              }
              imgClassName={cn(
                "h-7 object-contain",
                collapsed ? "w-7" : "w-auto max-w-40"
              )}
              logoUrl={logoUrl}
              name={brandName}
              textClassName={cn(
                "font-semibold text-sidebar-accent-content text-sm truncate",
                collapsed && "hidden"
              )}
            />
          </Link>
        </div>

        {/* Collapse toggle — centered on the seam where the sidebar's right
            edge crosses the top bar's bottom border, so the affordance reads
            as "grab the sidebar edge". */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              className="absolute top-14 right-0 z-20 flex size-6 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-base-300 bg-base-100 text-base-content-muted shadow-sm transition-colors hover:bg-base-300 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-base-200"
              onClick={toggle}
              type="button"
            >
              {collapsed ? (
                <CaretRightIcon className="size-3.5" weight="bold" />
              ) : (
                <CaretLeftIcon className="size-3.5" weight="bold" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{toggleLabel}</TooltipContent>
        </Tooltip>

        {/* Nav */}
        <nav
          className={cn(
            "flex-1 overflow-y-auto py-4 space-y-0.5",
            collapsed ? "px-2" : "px-3"
          )}
        >
          {navItems.map(({ href, label, icon: ItemIcon }) => (
            <NavLink
              active={isActive(href)}
              collapsed={collapsed}
              href={href}
              icon={ItemIcon}
              key={href}
              label={label}
            />
          ))}

          {/* Admin section */}
          {isAdmin && (
            <>
              {collapsed ? (
                <div className="my-2 h-px bg-sidebar-border" />
              ) : (
                <div className="pt-4 pb-1 px-3">
                  <span className="text-2xs font-medium text-sidebar-content/70 uppercase tracking-wider">
                    Admin
                  </span>
                </div>
              )}
              {adminItems.map(({ href, label, icon: ItemIcon }) => (
                <NavLink
                  active={isActive(href)}
                  collapsed={collapsed}
                  href={href}
                  icon={ItemIcon}
                  key={href}
                  label={label}
                />
              ))}
            </>
          )}
        </nav>

        {/* Agent info — links to the profile page */}
        <div
          className={cn(
            "py-3 border-t border-sidebar-border",
            collapsed ? "px-2" : "px-3"
          )}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  className="flex justify-center rounded-md py-1.5 transition-colors hover:bg-sidebar-accent/70"
                  href="/dashboard/profile"
                >
                  <span className="size-8 rounded-full bg-sidebar-primary flex items-center justify-center shrink-0">
                    <span className="text-2xs font-semibold text-sidebar-primary-content">
                      {getInitials(userName)}
                    </span>
                  </span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                <span className="flex flex-col">
                  <span className="font-medium">{userName}</span>
                  <span className="opacity-70">{userEmail}</span>
                </span>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Link
              className="flex items-center gap-2.5 rounded-md bg-sidebar-accent/40 px-2.5 py-2 transition-colors hover:bg-sidebar-accent/70"
              href="/dashboard/profile"
            >
              <div className="size-8 rounded-full bg-sidebar-primary flex items-center justify-center shrink-0">
                <span className="text-2xs font-semibold text-sidebar-primary-content">
                  {getInitials(userName)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-sidebar-accent-content truncate">
                  {userName}
                </p>
                <p className="text-2xs text-sidebar-content truncate">
                  {userEmail}
                </p>
              </div>
              {isAdmin && (
                <ShieldCheckIcon className="size-3.5 text-sidebar-content shrink-0" />
              )}
            </Link>
          )}
          <SignOutButton collapsed={collapsed} />
        </div>
      </aside>
    </TooltipProvider>
  );
}
