import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toolCallPresentation } from "./presentation.ts";

/** An absolute runtime-normalized cwd, deliberately distinct from the process cwd. */
const CWD = resolve("presentation workspace's cwd");
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

/** Commands occupy only a fenced block; its first line is the terminal-style preview. */
const commandLines = (
	card: ReturnType<typeof toolCallPresentation>,
): string[] => {
	const block = /^(`{3,})[^\n]*\n(?<body>[\s\S]*)\n\1$/.exec(visibleText(card));
	expect(
		block,
		"Expected only a fenced command, without wrapper prose",
	).not.toBeNull();
	return block!.groups!.body.split("\n");
};

/** User-visible approval data must remain faithful, inert and independent of execution data. */
describe("ACP tool presentation", () => {
	// Reviewed UX examples: expected text is authored independently of the production formatter.
	it.each([
		{
			name: "the user's bash example",
			input: { command: "bash", args: ["foo", "bar", "baz"] },
			line: "bash foo bar baz",
		},
		{
			name: "safe words and flags",
			input: {
				command: "./bin/tool",
				args: ["-y", ".", "../file.txt", "a_b-9"],
			},
			line: "./bin/tool -y . ../file.txt a_b-9",
		},
		{
			name: "spaces, empty strings and single quotes",
			input: {
				command: "program with spaces",
				args: ["a b", "", "single'quote"],
			},
			line: "'program with spaces' 'a b' '' 'single'\\''quote'",
		},
		{
			name: "literal shell syntax",
			input: {
				command: "printf",
				args: [
					'double"quote',
					String.raw`a\b`,
					"$(touch marker)",
					"; rm file",
					"*",
					"$HOME",
				],
			},
			line: String.raw`printf 'double"quote' 'a\b' '$(touch marker)' '; rm file' '*' '$HOME'`,
		},
		{
			name: "an explicit shell script as one ANSI-C quoted argument",
			input: {
				command: "bash",
				args: ["-c", "printf '%s\\n' 'two words'\nprintf done"],
			},
			line: String.raw`bash -c $'printf \'%s\\n\' \'two words\'\nprintf done'`,
		},
		{
			name: "newlines, tabs and carriage returns",
			input: { command: "node", args: ["first\nsecond", "a\tb\rc"] },
			line: String.raw`node $'first\nsecond' $'a\tb\rc'`,
		},
	])("renders $name as a concise terminal command", ({ input, line }) => {
		Object.freeze(input.args);
		Object.freeze(input);
		const card = command(input);
		expect(card.title).toBe(line);
		expect(commandLines(card)).toEqual([line]);
		expect(card.rawInput).toEqual(input);
		expect(card.rawInput).not.toBe(input);
	});

	it.each([
		{ cwd: undefined, line: undefined },
		{ cwd: ".", line: "# requested cwd: ." },
		{ cwd: "nested dir", line: "# requested cwd: 'nested dir'" },
		{ cwd: "../project", line: "# requested cwd: ../project" },
		{ cwd: "owner's dir", line: "# requested cwd: 'owner'\\''s dir'" },
		{
			cwd: "first\nsecond",
			line: String.raw`# requested cwd: $'first\nsecond'`,
		},
	])("does not invent a normalized cwd for $cwd", ({ cwd, line }) => {
		const input = { command: "pwd", ...(cwd === undefined ? {} : { cwd }) };
		const card = command(input);
		expect(commandLines(card)).toEqual(
			line === undefined ? ["pwd"] : ["pwd", line],
		);
		expect(card.title).toBe("pwd");
		expect(card.rawInput).toEqual(input);
	});

	it("distinguishes normalized approval cwd from the original activity in one compact line", () => {
		const input = { command: "pwd", cwd: CWD };
		const quotedCwd = `'${CWD.replaceAll("'", String.raw`'\''`)}'`;
		const activity = toolCallPresentation({
			title: "run_command",
			kind: "execute",
			input,
		});
		expect(commandLines(activity)).toEqual([
			"pwd",
			`# requested cwd: ${quotedCwd}`,
		]);
		const approval = command(input);
		expect(commandLines(approval)).toEqual(["pwd", `# cwd: ${quotedCwd}`]);
		expect(approval.title).toBe(activity.title);
		expect(approval.rawInput).toEqual(input);
	});

	it.each(["tool.cmd", "tool.BAT", "node"])(
		"previews %s without wrapper boilerplate or hidden timeout chatter",
		(executable) => {
			const input = {
				command: executable,
				args: ["two words", "literal & argument"],
				timeoutMs: 1234,
			};
			const card = command(input);
			const line = `${executable} 'two words' 'literal & argument'`;
			expect(card.title).toBe(line);
			expect(commandLines(card)).toEqual([line]);
			expect(card.rawInput).toEqual(input);
		},
	);

	it("bounds only the title, retaining the full approval payload in content and rawInput", () => {
		const longArgumentLength = 1000;
		const titleLimit = 100;
		const args = ["x".repeat(longArgumentLength), "last argument"];
		const card = command({ command: "node", args });
		expect(card.title.length).toBeLessThanOrEqual(titleLimit);
		expect(card.title).toMatch(/\.\.\.$/);
		const line = `node ${args[0]} 'last argument'`;
		expect(commandLines(card)).toEqual([line]);
		expect(line.startsWith(card.title.replace(/\.\.\.$/, ""))).toBe(true);
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
		expect(card.title).toBe(
			"'[redacted]-program' '[redacted]' '[redacted]' -y . a",
		);
		expect(commandLines(card)).toEqual([
			card.title,
			"# requested cwd: '[redacted]'",
		]);
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
		const [line] = commandLines(card);
		expect(commandLines(card)).toHaveLength(1);
		expect(line).toMatch(/^\$'node\\n\\u202e' -e \$'/i);
		expect(line).toMatch(/\\(?:u001b|x1b|e)\[2J\\r/i);
		expect(line).toContain(String.raw`\u202e\u2066`);
		expect(line).toMatch(/\\U000e0001/i);
		expect(line).toContain(
			String.raw`\n[approve](https://untrusted.invalid)\n`,
		);
		for (const display of [line, card.title]) {
			expect(display).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
		}
		expect(card.rawInput).toEqual(input);
	});
});
