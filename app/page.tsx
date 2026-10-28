import {
  ArrowRightIcon,
  BellIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  EnvelopeIcon,
  PaperPlaneTiltIcon,
  ShieldCheckIcon,
  TicketIcon,
  UserIcon,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/common/brand-mark";
import { ThemeResetScript } from "@/components/theme/theme-reset-script";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentSession } from "@/lib/authz";
import {
  getPlatformSettings,
  resolveBrandName,
  resolveLogoUrl,
} from "@/lib/settings";
import { hasAdminUser } from "@/lib/setup";
import { cn } from "@/lib/utils";

// The setup check queries the database, which must happen per request — never
// at build time (the Docker builder has no database, and a baked answer would
// be stale anyway).
export const dynamic = "force-dynamic";

const STEPS = [
  {
    icon: PaperPlaneTiltIcon,
    step: "01",
    title: "Submit a ticket",
    desc: "Describe your issue and attach files. No account required to get started.",
  },
  {
    icon: ChatCircleDotsIcon,
    step: "02",
    title: "Get a response",
    desc: "Our team reviews your request and replies directly — you'll be notified by email.",
  },
  {
    icon: CheckCircleIcon,
    step: "03",
    title: "Issue resolved",
    desc: "Follow the conversation, add details, and close the ticket once you're happy.",
  },
];

const TRUST = [
  { icon: UserIcon, label: "No account needed" },
  { icon: BellIcon, label: "Email updates" },
  { icon: ShieldCheckIcon, label: "Secure & private" },
];

export default async function HomePage() {
  // Before an admin exists, route first-time operators to the setup wizard
  // instead of the customer landing page.
  if (!(await hasAdminUser())) {
    redirect("/setup");
  }

  const session = await getCurrentSession();
  if (session) {
    redirect("/tickets");
  }

  const settings = await getPlatformSettings();
  const brandName = resolveBrandName(settings.brandName);
  const logoUrl = resolveLogoUrl(settings.logoKey);

  return (
    <div className="min-h-screen bg-public flex flex-col">
      <ThemeResetScript />
      {/* ── Header ── */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-sand sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <BrandMark
              fallbackIcon={
                <div className="size-7 rounded-md bg-bark flex items-center justify-center shrink-0">
                  <TicketIcon className="size-4 text-cream" weight="fill" />
                </div>
              }
              imgClassName="h-7 w-auto max-w-40 object-contain"
              logoUrl={logoUrl}
              name={brandName}
              textClassName="font-semibold text-bark text-sm truncate"
            />
          </div>
          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            <Link
              className="hidden sm:inline text-sm text-stone hover:text-bark transition-colors"
              href="/my-tickets"
            >
              Find My Tickets
            </Link>
            <Link
              className={cn(
                buttonVariants({ size: "sm" }),
                "bg-bark hover:bg-bark/90 text-white rounded-md"
              )}
              data-size="sm"
              data-slot="button"
              data-variant="default"
              href="/submit"
            >
              <span className="sm:hidden">Submit</span>
              <span className="hidden sm:inline">Submit a Ticket</span>
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <main className="flex-1">
        <section className="relative overflow-hidden">
          {/* Decorative background */}
          <div className="pointer-events-none absolute inset-0 z-0">
            <div className="absolute -top-24 left-1/2 -translate-x-1/2 size-144 rounded-full bg-sand/30 blur-3xl" />
            <div className="absolute top-32 -left-20 size-72 rounded-full bg-white/40 blur-3xl" />
            <div className="absolute top-40 -right-16 size-72 rounded-full bg-stone/20 blur-3xl" />
          </div>

          <div className="relative max-w-5xl mx-auto px-4 sm:px-6 pt-16 pb-14 sm:pt-28 sm:pb-20 flex flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-sand bg-white/70 px-3 py-1 text-2xs font-medium uppercase tracking-eyebrow text-stone">
              <span className="size-1.5 rounded-full bg-success" />
              Support team online
            </span>

            <h1 className="mt-6 text-3xl sm:text-4xl md:text-5xl font-semibold text-bark leading-[1.1] max-w-2xl">
              How can we help you today?
            </h1>
            <p className="mt-4 text-base sm:text-lg text-stone max-w-md leading-relaxed">
              Submit a ticket and our team will get back to you as soon as
              possible. Track every reply in one place.
            </p>

            <div className="mt-9 flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
              <Link
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "w-full sm:w-auto bg-bark hover:bg-bark/90 text-white rounded-md px-8 gap-2 shadow-sm"
                )}
                data-size="lg"
                data-slot="button"
                data-variant="default"
                href="/submit"
              >
                Submit a Support Ticket
                <ArrowRightIcon className="size-4" />
              </Link>
              <Link
                className={cn(
                  buttonVariants({ size: "lg", variant: "outline" }),
                  "w-full sm:w-auto border-sand bg-white/60 text-bark hover:bg-white rounded-md px-8 gap-2"
                )}
                data-size="lg"
                data-slot="button"
                data-variant="outline"
                href="/my-tickets"
              >
                <EnvelopeIcon className="size-4" />
                Find My Tickets
              </Link>
            </div>

            {/* Trust strip */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
              {TRUST.map(({ icon: Icon, label }) => (
                <div
                  className="flex items-center gap-1.5 text-xs text-stone"
                  key={label}
                >
                  <Icon className="size-4 text-bark/70" weight="bold" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── How it works ── */}
        <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-16 sm:pb-24">
          <div className="text-center mb-10">
            <h2 className="text-2xl font-semibold text-bark">How it works</h2>
            <p className="mt-2 text-sm text-stone">
              Three simple steps to get your issue resolved.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {STEPS.map(({ icon: Icon, step, title, desc }) => (
              <div
                className="group relative bg-white rounded-xl border border-sand shadow-soft p-6 text-left transition-all hover:shadow-md hover:-translate-y-0.5"
                key={step}
              >
                <span className="absolute top-5 right-6 text-2xl font-semibold text-sand/60 tabular-nums">
                  {step}
                </span>
                <div className="size-11 rounded-xl bg-cream flex items-center justify-center mb-4">
                  <Icon className="size-5 text-bark" weight="duotone" />
                </div>
                <h3 className="font-semibold text-bark text-sm">{title}</h3>
                <p className="text-stone text-sm mt-1.5 leading-relaxed">
                  {desc}
                </p>
              </div>
            ))}
          </div>

          {/* Closing CTA card */}
          <div className="mt-10 rounded-xl bg-bark px-5 sm:px-8 py-8 sm:py-10 text-center">
            <h3 className="text-xl font-semibold text-cream">
              Ready to get help?
            </h3>
            <p className="mt-2 text-sm text-sand max-w-sm mx-auto">
              It only takes a minute. Tell us what's going on and we'll take it
              from there.
            </p>
            <Link
              className={cn(
                buttonVariants({ size: "lg" }),
                "mt-6 w-full sm:w-auto bg-cream hover:bg-cream/90 text-bark rounded-md px-8 gap-2"
              )}
              data-size="lg"
              data-slot="button"
              data-variant="default"
              href="/submit"
            >
              Submit a Ticket
              <ArrowRightIcon className="size-4" />
            </Link>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-sand bg-white/50 py-6 px-4">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-stone">
          <span>{brandName}</span>
          <span className="hidden sm:inline">·</span>
          <span>Open-source self-hosted support tool</span>
          <span className="hidden sm:inline">·</span>
          <Link
            className="hover:text-bark transition-colors underline underline-offset-4"
            href="/login"
          >
            Agent login
          </Link>
        </div>
      </footer>
    </div>
  );
}
