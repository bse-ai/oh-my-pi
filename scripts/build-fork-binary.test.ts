import { describe, expect, it } from "bun:test";
import { nativeEntryName, validateForkIdentity, verifyNativeArchive } from "./build-fork-binary";

describe("fork binary artifact gates", () => {
	it("requires a distinct identity tied to the exact upstream release", () => {
		expect(() => validateForkIdentity("18.8.5", "18.8.5-arcadia.1")).not.toThrow();
		for (const version of ["18.8.5", "18.8.6-arcadia.1", "18.8.5-dirty", "18.8.5-arcadia.1/other"]) {
			expect(() => validateForkIdentity("18.8.5", version)).toThrow();
		}
	});
	it("rejects altered native archive bytes before extracting or running them", () => {
		const bytes = new TextEncoder().encode("reviewed upstream native fixture");
		const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
		expect(() => verifyNativeArchive(bytes, integrity)).not.toThrow();
		expect(() => verifyNativeArchive(new TextEncoder().encode("altered"), integrity)).toThrow();
	});
	it("selects only the selected platform addon without archive path traversal", () => {
		expect(nativeEntryName("package/pi_natives.win32-x64-baseline.node", "win32-x64")).toBe(
			"pi_natives.win32-x64-baseline.node",
		);
		for (const entry of [
			"../pi_natives.win32-x64.node",
			"package/../pi_natives.win32-x64.node",
			"package/pi_natives.linux-arm64.node",
			"package/install.js",
		]) {
			expect(nativeEntryName(entry, "win32-x64")).toBeUndefined();
		}
	});
});
