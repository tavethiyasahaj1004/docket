import { describe, expect, it } from "vitest";
import { GET as authServerGet } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";
import { GET as resourceGet } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import { setupMcpWorld } from "./mcp-helpers";

const world = setupMcpWorld();

// The stubs never read the database, so the answer cannot depend on the MCP
// switch (or on anything else in settings).
describe("OAuth discovery stubs with a real database", () => {
  it("answer identically whether MCP is on, off, or unconfigured", async () => {
    const bodies: string[] = [];
    for (const state of ["on", "off", "none"] as const) {
      if (state === "none") {
        await world.sql`DELETE FROM platform_settings`;
      } else {
        await world.sql`UPDATE platform_settings SET mcp_enabled = ${state === "on"}`;
      }
      for (const get of [resourceGet, authServerGet]) {
        const res = get();
        expect(res.status).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.push(await res.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({
      error: "This server does not support OAuth. Use a personal access token.",
    });
  });
});
