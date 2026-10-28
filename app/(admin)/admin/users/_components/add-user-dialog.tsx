"use client";

import { PlusIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";

interface Props {
  passwordLoginEnabled: boolean;
}

export function AddUserDialog({ passwordLoginEnabled }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(AGENT_ROLE);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list is server-rendered, so the new row only exists once the RSC
  // refetch commits. Keep the dialog in its submitting state until then —
  // otherwise it closes onto a list that still looks unchanged.
  const [refreshing, startRefresh] = useTransition();
  const [createdName, setCreatedName] = useState<string | null>(null);

  useEffect(() => {
    if (createdName && !refreshing) {
      setOpen(false);
      toast.success(`${createdName} has been added.`);
      setCreatedName(null);
    }
  }, [createdName, refreshing]);

  function handleOpen() {
    setName("");
    setEmail("");
    setRole(AGENT_ROLE);
    setPassword("");
    setConfirmPassword("");
    setError(null);
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          role,
          password,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      // Newest-first ordering puts the new user at the top of page 1, so an
      // active search or a later page has to be cleared for them to show up
      // at all — a filter they don't match would hide them just as well.
      const filtered = searchParams.get("q") || searchParams.get("page");
      startRefresh(() => {
        if (filtered) {
          router.replace("/admin/users");
        } else {
          router.refresh();
        }
      });
      setCreatedName(name.trim());
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const canSubmit =
    passwordLoginEnabled &&
    name.trim() &&
    email.trim() &&
    password.length >= 8 &&
    password === confirmPassword;

  return (
    <>
      <Button
        className="gap-1.5 bg-primary text-primary-content hover:bg-primary/90"
        onClick={handleOpen}
        size="sm"
      >
        <PlusIcon className="size-4" />
        Add User
      </Button>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="rounded-xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Create a new account and set their password directly — no email
              required.
            </DialogDescription>
          </DialogHeader>

          {passwordLoginEnabled ? (
            <form className="space-y-4 py-2" onSubmit={handleSubmit}>
              <div className="space-y-1.5">
                <Label htmlFor="add-user-name">Full name</Label>
                <Input
                  disabled={loading}
                  id="add-user-name"
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Smith"
                  required
                  value={name}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-user-email">Email address</Label>
                <Input
                  disabled={loading}
                  id="add-user-email"
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  required
                  type="email"
                  value={email}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Role</Label>
                <div className="flex gap-2">
                  {[
                    { value: AGENT_ROLE, label: "Agent" },
                    { value: ADMIN_ROLE, label: "Admin" },
                  ].map((opt) => (
                    <button
                      className={`flex-1 py-2 text-sm font-medium rounded-md border transition-colors ${
                        role === opt.value
                          ? "bg-primary text-primary-content border-primary"
                          : "border-base-300 text-base-content-muted hover:bg-base-300/60"
                      }`}
                      key={opt.value}
                      onClick={() => setRole(opt.value)}
                      type="button"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-user-password">Password</Label>
                <Input
                  autoComplete="new-password"
                  disabled={loading}
                  id="add-user-password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  type="password"
                  value={password}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="add-user-password-confirm">
                  Confirm password
                </Label>
                <Input
                  autoComplete="new-password"
                  disabled={loading}
                  id="add-user-password-confirm"
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  required
                  type="password"
                  value={confirmPassword}
                />
              </div>

              <p className="text-xs text-base-content-muted">
                They will not be notified — share the password with them
                yourself.
              </p>

              {error && <p className="text-sm text-error">{error}</p>}

              <DialogFooter className="pt-2">
                <Button
                  className="border-base-300 text-base-content hover:bg-base-300"
                  disabled={loading}
                  onClick={() => setOpen(false)}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  className="bg-primary text-primary-content hover:bg-primary/90"
                  disabled={loading || refreshing || !canSubmit}
                  type="submit"
                >
                  {loading || refreshing ? "Adding…" : "Add User"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4 py-2">
              <p className="text-sm text-base-content-muted">
                Adding a user requires setting their password, but password
                sign-in is currently disabled. Enable it in{" "}
                <Link
                  className="font-medium text-base-content underline underline-offset-2"
                  href="/admin/appearance"
                >
                  Appearance settings
                </Link>{" "}
                to add users here.
              </p>
              <DialogFooter>
                <Button
                  className="border-base-300 text-base-content hover:bg-base-300"
                  onClick={() => setOpen(false)}
                  type="button"
                  variant="outline"
                >
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
