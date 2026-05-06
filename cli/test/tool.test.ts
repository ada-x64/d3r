// Behavioural tests for the `tool` verb's dispatcher kernel. We
// exercise the pure `dispatchTool` function with a synthetic
// registry plus the real registry so the schema-driven flag
// derivation, coercion, error paths, and union variant handling
// are all pinned. process.* boundaries are stubbed via the
// injected DispatchIO surface; nothing here mocks `node:util`
// or shells out.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildRegistry, type ToolEntry } from "@d3r/tools";
import { dispatchTool, type DispatchIO } from "../src/verbs/tool.ts";

// fm_read end-to-end exercise below does not touch the web rows;
// passing `web: undefined` mirrors the production shape when no
// api key is set, so the registry simply omits `web_*` entries.
const registry = buildRegistry({ web: undefined });

class ExitError extends Error {
	code: number;
	constructor(code: number) {
		super(`exit:${code}`);
		this.name = "ExitError";
		this.code = code;
	}
}

interface Capture {
	stdout: string[];
	stderr: string[];
	io: DispatchIO;
}

const makeIO = (): Capture => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const io: DispatchIO = {
		stdout: (chunk) => stdout.push(chunk),
		stderr: (chunk) => stderr.push(chunk),
		exit: (code) => {
			throw new ExitError(code);
		},
	};
	return { stdout, stderr, io };
};

const echoTool: ToolEntry = {
	name: "echo",
	label: "Echo",
	description: "Echo a message back as JSON.",
	schema: z.object({
		message: z.string(),
		count: z.number().default(1),
		shout: z.boolean().optional(),
	}),
	fn: ((p: { message: string; count: number; shout?: boolean }) => ({
		repeated: Array.from({ length: p.count }, () =>
			p.shout ? p.message.toUpperCase() : p.message,
		),
	})) as (...args: never[]) => unknown,
};

const shapesTool: ToolEntry = {
	name: "shapes",
	label: "Shapes",
	description: "Pick a shape variant.",
	schema: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("circle"), r: z.number() }),
		z.object({ kind: z.literal("square"), side: z.number() }),
	]),
	fn: ((p: { kind: string }) => ({ picked: p.kind })) as (
		...args: never[]
	) => unknown,
};

const fakeRegistry: ToolEntry[] = [echoTool, shapesTool];

describe("dispatchTool", () => {
	it("calls the tool with parsed + coerced params and prints JSON", async () => {
		const cap = makeIO();
		await dispatchTool({
			registry: fakeRegistry,
			name: "echo",
			tail: ["--message", "hi", "--count", "2"],
			io: cap.io,
		});
		expect(cap.stderr.join("")).toBe("");
		const out = JSON.parse(cap.stdout.join("")) as { repeated: string[] };
		expect(out).toEqual({ repeated: ["hi", "hi"] });
	});

	it("treats boolean flags as presence-true", async () => {
		const cap = makeIO();
		await dispatchTool({
			registry: fakeRegistry,
			name: "echo",
			tail: ["--message", "hi", "--shout"],
			io: cap.io,
		});
		const out = JSON.parse(cap.stdout.join("")) as { repeated: string[] };
		expect(out.repeated).toEqual(["HI"]);
	});

	it("errors cleanly on an unknown tool", async () => {
		const cap = makeIO();
		await expect(
			dispatchTool({
				registry: fakeRegistry,
				name: "nonsense",
				tail: [],
				io: cap.io,
			}),
		).rejects.toBeInstanceOf(ExitError);
		expect(cap.stderr.join("")).toBe("error: unknown tool: nonsense\n");
	});

	it("surfaces a zod validation error when a required arg is missing", async () => {
		const cap = makeIO();
		await expect(
			dispatchTool({
				registry: fakeRegistry,
				name: "echo",
				tail: [],
				io: cap.io,
			}),
		).rejects.toBeInstanceOf(ExitError);
		expect(cap.stderr.join("")).toMatch(/invalid message/);
	});

	it("rejects unknown flags via parseArgs strict mode", async () => {
		const cap = makeIO();
		await expect(
			dispatchTool({
				registry: fakeRegistry,
				name: "echo",
				tail: ["--message", "hi", "--bogus", "x"],
				io: cap.io,
			}),
		).rejects.toBeInstanceOf(ExitError);
		expect(cap.stderr.join("")).toMatch(/error:/);
	});

	it("requires --<discriminator> for a union tool and reports the choices", async () => {
		const cap = makeIO();
		await expect(
			dispatchTool({
				registry: fakeRegistry,
				name: "shapes",
				tail: [],
				io: cap.io,
			}),
		).rejects.toBeInstanceOf(ExitError);
		expect(cap.stderr.join("")).toMatch(/--kind is required/);
		expect(cap.stderr.join("")).toMatch(/circle.*square|square.*circle/);
	});

	it("dispatches a chosen union variant and drops the discriminator flag", async () => {
		const cap = makeIO();
		await dispatchTool({
			registry: fakeRegistry,
			name: "shapes",
			tail: ["--kind", "circle", "--r", "3"],
			io: cap.io,
		});
		const out = JSON.parse(cap.stdout.join("")) as { picked: string };
		expect(out.picked).toBe("circle");
	});

	it("rejects an unknown variant for a union tool", async () => {
		const cap = makeIO();
		await expect(
			dispatchTool({
				registry: fakeRegistry,
				name: "shapes",
				tail: ["--kind", "triangle"],
				io: cap.io,
			}),
		).rejects.toBeInstanceOf(ExitError);
		expect(cap.stderr.join("")).toMatch(/unknown kind: triangle/);
	});

	it("prints a usage block on --help without invoking the tool", async () => {
		const cap = makeIO();
		await dispatchTool({
			registry: fakeRegistry,
			name: "echo",
			tail: ["--help"],
			io: cap.io,
		});
		const out = cap.stdout.join("");
		expect(out).toMatch(/d3r tool echo/);
		expect(out).toMatch(/--message/);
		expect(out).toMatch(/--count/);
		expect(cap.stderr.join("")).toBe("");
	});

	it("dispatches the real fm_read entry end-to-end against @d3r/tools", async () => {
		const cap = makeIO();
		await dispatchTool({
			registry,
			name: "fm_read",
			tail: ["--text=---\nkind: note\n---\nbody"],
			io: cap.io,
		});
		const out = JSON.parse(cap.stdout.join("")) as {
			data: { kind: string };
			body: string;
		};
		expect(out.data.kind).toBe("note");
		expect(out.body).toBe("body");
	});
});
