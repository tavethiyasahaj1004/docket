import fs from "node:fs/promises";
import path from "node:path";
import type { Files } from "files-sdk";
import {
  getStorageSettings,
  type StorageSettings,
} from "@/lib/integration-settings";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

// ── Local filesystem driver — the default, and the only one needing no setup.
// MUST be a persistent volume in Docker or a redeploy wipes every upload; see
// docker-compose.yml and docs/file-uploads.md.
const fsDriver = {
  async upload(key: string, buffer: Buffer): Promise<void> {
    const dest = path.join(UPLOADS_DIR, ...key.split("/"));
    await ensureDir(path.dirname(dest));
    await fs.writeFile(dest, buffer);
  },
  async download(key: string): Promise<Buffer> {
    const src = path.join(UPLOADS_DIR, ...key.split("/"));
    return fs.readFile(src);
  },
  async delete(key: string): Promise<void> {
    const target = path.join(UPLOADS_DIR, ...key.split("/"));
    await fs.unlink(target).catch(() => undefined);
  },
};

// ── Cloud drivers (s3 / r2) via files-sdk, dynamically imported so the default
// local-disk path never loads files-sdk or the AWS SDK. Cached by a signature of
// the resolved config, not forever, so a settings change rebuilds on next use.
type CloudStorageSettings = Extract<StorageSettings, { driver: "s3" | "r2" }>;

let cachedKey: string | null = null;
let cachedFiles: Files | null = null;

async function buildCloudFiles(settings: CloudStorageSettings): Promise<Files> {
  if (settings.driver === "s3") {
    const [{ Files: FilesCtor }, { s3 }] = await Promise.all([
      import("files-sdk"),
      import("files-sdk/s3"),
    ]);
    return new FilesCtor({
      adapter: s3({
        bucket: settings.bucket,
        region: settings.region,
        publicBaseUrl: settings.publicBaseUrl,
        // Only pass explicit credentials when the admin set them via
        // Settings — otherwise omitted so the adapter falls back to the
        // standard AWS chain (env vars, IAM role, shared profile).
        credentials:
          settings.accessKeyId && settings.secretAccessKey
            ? {
                accessKeyId: settings.accessKeyId,
                secretAccessKey: settings.secretAccessKey,
              }
            : undefined,
      }),
    });
  }
  const [{ Files: FilesCtor }, { r2 }] = await Promise.all([
    import("files-sdk"),
    import("files-sdk/r2"),
  ]);
  return new FilesCtor({
    adapter: r2({
      bucket: settings.bucket,
      accountId: settings.accountId,
      // Same as above: omitted falls back to the adapter reading
      // R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY directly.
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      publicBaseUrl: settings.publicBaseUrl,
    }),
  });
}

async function getCloudFiles(settings: CloudStorageSettings): Promise<Files> {
  const key = JSON.stringify(settings);
  if (cachedFiles && cachedKey === key) {
    return cachedFiles;
  }
  cachedFiles = await buildCloudFiles(settings);
  cachedKey = key;
  return cachedFiles;
}

export const storage = {
  /** Store a file. Key format: `tickets/{ticketId}/{uuid}/{filename}`.
   * Returns the key, never a full URL. */
  async upload(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    const settings = await getStorageSettings();
    if (settings.driver === "local") {
      await fsDriver.upload(key, buffer);
      return;
    }
    const files = await getCloudFiles(settings);
    await files.upload(key, buffer, { contentType: mimeType });
  },

  /** Read a file as a Buffer. */
  async download(key: string): Promise<Buffer> {
    const settings = await getStorageSettings();
    if (settings.driver === "local") {
      return fsDriver.download(key);
    }
    const files = await getCloudFiles(settings);
    const file = await files.download(key);
    return Buffer.from(await file.arrayBuffer());
  },

  /** Delete a file. Does not throw if the file does not exist. */
  async delete(key: string): Promise<void> {
    const settings = await getStorageSettings();
    if (settings.driver === "local") {
      await fsDriver.delete(key);
      return;
    }
    const files = await getCloudFiles(settings);
    await files.delete(key).catch(() => undefined);
  },

  /** Always our own /api/files route, never a direct or signed cloud URL: that
   * keeps this synchronous for inline `.map()` callers, and keeps attachment
   * access control in our route. The route calls `download()` for every driver. */
  url(key: string): string {
    return `/api/files/${key}`;
  },
};
