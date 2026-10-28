import { asc, ilike } from "drizzle-orm";
import { cannedResponses } from "@/db/schema";
import { db } from "@/lib/db";

export type CannedResponse = typeof cannedResponses.$inferSelect;

export async function getCannedResponses(): Promise<CannedResponse[]> {
  return db.select().from(cannedResponses).orderBy(asc(cannedResponses.title));
}

export async function searchCannedResponses(
  q: string | undefined
): Promise<CannedResponse[]> {
  return db
    .select()
    .from(cannedResponses)
    .where(q ? ilike(cannedResponses.title, `%${q}%`) : undefined)
    .orderBy(asc(cannedResponses.title));
}
