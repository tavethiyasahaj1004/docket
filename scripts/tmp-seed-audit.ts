import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile();
}

async function main() {
  const { audit } = await import("@/lib/audit");
  for (let i = 0; i < 60; i++) {
    await audit({
      action: "ticket.updated",
      actorEmail: "verify-agent@example.com",
      description: `Temp verification row ${i + 1} for sticky-header test`,
      entityId: `seed-${i}`,
      entityType: "ticket",
    });
  }
  console.log("seeded 60 audit rows");
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
