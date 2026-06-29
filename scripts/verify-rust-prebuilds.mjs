#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const binaries = ["epoch-cli", "epoch-mcp", "epoch-http"];
const checksumPattern = /^[a-f0-9]{64}$/;
const currentArch = process.arch === "x64" ? "x64" : process.arch;
const currentPlatform = `${process.platform}-${currentArch}`;

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
	return raw ? resolve(raw) : resolve(new URL("..", import.meta.url).pathname);
}

function platformsFromArgs(argv) {
	const fromFlag = argv.find((arg) => arg.startsWith("--platforms="));
	const raw =
		fromFlag?.slice("--platforms=".length) ??
		process.env.EPOCH_REQUIRED_PREBUILD_PLATFORMS ??
		currentPlatform;
	return raw
		.split(",")
		.map((platform) => platform.trim())
		.filter(Boolean);
}

function suffixFor(platform) {
	return platform.startsWith("win32-") ? ".exe" : "";
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifyManifest(platform, dir) {
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`Missing ${manifestPath}`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!isRecord(manifest)) {
		throw new Error(`${manifestPath} must contain a JSON object`);
	}
	if (manifest.platform !== platform) {
		throw new Error(
			`${manifestPath} platform is ${manifest.platform}, expected ${platform}`,
		);
	}
	if (!Array.isArray(manifest.binaries)) {
		throw new Error(`${manifestPath} must list binaries`);
	}
	const expectedBinaries = [...binaries].sort();
	if (manifest.binaries.some((binary) => typeof binary !== "string")) {
		throw new Error(`${manifestPath} binaries must all be strings`);
	}
	const actualBinaries = [...manifest.binaries].sort();
	if (JSON.stringify(actualBinaries) !== JSON.stringify(expectedBinaries)) {
		throw new Error(
			`${manifestPath} binaries are ${actualBinaries.join(", ")}, expected ${expectedBinaries.join(", ")}`,
		);
	}
	if (!isRecord(manifest.checksums)) {
		throw new Error(`${manifestPath} must include binary SHA-256 checksums`);
	}
	const suffix = suffixFor(platform);
	const expectedChecksums = binaries.map((binary) => `${binary}${suffix}`).sort();
	const actualChecksums = Object.keys(manifest.checksums).sort();
	if (JSON.stringify(actualChecksums) !== JSON.stringify(expectedChecksums)) {
		throw new Error(
			`${manifestPath} checksums are ${actualChecksums.join(", ")}, expected ${expectedChecksums.join(", ")}`,
		);
	}
	return manifest;
}

function verifyPayloadFiles(platform, dir) {
	const suffix = suffixFor(platform);
	const expected = new Set([
		"manifest.json",
		...binaries.map((binary) => `${binary}${suffix}`),
	]);
	for (const entry of readdirSync(dir)) {
		if (!expected.has(entry)) {
			throw new Error(`${join(dir, entry)} is not an expected prebuild file`);
		}
	}
}

function verifyBinary(platform, dir, manifest, binary) {
	const fileName = `${binary}${suffixFor(platform)}`;
	const path = join(dir, fileName);
	if (!existsSync(path)) {
		throw new Error(`Missing ${path}`);
	}
	const stat = statSync(path);
	if (!stat.isFile() || stat.size === 0) {
		throw new Error(`${path} is empty or not a file`);
	}
	if (!platform.startsWith("win32-") && (stat.mode & 0o111) === 0) {
		throw new Error(`${path} is not executable`);
	}
	const expectedChecksum = manifest.checksums[fileName];
	if (
		typeof expectedChecksum !== "string" ||
		!checksumPattern.test(expectedChecksum)
	) {
		throw new Error(`${manifestPathFor(dir)} checksum for ${fileName} is invalid`);
	}
	const actualChecksum = createHash("sha256")
		.update(readFileSync(path))
		.digest("hex");
	if (actualChecksum !== expectedChecksum) {
		throw new Error(
			`${path} sha256 is ${actualChecksum}, expected ${expectedChecksum}`,
		);
	}
}

function manifestPathFor(dir) {
	return join(dir, "manifest.json");
}

function main() {
	const args = process.argv.slice(2);
	const root = packageRoot(args);
	const platforms = platformsFromArgs(args);
	if (platforms.length === 0) {
		throw new Error("No prebuild platforms requested");
	}
	for (const platform of platforms) {
		const dir = join(root, "prebuilds", platform);
		const manifest = verifyManifest(platform, dir);
		verifyPayloadFiles(platform, dir);
		for (const binary of binaries) verifyBinary(platform, dir, manifest, binary);
	}
	console.log(`Verified Rust prebuilds: ${platforms.join(", ")}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
