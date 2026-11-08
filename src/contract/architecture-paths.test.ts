import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n");
const inventory = JSON.parse(readFileSync("qa/architecture-paths.json", "utf8"));
function validate(value: typeof inventory): void {
  expect(Object.keys(value).sort()).toEqual(["paths", "repo", "schema_version"]);
  expect(value.schema_version).toBe(1);
  expect(value.repo).toBe("github.com/KyaniteLabs/Epoch");
  expect(value.paths.length).toBeGreaterThan(0);
  for (const row of value.paths) {
    expect(Object.keys(row).sort()).toEqual(["layer", "owner", "pattern"]);
    expect(row.layer.trim()).not.toBe("");
    expect(["Engineering", "Product"]).toContain(row.owner);
    expect(row.pattern).not.toMatch(/(^\/|\.\.)/);
    const regex = new RegExp("^" + row.pattern.split("**").map((part: string) => part.split("*").map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    expect(files.some((file) => regex.test(file)), row.pattern).toBe(true);
  }
}
describe("architecture ownership inventory", () => {
  it("validates literal identity and nonempty source-matched rows", () => validate(inventory));
  it("rejects wrong identity, unmatched patterns and empty inventories", () => {
    expect(() => validate({ ...inventory, repo: "github.com/KyaniteLabs/Other" })).toThrow();
    expect(() => validate({ ...inventory, paths: [] })).toThrow();
    expect(() => validate({ ...inventory, paths: [{ pattern: "missing/**", layer: "missing", owner: "Engineering" }] })).toThrow();
  });
});
