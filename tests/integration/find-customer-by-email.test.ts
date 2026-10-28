import { describe, expect, it } from "vitest";
import { findCustomerByEmail } from "@/lib/customers";
import { useSeededDatabase } from "./characterization/helpers";
import { CUSTOMERS, seedCustomers } from "./fixtures";

describe("findCustomerByEmail", () => {
  useSeededDatabase(seedCustomers);

  it("returns the customer for an exact email match", async () => {
    const found = await findCustomerByEmail(CUSTOMERS.ann.email);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(CUSTOMERS.ann.id);
    expect(found?.name).toBe(CUSTOMERS.ann.name);
    expect(found?.email).toBe(CUSTOMERS.ann.email);
  });

  it("matches case- and whitespace-insensitively", async () => {
    const found = await findCustomerByEmail("  ANN@Example.TEST \n");
    expect(found?.id).toBe(CUSTOMERS.ann.id);
  });

  it("returns null for an unknown email", async () => {
    expect(await findCustomerByEmail("nobody@example.test")).toBeNull();
  });
});
