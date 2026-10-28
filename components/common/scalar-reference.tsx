"use client";

// Scalar's stylesheet, imported explicitly: its own internal CSS side-effect
// import is dropped when the component loads via next/dynamic under Turbopack,
// leaving the reference unstyled. Importing here guarantees Next bundles it.
import "@scalar/api-reference-react/style.css";

import dynamic from "next/dynamic";
import * as React from "react";
import { useTheme } from "@/components/theme/theme-provider";

// Scalar's reference is a Vue app under the hood — render it client-only.
const ApiReferenceReact = dynamic(
  () => import("@scalar/api-reference-react").then((m) => m.ApiReferenceReact),
  { ssr: false }
);

interface Props {
  /** Security scheme key from the spec's `components.securitySchemes` to
   * preselect in Scalar's "Test Request" panel — omit for specs with no
   * testable request operations (e.g. a `webhooks`-only document). */
  preferredSecurityScheme?: string;
  /** The OpenAPI document (built server-side with this instance's base URL). */
  spec: Record<string, unknown>;
}

// Renders the interactive API reference from an OpenAPI spec. Dark mode follows
// the admin ThemeProvider, with Scalar's own toggle hidden so the two can't
// disagree. Shared by every admin docs page — pass a different `spec` per one.
export function ScalarReference({ spec, preferredSecurityScheme }: Props) {
  const { appearanceMode } = useTheme();
  const [systemDark, setSystemDark] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isDark =
    appearanceMode === "dark" || (appearanceMode === "auto" && systemDark);

  return (
    <ApiReferenceReact
      configuration={{
        content: spec,
        darkMode: isDark,
        hideDarkModeToggle: true,
        // The page header already offers OpenAPI + Postman downloads —
        // Scalar's own download button would duplicate them.
        documentDownloadType: "none",
        ...(preferredSecurityScheme
          ? { authentication: { preferredSecurityScheme } }
          : {}),
      }}
    />
  );
}
