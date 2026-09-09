import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

/** Published packages must work without the workspace's TypeScript aliases. */
const packageDirs = ["core", "tools", "adapters/pi", "adapters/acp", "cli"];
/** Resolve sources independently of the test runner's working directory. */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
/** Bound package-manager and archive subprocesses, including on CI. */
const packTimeout = 60_000;
/** Allow both bounded subprocesses to complete before the test deadline. */
const testTimeout = 150_000;

/** Parse the package metadata used by the packaging contract. */
const Manifest = z.object({
	name: z.string(),
	version: z.string(),
	type: z.literal("module"),
	main: z.string(),
	types: z.string(),
	exports: z.record(
		z.union([z.string(), z.object({ types: z.string(), default: z.string() })]),
	),
	dependencies: z.record(z.string()),
	peerDependencies: z.record(z.string()).optional(),
	scripts: z.record(z.string()),
	bin: z.record(z.string()).optional(),
	pi: z.object({ extensions: z.array(z.string()) }).optional(),
});

/** A missing manifest is a failed fixture, never a reason to skip the test. */
const readManifest = (root: string) =>
	Manifest.parse(
		JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")),
	);

/** Keep archives and unpacked fixtures outside the repository and global links. */
const temporaryFixture = (): string => {
	const root = mkdtempSync(path.join(tmpdir(), "d3r-package-dist-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	return root;
};

/** Inspect pnpm's actual rewrite, not a simulated publishConfig merge. */
const packPackage = (sourceRoot: string, fixture: string): string => {
	const windows = process.platform === "win32";
	execFileSync(
		"pnpm",
		["pack", "--pack-destination", windows ? `"${fixture}"` : fixture],
		{
			cwd: sourceRoot,
			env: { ...process.env, npm_config_ignore_scripts: "true" },
			shell: windows,
			timeout: packTimeout,
		},
	);
	const archives = readdirSync(fixture).filter((file) => file.endsWith(".tgz"));
	expect(archives).toHaveLength(1);
	execFileSync(
		"tar",
		["-xzf", path.join(fixture, archives[0]), "-C", fixture],
		{
			timeout: packTimeout,
		},
	);
	return path.join(fixture, "package");
};

/** Account for the CLI's src root while preserving every exported subpath. */
const compiledPath = (source: string): string =>
	source.replace(/^\.\/(?:src\/)?/, "./dist/").replace(/\.ts$/, ".js");

/** Missing build output must fail loudly even when pnpm pack itself succeeds. */
const requireFile = (root: string, file: string): void => {
	const target = path.join(root, file);
	expect(existsSync(target), `${file} missing; run pnpm -r build first`).toBe(
		true,
	);
	expect(statSync(target).isFile(), file).toBe(true);
};

/** Expand the existing vault wildcard from sources so missing emits are caught. */
const sourceTargets = (sourceRoot: string, target: string): string[] => {
	if (!target.includes("*")) {
		return [target];
	}
	const directory = path.posix.dirname(target);
	return readdirSync(path.join(sourceRoot, directory))
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
		.map((file) => `./${path.posix.join(directory, file)}`);
};

/** Verify entrypoint declarations and JS for every source export, including globs. */
const expectExports = (sourceRoot: string, packedRoot: string): void => {
	const source = readManifest(sourceRoot);
	const packed = readManifest(packedRoot);
	expect(packed.main).toBe(compiledPath(source.main));
	expect(packed.types).toBe(
		compiledPath(source.types).replace(/\.js$/, ".d.ts"),
	);
	requireFile(packedRoot, packed.main);
	requireFile(packedRoot, packed.types);
	expect(Object.keys(packed.exports)).toEqual(Object.keys(source.exports));
	for (const [subpath, target] of Object.entries(source.exports)) {
		if (typeof target !== "string") {
			throw new Error(`Expected a workspace source export for ${subpath}`);
		}
		if (subpath === "./package.json") {
			expect(packed.exports[subpath]).toBe(target);
			requireFile(packedRoot, target);
		} else {
			expect(packed.exports[subpath]).toEqual({
				types: compiledPath(target).replace(/\.js$/, ".d.ts"),
				default: compiledPath(target),
			});
			const targets = sourceTargets(sourceRoot, target);
			expect(targets.length, subpath).toBeGreaterThan(0);
			for (const entry of targets) {
				requireFile(packedRoot, compiledPath(entry));
				requireFile(packedRoot, compiledPath(entry).replace(/\.js$/, ".d.ts"));
			}
		}
	}
};

/** Include hidden seed files and extension support modules, not just entrypoints. */
const filesUnder = (root: string): string[] =>
	readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? filesUnder(path.join(root, entry.name)).map((file) =>
					path.posix.join(entry.name, file),
				)
			: [entry.name],
	);

/** Authored assets and generated prompt content must survive the file allowlist. */
const expectAssets = (
	sourceRoot: string,
	packedRoot: string,
	dir: string,
): void => {
	const trees = dir === "core" ? ["agents", "seed"] : [];
	if (dir === "adapters/pi") {
		trees.push("extensions");
		requireFile(
			packedRoot,
			"extensions/mode/orchestrator-contract.generated.ts",
		);
		for (const agent of filesUnder(path.join(repoRoot, "core/agents"))) {
			requireFile(packedRoot, `dist/agents/${agent}`);
		}
	}
	for (const tree of trees) {
		for (const file of filesUnder(path.join(sourceRoot, tree))) {
			const expected = readFileSync(path.join(sourceRoot, tree, file));
			expect(readFileSync(path.join(packedRoot, tree, file))).toEqual(expected);
			if (tree === "seed") {
				expect(readFileSync(path.join(packedRoot, "dist", tree, file))).toEqual(
					expected,
				);
			}
		}
	}
	if (dir === "core") {
		expect(readFileSync(path.join(packedRoot, "workflow.yaml"))).toEqual(
			readFileSync(path.join(sourceRoot, "workflow.yaml")),
		);
	}
};

/** Preserve runtime dependencies, commands, and the Node-backed binary contract. */
const expectMetadata = (sourceRoot: string, packedRoot: string): void => {
	const source = readManifest(sourceRoot);
	const packed = readManifest(packedRoot);
	const versions = Object.fromEntries(
		packageDirs.map((dir) => {
			const manifest = readManifest(path.join(repoRoot, dir));
			return [manifest.name, manifest.version];
		}),
	);
	expect(packed.name).toBe(source.name);
	expect(packed.version).toBe(source.version);
	expect(packed.dependencies).toEqual(
		Object.fromEntries(
			Object.entries(source.dependencies).map(([name, version]) => [
				name,
				version === "workspace:*" ? versions[name] : version,
			]),
		),
	);
	expect(packed.peerDependencies).toEqual(source.peerDependencies);
	expect(packed.scripts).toEqual(source.scripts);
	expect(packed.bin).toEqual(source.bin);
	expect(packed.pi).toEqual(source.pi);
	for (const bin of Object.values(packed.bin ?? {})) {
		requireFile(packedRoot, bin);
		expect(readFileSync(path.join(packedRoot, bin), "utf8")).toMatch(
			/^#!\/usr\/bin\/env node\r?\n/,
		);
	}
};

describe("published package artifacts", () => {
	it("fails on a missing manifest in an isolated fixture", () => {
		const fixture = temporaryFixture();
		expect(() => readManifest(fixture)).toThrow(/ENOENT.*package\.json/);
	});

	it.each(packageDirs)(
		"packs %s with compiled exports and required runtime assets",
		(dir) => {
			const sourceRoot = path.join(repoRoot, dir);
			const packedRoot = packPackage(sourceRoot, temporaryFixture());
			expectExports(sourceRoot, packedRoot);
			expectAssets(sourceRoot, packedRoot, dir);
			expectMetadata(sourceRoot, packedRoot);
		},
		testTimeout,
	);
});
