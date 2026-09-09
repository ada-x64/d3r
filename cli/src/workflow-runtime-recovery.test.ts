/* oxlint-disable no-magic-numbers -- Fixture call counts and selections are assertions. */
import { Workflow } from "@d3r/core";
import {
	type RuntimeConfigOption,
	type RuntimePrompt,
	type RuntimeStopReason,
} from "@d3r/core/runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createWorkflowRuntime } from "./workflow-runtime.ts";

/** Real selection constraints make restoring the old model observably incorrect. */
const levels: Record<string, string[]> = {
	A: ["off", "high"],
	B: ["off", "max"],
};
/** Native-shaped and opaque checkpoints use identical strict runtime-owned validation. */
const Saved = z.object({
	version: z.literal(1),
	format: z.enum(["d3r.pi.embedded", "test.routing"]),
	model: z.object({ provider: z.literal("test"), id: z.enum(["A", "B"]) }),
	thinkingLevel: z.string(),
	messages: z.array(z.string()),
});
/** Recovery does not require workflow agents or any model/provider calls. */
const workflow = Workflow.parse({
	commands: {},
	vault: { dirs: [], template_kinds: [] },
});
/** Fake routing rejects an incompatible model/thought pair instead of silently clamping it. */
const harness = (native: boolean) => {
	let model = "A";
	let thinking = "high";
	let messages: string[] = [];
	const control = {
		reason: "cancelled" as RuntimeStopReason,
		rejectThought: false,
		hideOff: false,
		ignoreModel: false,
		afterSet: null as (() => Promise<void>) | null,
	};
	const getConfig = (): RuntimeConfigOption[] => [
		{
			id: "model",
			name: "Model",
			category: "model",
			value: `test/${model}`,
			options: ["A", "B"].map((id) => ({ value: `test/${id}`, name: id })),
		},
		{
			id: "thought_level",
			name: "Thought",
			category: "thought_level",
			value: thinking,
			options: levels[model]
				.filter((level) => !control.hideOff || level !== "off")
				.map((level) => ({ value: level, name: level })),
		},
	];
	const routing = {
		getConfig,
		setConfig: vi.fn(async (id: string, value: string) => {
			if (
				!getConfig()
					.find((option) => option.id === id)
					?.options.some((option) => option.value === value)
			) {
				throw new Error("Unsupported selector value");
			}
			if (id === "model") {
				const target = value.slice("test/".length);
				if (!levels[target].includes(thinking)) {
					throw new Error("Unsupported model/thought combination");
				}
				if (!control.ignoreModel) {
					model = target;
				}
			} else {
				if (control.rejectThought && value === "max") {
					throw new Error("private selector diagnostic");
				}
				thinking = value;
			}
			await control.afterSet?.();
			return getConfig();
		}),
		snapshot: () => ({
			version: 1,
			format: native ? "d3r.pi.embedded" : "test.routing",
			model: { provider: "test", id: model },
			thinkingLevel: thinking,
			messages: [...messages],
		}),
		restore: vi.fn((checkpoint: unknown) => {
			const saved = Saved.parse(checkpoint);
			if (!levels[saved.model.id].includes(saved.thinkingLevel)) {
				throw new Error("Unsupported restored selection");
			}
			model = saved.model.id;
			thinking = saved.thinkingLevel;
			({ messages } = saved);
		}),
		prompt: vi.fn(async (request: RuntimePrompt) => {
			messages.push(
				request.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n"),
			);
			return control.reason;
		}),
		dispose: vi.fn(async () => undefined),
	};
	const runtime = createWorkflowRuntime({
		routing,
		workflow,
		agents: [],
		createAgent: vi.fn(),
	});
	const request = (text: string): RuntimePrompt => ({
		content: [{ type: "text", text }],
		signal: new AbortController().signal,
		emit: vi.fn(async () => undefined),
	});
	const prompt = (text: string) => runtime.prompt(request(text));
	const selection = () =>
		runtime.getConfig!()
			.filter(({ id }) => id !== "phase")
			.map(({ value }) => value);
	const selectB = async () => {
		await runtime.setConfig!("thought_level", "off");
		await runtime.setConfig!("model", "test/B");
		await runtime.setConfig!("thought_level", "max");
		routing.setConfig.mockClear();
		routing.restore.mockClear();
		control.reason = "completed";
	};
	return { runtime, routing, control, request, prompt, selection, selectB };
};

/** Gate a sequential setter to inspect the wrapper's atomic public configuration view. */
const gate = () => {
	let resolve: (() => void) | undefined = undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve: resolve! };
};

describe("workflow routing recovery", () => {
	it.each(["restart", "abandon"])(
		"preserves the native model and thought atomically on %s",
		async (decision) => {
			const h = harness(true);
			await h.prompt("original effect");
			await h.selectB();
			await h.prompt(decision);
			expect(h.selection()).toEqual(["test/B", "max"]);
			expect(h.routing.setConfig).not.toHaveBeenCalled();
			expect(h.routing.restore).toHaveBeenCalledTimes(1);
			expect(h.routing.restore.mock.calls[0][0]).toMatchObject({
				model: { provider: "test", id: "B" },
				thinkingLevel: "max",
				messages: [],
			});
			expect(h.routing.prompt).toHaveBeenCalledTimes(
				decision === "restart" ? 2 : 1,
			);
		},
	);
	it.each(["restart", "abandon"])(
		"keeps latest selection and the separate recovery transcript through snapshot/restore before %s",
		async (decision) => {
			const original = harness(true);
			await original.prompt("original effect");
			await original.selectB();
			const checkpoint = original.runtime.snapshot!();
			expect(checkpoint).toMatchObject({
				routing: { model: { id: "B" }, thinkingLevel: "max" },
				routingBefore: {
					model: { id: "A" },
					thinkingLevel: "high",
					messages: [],
				},
			});
			const h = harness(true);
			h.runtime.restore!(JSON.stringify(checkpoint));
			expect(h.routing.prompt).not.toHaveBeenCalled();
			expect(h.selection()).toEqual(["test/B", "max"]);
			h.control.reason = "completed";
			await h.prompt(decision);
			expect(h.selection()).toEqual(["test/B", "max"]);
			expect(h.routing.restore.mock.calls.at(-1)?.[0]).toMatchObject({
				model: { id: "B" },
				thinkingLevel: "max",
				messages: [],
			});
		},
	);
	it.each(["restart", "abandon"])(
		"uses validated off/model/thought order for generic %s",
		async (decision) => {
			const h = harness(false);
			await h.prompt("original effect");
			await h.selectB();
			await h.prompt(decision);
			expect(h.routing.setConfig.mock.calls).toEqual([
				["thought_level", "off"],
				["model", "test/B"],
				["thought_level", "max"],
			]);
			expect(h.selection()).toEqual(["test/B", "max"]);
		},
	);
	it("preserves a changed generic selection through checkpoint restoration", async () => {
		const original = harness(false);
		await original.prompt("original effect");
		await original.selectB();
		const h = harness(false);
		h.runtime.restore!(JSON.stringify(original.runtime.snapshot!()));
		expect(h.selection()).toEqual(["test/B", "max"]);
		await h.prompt("abandon");
		expect(h.selection()).toEqual(["test/B", "max"]);
		expect(h.routing.snapshot().messages).toEqual([]);
	});
	it("never exposes intermediate generic selector states or snapshots during recovery", async () => {
		const h = harness(false);
		const entered = gate();
		const release = gate();
		await h.prompt("original effect");
		await h.selectB();
		h.control.afterSet = async () => {
			entered.resolve();
			await release.promise;
		};
		const recovering = h.prompt("abandon");
		await entered.promise;
		expect(h.routing.getConfig().map(({ value }) => value)).toEqual([
			"test/A",
			"off",
		]);
		expect(h.selection()).toEqual(["test/B", "max"]);
		expect(() => h.runtime.snapshot!()).toThrow();
		await expect(h.runtime.setConfig!("model", "test/A")).rejects.toThrow(
			/running/,
		);
		release.resolve();
		await recovering;
		expect(h.selection()).toEqual(["test/B", "max"]);
	});
	it.each(["rejectThought", "hideOff", "ignoreModel"] as const)(
		"rolls back transcript and latest selectors if generic recovery fails: %s",
		async (failure) => {
			const h = harness(false);
			await h.prompt("original effect");
			await h.selectB();
			const before = h.routing.snapshot();
			h.control[failure] = true;
			await expect(h.prompt("restart")).rejects.toThrow(
				"Routing recovery failed; previous transcript and selection retained.",
			);
			expect(h.routing.snapshot()).toEqual(before);
			expect(h.selection()).toEqual(["test/B", "max"]);
			expect(h.routing.prompt).toHaveBeenCalledTimes(1);
			expect(h.runtime.snapshot!()).toMatchObject({ routingInterrupted: true });
			if (failure === "hideOff") {
				expect(h.routing.setConfig).not.toHaveBeenCalled();
			}
			h.control[failure] = false;
			await h.prompt("abandon");
			expect(h.selection()).toEqual(["test/B", "max"]);
		},
	);
	it("preserves thinking-only changes without unnecessary model switches", async () => {
		const h = harness(false);
		await h.prompt("original effect");
		await h.runtime.setConfig!("thought_level", "off");
		h.routing.setConfig.mockClear();
		await h.prompt("abandon");
		expect(h.selection()).toEqual(["test/A", "off"]);
		expect(h.routing.setConfig.mock.calls).toEqual([["thought_level", "off"]]);
	});
});
