import { seedDefaults } from "@/lib/seed-defaults";

async function seed() {
  console.log("Seeding default statuses, categories & priorities…");
  const { statuses, categories, priorities } = await seedDefaults();
  console.log(
    `  ✓ ${statuses} statuses, ${categories} categories, ${priorities} priorities (skipped if already exist)`
  );
  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
