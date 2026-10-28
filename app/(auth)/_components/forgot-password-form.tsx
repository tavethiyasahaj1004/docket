"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandMark } from "@/components/common/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { getInitials } from "@/lib/utils";

interface Props {
  brandName: string;
  logoUrl: string | null;
}

export function ForgotPasswordForm({ brandName, logoUrl }: Props) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setSubmitting(false);
    if (result.error) {
      setError(
        result.error.message ?? "Something went wrong. Please try again."
      );
      return;
    }
    setSent(true);
  }

  return (
    <main className="min-h-screen bg-public flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <BrandMark
            fallbackIcon={
              <div className="inline-flex items-center justify-center size-12 rounded-xl bg-bark text-cream font-bold text-lg mb-4">
                {getInitials(brandName)}
              </div>
            }
            imgClassName="h-10 w-auto max-w-56 object-contain mx-auto mb-4"
            logoUrl={logoUrl}
            name={brandName}
            textClassName="text-2xl font-semibold text-bark block"
          />
          <p className="text-sm text-stone mt-1">Agent &amp; Admin Portal</p>
        </div>

        <div className="bg-white rounded-xl border border-sand shadow-soft shadow-sm p-8">
          {sent ? (
            <div className="text-center space-y-4">
              <div className="inline-flex items-center justify-center size-12 rounded-full bg-bark/10 mb-2">
                <svg
                  className="size-6 text-bark"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-bark">
                  Check your inbox
                </h2>
                <p className="text-sm text-stone mt-1">
                  If an account exists for{" "}
                  <span className="font-medium text-bark">{email}</span>, we've
                  sent a link to set a new password.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-semibold text-bark">
                  Forgot password?
                </h2>
                <p className="text-sm text-stone mt-1">
                  Enter your email and we'll send you a link to set a new
                  password.
                </p>
              </div>

              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label
                    className="block text-sm font-medium text-bark mb-1.5"
                    htmlFor="email"
                  >
                    Email address
                  </label>
                  <Input
                    autoComplete="email"
                    className="text-base-content"
                    id="email"
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    type="email"
                    value={email}
                  />
                </div>

                {error && (
                  <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
                    {error}
                  </p>
                )}

                <Button
                  className="w-full bg-bark hover:bg-bark/90 text-white"
                  disabled={submitting}
                  type="submit"
                >
                  {submitting ? (
                    <span className="flex items-center gap-2">
                      <span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />
                      Sending…
                    </span>
                  ) : (
                    "Send Reset Link"
                  )}
                </Button>

                <Link
                  className="block w-full text-center text-xs text-stone underline underline-offset-4 hover:text-bark transition-colors"
                  href="/login"
                >
                  Back to sign in
                </Link>
              </form>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
