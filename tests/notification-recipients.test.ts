import { describe, expect, it } from "vitest";
import { routeOwnerRecipients } from "@/lib/notifications";

const active = ["actor", "alice", "bob"];

describe("routeOwnerRecipients", () => {
  it("notifies only the assignee of an assigned ticket", () => {
    expect(routeOwnerRecipients(["alice", "bob"], active, "actor")).toEqual([
      ["alice"],
      ["bob"],
    ]);
  });

  it("falls back to every active agent for an unassigned ticket", () => {
    expect(routeOwnerRecipients([null], active, "actor")).toEqual([
      ["alice", "bob"],
    ]);
  });

  it("never notifies the actor", () => {
    expect(routeOwnerRecipients(["actor", null], active, "actor")).toEqual([
      [],
      ["alice", "bob"],
    ]);
  });

  it("gives each person at most one notification, earliest list wins", () => {
    expect(routeOwnerRecipients(["alice", null], active, "actor")).toEqual([
      ["alice"],
      ["bob"],
    ]);
    expect(routeOwnerRecipients([null, null], active, "actor")).toEqual([
      ["alice", "bob"],
      [],
    ]);
  });

  it("skips an assignee who is no longer active", () => {
    expect(routeOwnerRecipients(["gone"], active, "actor")).toEqual([[]]);
  });
});
