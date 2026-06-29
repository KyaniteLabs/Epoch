#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function optionValue(argv, name) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === name) return argv[i + 1];
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
	}
	return null;
}

function packageRoot(argv) {
	const raw =
		optionValue(argv, "--root") ?? process.env.EPOCH_PREBUILD_ROOT ?? null;
	return raw
		? resolve(raw)
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const root = packageRoot(process.argv.slice(2));
const arch = process.arch === "x64" ? "x64" : process.arch;
const platform = `${process.platform}-${arch}`;
const suffix = process.platform === "win32" ? ".exe" : "";
const targetDir = join(root, "prebuilds", platform);
const sourceDir = join(root, "rust", "target", "release");
const binaries = ["epoch-cli", "epoch-mcp", "epoch-http"];
const checksums = {};

mkdirSync(targetDir, { recursive: true });

for (const binary of binaries) {
	const source = join(sourceDir, `${binary}${suffix}`);
	const destination = join(targetDir, `${binary}${suffix}`);
	copyFileSync(source, destination);
	chmodSync(destination, 0o755);
	checksums[`${binary}${suffix}`] = createHash("sha256")
		.update(readFileSync(destination))
		.digest("hex");
}

writeFileSync(
	join(targetDir, "manifest.json"),
	`${JSON.stringify(
		{
			platform,
			binaries,
			checksums,
			source: "rust/target/release",
			generatedAt: new Date().toISOString(),
		},
		null,
		2,
	)}\n`,
);

console.log(`Staged Rust prebuilds: prebuilds/${platform}`);
