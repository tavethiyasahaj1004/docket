import { createECDH } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, inArray, or } from "drizzle-orm";
import webpush from "web-push";
import { pushSubscriptions } from "@/db/schema/push-subscriptions";
import { db } from "@/lib/db";
import {
  getWebPushSettings,
  type WebPushSettings,
} from "@/lib/integration-settings";
import type { CredentialTestResult } from "@/lib/integration-test";

/** Shape the service worker (public/service-worker.js) expects. Kept flat and
 * without a `data.pusher` key, which is how the SW tells it apart from Beams. */
export interface WebPushPayload {
  body: string;
  tag?: string;
  title: string;
  url?: string;
}

// Push service responses meaning the subscription is permanently gone
// (unsubscribed, expired, or the browser profile was deleted).
const GONE_STATUS_CODES = new Set([404, 410]);

// Browser push services. A subscription endpoint is client-supplied and the
// server later POSTs to it, so anything else is refused — otherwise any agent
// could point the server at internal hosts (SSRF). Matched as the host itself
// or any subdomain of it.
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Opera, Samsung Internet
  "android.googleapis.com", // legacy GCM endpoints
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari (web.push.apple.com)
  "notify.windows.com", // legacy Edge / WNS
];

/** True for an https URL on a known browser push service (default port). */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

export function generateVapidKeys(): { privateKey: string; publicKey: string } {
  return webpush.generateVAPIDKeys();
}

/** Sends `payload` to every saved subscription of the given users, pruning
 * subscriptions the push service reports as gone. No-op when VAPID keys aren't
 * configured. Returns how many deliveries the push services accepted. */
export async function sendWebPushToUsers(
  userIds: string[],
  payload: WebPushPayload,
  settings?: WebPushSettings
): Promise<{ attempted: number; delivered: number }> {
  const vapid = settings ?? (await getWebPushSettings());
  if (!vapid || userIds.length === 0) {
    return { attempted: 0, delivered: 0 };
  }

  // Re-checked at send time too, in case a row predates the endpoint check.
  const subs = (
    await db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds))
  ).filter((sub) => isAllowedPushEndpoint(sub.endpoint));
  if (subs.length === 0) {
    return { attempted: 0, delivered: 0 };
  }

  const body = JSON.stringify(payload);
  const gone: string[] = [];
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush
        .sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          {
            vapidDetails: vapid,
            TTL: 60 * 60 * 24,
            urgency: "high",
          }
        )
        .catch((error: unknown) => {
          if (
            error instanceof webpush.WebPushError &&
            GONE_STATUS_CODES.has(error.statusCode)
          ) {
            gone.push(sub.id);
          }
          throw error;
        })
    )
  );

  if (gone.length > 0) {
    await db
      .delete(pushSubscriptions)
      .where(inArray(pushSubscriptions.id, gone))
      .catch(() => undefined);
  }

  return {
    attempted: subs.length,
    delivered: results.filter((r) => r.status === "fulfilled").length,
  };
}

/** Drops every saved subscription. Called when the VAPID key pair changes —
 * browsers bind a subscription to the public key it was created with, so the
 * old ones can never receive pushes signed by the new key. Agents' browsers
 * re-subscribe on their next page load (components/agent/push-init.tsx). */
export async function clearAllWebPushSubscriptions(): Promise<void> {
  await db.delete(pushSubscriptions);
}

/** Upserts on `endpoint`: the same browser re-subscribing (e.g. after another
 * agent signs in on it) moves the device to the current user. A row owned by
 * someone else is only taken over when the caller also presents its keys —
 * proof it holds that browser's subscription — so an agent who learned another
 * agent's endpoint URL can't silently redirect their notifications. */
export async function saveWebPushSubscription(input: {
  auth: string;
  endpoint: string;
  p256dh: string;
  userAgent: string | null;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(pushSubscriptions)
    .values({ id: createId(), ...input, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
        updatedAt: now,
      },
      setWhere: or(
        eq(pushSubscriptions.userId, input.userId),
        and(
          eq(pushSubscriptions.p256dh, input.p256dh),
          eq(pushSubscriptions.auth, input.auth)
        )
      ),
    });
}

export async function deleteWebPushSubscription(
  userId: string,
  endpoint: string
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, userId)
      )
    );
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** VAPID keys can be checked fully offline: the format (via web-push's own
 * validators) and that the public key really is derived from the private one —
 * a mismatched pair is the most likely copy-paste mistake and would otherwise
 * only surface as every push failing with 403. */
export function testWebPushKeys(
  settings: WebPushSettings
): CredentialTestResult {
  try {
    webpush.setVapidDetails(
      settings.subject,
      settings.publicKey,
      settings.privateKey
    );
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Invalid VAPID settings.",
    };
  }

  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(decodeBase64Url(settings.privateKey));
    if (!ecdh.getPublicKey().equals(decodeBase64Url(settings.publicKey))) {
      return {
        ok: false,
        message: "The public and private keys are not a matching pair.",
      };
    }
  } catch {
    return { ok: false, message: "The private key is not a valid VAPID key." };
  }

  return { ok: true, message: "VAPID keys are valid." };
}
