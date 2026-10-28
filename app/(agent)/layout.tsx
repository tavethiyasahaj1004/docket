import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { PushInit } from "@/components/agent/push-init";
import { SessionGuard } from "@/components/agent/session-guard";
import { AgentSidebar } from "@/components/agent/sidebar";
import { TopBar } from "@/components/agent/topbar";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { UnsavedThemeChangesGuard } from "@/components/theme/unsaved-theme-changes-guard";
import { requireAgent } from "@/lib/authz";
import {
  getPlatformSettings,
  resolveBrandName,
  resolveLogoUrl,
} from "@/lib/settings";
import { isSidebarCollapsed, SIDEBAR_COOKIE } from "@/lib/sidebar";

export default async function AgentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const [session, settings, cookieStore] = await Promise.all([
    requireAgent(),
    getPlatformSettings(),
    cookies(),
  ]);
  const sidebarCollapsed = isSidebarCollapsed(
    cookieStore.get(SIDEBAR_COOKIE)?.value
  );

  return (
    <ThemeProvider
      initialAppearanceMode={
        settings.appearanceMode as "light" | "dark" | "auto"
      }
      initialTheme={settings.theme}
    >
      <PushInit userId={session.id} />
      <SessionGuard />
      <UnsavedThemeChangesGuard />
      <div className="fixed inset-0 flex overflow-hidden">
        <AgentSidebar
          brandName={resolveBrandName(settings.brandName)}
          defaultCollapsed={sidebarCollapsed}
          logoUrl={resolveLogoUrl(settings.logoKey)}
          userEmail={session.email}
          userName={session.name ?? session.email}
          userRole={session.role ?? "agent"}
        />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <TopBar userId={session.id} />
          <main className="flex-1 overflow-y-auto bg-surface">{children}</main>
        </div>
      </div>
    </ThemeProvider>
  );
}
