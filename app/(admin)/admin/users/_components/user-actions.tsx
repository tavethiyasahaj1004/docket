"use client";

import {
  DotsThreeIcon,
  KeyIcon,
  TrashIcon,
  UserGearIcon,
  UserMinusIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";

interface Props {
  isCurrentUser: boolean;
  passwordResetEnabled: boolean;
  /** Backed by `user.banned` but surfaced as "deactivated" everywhere, since
   * off-boarding a colleague is the common case, not punishment. The column name
   * stays as-is because Better Auth's Admin Plugin owns it. */
  userDeactivated: boolean;
  userEmail: string;
  userId: string;
  userName: string;
  userRole: string;
}

export function UserActions({
  userId,
  userName,
  userEmail,
  userRole,
  userDeactivated,
  isCurrentUser,
  passwordResetEnabled,
}: Props) {
  const router = useRouter();

  // Role dialog
  const [roleOpen, setRoleOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState(userRole);
  const [roleLoading, setRoleLoading] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  // Deactivate / reactivate dialog
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deactivateReason, setDeactivateReason] = useState("");
  const [deactivateLoading, setDeactivateLoading] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reset password dialog
  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function handleRoleChange() {
    if (selectedRole === userRole) {
      setRoleOpen(false);
      return;
    }
    setRoleLoading(true);
    setRoleError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: selectedRole }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        const msg = d.error ?? "Failed to update role.";
        setRoleError(msg);
        toast.error(msg);
        return;
      }
      setRoleOpen(false);
      toast.success(
        `${userName} is now ${selectedRole === ADMIN_ROLE ? "an admin" : "an agent"}.`
      );
      router.refresh();
    } catch {
      setRoleError("Network error.");
      toast.error("Network error.");
    } finally {
      setRoleLoading(false);
    }
  }

  async function handleDeactivate() {
    setDeactivateLoading(true);
    setDeactivateError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          banned: true,
          banReason: deactivateReason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        const msg = d.error ?? "Failed to deactivate user.";
        setDeactivateError(msg);
        toast.error(msg);
        return;
      }
      setDeactivateOpen(false);
      setDeactivateReason("");
      toast.success(`${userName} has been deactivated.`);
      router.refresh();
    } catch {
      setDeactivateError("Network error.");
      toast.error("Network error.");
    } finally {
      setDeactivateLoading(false);
    }
  }

  async function handleReactivate() {
    setDeactivateLoading(true);
    setDeactivateError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banned: false }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        const msg = d.error ?? "Failed to reactivate user.";
        setDeactivateError(msg);
        toast.error(msg);
        return;
      }
      setDeactivateOpen(false);
      toast.success(`${userName} has been reactivated.`);
      router.refresh();
    } catch {
      setDeactivateError("Network error.");
      toast.error("Network error.");
    } finally {
      setDeactivateLoading(false);
    }
  }

  async function handleDelete() {
    if (deleteEmail !== userEmail) {
      setDeleteError("Email does not match.");
      return;
    }
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        const msg = d.error ?? "Failed to delete user.";
        setDeleteError(msg);
        toast.error(msg);
        return;
      }
      setDeleteOpen(false);
      toast.success(`${userName} has been deleted.`);
      router.refresh();
    } catch {
      setDeleteError("Network error.");
      toast.error("Network error.");
    } finally {
      setDeleteLoading(false);
    }
  }

  async function handleResetPassword() {
    if (newPassword.length < 8) {
      setResetError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError("Passwords do not match.");
      return;
    }
    setResetLoading(true);
    setResetError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        const msg = d.error ?? "Failed to reset password.";
        setResetError(msg);
        toast.error(msg);
        return;
      }
      setResetOpen(false);
      setNewPassword("");
      setConfirmPassword("");
      toast.success(`Password reset for ${userName}.`);
      router.refresh();
    } catch {
      setResetError("Network error.");
      toast.error("Network error.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <>
      {/* modal={false} — a modal menu locks body pointer-events, which fights
          the Dialogs each item opens. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${userName}`}
            className="size-7 p-0 border-base-300 text-base-content-muted hover:bg-base-300 hover:text-base-content"
            size="sm"
            variant="outline"
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setSelectedRole(userRole);
              setRoleError(null);
              setRoleOpen(true);
            }}
          >
            <UserGearIcon className="size-4" />
            Change Role
          </DropdownMenuItem>

          {passwordResetEnabled && (
            <DropdownMenuItem
              onSelect={() => {
                setNewPassword("");
                setConfirmPassword("");
                setResetError(null);
                setResetOpen(true);
              }}
            >
              <KeyIcon className="size-4" />
              Reset Password
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {/* Deactivate is the primary off-boarding action — it keeps ticket
              history and assignment intact. Delete sits below its own
              separator because it is the rare, irreversible erasure path. */}
          {userDeactivated ? (
            <DropdownMenuItem
              onSelect={() => {
                setDeactivateError(null);
                setDeactivateOpen(true);
              }}
            >
              <UserPlusIcon className="size-4" />
              Reactivate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isCurrentUser}
              onSelect={() => {
                setDeactivateReason("");
                setDeactivateError(null);
                setDeactivateOpen(true);
              }}
            >
              <UserMinusIcon className="size-4" />
              Deactivate
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => {
              setDeleteEmail("");
              setDeleteError(null);
              setDeleteOpen(true);
            }}
            variant="destructive"
          >
            <TrashIcon className="size-4" />
            Delete Permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Change Role Dialog */}
      <Dialog onOpenChange={setRoleOpen} open={roleOpen}>
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base-content">Change Role</DialogTitle>
            <DialogDescription className="text-base-content-muted">
              Set the role for{" "}
              <strong className="text-base-content">{userName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 py-1">
            <button
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                selectedRole === AGENT_ROLE
                  ? "bg-primary text-primary-content border-primary"
                  : "border-base-300 text-base-content hover:bg-base-300"
              }`}
              onClick={() => setSelectedRole(AGENT_ROLE)}
              type="button"
            >
              Agent
            </button>
            <button
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                selectedRole === ADMIN_ROLE
                  ? "bg-primary text-primary-content border-primary"
                  : "border-base-300 text-base-content hover:bg-base-300"
              }`}
              onClick={() => setSelectedRole(ADMIN_ROLE)}
              type="button"
            >
              Admin
            </button>
          </div>
          {roleError && <p className="text-xs text-red-600">{roleError}</p>}
          <DialogFooter className="gap-2">
            <Button
              className="border-base-300 text-base-content"
              disabled={roleLoading}
              onClick={() => setRoleOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-content"
              disabled={roleLoading}
              onClick={handleRoleChange}
            >
              {roleLoading ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate / Reactivate Dialog */}
      <Dialog onOpenChange={setDeactivateOpen} open={deactivateOpen}>
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              {userDeactivated ? "Reactivate User" : "Deactivate User"}
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              {userDeactivated
                ? `Restore sign-in access for ${userName}. They become assignable again and will start receiving notifications.`
                : `${userName} will be signed out immediately and can no longer sign in or be assigned new tickets. Their existing tickets stay assigned to them and their reply history is unchanged. Reversible at any time.`}
            </DialogDescription>
          </DialogHeader>
          {!userDeactivated && (
            <div className="space-y-1.5">
              <Label className="text-xs text-base-content-muted">
                Reason (optional)
              </Label>
              <Textarea
                className="resize-none"
                onChange={(e) => setDeactivateReason(e.target.value)}
                placeholder="e.g. Left the company"
                rows={2}
                value={deactivateReason}
              />
            </div>
          )}
          {deactivateError && (
            <p className="text-xs text-red-600">{deactivateError}</p>
          )}
          <DialogFooter className="gap-2">
            <Button
              className="border-base-300 text-base-content"
              disabled={deactivateLoading}
              onClick={() => setDeactivateOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-content"
              disabled={deactivateLoading}
              onClick={userDeactivated ? handleReactivate : handleDeactivate}
            >
              {deactivateLoading
                ? userDeactivated
                  ? "Reactivating…"
                  : "Deactivating…"
                : userDeactivated
                  ? "Reactivate"
                  : "Deactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              Delete Permanently?
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              Erases <strong className="text-base-content">{userName}</strong>{" "}
              from the platform. Their assigned tickets become unassigned, and
              their name is replaced with &ldquo;Deleted user&rdquo; on every
              reply, note, and activity entry they left behind. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md bg-base-300 px-3 py-2 text-xs text-base-content-muted">
            Off-boarding someone?{" "}
            <strong className="text-base-content">Deactivate</strong> instead —
            it revokes access but keeps their ticket history readable.
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs text-base-content-muted">
              Type{" "}
              <span className="font-mono text-base-content">{userEmail}</span>{" "}
              to confirm
            </Label>
            <Input
              autoComplete="off"
              name="delete-confirm-email"
              onChange={(e) => setDeleteEmail(e.target.value)}
              placeholder={userEmail}
              value={deleteEmail}
            />
          </div>
          {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
          <DialogFooter className="gap-2">
            <Button
              className="border-base-300 text-base-content"
              disabled={deleteLoading}
              onClick={() => setDeleteOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteLoading || deleteEmail !== userEmail}
              onClick={handleDelete}
            >
              {deleteLoading ? "Deleting…" : "Delete User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog onOpenChange={setResetOpen} open={resetOpen}>
        <DialogContent className="rounded-xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base-content">
              Reset Password
            </DialogTitle>
            <DialogDescription className="text-base-content-muted">
              Set a new password for{" "}
              <strong className="text-base-content">{userName}</strong>. They
              will not be notified — share the new password with them yourself.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-base-content-muted">
                New password
              </Label>
              <Input
                autoComplete="new-password"
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                type="password"
                value={newPassword}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-base-content-muted">
                Confirm password
              </Label>
              <Input
                autoComplete="new-password"
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                type="password"
                value={confirmPassword}
              />
            </div>
          </div>
          {resetError && <p className="text-xs text-red-600">{resetError}</p>}
          <DialogFooter className="gap-2">
            <Button
              className="border-base-300 text-base-content"
              disabled={resetLoading}
              onClick={() => setResetOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-content"
              disabled={
                resetLoading ||
                newPassword.length < 8 ||
                newPassword !== confirmPassword
              }
              onClick={handleResetPassword}
            >
              {resetLoading ? "Saving…" : "Reset Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
