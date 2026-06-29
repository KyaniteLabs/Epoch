#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const binaries = ["epoch-cli", "epoch-mcp", "epoch-http"];
const currentArch = process.arch === "x64" ? "x64" : process.arch;
const currentPlatform = `${process.platform}-${currentArch}`;

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

function verifyManifest(platform, dir) {
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`Missing ${manifestPath}`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.platform !== platform) {
		throw new Error(
			`${manifestPath} platform is ${manifest.platform}, expected ${platform}`,
		);
	}
	for (const binary of binaries) {
		if (!manifest.binaries?.includes(binary)) {
			throw new Error(`${manifestPath} does not list ${binary}`);
		}
	}
}

function verifyBinary(platform, dir, binary) {
	const path = join(dir, `${binary}${suffixFor(platform)}`);
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
}

function main() {
	const platforms = platformsFromArgs(process.argv.slice(2));
	if (platforms.length === 0) {
		throw new Error("No prebuild platforms requested");
	}
	for (const platform of platforms) {
		const dir = join(root, "prebuilds", platform);
		verifyManifest(platform, dir);
		for (const binary of binaries) verifyBinary(platform, dir, binary);
	}
	console.log(`Verified Rust prebuilds: ${platforms.join(", ")}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
