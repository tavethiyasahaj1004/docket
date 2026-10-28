import { isGoogleOAuthConfigured } from "@/lib/integration-settings";
import { getPlatformSettings, resolveLogoUrl } from "@/lib/settings";
import { AppearanceSettingsForm } from "./_components/appearance-settings-form";
import { BrandingSettingsForm } from "./_components/branding-settings-form";
import { LoginMethodsSettingsForm } from "./_components/login-methods-settings-form";

export const metadata = { title: "Appearance" };

export default async function AppearancePage() {
  const [settings, googleConfigured] = await Promise.all([
    getPlatformSettings(),
    isGoogleOAuthConfigured(),
  ]);

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6">
        <BrandingSettingsForm
          initialBrandName={settings.brandName}
          initialFaviconUrl={resolveLogoUrl(settings.faviconKey)}
          initialLogoUrl={resolveLogoUrl(settings.logoKey)}
        />
      </div>
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6">
        <AppearanceSettingsForm />
      </div>
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6">
        <LoginMethodsSettingsForm
          googleConfigured={googleConfigured}
          initialSettings={{
            passwordLoginEnabled: settings.passwordLoginEnabled,
            magicLinkEnabled: settings.magicLinkEnabled,
            googleLoginEnabled: settings.googleLoginEnabled,
          }}
        />
      </div>
    </div>
  );
}
