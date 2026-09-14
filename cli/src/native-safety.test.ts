import { join } from "node:path";
import { type RuntimeSession } from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { createNativeMcpSecurity } from "./native-mcp.ts";
import { nativeModelKey } from "./native-models.ts";
import { parseNativeCheckpoint } from "./native-resources.ts";
import { CWD, HOME, MODEL_A, nativeFixture } from "./native-test-support.ts";

/** Native exposes the new optional core hook even while other runtimes need not implement it. */
type PreflightSession = RuntimeSession & {
	readonly validateRestore: (checkpoint: unknown) => void;
};
/** Frozen plain-data fixtures detect mutation anywhere in the parser's resource tree. */
const freezeData = <T>(value: T): T => {
	if (value !== null && typeof value === "object") {
		Object.values(value).forEach(freezeData);
		Object.freeze(value);
	}
	return value;
};

/** Benign metadata must never become a global substring replacement in persisted state. */
describe("native credential classification", () => {
	it.each([
		"X-Mode",
		"MAX_TOKENS",
		"maxTokens",
		"TOKEN_LIMIT",
		"tokenLimit",
		"PASSWORD_FILE",
		"passwordFile",
		"AUTH_ENABLED",
		"authEnabled",
		"API_KEY_PATH",
		"HOME",
		"PATH",
		"NODE_OPTIONS",
	])("does not register ordinary %s header or environment settings", (name) => {
		const registerSecrets = vi.fn();
		const security = createNativeMcpSecurity({
			requestPermission: async () => true,
			registerSecrets,
		});
		const plan = security.plan(
			[
				{
					name: "local",
					command: "node",
					args: ["--token-limit", "1", "--password-file", "a"],
					env: [{ name, value: "a" }],
				},
				{
					name: "remote",
					type: "http",
					url: "https://mcp.invalid",
					headers: [{ name, value: "a" }],
				},
			],
			[],
			{ home: HOME, cwd: CWD, environment: { [name]: "a" } },
		);
		expect(registerSecrets).not.toHaveBeenCalled();
		expect(plan[0].summary.args).toEqual([
			"--token-limit",
			"1",
			"--password-file",
			"a",
		]);
		expect(plan[0].summary.environment).toEqual([
			{ name, value: "a", source: "Server override" },
		]);
		expect(plan[1].title).toBe("Connect MCP remote: https://mcp.invalid");
		expect(plan[1].summary).not.toHaveProperty("headers");
	});

	it.each([
		"Authorization",
		"x-api-key",
		"apiKey",
		"accessToken",
		"COOKIE",
		"client_secret",
		"password",
		"credentials",
		"SIGNATURE",
	])("registers actual %s credentials and masks their values", (name) => {
		const registerSecrets = vi.fn();
		const security = createNativeMcpSecurity({
			requestPermission: async () => true,
			registerSecrets,
		});
		security.collect([
			{
				name: "remote",
				type: "http",
				url: "https://mcp.invalid",
				headers: [{ name, value: "Bearer actual-credential" }],
			},
		]);
		expect(registerSecrets).toHaveBeenCalledWith([
			"Bearer actual-credential",
			"actual-credential",
		]);
		const [plan] = security.plan(
			[
				{
					name: "local",
					command: "node",
					args: ["--value", "actual-credential"],
					env: [],
				},
			],
			[],
			{ home: HOME, cwd: CWD, environment: {} },
		);
		expect(plan.summary.args).toEqual(["--value", "[REDACTED]"]);
	});

	it("keeps conservative permission-only masking out of persistent credential registration", () => {
		const registerSecrets = vi.fn();
		const security = createNativeMcpSecurity({
			requestPermission: async () => true,
			registerSecrets,
		});
		security.maskPermissionValues([HOME]);
		const [plan] = security.plan(
			[
				{
					name: "local",
					command: "node",
					args: ["--directory", HOME],
					env: [],
				},
			],
			[],
			{ home: HOME, cwd: CWD, environment: {} },
		);
		expect(plan.summary.args).toEqual(["--directory", "[REDACTED]"]);
		expect(registerSecrets).not.toHaveBeenCalled();
		security.registerSecrets([HOME]);
		expect(registerSecrets).toHaveBeenCalledWith([HOME]);
	});

	it("registers only credential query values, not URL usernames or token-limit settings", () => {
		const registerSecrets = vi.fn();
		const security = createNativeMcpSecurity({
			requestPermission: async () => true,
			registerSecrets,
		});
		security.collect([
			{
				name: "remote",
				type: "http",
				url: "https://a@mcp.invalid?tokenLimit=1&maxTokens=2&passwordFile=a&apiKey=actual%2Fcredential",
				headers: [],
			},
		]);
		expect(registerSecrets).toHaveBeenCalledWith([
			"actual/credential",
			"actual%2Fcredential",
		]);
	});
});

/** Preflight never changes conversation state, touches resources, or starts a backend for validation. */
describe("native restore preflight", () => {
	it("validates a frozen resource pin without mutating either the input or the live session", async () => {
		const f = nativeFixture();
		const session = (await f.open()) as PreflightSession;
		try {
			const before = parseNativeCheckpoint(session.snapshot!());
			const candidate = freezeData({
				...before,
				resources: {
					...before.resources,
					instructions: "Different pinned instructions",
				},
				selection: { model: nativeModelKey(MODEL_A), thinking: "off" },
			});
			const original = structuredClone(candidate);
			const effects = () =>
				[
					f.deps.realpath,
					f.deps.loadAgentResources,
					f.deps.loadModelConfig,
					f.models.getAvailable,
					f.deps.loadMcpConfig,
					f.deps.createEmbeddedRuntime,
					f.deps.createWorkflowRuntime,
					f.deps.connectMcpTools,
					f.requestPermission,
				].map((mock) => mock.mock.calls.length);
			const counts = effects();
			expect(session.validateRestore(candidate)).toBeUndefined();
			expect(session.snapshot!()).toEqual(before);
			expect(candidate).toEqual(original);
			expect(effects()).toEqual(counts);
			session.restore!(candidate);
			expect(session.snapshot!()).toEqual(candidate);
			expect(candidate).toEqual(original);
			expect(effects()).toEqual(counts);
			expect(f.resources.instructions).toBe(before.resources.instructions);
		} finally {
			await f.close();
		}
	});

	it("rejects structural, resource-root, and unavailable-selection failures identically in preflight and restore", async () => {
		const f = nativeFixture();
		const session = (await f.open()) as PreflightSession;
		try {
			const before = parseNativeCheckpoint(session.snapshot!());
			const getter = vi.fn(() => before.selection);
			const accessor = { ...before };
			Object.defineProperty(accessor, "selection", { get: getter });
			const invalid = [
				{ ...before, trusted: true },
				{
					...before,
					sources: {
						...before.sources,
						additionalDirectories: [join(CWD, "other-root")],
					},
				},
				{ ...before, resources: { ...before.resources, vaultRoot: HOME } },
				...[
					join(HOME, ".github", "skills", "example", "SKILL.md"),
					join(CWD, ".github", "agents", "example", "SKILL.md"),
					join(CWD, ".github", "skills-other", "example", "SKILL.md"),
				].map((path) => ({
					...before,
					resources: {
						...before.resources,
						skills: [{ ...before.resources.skills[0], path }],
					},
				})),
				{ ...before, selection: { model: "offline/missing", thinking: "off" } },
				{
					...before,
					selection: { ...before.selection, thinking: "unsupported" },
				},
				accessor,
			];
			invalid.forEach((value) => {
				expect(() => session.validateRestore(value)).toThrow();
				expect(() => session.restore!(value)).toThrow();
				expect(session.snapshot!()).toEqual(before);
			});
			expect(getter).not.toHaveBeenCalled();
			expect(f.deps.createEmbeddedRuntime).not.toHaveBeenCalled();
			expect(f.requestPermission).not.toHaveBeenCalled();
		} finally {
			await f.close();
		}
	});

	it("revalidates at restore instead of trusting a cached preflight of a subsequently changed object", async () => {
		const f = nativeFixture();
		const session = (await f.open()) as PreflightSession;
		try {
			const before = parseNativeCheckpoint(session.snapshot!());
			const candidate = structuredClone(before);
			session.validateRestore(candidate);
			candidate.selection.model = "offline/no-longer-valid";
			expect(() => session.restore!(candidate)).toThrow("Unavailable model");
			expect(session.snapshot!()).toEqual(before);
		} finally {
			await f.close();
		}
	});
});
