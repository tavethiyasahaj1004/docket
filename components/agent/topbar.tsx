"use client";

import {
  BookOpenIcon,
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
  SquaresFourIcon,
  TagIcon,
  TicketIcon,
  UserCircleIcon,
  UsersIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";
import { usePathname } from "next/navigation";
import { NotificationBell } from "./notification-bell";

interface RouteMeta {
  description?: string;
  icon?: Icon;
  title: string;
}

const ROUTE_META: Record<string, RouteMeta> = {
  "/dashboard": {
    title: "Dashboard",
    description: "Ticket volume and team activity at a glance.",
    icon: SquaresFourIcon,
  },
  "/tickets": {
    title: "All Tickets",
    description: "Search and manage all support tickets.",
    icon: TicketIcon,
  },
  "/canned-responses": {
    title: "Canned Responses",
    description:
      "Reusable reply templates any agent can insert into a ticket reply.",
    icon: ChatTextIcon,
  },
  "/admin/audit-log": {
    title: "Audit Log",
    description: "A record of account-level and administrative actions.",
    icon: ClockCounterClockwiseIcon,
  },
  "/dashboard/profile": {
    title: "Your Profile",
    description: "Manage your account, password, active sessions, and data.",
    icon: UserCircleIcon,
  },
  "/settings": {
    title: "Settings",
    description: "Personal preferences for how you work in Docket.",
    icon: GearSixIcon,
  },
  "/admin/users": {
    title: "Users",
    description: "Manage agents and admins.",
    icon: UsersIcon,
  },
  "/admin/reports": {
    title: "Reports",
    description:
      "Who's busy, how fast the team responds, and what tickets are about.",
    icon: ChartBarIcon,
  },
  "/admin/appearance": {
    title: "Appearance",
    description:
      "Set the color theme and appearance mode for all agents and admins.",
    icon: PaintBrushIcon,
  },
  "/admin/ticket-config": {
    title: "Ticket Configuration",
    description:
      "Manage ticket statuses and categories available to agents and customers.",
    icon: TagIcon,
  },
  "/admin/custom-fields": {
    title: "Custom Fields",
    description:
      "Extra fields collected on the ticket form and shown on every ticket.",
    icon: ListChecksIcon,
  },
  "/admin/email-templates": {
    title: "Email Templates",
    description:
      "Customize the subject and body of each customer-facing email.",
    icon: EnvelopeSimpleIcon,
  },
  "/admin/api-keys": {
    title: "API Keys",
    description: "Let external websites create tickets programmatically.",
    icon: KeyIcon,
  },
  "/admin/api-keys/docs": {
    title: "API Documentation",
    description: "Reference for integrating with the public API.",
    icon: BookOpenIcon,
  },
  "/admin/webhooks": {
    title: "Webhooks",
    description: "Send ticket events to your own endpoints in real time.",
    icon: WebhooksLogoIcon,
  },
  "/admin/webhooks/docs": {
    title: "Webhook Documentation",
    description: "Payload shapes, signing, and retry behavior.",
    icon: BookOpenIcon,
  },
  "/admin/integrations": {
    title: "Integrations",
    description:
      "Configure SMTP, Google Sign-in, Pusher, and file storage without editing .env.",
    icon: PlugsIcon,
  },
};

function getMeta(pathname: string): RouteMeta {
  if (ROUTE_META[pathname]) {
    return ROUTE_META[pathname];
  }
  if (pathname.startsWith("/tickets/")) {
    return {
      title: "Ticket Detail",
      description: "View and respond to this ticket.",
      icon: TicketIcon,
    };
  }
  return { title: "" };
}

export function TopBar({ userId }: { userId: string }) {
  const pathname = usePathname();
  const { title, description, icon: Icon } = getMeta(pathname);

  return (
    <div className="h-14 shrink-0 border-b border-base-300 bg-base-100 flex items-center justify-between px-6">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && <Icon className="size-5 text-base-content shrink-0" />}
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-base-content leading-tight truncate">
            {title}
          </h1>
          {description && (
            <p className="text-xs text-base-content-muted leading-tight truncate">
              {description}
            </p>
          )}
        </div>
      </div>
      <NotificationBell userId={userId} />
    </div>
  );
}
