import { describe, expect, it } from "vitest";
import { canDeleteAttachment } from "@/lib/tickets/attachment-permissions";

// A customer's attachment is their own evidence in the ticket — an agent or
// admin should never be able to make it disappear, even by calling the
// delete endpoint directly.

describe("canDeleteAttachment", () => {
  it("forbids deleting a customer-uploaded attachment", () => {
    expect(canDeleteAttachment("customer")).toBe(false);
  });

  it("allows deleting an agent-uploaded attachment", () => {
    expect(canDeleteAttachment("agent")).toBe(true);
  });

  it("allows deleting an admin-uploaded attachment", () => {
    expect(canDeleteAttachment("admin")).toBe(true);
  });
});
