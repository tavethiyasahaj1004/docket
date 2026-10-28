import PushNotifications from "@pusher/push-notifications-server";
import nodemailer from "nodemailer";
import PusherServer from "pusher";

export interface CredentialTestResult {
  message: string;
  ok: boolean;
}

/** Opens a real connection and authenticates, without sending any mail —
 * nodemailer's `verify()` does the full SMTP handshake including AUTH. */
export async function testSmtpConnection(settings: {
  host: string;
  pass: string;
  port: number;
  user: string;
}): Promise<CredentialTestResult> {
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    auth: { user: settings.user, pass: settings.pass },
  });
  try {
    await transporter.verify();
    return { ok: true, message: "Connected and authenticated successfully." };
  } catch (error) {
    return { ok: false, message: smtpErrorMessage(error) };
  } finally {
    transporter.close();
  }
}

function smtpErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // nodemailer errors carry a "responseCode"/"code" that's more useful than
    // the generic message, but the message itself is usually the server's
    // own SMTP response text — surface it as-is for self-hosters to search on.
    return error.message;
  }
  return "Could not connect to the SMTP server.";
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google has no "validate this client_id/secret" endpoint, so this exchanges
 * a deliberately-invalid authorization code and reads the error Google sends
 * back: `invalid_client` means the ID/secret pair itself is wrong,
 * `invalid_grant` means the pair is valid but (unsurprisingly) the fake code
 * isn't — which is exactly the signal we want without a real consent round-trip. */
export async function testGoogleOAuthCredentials(
  clientId: string,
  clientSecret: string
): Promise<CredentialTestResult> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: "docket-credential-check",
        grant_type: "authorization_code",
        redirect_uri: "https://docket.invalid/api/auth/callback/google",
      }),
    });
  } catch {
    return { ok: false, message: "Could not reach Google's token endpoint." };
  }

  const data = (await res.json().catch(() => ({}))) as { error?: string };

  if (data.error === "invalid_grant") {
    return { ok: true, message: "Client ID and secret are valid." };
  }
  if (data.error === "invalid_client") {
    return {
      ok: false,
      message: "Google rejected this client ID/secret pair.",
    };
  }
  return {
    ok: false,
    message: `Unexpected response from Google (${data.error ?? res.status}).`,
  };
}

/** Signed authenticated GET against Pusher's own REST API — validates
 * appId/key/secret/cluster together without triggering any event a connected
 * client would see. */
export async function testPusherChannelsConnection(settings: {
  appId: string;
  cluster: string;
  key: string;
  secret: string;
}): Promise<CredentialTestResult> {
  const client = new PusherServer({
    appId: settings.appId,
    key: settings.key,
    secret: settings.secret,
    cluster: settings.cluster,
    useTLS: true,
  });
  try {
    await client.get({ path: "/channels" });
    return { ok: true, message: "Connected and authenticated successfully." };
  } catch (error) {
    if (error instanceof PusherServer.RequestError) {
      if (error.status === 401 || error.status === 403) {
        return {
          ok: false,
          message:
            "Pusher rejected these credentials — check the app ID, key, secret, and cluster.",
        };
      }
      return {
        ok: false,
        message: `Pusher returned an unexpected response (${error.status ?? "no status"}).`,
      };
    }
    return { ok: false, message: "Could not reach Pusher." };
  }
}

const BEAMS_TEST_USER_ID = "docket-connection-test";

/** Beams has no dedicated "validate credentials" endpoint, so this publishes
 * to a reserved user ID no real device is ever registered under — a bad
 * instanceId/secretKey gets rejected by Pusher's API (401/404), while valid
 * credentials succeed with zero recipients and nothing delivered. */
export async function testPusherBeamsConnection(settings: {
  instanceId: string;
  secretKey: string;
}): Promise<CredentialTestResult> {
  const client = new PushNotifications({
    instanceId: settings.instanceId,
    secretKey: settings.secretKey,
  });
  try {
    await client.publishToUsers([BEAMS_TEST_USER_ID], {
      web: { notification: { title: "Docket connection test" } },
    });
    return { ok: true, message: "Connected and authenticated successfully." };
  } catch (error) {
    if (error instanceof Error) {
      if (/^40[13]/.test(error.message)) {
        return {
          ok: false,
          message:
            "Pusher rejected these credentials — check the instance ID and secret key.",
        };
      }
      if (/^404/.test(error.message)) {
        return {
          ok: false,
          message: "Pusher could not find this instance ID.",
        };
      }
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "Could not reach Pusher Beams." };
  }
}
