import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isCurrentFileEntrypoint } from "./entrypoint.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "epoch-entrypoint-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("isCurrentFileEntrypoint", () => {
	it("recognizes an npm bin symlink whose target is the running module", () => {
		const root = makeTempRoot();
		const realEntry = join(root, "dist", "index.js");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(realEntry, "// fake CLI entry\n");
		const bin = join(root, "epoch");
		symlinkSync(realEntry, bin);

		// Node realpaths import.meta.url; argv[1] keeps the symlink path.
		const moduleUrl = pathToFileURL(realpathSync(realEntry)).href;
		expect(isCurrentFileEntrypoint(bin, moduleUrl)).toBe(true);
	});

	it("returns false when argv[1] names a different file", () => {
		const root = makeTempRoot();
		const otherEntry = join(root, "other.js");
		writeFileSync(otherEntry, "// fake other entry\n");

		const moduleUrl = pathToFileURL(join(root, "dist", "index.js")).href;
		expect(isCurrentFileEntrypoint(otherEntry, moduleUrl)).toBe(false);
	});

	it("falls back to the literal path when realpath cannot resolve argv[1]", () => {
		const missing = join(makeTempRoot(), "not-built-yet.js");
		const moduleUrl = pathToFileURL(missing).href;

		// realpathSync throws; the literal comparison still answers true.
		expect(isCurrentFileEntrypoint(missing, moduleUrl)).toBe(true);
		expect(isCurrentFileEntrypoint(missing, pathToFileURL(`${missing}.other`).href)).toBe(false);
	});

	it("returns false without an argv[1] (imported, not executed)", () => {
		expect(
			isCurrentFileEntrypoint(undefined, pathToFileURL("/tmp/index.js").href),
		).toBe(false);
	});
});
