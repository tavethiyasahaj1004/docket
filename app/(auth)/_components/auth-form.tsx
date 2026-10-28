"use client";

import { GoogleLogoIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BrandMark } from "@/components/common/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth-client";
import { getInitials } from "@/lib/utils";

interface AuthFormProps {
  brandName: string;
  googleEnabled: boolean;
  logoUrl: string | null;
  magicLinkEnabled: boolean;
  passwordLoginEnabled: boolean;
}

export function AuthForm(props: AuthFormProps) {
  return (
    <Suspense fallback={null}>
      <AuthFormInner {...props} />
    </Suspense>
  );
}

function AuthFormInner({
  brandName,
  googleEnabled,
  logoUrl,
  magicLinkEnabled,
  passwordLoginEnabled,
}: AuthFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const bothEmailModesAvailable = magicLinkEnabled && passwordLoginEnabled;
  const [mode, setMode] = useState<"magic-link" | "password">(
    passwordLoginEnabled ? "password" : "magic-link"
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const callbackURL = searchParams.get("next") ?? "/post-auth";
  const passwordJustReset = searchParams.get("passwordReset") === "1";

  async function handleGoogleSignIn() {
    setError(null);
    setGoogleLoading(true);
    try {
      await authClient.signIn.social({ provider: "google", callbackURL });
    } catch {
      setError("Failed to sign in with Google. Please try again.");
      setGoogleLoading(false);
    }
  }

  async function onSubmitMagicLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await authClient.signIn.magicLink({ email, callbackURL });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? "Failed to send sign-in link.");
      return;
    }
    setSent(true);
  }

  async function onSubmitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await authClient.signIn.email({
      email,
      password,
      callbackURL,
    });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message ?? "Invalid email or password.");
      return;
    }
    router.push(callbackURL);
  }

  const noEmailBasedMethod = !(magicLinkEnabled || passwordLoginEnabled);

  return (
    <main className="min-h-screen bg-public flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Logo */}
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

        {/* Card */}
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
                  We sent a sign-in link to{" "}
                  <span className="font-medium text-bark">{email}</span>
                </p>
              </div>
              <p className="text-xs text-stone">
                Didn&apos;t receive it?{" "}
                <button
                  className="underline underline-offset-4 hover:text-bark transition-colors"
                  onClick={() => setSent(false)}
                  type="button"
                >
                  Try again
                </button>
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-semibold text-bark">Sign in</h2>
                <p className="text-sm text-stone mt-1">
                  {mode === "password"
                    ? "Enter your email and password."
                    : "No password needed — we'll email you a secure link."}
                </p>
              </div>

              {passwordJustReset && (
                <p className="text-sm text-bark bg-cream rounded-md px-3 py-2">
                  Password updated. Sign in with your new password.
                </p>
              )}

              {/* Google button — only when configured and enabled */}
              {googleEnabled && (
                <>
                  <Button
                    className="w-full gap-2 border-sand text-bark hover:bg-cream"
                    disabled={submitting || googleLoading}
                    onClick={handleGoogleSignIn}
                    type="button"
                    variant="outline"
                  >
                    {googleLoading ? (
                      <span className="size-4 rounded-full border-2 border-bark/30 border-t-bark animate-spin inline-block" />
                    ) : (
                      <GoogleLogoIcon className="size-4" />
                    )}
                    Continue with Google
                  </Button>

                  {!noEmailBasedMethod && (
                    <Separator className="my-0 text-xs text-stone">
                      or
                    </Separator>
                  )}
                </>
              )}

              {noEmailBasedMethod ? (
                !googleEnabled && (
                  <p className="text-sm text-stone text-center">
                    No sign-in methods are enabled. Contact your administrator.
                  </p>
                )
              ) : mode === "password" ? (
                <form className="space-y-4" onSubmit={onSubmitPassword}>
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
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label
                        className="block text-sm font-medium text-bark"
                        htmlFor="password"
                      >
                        Password
                      </label>
                      <Link
                        className="text-xs text-stone underline underline-offset-4 hover:text-bark transition-colors"
                        href="/forgot-password"
                      >
                        Forgot password?
                      </Link>
                    </div>
                    <Input
                      autoComplete="current-password"
                      className="text-base-content"
                      id="password"
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      type="password"
                      value={password}
                    />
                  </div>

                  {error && (
                    <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
                      {error}
                    </p>
                  )}

                  <Button
                    className="w-full bg-bark hover:bg-bark/90 text-white"
                    disabled={submitting || googleLoading}
                    type="submit"
                  >
                    {submitting ? (
                      <span className="flex items-center gap-2">
                        <span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />
                        Signing in…
                      </span>
                    ) : (
                      "Sign In"
                    )}
                  </Button>

                  {bothEmailModesAvailable && (
                    <button
                      className="w-full text-center text-xs text-stone underline underline-offset-4 hover:text-bark transition-colors"
                      onClick={() => {
                        setError(null);
                        setMode("magic-link");
                      }}
                      type="button"
                    >
                      Use a magic link instead
                    </button>
                  )}
                </form>
              ) : (
                <form className="space-y-4" onSubmit={onSubmitMagicLink}>
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
                    disabled={submitting || googleLoading}
                    type="submit"
                  >
                    {submitting ? (
                      <span className="flex items-center gap-2">
                        <span className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" />
                        Sending link…
                      </span>
                    ) : (
                      "Send Sign-In Link"
                    )}
                  </Button>

                  {bothEmailModesAvailable && (
                    <button
                      className="w-full text-center text-xs text-stone underline underline-offset-4 hover:text-bark transition-colors"
                      onClick={() => {
                        setError(null);
                        setMode("password");
                      }}
                      type="button"
                    >
                      Use a password instead
                    </button>
                  )}
                </form>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-stone mt-6">
          Looking to submit a support ticket?{" "}
          <a
            className="underline underline-offset-4 hover:text-bark transition-colors"
            href="/"
          >
            Go to customer portal
          </a>
        </p>
      </div>
    </main>
  );
}
