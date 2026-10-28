import type { ReactNode } from "react";

interface BrandMarkProps {
  /** Icon/initials badge shown when no logo is configured — layout (size,
   * color, rounding) is the caller's own markup, this component just decides
   * whether to render it. */
  fallbackIcon?: ReactNode;
  /** Classes for the <img> when a logo is configured. */
  imgClassName?: string;
  logoUrl: string | null;
  name: string;
  /** Classes for the name text, only rendered alongside `fallbackIcon`. */
  textClassName?: string;
}

/** A configured logo replaces the icon-badge and name text entirely, since an
 * uploaded logo usually contains its own wordmark. EmailLayout makes the same
 * swap for emails. */
export function BrandMark({
  name,
  logoUrl,
  fallbackIcon,
  textClassName,
  imgClassName,
}: BrandMarkProps) {
  if (logoUrl) {
    // next/image is wrong here: logoUrl is admin-uploaded and served from our own
    // route or a user-set CDN, so it would need per-deployment remotePatterns,
    // and it demands intrinsic dimensions no arbitrary uploaded logo can supply.
    // biome-ignore lint/performance/noImgElement: admin-uploaded logo of unknown intrinsic size, served via our own route
    return <img alt={name} className={imgClassName} src={logoUrl} />;
  }
  return (
    <>
      {fallbackIcon}
      <span className={textClassName}>{name}</span>
    </>
  );
}
