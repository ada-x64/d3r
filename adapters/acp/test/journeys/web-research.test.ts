import {
	expectStop,
	type JourneyContext,
	workspaceSnapshot,
	type JourneyScripts,
	JOURNEY_MODEL,
	JOURNEY_SUMMARY,
	journeyCall as call,
	journeyResult,
	journeyResultText,
	type JourneyDecision,
	journeyReport,
	journeyDone as done,
	journeyText,
	journeyToolText,
	journeyTools,
	reply,
	callWith,
	lastRequest,
	roleRequests,
} from "./helpers.ts";

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { describe, expect, it, vi } from "vitest";
import { nativeModelKey } from "../../../../cli/src/native-models.ts";
import { deferred } from "../../test-support.ts";

import { nativeJourneySuite } from "./harness.ts";
describe("native ACP shipped-workflow journeys", () => {
	const { open, cleanup } = nativeJourneySuite();
	// oxlint-disable-next-line max-statements -- Follow real HTTP evidence, separate grants, persistence and renewed trust in one research journey.
	it("researches /design through native Exa tools with thread-scoped consent and no persisted credentials or grants", async () => {
		const key = "journey-exa-secret+/=";
		const url = "https://sources.example/durable-queues";
		const source =
			"The reference queue fsyncs its journal before acknowledging a job.";
		const report = `${source}\nProvider echo: [REDACTED]\nSource: ${url}\n`;
		const network: {
			url: string;
			headers: Record<string, string>;
			body: unknown;
		}[] = [];
		const unhandled: string[] = [];
		const server = setupServer(
			http.post("https://api.exa.ai/:endpoint", async ({ request, params }) => {
				network.push({
					url: request.url,
					headers: Object.fromEntries(request.headers),
					body: await request.json(),
				});
				return HttpResponse.json({
					results:
						params.endpoint === "search"
							? [
									{
										url,
										highlights: ["Journal durability before acknowledgement"],
									},
								]
							: [{ url, text: `${source}\nProvider echo: ${key}` }],
				});
			}),
		);
		server.events.on("request:unhandled", ({ request }) =>
			unhandled.push(request.url),
		);
		server.listen({ onUnhandledRequest: "error" });
		cleanup.push(async () => server.close());
		const evidence = (context: JourneyContext) => {
			const { docs } = JSON.parse(
				journeyResultText(context, "fetch-again"),
			) as { docs: { url: string; text: string }[] };
			return `${docs[0].text}\nSource: ${docs[0].url}\n`;
		};
		const scripts: JourneyScripts = {
			aggregator: done("Local requirements collected."),
			researcher: [
				call(
					"web_search",
					{ query: "durable job queue primary sources", k: 1 },
					"search-first",
				),
				call(
					"web_search",
					{ query: "journal acknowledgement ordering", k: 1 },
					"search-again",
				),
				callWith(
					"web_fetch",
					(context) => {
						const { hits } = JSON.parse(
							journeyResultText(context, "search-again"),
						) as { hits: { url: string }[] };
						return { urls: hits.map((hit) => hit.url) };
					},
					"fetch-first",
				),
				callWith(
					"web_fetch",
					(context) => {
						const { docs } = JSON.parse(
							journeyResultText(context, "fetch-first"),
						) as { docs: { url: string }[] };
						return { urls: docs.map((doc) => doc.url) };
					},
					"fetch-again",
				),
				callWith("write_file", (context) => ({
					path: "research.md",
					content: evidence(context),
				})),
				(context) => journeyReport(evidence(context)),
				(context) => reply(evidence(context)),
			],
			designer: done("Design grounded in retrieved research."),
		};
		const j = await open(scripts, {
			getWebConfig: () => ({ providerId: "exa", exaApiKey: key }),
		});
		const f = await j.connect();
		const { sessionId } = await f.newSession(j.cwd);
		await f.peer.agent.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: nativeModelKey(JOURNEY_MODEL),
		});
		const request =
			"/design Research durable queues with web_search and web_fetch; save cited findings in research.md, without shell commands.";
		j.approval.decide = async () => false;
		await expectStop(f.prompt(sessionId, request));
		expect(j.requests).toEqual([]);
		expect(network).toEqual([]);
		const search = deferred<JourneyDecision>();
		const fetch = deferred<JourneyDecision>();
		const mutation = deferred<JourneyDecision>();
		j.approval.decide = async ({ toolCall }) => {
			if (toolCall.title === "web_search") {
				return search.promise;
			}
			if (toolCall.title === "web_fetch") {
				return fetch.promise;
			}
			if (toolCall.title === "write_file") {
				return mutation.promise;
			}
			return true;
		};
		const pending = f.prompt(sessionId, request);
		try {
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "web_search"),
				).toBe(true),
			);
			expect(network).toEqual([]);
			search.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "web_fetch"),
				).toBe(true),
			);
			expect(network.map((entry) => entry.url)).toEqual([
				"https://api.exa.ai/search",
				"https://api.exa.ai/search",
			]);
			fetch.resolve("allow_scope");
			await vi.waitFor(() =>
				expect(
					j.permissions.some(({ toolCall }) => toolCall.title === "write_file"),
				).toBe(true),
			);
			await expect(
				readFile(resolve(j.cwd, "research.md")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				j.permissions
					.find(({ toolCall }) => toolCall.title === "write_file")
					?.options.map(({ kind }) => kind),
			).toEqual(["allow_once", "reject_once", "allow_always"]);
			expect(
				j.permissions
					.find(({ toolCall }) => toolCall.title === "write_file")
					?.options.at(-1)?.name,
			).toBe("Allow workspace file writes and edits for this thread");
			mutation.resolve("allow_scope");
			await expectStop(pending);
		} finally {
			search.resolve(false);
			fetch.resolve(false);
			mutation.resolve(false);
			await f.cancel(sessionId);
			await pending;
		}
		const webPermissions = j.permissions.filter(({ toolCall }) =>
			toolCall.title?.startsWith("web_"),
		);
		expect(webPermissions.map(({ toolCall }) => toolCall.title)).toEqual([
			"web_search",
			"web_fetch",
		]);
		expect(webPermissions.map(({ options }) => options.at(-1))).toEqual([
			{
				optionId: "allow_scope",
				kind: "allow_always",
				name: "Allow web searches via Exa for this thread",
			},
			{
				optionId: "allow_scope",
				kind: "allow_always",
				name: "Allow web fetches via Exa for this thread",
			},
		]);
		expect(
			network.map(({ url: endpoint, body }) => ({ endpoint, body })),
		).toEqual([
			...[
				"durable job queue primary sources",
				"journal acknowledgement ordering",
			].map((query) => ({
				endpoint: "https://api.exa.ai/search",
				body: { query, numResults: 1, contents: { highlights: true } },
			})),
			...Array.from({ length: 2 }, () => ({
				endpoint: "https://api.exa.ai/contents",
				body: { urls: [url], text: { maxCharacters: expect.any(Number) } },
			})),
		]);
		const researcher = lastRequest(j.requests, "researcher").context;
		roleRequests(j.requests, "researcher").forEach(({ context }, index) => {
			expect(context.systemPrompt).toContain(`Response ${index + 1} of 50`);
			expect(context.systemPrompt).toContain("Hard cap: 100");
			expect(JSON.stringify(context.messages)).not.toContain(
				"[D3R request budget",
			);
		});
		expect(JSON.parse(journeyResultText(researcher, "search-again"))).toEqual({
			hits: [
				{
					id: url,
					title: url,
					url,
					highlights: ["Journal durability before acknowledgement"],
				},
			],
		});
		expect(JSON.parse(journeyResultText(researcher, "fetch-again"))).toEqual({
			docs: [
				{ url, title: null, text: `${source}\nProvider echo: [REDACTED]` },
			],
		});
		for (const id of [
			"search-first",
			"search-again",
			"fetch-first",
			"fetch-again",
		]) {
			expect(journeyResult(researcher, id)).toMatchObject({
				role: "toolResult",
				isError: false,
			});
		}
		expect(
			researcher.tools?.find(({ name }) => name === "web_search")?.parameters,
		).toMatchObject({
			type: "object",
			required: ["query"],
			additionalProperties: false,
			properties: {
				query: { type: "string" },
				k: { type: "integer", default: 5, maximum: 20 },
			},
		});
		expect(
			researcher.tools?.find(({ name }) => name === "web_fetch")?.parameters,
		).toMatchObject({
			type: "object",
			required: ["urls"],
			additionalProperties: false,
			properties: {
				urls: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: { type: "string", format: "uri" },
				},
			},
		});
		await expect(readFile(resolve(j.cwd, "research.md"), "utf8")).resolves.toBe(
			report,
		);
		const researchCard = journeyTools(f.updates).findLast(
			(update) => update.title === "researcher",
		)!;
		expect(researchCard).toMatchObject({
			status: "completed",
			rawOutput: { status: "completed", summary: report.trim() },
		});
		expect(journeyToolText(researchCard)).toContain(report.trim());
		expect(journeyText(f.updates)).toContain(
			"Discuss design questions before drafting",
		);
		j.approval.decide = async () => true;
		await expectStop(
			f.prompt(
				sessionId,
				"Use the retrieved durability findings in the design.",
			),
		);
		expect(
			JSON.stringify(
				j.requests.find(({ role }) => role === "designer")?.context.messages,
			),
		).toContain(source);
		expect(journeyText(f.updates)).toContain(JOURNEY_SUMMARY);

		// oxlint-disable-next-line max-statements -- Reuse the same web and workspace grant probes for retained, new and reloaded sessions.
		const probeScopes = async (
			connection: typeof f,
			id: string,
			reuse = false,
		) => {
			const before = j.requests.length;
			const permissionsBefore = j.permissions.length;
			const networkBefore = network.length;
			const names = ["web_search", "web_fetch"];
			const prompt = "/design Check for new external evidence using web tools.";
			const summary = reuse
				? "Retrieved new evidence using the thread grants."
				: "No new external evidence: web access was declined.";
			scripts.aggregator = done("Local recon complete.");
			scripts.researcher = [
				call("web_search", { query: "new evidence" }),
				call("web_fetch", { urls: [url] }),
				...done(summary),
			];
			if (!reuse) {
				j.approval.decide = async () => false;
				await expectStop(connection.prompt(id, prompt));
				expect(j.requests).toHaveLength(before);
				expect(network).toHaveLength(networkBefore);
				expect(j.permissions.at(-1)?.toolCall.title).toMatch(
					/^Trust workspace/,
				);
			}
			j.approval.decide = async ({ toolCall }) =>
				toolCall.title?.startsWith("Trust workspace") === true;
			await expectStop(connection.prompt(id, prompt));
			expect(
				j.permissions
					.slice(permissionsBefore)
					.map(({ toolCall }) => toolCall.title),
			).toEqual(
				reuse
					? []
					: [
							expect.stringMatching(/^Trust workspace/),
							expect.stringMatching(/^Trust workspace/),
							...names,
						],
			);
			expect(network).toHaveLength(networkBefore + (reuse ? names.length : 0));
			const { context } = lastRequest(j.requests, "researcher");
			for (const name of names) {
				expect(journeyResult(context, name)).toMatchObject({ isError: !reuse });
				expect(journeyResultText(context, name)).toMatch(
					reuse ? /sources.example/ : /denied/i,
				);
			}
			expect(
				journeyTools(connection.updates).findLast(
					(update) => update.title === "researcher",
				),
			).toMatchObject({ status: "completed", rawOutput: { summary } });
			scripts.designer = done("Updated design based on available evidence.");
			await expectStop(connection.prompt(id, "Use the available evidence."));
			const workspacePermissions = j.permissions.length;
			const created = `scope-probe-${workspacePermissions}.md`;
			await writeFile(resolve(j.cwd, "scope-edit.txt"), "Before\n");
			scripts.router = [
				call("read_file", { path: "scope-edit.txt" }, "scope-read"),
				callWith(
					"edit_file",
					(observed) => ({
						path: "scope-edit.txt",
						oldText: "Before",
						newText: "After",
						snapshot: workspaceSnapshot(observed, "scope-read"),
					}),
					"scope-edit",
				),
				call(
					"write_file",
					{ path: created, content: "Follow-up report\n" },
					"scope-write",
				),
				reply("Workspace follow-up finished within the current permissions."),
			];
			await expectStop(
				connection.prompt(
					id,
					"Update scope-edit.txt and save a follow-up report directly, without starting another phase.",
				),
			);
			expect(
				j.permissions
					.slice(workspacePermissions)
					.map(({ toolCall }) => toolCall.title),
			).toEqual(reuse ? [] : ["edit_file", "write_file"]);
			const router = lastRequest(j.requests, "router").context;
			for (const callId of ["scope-edit", "scope-write"]) {
				expect(journeyResult(router, callId), callId).toMatchObject({
					isError: !reuse,
				});
			}
			await expect(
				readFile(resolve(j.cwd, "scope-edit.txt"), "utf8"),
			).resolves.toBe(reuse ? "After\n" : "Before\n");
			await (reuse
				? expect(readFile(resolve(j.cwd, created), "utf8")).resolves.toBe(
						"Follow-up report\n",
					)
				: expect(readFile(resolve(j.cwd, created))).rejects.toMatchObject({
						code: "ENOENT",
					}));
		};
		await probeScopes(f, sessionId, true);
		const fresh = await f.session();
		await probeScopes(f, fresh.sessionId);
		const saved = await f.saved(sessionId);
		await f.close();
		const resumed = await j.connect();
		const networkBeforeLoad = network.length;
		const requestsBeforeLoad = j.requests.length;
		await resumed.load(sessionId);
		expect(network).toHaveLength(networkBeforeLoad);
		expect(j.requests).toHaveLength(requestsBeforeLoad);
		await probeScopes(resumed, sessionId);
		for (const state of [saved, await resumed.saved(sessionId)]) {
			const text = JSON.stringify(state);
			expect(text).not.toContain("allow_scope");
			expect(text).not.toMatch(
				/exa:web_(search|fetch)|d3r:native:workspace-edits/,
			);
			expect(text).not.toContain(key);
			expect(text).not.toContain(encodeURIComponent(key));
		}
		expect(
			JSON.stringify([j.requests, j.permissions, f.updates, resumed.updates]),
		).not.toContain(key);
		expect(
			JSON.stringify(j.requests.flatMap(({ context }) => context.messages)),
		).not.toContain('"name":"run_command"');
		expect(
			j.permissions.some(
				({ toolCall }) =>
					toolCall.kind === "execute" &&
					!toolCall.title?.startsWith("Trust workspace"),
			),
		).toBe(false);
		for (const { headers, body, url: endpoint } of network) {
			expect(headers["x-api-key"]).toBe(key);
			expect(headers["content-type"]).toBe("application/json");
			expect(
				JSON.stringify([
					endpoint,
					body,
					Object.entries(headers).filter(([name]) => name !== "x-api-key"),
				]),
			).not.toContain(key);
		}
		expect(unhandled).toEqual([]);
		expect(Object.values(scripts).every((steps) => steps.length === 0)).toBe(
			true,
		);
	});
});
