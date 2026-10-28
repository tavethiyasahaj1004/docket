import {
  getAttachmentLimits,
  getPlatformSettings,
  resolveBrandName,
  resolveLogoUrl,
} from "@/lib/settings";
import { SubmitForm } from "./_components/submit-form";

export default async function SubmitPage() {
  const [settings, attachmentLimits] = await Promise.all([
    getPlatformSettings(),
    getAttachmentLimits(),
  ]);
  return (
    <SubmitForm
      attachmentLimits={attachmentLimits}
      brandName={resolveBrandName(settings.brandName)}
      logoUrl={resolveLogoUrl(settings.logoKey)}
    />
  );
}
