// Boot-time check of APP_SECRET's length. It only warns: a weak secret is an
// operator misconfiguration (SECURITY.md), and refusing to boot would take a
// working install down on upgrade. Reads the raw value rather than lib/env.ts so
// calling it at startup doesn't move env validation earlier.

export const RECOMMENDED_APP_SECRET_LENGTH = 32;

/** Logs a warning (never the secret) when APP_SECRET is set but shorter than
 * 32 characters. Returns whether it warned. */
export function warnIfWeakAppSecret(
  secret: string | undefined = process.env.APP_SECRET,
  warn: (message: string) => void = console.warn
): boolean {
  if (!secret || secret.length >= RECOMMENDED_APP_SECRET_LENGTH) {
    return false;
  }
  warn(
    `[docket] APP_SECRET is shorter than ${RECOMMENDED_APP_SECRET_LENGTH} characters. ` +
      "It protects sessions, signed links and stored secrets; set a long random value " +
      "(for example `openssl rand -base64 32`)."
  );
  return true;
}
