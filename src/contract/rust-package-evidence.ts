export type PackageCommandEvidence = {
	name: string;
	target: string;
	exitCode: number | null;
	signal: string | null;
	stdoutHead: string;
	stderrHead: string;
	error: string | null;
};

export const REQUIRED_PACKAGE_COMMANDS = [
	"epoch-cli",
	"epoch-mcp",
	"epoch-http",
] as const;

export function currentPackagePlatform(): string {
	return `${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
}

export function packagePrebuildTarget(binary: "epoch-mcp" | "epoch-http"): string {
	return `prebuilds/${currentPackagePlatform()}/${binary}${process.platform === "win32" ? ".exe" : ""}`;
}

export function packageCommandHasExpectedEvidence(
	command: PackageCommandEvidence,
): boolean {
	if (
		command.exitCode !== 0 ||
		command.signal !== null ||
		command.error !== null
	) {
		return false;
	}
	if (command.name === "epoch-cli") {
		return (
			command.target === "node_modules/.bin/epoch" &&
			command.stdoutHead.includes('"ok": true')
		);
	}
	if (command.name === "epoch-mcp") {
		return (
			command.target === packagePrebuildTarget("epoch-mcp") &&
			command.stdoutHead.startsWith("Content-Length:") &&
			command.stdoutHead.includes('"result":{}')
		);
	}
	if (command.name === "epoch-http") {
		return (
			command.target === packagePrebuildTarget("epoch-http") &&
			command.stdoutHead.includes("health ") &&
			command.stdoutHead.includes('"status":"ok"') &&
			command.stdoutHead.includes('"tools":24')
		);
	}
	return false;
}

export function hasRequiredPackageCommands(
	commands: readonly PackageCommandEvidence[],
): boolean {
	return REQUIRED_PACKAGE_COMMANDS.every((name) => {
		const command = commands.find((candidate) => candidate.name === name);
		return command !== undefined && packageCommandHasExpectedEvidence(command);
	});
}

export function packageCommandsFromUnknown(value: unknown): PackageCommandEvidence[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(packageCommandFromUnknown)
		.filter((command): command is PackageCommandEvidence => command !== null);
}

function packageCommandFromUnknown(value: unknown): PackageCommandEvidence | null {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("name" in value) ||
		typeof value.name !== "string"
	) {
		return null;
	}
	return {
		name: value.name,
		target: "target" in value && typeof value.target === "string" ? value.target : "",
		exitCode:
			"exitCode" in value && typeof value.exitCode === "number"
				? value.exitCode
				: null,
		signal: "signal" in value && typeof value.signal === "string" ? value.signal : null,
		stdoutHead:
			"stdoutHead" in value && typeof value.stdoutHead === "string"
				? value.stdoutHead
				: "",
		stderrHead:
			"stderrHead" in value && typeof value.stderrHead === "string"
				? value.stderrHead
				: "",
		error: "error" in value && typeof value.error === "string" ? value.error : null,
	};
}
