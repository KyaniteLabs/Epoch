// Small WebCrypto shim so the worker needs no nodejs_compat flag.
// Mirrors the semantics of node:crypto's createHmac/createHash/timingSafeEqual
// used by src/lib/telemetry-{submit,receiver}.ts in the main package.

const HEX_64 = /^[0-9a-f]{64}$/i;

function bufferToHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function hmacSha256Hex(
	key: string,
	message: string,
): Promise<string> {
	const enc = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		enc.encode(message),
	);
	return bufferToHex(signature);
}

export async function sha256Hex(message: string): Promise<string> {
	const enc = new TextEncoder();
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(message));
	return bufferToHex(digest);
}

/** Constant-time comparison of two 64-char lowercase hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (!HEX_64.test(a) || !HEX_64.test(b) || a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
