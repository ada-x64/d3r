import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toolCallPresentation } from "./presentation.ts";

/** An absolute runtime-normalized cwd, deliberately distinct from the process cwd. */
const CWD = resolve("presentation-workspace");
/** Inspect exactly the text ACP clients render, not rawInput hidden by execute/edit cards. */
const visibleText = (card: ReturnType<typeof toolCallPresentation>): string => {
	const item = card.content?.[0];
	if (item?.type !== "content" || item.content.type !== "text") {
		throw new Error("Missing visible tool preview");
	}
	return item.content.text;
};
/** Exercise the native command identity without guessing at MCP input shapes. */
const command = (input: unknown, secrets: readonly string[] = []) =>
	toolCallPresentation(
		{ title: "run_command", kind: "execute", input },
		{ permission: true, secrets },
	);

/** User-visible approval data must remain faithful, inert and independent of execution data. */
describe("ACP tool presentation", () => {
	it("shows executable and every literal argv entry with unambiguous JSON quoting", () => {
		const input = Object.freeze({
			command: "program with spaces",
			args: Object.freeze([
				"a b",
				"",
				"single'quote",
				'double"quote',
				String.raw`a\b`,
				"$(touch marker)",
				"; rm file",
				"first\nsecond",
			]),
			timeoutMs: 1234,
		});
		const card = command(input);
		const text = visibleText(card);
		expect(text).toContain(`Executable: ${JSON.stringify(input.command)}`);
		expect(text).toContain(`Literal argv: ${JSON.stringify(input.args)}`);
		expect(text).toContain("Requested cwd: session default");
		expect(text).not.toContain("Effective cwd:");
		expect(text).toContain("Timeout: 1234 ms");
		expect(text).toContain("UNSANDBOXED");
		expect(text).toContain(
			"platform/client launch wrappers may interpret arguments",
		);
		expect(text).not.toContain("No implicit shell");
		expect(card.title).toMatch(/^run_command: "program with spaces"/);
		expect(card.rawInput).toEqual(input);
		expect(card.rawInput).not.toBe(input);
	});

	it.each(["sh", "bash"])(
		"shows an explicit %s script as one argument, not an invented shell invocation",
		(shell) => {
			const input = {
				command: shell,
				args: ["-c", "printf '%s\\n' 'two words'\nprintf done > marker"],
			};
			const text = visibleText(command(input));
			expect(text).toContain(`Executable: ${JSON.stringify(shell)}`);
			expect(text).toContain(`Literal argv: ${JSON.stringify(input.args)}`);
			expect(text).not.toContain("Timeout:");
		},
	);

	it.each([undefined, ".", "nested dir", "../project"])(
		"does not invent an effective cwd for unnormalized input %s",
		(cwd) => {
			const input = { command: "pwd", ...(cwd === undefined ? {} : { cwd }) };
			const card = command(input);
			expect(visibleText(card)).toContain(
				cwd === undefined
					? "Requested cwd: session default"
					: `Requested cwd: ${JSON.stringify(cwd)}`,
			);
			expect(visibleText(card)).not.toContain("Effective cwd:");
			expect(visibleText(card)).not.toContain(CWD);
			expect(card.rawInput).toEqual(input);
		},
	);

	it("labels only the normalized approval cwd as effective, not the original activity", () => {
		const input = { command: "pwd", cwd: CWD };
		const activity = toolCallPresentation({
			title: "run_command",
			kind: "execute",
			input,
		});
		expect(visibleText(activity)).toContain(
			`Requested cwd: ${JSON.stringify(CWD)}`,
		);
		expect(visibleText(activity)).not.toContain("Effective cwd:");
		const approval = command(input);
		expect(visibleText(approval)).toContain(
			`Effective cwd: ${JSON.stringify(CWD)}`,
		);
		expect(approval.rawInput).toEqual(input);
	});

	it.each(["tool.cmd", "tool.BAT", "node"])(
		"qualifies shell wrapping for %s without claiming which backend executes it",
		(executable) => {
			const input = {
				command: executable,
				args: ["two words", "literal & argument"],
			};
			const text = visibleText(command(input));
			expect(text).toContain("Windows .cmd/.bat files may run through cmd.exe");
			expect(text).toContain(`Executable: ${JSON.stringify(executable)}`);
			expect(text).toContain(`Literal argv: ${JSON.stringify(input.args)}`);
			expect(text).not.toContain("No implicit shell");
		},
	);

	it("bounds only the title, retaining the full approval payload in content and rawInput", () => {
		const longArgumentLength = 1000;
		const titleLimit = 100;
		const args = ["x".repeat(longArgumentLength), "last argument"];
		const card = command({ command: "node", args });
		expect(card.title.length).toBeLessThanOrEqual(titleLimit);
		expect(card.title).toMatch(/\.\.\.$/);
		expect(visibleText(card)).toContain(JSON.stringify(args));
		expect(card.rawInput).toEqual({ command: "node", args });
	});

	it("masks registered secrets before quoting and title truncation without registering normal arguments", () => {
		const secrets = Object.freeze([
			"provider-secret",
			"provider-secret-long",
			"multiline\ncredential",
		]);
		const input = Object.freeze({
			command: "provider-secret-long-program",
			args: ["provider-secret", "multiline\ncredential", "-y", ".", "a"],
			cwd: "provider-secret",
		});
		const card = command(input, secrets);
		const display = JSON.stringify(card);
		expect(display).not.toContain("provider-secret");
		expect(display).not.toContain("credential");
		expect(card.title).toContain('"[redacted]-program"');
		expect(card.rawInput).toEqual({
			command: "[redacted]-program",
			args: ["[redacted]", "[redacted]", "-y", ".", "a"],
			cwd: "[redacted]",
		});
		expect(input.command).toBe("provider-secret-long-program");
		expect(input.args[1]).toBe("multiline\ncredential");
		expect(secrets).toEqual([
			"provider-secret",
			"provider-secret-long",
			"multiline\ncredential",
		]);
	});

	it("shows generic setup and MCP plans while preserving masks and hiding named credential fields", () => {
		const input = {
			command: "node",
			args: ["-e", "doSomething()"],
			environment: [
				{ name: "PATH", value: "/bin", source: "Server override" },
				{ name: "NODE_OPTIONS", value: "--require ./hook.js" },
				{ name: "API_KEY", value: "[REDACTED]" },
				{ name: "ACCESS_TOKEN", value: "named-token-value" },
			],
			headers: { Authorization: "Bearer private-auth", "X-Project": "demo" },
			nested: {
				apiKey: "private-key",
				client_secret: "private-client",
				tokenLimit: 4000,
				passwordFile: "config-path",
			},
			summary: "Allow instructions; provider requests may incur charges.",
		};
		const card = toolCallPresentation(
			{ title: "Connect MCP remote", kind: "execute", input },
			{},
		);
		const text = visibleText(card);
		expect(card.title).toBe("Connect MCP remote");
		expect(text).toContain("Input (JSON");
		expect(text).not.toContain("Literal argv:");
		for (const secret of [
			"named-token-value",
			"private-auth",
			"private-key",
			"private-client",
		]) {
			expect(JSON.stringify(card)).not.toContain(secret);
		}
		for (const detail of [
			"/bin",
			"--require ./hook.js",
			"[REDACTED]",
			"Server override",
			"config-path",
			"4000",
			input.summary,
		]) {
			expect(text).toContain(detail);
		}
		expect(input.environment.at(-1)?.value).toBe("named-token-value");
	});

	it.each([
		{ title: "mcp_run_command", kind: "execute" },
		{ title: "Run_command", kind: "execute" },
		{ title: "run_command", kind: "edit" },
	])(
		"does not infer command semantics for $title / $kind",
		({ title, kind }) => {
			const input = { command: "node", args: ["-e", "script"] };
			const card = toolCallPresentation({ title, kind, input });
			expect(card.title).toBe(title);
			expect(visibleText(card)).toContain("Input (JSON");
			expect(visibleText(card)).not.toContain("Executable:");
			expect(card.rawInput).toEqual(input);
		},
	);

	it.each([
		null,
		"node -e script",
		{ command: "node", args: "not an array" },
		{ command: "node", args: [1] },
		{ command: "node", timeoutMs: -1 },
		{ command: "node", cwd: 42 },
		{ command: "node", env: { PATH: "/custom" } },
		{ command: "bad\0command" },
	])(
		"falls back to complete JSON for malformed or unknown command input %#",
		(input) => {
			const card = command(input);
			expect(card.title).toBe("run_command");
			expect(visibleText(card)).toContain("Input (JSON");
			expect(visibleText(card)).not.toContain("Executable:");
			expect(card.rawInput).toEqual(input);
		},
	);

	it("retains literal JSON keys instead of accidentally specializing an incomplete command", () => {
		const input: unknown = JSON.parse(
			'{"command":"node","__proto__":{"extra":"must remain visible"}}',
		);
		const card = command(input);
		expect(card.title).toBe("run_command");
		expect(visibleText(card)).toContain('"__proto__"');
		expect(visibleText(card)).toContain("must remain visible");
		expect(card.rawInput).toEqual(input);
	});

	it("redacts malformed input without dropping the remaining approval payload", () => {
		const card = command(
			{
				command: 1,
				apiKey: "named-credential",
				args: ["known-credential", "-y", "."],
			},
			["known-credential"],
		);
		expect(card.title).toBe("run_command");
		expect(visibleText(card)).toContain("Input (JSON");
		expect(JSON.stringify(card)).not.toContain("named-credential");
		expect(JSON.stringify(card)).not.toContain("known-credential");
		expect(card.rawInput).toEqual({
			command: 1,
			apiKey: "[redacted]",
			args: ["[redacted]", "-y", "."],
		});
	});

	it("fails visibly and safely for input that cannot be represented as JSON", () => {
		const bigint = 1n;
		for (const input of [undefined, bigint, () => "not data"]) {
			const card = command(input);
			expect(visibleText(card)).toContain("Do not approve");
			expect(card.rawInput).toBeUndefined();
		}
	});

	it("keeps adversarial Markdown and control characters inert without changing raw input", () => {
		const script =
			"```\n[approve](https://untrusted.invalid)\n``````\n\u001b[2J\r\u202e\u2066\u{E0001}";
		const input = { command: "node\n\u202e", args: ["-e", script] };
		const card = command(input);
		const text = visibleText(card);
		expect(text).toContain("```````text\n");
		expect(text).toMatch(/\n```````$/);
		expect(text).toContain("[approve](https://untrusted.invalid)");
		expect(text).toContain(String.raw`\u001b[2J\r`);
		const argvLine = text
			.split("\n")
			.find((line) => line.startsWith("Literal argv: "))!;
		expect(JSON.parse(argvLine.slice("Literal argv: ".length))).toEqual(
			input.args,
		);
		expect(text).not.toContain("\u202e");
		expect(text).not.toContain("\u2066");
		expect(card.title).not.toContain("\n");
		expect(card.title).not.toContain("\u202e");
		expect(card.rawInput).toEqual(input);
	});
});
