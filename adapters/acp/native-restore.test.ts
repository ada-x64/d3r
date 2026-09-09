import { client } from "@agentclientprotocol/sdk";
import { createSessionStore } from "@d3r/adapter-acp/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	CWD,
	MODEL_A,
	MODEL_B,
	nativeFixture,
} from "../../cli/src/native-test-support.ts";
import { nativeModelKey } from "../../cli/src/native-models.ts";
import { fixture } from "./test-support.ts";

/** Compose the real native runtime with an observed file store and inert model/catalog IO. */
const nativeConnection = async () => {
	const dir = await mkdtemp(join(tmpdir(), "d3r-native-restore-"));
	const store = createSessionStore(dir);
	const save = vi.fn(store.save);
	const native = nativeFixture();
	const deps = await native.server(
		{},
		{ createSessionStore: () => ({ ...store, save }) },
	);
	const f = fixture(deps.createSession, async () => {}, {
		deps,
		clientApp: client().onRequest("session/request_permission", () => ({
			outcome: { outcome: "selected", optionId: "allow" },
		})),
	});
	return { dir, store, save, native, f };
};
/** Real native checkpoint validation runs against an injected catalog, without auth, network, or model inference. */
it.each(["unavailable model", "changed roots"] as const)(
	"preserves saved native model A after %s validation fails and resumes it after correction",
	async (failure) => {
		const { dir, store, save, native, f } = await nativeConnection();
		try {
			await f.initialize();
			const { sessionId } = await f.newSession(CWD);
			await f.peer.agent.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: nativeModelKey(MODEL_A),
			});
			await f.prompt(sessionId);
			await f.peer.agent.request("session/close", { sessionId });
			const file = join(dir, `${sessionId}.json`);
			const before = await readFile(file, "utf8");
			// A fresh unselected runtime exposes only "off" until the saved model is restored.
			native.deps.loadModelConfig.mockResolvedValue({
				ok: true,
				value: { config: { presets: [], defaultPreset: null }, sources: [] },
			});
			if (failure === "unavailable model") {
				native.models.getAvailable.mockResolvedValue([MODEL_B]);
			}
			save.mockClear();
			f.updates.length = 0;
			await expect(
				f.peer.agent.request("session/load", {
					sessionId,
					cwd: CWD,
					mcpServers: [],
					additionalDirectories:
						failure === "changed roots" ? [join(CWD, "other-root")] : [],
				}),
			).rejects.toMatchObject({ code: -32_603 });
			expect(save).not.toHaveBeenCalled();
			expect(f.updates).toEqual([]);
			expect(await readFile(file, "utf8")).toBe(before);
			expect(await store.get(sessionId)).toEqual(JSON.parse(before));
			native.models.getAvailable.mockResolvedValue([MODEL_A, MODEL_B]);
			const resumed = await f.peer.agent.request("session/resume", {
				sessionId,
				cwd: CWD,
			});
			expect(
				resumed.configOptions?.find((option) => option.id === "model")
					?.currentValue,
			).toBe(nativeModelKey(MODEL_A));
			expect(
				resumed.configOptions?.find((option) => option.id === "thought_level")
					?.currentValue,
			).toBe("medium");
			await f.prompt(sessionId);
			expect(native.turns.at(-1)?.options.model).toMatchObject({
				provider: MODEL_A.provider,
				id: MODEL_A.id,
			});
		} finally {
			await f.close();
			await native.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
