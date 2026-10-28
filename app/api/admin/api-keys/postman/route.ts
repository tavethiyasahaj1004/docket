import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { env } from "@/lib/env";

// GET /api/admin/api-keys/postman — a ready-to-import Postman collection for the
// public API, pre-filled with this instance's base_url; api_key is a placeholder,
// no secrets. Hand-authored, so keep it in sync with the spec and docs/api.md.
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const baseUrl = env.NEXT_PUBLIC_APP_URL;

  const collection = {
    info: {
      name: "Docket API",
      description:
        "Create and look up tickets via the Docket public API. " +
        "Set the `api_key` collection variable to a key generated at " +
        "/admin/api-keys before sending requests. See docs/api.md.",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    auth: {
      type: "bearer",
      bearer: [{ key: "token", value: "{{api_key}}", type: "string" }],
    },
    variable: [
      { key: "base_url", value: baseUrl, type: "string" },
      {
        key: "api_key",
        value: "dk_live_xxxxxxxxxxxxxxxxxxxxxxxx",
        type: "string",
      },
      { key: "ticket_id", value: "", type: "string" },
      { key: "attachment_id", value: "", type: "string" },
      { key: "customer_email", value: "jane@example.com", type: "string" },
    ],
    item: [
      {
        name: "Get Config (categories, priorities, statuses)",
        request: {
          method: "GET",
          url: {
            raw: "{{base_url}}/api/v1/config",
            host: ["{{base_url}}"],
            path: ["api", "v1", "config"],
          },
        },
      },
      {
        name: "Create Ticket (plain text)",
        request: {
          method: "POST",
          header: [{ key: "Content-Type", value: "application/json" }],
          description:
            '`customFields` keys are whatever YOUR admin configured at /admin/custom-fields — there\'s no fixed set. Run "Get Config" first to see the real keys/types for this instance, then replace the `"//"` placeholder below with real `"<key>": <value>` entries (e.g. `"app": "Mobile App"`). Required fields are only enforced once you include `customFields` at all — see docs/api.md.',
          body: {
            mode: "raw",
            raw: JSON.stringify(
              {
                name: "Jane Doe",
                email: "jane@example.com",
                subject: "Cannot log in",
                description: "I get an error when I try to sign in.",
                category: "bug",
                customFields: {
                  "//": 'Run "Get Config" to see this instance\'s real custom field keys, then replace this line — e.g. "app": "Mobile App"',
                },
              },
              null,
              2
            ),
          },
          url: {
            raw: "{{base_url}}/api/v1/tickets",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets"],
          },
        },
        event: [
          {
            listen: "test",
            script: {
              type: "text/javascript",
              exec: [
                "if (pm.response.code === 201) {",
                "  const body = pm.response.json();",
                "  pm.collectionVariables.set('ticket_id', body.id);",
                "}",
              ],
            },
          },
        ],
      },
      {
        name: "Create Ticket (HTML from your own editor)",
        request: {
          method: "POST",
          header: [{ key: "Content-Type", value: "application/json" }],
          body: {
            mode: "raw",
            raw: JSON.stringify(
              {
                name: "Jane Doe",
                email: "jane@example.com",
                subject: "Cannot log in",
                description:
                  "<p>I get an error when I try to sign in.</p><p><strong>It started this morning.</strong></p>",
                descriptionFormat: "html",
                category: "bug",
              },
              null,
              2
            ),
          },
          url: {
            raw: "{{base_url}}/api/v1/tickets",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets"],
          },
        },
      },
      {
        name: "Get Ticket Status",
        request: {
          method: "GET",
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets", "{{ticket_id}}"],
          },
        },
      },
      {
        name: "Download Attachment",
        request: {
          method: "GET",
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}/attachments/{{attachment_id}}",
            host: ["{{base_url}}"],
            path: [
              "api",
              "v1",
              "tickets",
              "{{ticket_id}}",
              "attachments",
              "{{attachment_id}}",
            ],
          },
        },
      },
      {
        name: "Get Ticket Comments",
        request: {
          method: "GET",
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}/comments",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets", "{{ticket_id}}", "comments"],
          },
        },
      },
      {
        name: "Post a Reply",
        request: {
          method: "POST",
          header: [{ key: "Content-Type", value: "application/json" }],
          body: {
            mode: "raw",
            raw: JSON.stringify(
              {
                email: "{{customer_email}}",
                content: "Thanks, that fixed it!",
                contentFormat: "text",
              },
              null,
              2
            ),
          },
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}/comments",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets", "{{ticket_id}}", "comments"],
          },
        },
      },
      {
        name: "Close Ticket",
        request: {
          method: "PATCH",
          header: [{ key: "Content-Type", value: "application/json" }],
          body: {
            mode: "raw",
            raw: JSON.stringify(
              { email: "{{customer_email}}", action: "close" },
              null,
              2
            ),
          },
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}/status",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets", "{{ticket_id}}", "status"],
          },
        },
      },
      {
        name: "Reopen Ticket",
        request: {
          method: "PATCH",
          header: [{ key: "Content-Type", value: "application/json" }],
          body: {
            mode: "raw",
            raw: JSON.stringify(
              { email: "{{customer_email}}", action: "reopen" },
              null,
              2
            ),
          },
          url: {
            raw: "{{base_url}}/api/v1/tickets/{{ticket_id}}/status",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets", "{{ticket_id}}", "status"],
          },
        },
      },
      {
        name: "List Tickets by Email",
        request: {
          method: "GET",
          url: {
            raw: "{{base_url}}/api/v1/tickets?email={{customer_email}}",
            host: ["{{base_url}}"],
            path: ["api", "v1", "tickets"],
            query: [
              { key: "email", value: "{{customer_email}}" },
              { key: "page", value: "1", disabled: true },
              { key: "per_page", value: "50", disabled: true },
            ],
          },
        },
      },
    ],
  };

  return NextResponse.json(collection, {
    headers: {
      "Content-Disposition":
        'attachment; filename="docket-api.postman_collection.json"',
    },
  });
}
