import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { ticketCustomFields, ticketCustomFieldValues } from "@/db/schema";
import { db } from "@/lib/db";

export type TicketCustomField = typeof ticketCustomFields.$inferSelect;
export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldWithValue {
  fieldId: string;
  key: string;
  label: string;
  options: string[] | null;
  required: boolean;
  type: string;
  value: string | null;
}

export async function getCustomFields(): Promise<TicketCustomField[]> {
  return db
    .select()
    .from(ticketCustomFields)
    .orderBy(asc(ticketCustomFields.sortOrder));
}

/** Every defined field for one ticket, joined with its stored value (null if unset). */
export async function getCustomFieldValues(
  ticketId: string
): Promise<CustomFieldWithValue[]> {
  const fields = await getCustomFields();
  if (fields.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      fieldId: ticketCustomFieldValues.fieldId,
      value: ticketCustomFieldValues.value,
    })
    .from(ticketCustomFieldValues)
    .where(eq(ticketCustomFieldValues.ticketId, ticketId));
  const valueByFieldId = new Map(rows.map((r) => [r.fieldId, r.value]));

  return fields.map((f) => ({
    fieldId: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    options: f.options ?? null,
    required: f.required,
    value: valueByFieldId.get(f.id) ?? null,
  }));
}

export type CustomFieldValidationResult =
  | { ok: true; values: Array<{ fieldId: string; value: string | null }> }
  | { ok: false; error: string; httpStatus: number };

/** Hand-rolled validation (no zod here) of a `{ [field.key]: rawValue }` payload
 * against the admin-defined fields. `partial: true` (agent PATCH) checks only
 * keys present, matching every other PATCH route; `partial: false` (creation)
 * checks all, so a required field that's absent entirely is still caught. */
export function validateCustomFieldInput(
  fields: TicketCustomField[],
  input: Record<string, unknown> | undefined,
  { partial = false }: { partial?: boolean } = {}
): CustomFieldValidationResult {
  const raw = input ?? {};
  const targets = partial ? fields.filter((f) => f.key in raw) : fields;

  const values: Array<{ fieldId: string; value: string | null }> = [];

  for (const field of targets) {
    const rawValue = raw[field.key];
    const isEmpty =
      rawValue === undefined ||
      rawValue === null ||
      (typeof rawValue === "string" && rawValue.trim() === "");

    if (isEmpty) {
      if (field.required) {
        return {
          ok: false,
          error: `"${field.label}" is required.`,
          httpStatus: 400,
        };
      }
      values.push({ fieldId: field.id, value: null });
      continue;
    }

    switch (field.type as CustomFieldType) {
      case "text": {
        const text = String(rawValue).trim();
        if (text.length > 1000) {
          return {
            ok: false,
            error: `"${field.label}" must be 1000 characters or fewer.`,
            httpStatus: 400,
          };
        }
        values.push({ fieldId: field.id, value: text });
        break;
      }
      case "number": {
        const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
        if (!Number.isFinite(num)) {
          return {
            ok: false,
            error: `"${field.label}" must be a number.`,
            httpStatus: 400,
          };
        }
        values.push({ fieldId: field.id, value: String(num) });
        break;
      }
      case "date": {
        const str = String(rawValue).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(str))) {
          return {
            ok: false,
            error: `"${field.label}" must be a valid date (YYYY-MM-DD).`,
            httpStatus: 400,
          };
        }
        values.push({ fieldId: field.id, value: str });
        break;
      }
      case "checkbox": {
        const bool =
          typeof rawValue === "boolean"
            ? rawValue
            : rawValue === "true" || rawValue === "1" || rawValue === 1;
        values.push({ fieldId: field.id, value: bool ? "true" : "false" });
        break;
      }
      case "select": {
        const option = String(rawValue).trim();
        if (!(field.options ?? []).includes(option)) {
          return {
            ok: false,
            error: `"${field.label}" must be one of the configured options.`,
            httpStatus: 400,
          };
        }
        values.push({ fieldId: field.id, value: option });
        break;
      }
      default:
        values.push({ fieldId: field.id, value: String(rawValue) });
    }
  }

  return { ok: true, values };
}

/** Upsert-or-clear a ticket's custom field values. `value: null` deletes the row. */
export async function setCustomFieldValues(
  ticketId: string,
  values: Array<{ fieldId: string; value: string | null }>
): Promise<void> {
  const now = new Date();
  for (const v of values) {
    if (v.value === null) {
      await db
        .delete(ticketCustomFieldValues)
        .where(
          and(
            eq(ticketCustomFieldValues.ticketId, ticketId),
            eq(ticketCustomFieldValues.fieldId, v.fieldId)
          )
        );
      continue;
    }
    await db
      .insert(ticketCustomFieldValues)
      .values({
        id: createId(),
        ticketId,
        fieldId: v.fieldId,
        value: v.value,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          ticketCustomFieldValues.ticketId,
          ticketCustomFieldValues.fieldId,
        ],
        set: { value: v.value, updatedAt: now },
      });
  }
}

/** Decode a stored text value to the native JS type callers expect over the API. */
export function coerceCustomFieldValue(
  type: string,
  value: string | null
): string | number | boolean | null {
  if (value === null) {
    return null;
  }
  if (type === "number") {
    return Number(value);
  }
  if (type === "checkbox") {
    return value === "true";
  }
  return value;
}
