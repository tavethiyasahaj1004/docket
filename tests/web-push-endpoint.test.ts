import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint } from "@/lib/web-push";

describe("isAllowedPushEndpoint", () => {
  it("accepts the real browser push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    }
  });

  it("rejects internal and arbitrary hosts (SSRF)", () => {
    for (const endpoint of [
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/push",
      "https://localhost/push",
      "https://example.com/push",
      "https://fcm.googleapis.com.evil.com/x",
      "https://evilfcm.googleapis.com.attacker.io/x",
      "https://notfcm.googleapis.com@10.0.0.5/x",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    }
  });

  it("rejects non-https, custom ports, credentials and junk", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pass@fcm.googleapis.com/fcm/send/x",
      "not a url",
      "",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    }
  });
});
