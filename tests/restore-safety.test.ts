import { describe, expect, it } from "vitest";
import { restoreConnection } from "../scripts/restore-safety.js";
describe("restore rehearsal isolation", () => {
  const database = "papersign_restore_0123456789abcdef01234567";
  it("permits only a generated restore database on a loopback server", () => {
    expect(
      restoreConnection(
        "postgresql://fixture:secret@127.0.0.1:54376/papersign",
        database,
      ).pathname,
    ).toBe(`/${database}`);
  });
  it.each([
    "papersign",
    "papersign_restore_existing",
    "papersign_restore_0123456789abcdef01234567;drop database papersign",
  ])("refuses existing/application-shaped target %s", (name) => {
    expect(() =>
      restoreConnection("postgresql://fixture@127.0.0.1/papersign", name),
    ).toThrow("isolated papersign_restore_");
  });
  it.each([
    "postgresql://fixture@10.20.30.40/papersign",
    "postgresql://fixture@example.invalid/papersign",
    "postgresql://fixture@127.0.0.1/papersign?host=10.20.30.40",
  ])("refuses remote/overridden target %s", (url) => {
    expect(() => restoreConnection(url, database)).toThrow();
  });
});
