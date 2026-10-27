import type { McpPrincipal } from "@/lib/mcp/auth";
import { MCP_TAG_LIMIT } from "@/lib/mcp/limits";
import type { getPublicTicketConfig } from "@/lib/ticket-config";

// Allowlist DTOs: each field is copied by name. Database rows are never spread
// into tool output.

/** Text that must never appear in any serialized tool output (checked in tests). */
export const FORBIDDEN_OUTPUT_PATTERNS: readonly (string | RegExp)[] = [
  "customerToken",
  "storageKey",
  "/api/files/",
  "token=",
  "apiKeyId",
  '"type":"doc"',
  "keyHash",
  "key_hash",
  "dkm_",
];

export function toWhoamiDto(principal: McpPrincipal, toolNames: string[]) {
  return {
    user: {
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      role: principal.role,
    },
    scopes: [...principal.scopes],
    authMethod: principal.authMethod,
    credential: {
      id: principal.credentialId,
      name: principal.credentialName,
      expiresAt: principal.credentialExpiresAt.toISOString(),
    },
    tools: [...toolNames],
  };
}
export type WhoamiDto = ReturnType<typeof toWhoamiDto>;

type PublicTicketConfig = Awaited<ReturnType<typeof getPublicTicketConfig>>;

export function toTicketConfigDto(
  config: PublicTicketConfig,
  options: { includeTags: boolean }
) {
  const tags = options.includeTags ? config.tags : [];
  return {
    statuses: config.statuses.map((s) => ({
      slug: s.slug,
      label: s.label,
      isDefault: s.isDefault,
      isClosedState: s.isClosedState,
    })),
    priorities: config.priorities.map((p) => ({
      slug: p.slug,
      label: p.label,
      isDefault: p.isDefault,
    })),
    categories: config.categories.map((c) => ({
      slug: c.slug,
      label: c.label,
    })),
    customFields: config.customFields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.options ? { options: [...f.options] } : {}),
      required: f.required,
    })),
    tags: tags.slice(0, MCP_TAG_LIMIT).map((t) => ({ id: t.id, name: t.name })),
    tagsTruncated: tags.length > MCP_TAG_LIMIT,
  };
}
export type TicketConfigDto = ReturnType<typeof toTicketConfigDto>;
