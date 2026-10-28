"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { BrandMark } from "@/components/common/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PRODUCT_NAME } from "@/config/platform";
import { getInitials } from "@/lib/utils";

interface Props {
  initialBrandName: string | null;
  initialFaviconUrl: string | null;
  initialLogoUrl: string | null;
}

/** Shared upload/remove logic for the logo and favicon fields — same
 * endpoint shape (`/api/admin/settings/{kind}`), form field, and JSON
 * response key (`{kind}Url`) for both. */
function useBrandImageUpload(
  kind: "favicon" | "logo",
  initialUrl: string | null
) {
  const [url, setUrl] = useState(initialUrl);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const label = kind === "logo" ? "Logo" : "Favicon";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append(kind, file);
      const res = await fetch(`/api/admin/settings/${kind}`, {
        method: "POST",
        body: formData,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        string | undefined
      >;
      if (!res.ok) {
        toast.error(data.error ?? `Failed to upload ${label.toLowerCase()}.`);
        return;
      }
      setUrl(data[`${kind}Url`] ?? null);
      toast.success(`${label} uploaded.`);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setUploading(true);
    try {
      const res = await fetch(`/api/admin/settings/${kind}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(`Failed to remove ${label.toLowerCase()}.`);
        return;
      }
      setUrl(null);
      toast.success(`${label} removed.`);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return { fileInputRef, handleFileSelect, label, remove, uploading, url };
}

export function BrandingSettingsForm({
  initialBrandName,
  initialFaviconUrl,
  initialLogoUrl,
}: Props) {
  const [brandName, setBrandName] = useState(initialBrandName ?? "");
  const [savedBrandName, setSavedBrandName] = useState(initialBrandName ?? "");
  const [savingName, setSavingName] = useState(false);
  const logo = useBrandImageUpload("logo", initialLogoUrl);
  const favicon = useBrandImageUpload("favicon", initialFaviconUrl);

  const displayName = brandName.trim() || PRODUCT_NAME;

  async function saveBrandName() {
    if (brandName === savedBrandName) {
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandName: brandName.trim() || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      setSavedBrandName(brandName);
      toast.success("Brand name saved.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-base-content">Branding</h3>
        <p className="text-xs text-base-content-muted mt-0.5">
          Shown in the sidebar, emails, and browser tab instead of "
          {PRODUCT_NAME}".
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brand-name">Brand name</Label>
        <Input
          disabled={savingName}
          id="brand-name"
          onBlur={saveBrandName}
          onChange={(e) => setBrandName(e.target.value)}
          placeholder={PRODUCT_NAME}
          value={brandName}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-base-300 bg-base-300/40 overflow-hidden">
            <BrandMark
              fallbackIcon={
                <span className="text-sm font-semibold text-base-content-muted">
                  {getInitials(displayName)}
                </span>
              }
              imgClassName="max-h-12 max-w-12 object-contain"
              logoUrl={logo.url}
              name={displayName}
              textClassName="sr-only"
            />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={logo.uploading}
              onClick={() => logo.fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              {logo.url ? "Replace" : "Upload"}
            </Button>
            {logo.url && (
              <Button
                className="border-red-200 text-red-600 hover:bg-red-50"
                disabled={logo.uploading}
                onClick={logo.remove}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove
              </Button>
            )}
          </div>
          <input
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={logo.handleFileSelect}
            ref={logo.fileInputRef}
            type="file"
          />
        </div>
        <p className="text-xs text-base-content-muted">
          PNG, JPEG, SVG, or WebP — up to 2 MB. Also used as the browser tab
          icon unless you set a dedicated favicon below.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Favicon</Label>
        <div className="flex items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-base-300 bg-base-300/40 overflow-hidden">
            <BrandMark
              fallbackIcon={
                <span className="text-sm font-semibold text-base-content-muted">
                  {getInitials(displayName)}
                </span>
              }
              imgClassName="max-h-10 max-w-10 object-contain"
              logoUrl={favicon.url}
              name={displayName}
              textClassName="sr-only"
            />
          </div>
          <div className="flex gap-2">
            <Button
              disabled={favicon.uploading}
              onClick={() => favicon.fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              {favicon.url ? "Replace" : "Upload"}
            </Button>
            {favicon.url && (
              <Button
                className="border-red-200 text-red-600 hover:bg-red-50"
                disabled={favicon.uploading}
                onClick={favicon.remove}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove
              </Button>
            )}
          </div>
          <input
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico"
            className="hidden"
            onChange={favicon.handleFileSelect}
            ref={favicon.fileInputRef}
            type="file"
          />
        </div>
        <p className="text-xs text-base-content-muted">
          Optional — a square, icon-only mark for the browser tab (PNG, JPEG,
          SVG, WebP, or ICO). Useful when your logo above combines an icon with
          a wordmark. Falls back to the logo when not set.
        </p>
      </div>
    </div>
  );
}
