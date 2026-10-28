import Script from "next/script";

// Blocking inline script setting `.dark` on <html> before first paint, from
// localStorage → server default → OS preference, so nothing flashes light. Keep
// in sync with theme-provider.tsx. Must be next/script beforeInteractive: Next
// injects those into the initial HTML, while a raw JSX <script> never executes.
export function ThemeScript({ appearanceMode }: { appearanceMode: string }) {
  const js = `(function(){try{var a=localStorage.getItem('docket_appearance')||'${appearanceMode}';var d=a==='dark'||(a==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList[d?'add':'remove']('dark');}catch(e){}})();`;
  return (
    <Script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static, non-user script run before paint to prevent theme flash
      dangerouslySetInnerHTML={{ __html: js }}
      id="theme-script"
      strategy="beforeInteractive"
    />
  );
}
