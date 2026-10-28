"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { IntegrationSettingsSummary } from "@/lib/integration-settings";
import { IntegrationCard } from "./integration-card";
import { SecretInput } from "./secret-input";

type Storage = IntegrationSettingsSummary["storage"];
type Driver = Storage["driver"];

interface Props {
  collapsible?: boolean;
  defaultOpen?: boolean;
  initial: Storage;
}

export function StorageSettingsForm({
  initial,
  collapsible,
  defaultOpen,
}: Props) {
  const [driver, setDriver] = useState<Driver>(initial.driver);
  const [s3Bucket, setS3Bucket] = useState(initial.s3Bucket);
  const [s3Region, setS3Region] = useState(initial.s3Region);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState(initial.awsAccessKeyId);
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [hasAwsSecretAccessKey, setHasAwsSecretAccessKey] = useState(
    initial.hasAwsSecretAccessKey
  );
  const [r2Bucket, setR2Bucket] = useState(initial.r2Bucket);
  const [r2AccountId, setR2AccountId] = useState(initial.r2AccountId);
  const [r2AccessKeyId, setR2AccessKeyId] = useState(initial.r2AccessKeyId);
  const [r2SecretAccessKey, setR2SecretAccessKey] = useState("");
  const [hasR2SecretAccessKey, setHasR2SecretAccessKey] = useState(
    initial.hasR2SecretAccessKey
  );
  const [publicBaseUrl, setPublicBaseUrl] = useState(initial.publicBaseUrl);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/integration-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: {
            driver,
            s3Bucket,
            s3Region,
            awsAccessKeyId,
            awsSecretAccessKey: awsSecretAccessKey || undefined,
            r2Bucket,
            r2AccountId,
            r2AccessKeyId,
            r2SecretAccessKey: r2SecretAccessKey || undefined,
            publicBaseUrl,
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      if (awsSecretAccessKey) {
        setHasAwsSecretAccessKey(true);
      }
      if (r2SecretAccessKey) {
        setHasR2SecretAccessKey(true);
      }
      setAwsSecretAccessKey("");
      setR2SecretAccessKey("");
      toast.success("Storage settings saved.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <IntegrationCard
      collapsible={collapsible}
      configured={driver !== "local"}
      defaultOpen={defaultOpen}
      description="Where ticket attachments are stored. Local disk needs no setup but requires a persistent Docker volume; S3/R2 survive host loss and work across replicas."
      onSave={save}
      saving={saving}
      title="File Storage"
    >
      <div className="space-y-1.5">
        <Label htmlFor="storage-driver">Driver</Label>
        <Select
          disabled={saving}
          onValueChange={(v) => setDriver(v as Driver)}
          value={driver}
        >
          <SelectTrigger className="h-11 w-full" id="storage-driver">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local disk (default)</SelectItem>
            <SelectItem value="s3">S3-compatible</SelectItem>
            <SelectItem value="r2">Cloudflare R2</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {driver === "s3" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s3-bucket">Bucket</Label>
            <Input
              disabled={saving}
              id="s3-bucket"
              onChange={(e) => setS3Bucket(e.target.value)}
              value={s3Bucket}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s3-region">Region</Label>
            <Input
              disabled={saving}
              id="s3-region"
              onChange={(e) => setS3Region(e.target.value)}
              placeholder="us-east-1"
              value={s3Region}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s3-access-key">
              Access Key ID{" "}
              <span className="text-base-content-muted font-normal">
                (optional — falls back to IAM role)
              </span>
            </Label>
            <Input
              disabled={saving}
              id="s3-access-key"
              onChange={(e) => setAwsAccessKeyId(e.target.value)}
              value={awsAccessKeyId}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s3-secret-key">Secret Access Key</Label>
            <SecretInput
              disabled={saving}
              hasSavedValue={hasAwsSecretAccessKey}
              id="s3-secret-key"
              onChange={setAwsSecretAccessKey}
              value={awsSecretAccessKey}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="s3-public-base-url">
              Public base URL{" "}
              <span className="text-base-content-muted font-normal">
                (optional — CDN/custom domain)
              </span>
            </Label>
            <Input
              disabled={saving}
              id="s3-public-base-url"
              onChange={(e) => setPublicBaseUrl(e.target.value)}
              value={publicBaseUrl}
            />
          </div>
        </div>
      )}

      {driver === "r2" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="r2-bucket">Bucket</Label>
            <Input
              disabled={saving}
              id="r2-bucket"
              onChange={(e) => setR2Bucket(e.target.value)}
              value={r2Bucket}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r2-account-id">Account ID</Label>
            <Input
              disabled={saving}
              id="r2-account-id"
              onChange={(e) => setR2AccountId(e.target.value)}
              value={r2AccountId}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r2-access-key">Access Key ID</Label>
            <Input
              disabled={saving}
              id="r2-access-key"
              onChange={(e) => setR2AccessKeyId(e.target.value)}
              value={r2AccessKeyId}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="r2-secret-key">Secret Access Key</Label>
            <SecretInput
              disabled={saving}
              hasSavedValue={hasR2SecretAccessKey}
              id="r2-secret-key"
              onChange={setR2SecretAccessKey}
              value={r2SecretAccessKey}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="r2-public-base-url">
              Public base URL{" "}
              <span className="text-base-content-muted font-normal">
                (optional — CDN/custom domain)
              </span>
            </Label>
            <Input
              disabled={saving}
              id="r2-public-base-url"
              onChange={(e) => setPublicBaseUrl(e.target.value)}
              value={publicBaseUrl}
            />
          </div>
        </div>
      )}
    </IntegrationCard>
  );
}
