#!/usr/bin/env bun
// Build reviewable CI artifacts only. Never tags, creates a release, or publishes npm packages.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import config from "./fork-build.json" with { type: "json" };

const root = path.resolve(import.meta.dir, "..");
type Target = keyof typeof config.nativePackages;

export function validateForkIdentity(upstreamVersion: string, version: string): void {
	if (!/^\d+\.\d+\.\d+$/.test(upstreamVersion) || !version.startsWith(`${upstreamVersion}-`)) {
		throw new Error("Fork identity must name its exact upstream version and a distinct prerelease suffix");
	}
	if (!/^\d+\.\d+\.\d+-[a-z][a-z0-9-]*\.\d+$/.test(version)) {
		throw new Error("Fork identity must have a named, numbered prerelease suffix");
	}
}

export function verifyNativeArchive(bytes: Uint8Array, integrity: string): void {
	const actual = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
	if (actual !== integrity) throw new Error("Native archive does not match the reviewed upstream integrity");
}

export function nativeEntryName(entry: string, target: string): string | undefined {
	const names = [
		`pi_natives.${target}.node`,
		`pi_natives.${target}-baseline.node`,
		`pi_natives.${target}-modern.node`,
	];
	return names.find(name => entry === `package/${name}`);
}

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const child = Bun.spawn(args, { cwd: root, env, stdout: "pipe", stderr: "inherit" });
	const output = await new Response(child.stdout).text();
	if ((await child.exited) !== 0) throw new Error(`Command failed: ${args.join(" ")}`);
	return output.trim();
}

async function main(): Promise<void> {
	validateForkIdentity(config.upstreamVersion, config.version);
	const requested = process.argv[2];
	if (!requested || !Object.hasOwn(config.nativePackages, requested)) {
		throw new Error(`Usage: build-fork-binary.ts <${Object.keys(config.nativePackages).join("|")}>`);
	}
	const target = requested as Target;
	if (target !== `${process.platform}-${process.arch}`) {
		throw new Error("Fork artifact must build and smoke-test on its actual target platform");
	}
	await run(["git", "merge-base", "--is-ancestor", config.upstreamCommit, "HEAD"]);
	const sourceCommit = await run(["git", "rev-parse", "HEAD"]);
	const sourceDiff = await run(["git", "diff", "HEAD", "--", "packages", "scripts", ".github/workflows"]);
	const untrackedSource = await run([
		"git",
		"ls-files",
		"--others",
		"--exclude-standard",
		"--",
		"packages",
		"scripts",
		".github/workflows",
	]);
	if (process.env.GITHUB_ACTIONS === "true" && (sourceDiff || untrackedSource)) {
		throw new Error("CI artifacts require the exact committed source tree");
	}
	const sourceFiles = await run([
		"git",
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		"packages",
		"scripts",
		".github/workflows",
	]);
	const sourceHasher = new Bun.CryptoHasher("sha256");
	for (const file of [...new Set(sourceFiles.split("\0").filter(Boolean))].sort()) {
		sourceHasher.update(`${file}\0`);
		sourceHasher.update(await Bun.file(path.join(root, file)).bytes());
		sourceHasher.update("\0");
	}
	const sourceTreeSha256 = sourceHasher.digest("hex");
	const native = config.nativePackages[target];
	const response = await fetch(native.url);
	if (!response.ok) throw new Error(`Native archive download failed: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	verifyNativeArchive(bytes, native.integrity);
	const entries = await new Bun.Archive(bytes).files();
	let count = 0;
	for (const [entry, file] of entries) {
		const name = nativeEntryName(entry, target);
		if (!name) continue;
		await Bun.write(path.join(root, "packages/natives/native", name), file);
		count++;
	}
	if (!count) throw new Error("Verified archive contains no native addon for the selected target");

	// Only the distribution banner changes. Native ABI/components remain at the
	// reviewed upstream version; the compiler verifies every native version stamp.
	const manifestPath = path.join(root, "packages/utils/package.json");
	const original = await readFile(manifestPath, "utf8");
	const manifest = JSON.parse(original) as { version: string };
	if (manifest.version !== config.upstreamVersion) throw new Error("Unexpected upstream component version");
	try {
		manifest.version = config.version;
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(await run([process.execPath, "scripts/ci-release-build-binaries.ts", "--targets", target]));
	} finally {
		await writeFile(manifestPath, original);
	}
	const asset = `omp-${target.replace("win32", "windows")}${target.startsWith("win32") ? ".exe" : ""}`;
	const binary = path.join(root, "packages/coding-agent/binaries", asset);
	const outDir = path.join(root, "fork-artifacts", target);
	const smokeHome = path.join(outDir, "smoke-home");
	await mkdir(smokeHome, { recursive: true });
	const env = {
		...process.env,
		HOME: smokeHome,
		USERPROFILE: smokeHome,
		LOCALAPPDATA: path.join(smokeHome, "local"),
		XDG_DATA_HOME: path.join(smokeHome, "xdg"),
		PI_CODING_AGENT_DIR: path.join(smokeHome, ".omp/agent"),
		PI_NATIVES_DIR: path.join(smokeHome, ".omp/natives"),
	};
	const banner = await run([binary, "--version"], env);
	if (banner !== `omp/${config.version}`) throw new Error(`Unexpected built binary identity: ${banner}`);
	console.log(await run([binary, "--smoke-test"], env));
	const binaryBytes = new Uint8Array(await Bun.file(binary).arrayBuffer());
	const sha256 = new Bun.CryptoHasher("sha256").update(binaryBytes).digest("hex");
	await Bun.write(path.join(outDir, asset), binaryBytes);
	await Bun.write(path.join(outDir, "SHA256SUMS.txt"), `${sha256}  ${asset}\n`);
	await Bun.write(
		path.join(outDir, "build-provenance.json"),
		`${JSON.stringify(
			{
				version: config.version,
				upstreamVersion: config.upstreamVersion,
				upstreamCommit: config.upstreamCommit,
				sourceCommit,
				sourceTreeSha256,
				dirtySource: Boolean(sourceDiff || untrackedSource),
				sourceDiffSha256: sourceDiff ? new Bun.CryptoHasher("sha256").update(sourceDiff).digest("hex") : null,
				target,
				bunVersion: Bun.version,
				native,
				asset,
				sha256,
				banner,
				published: false,
			},
			null,
			2,
		)}\n`,
	);
	for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
		await Bun.write(path.join(outDir, name), Bun.file(path.join(root, name)));
	}
	console.log(JSON.stringify({ version: config.version, target, asset, sha256, outDir }));
}

if (import.meta.main) await main();
