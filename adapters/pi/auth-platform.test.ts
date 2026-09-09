import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialStore } from "./auth-store.ts";
import { createModelRuntime } from "./auth.ts";

/** Refusal must precede filesystem access, not just the final credential write. */
vi.mock("node:fs/promises", () => ({
	lstat: vi.fn(),
	mkdir: vi.fn(),
	open: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
}));

/** A rejected private store must never fall back to the library's default store. */
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
	builtinModels: vi.fn(),
}));

/** Simulate Windows on POSIX CI without adding a production platform override. */
const platformDescriptor = Object.getOwnPropertyDescriptor(
	process,
	"platform",
)!;

/** This path is never inspected, created or printed, on either host platform. */
const stateDir = String.raw`C:\fake-secret-state\private`;

describe("Windows credential storage policy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", platformDescriptor);
	});

	it("refuses private storage before touching directories, credentials or locks", async () => {
		const failure = await createCredentialStore({ stateDir }).catch(
			(error) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toBe(
			"Private credential storage is disabled on Windows: user-only ACL verification is not implemented",
		);
		expect(String(failure)).not.toContain("fake-secret-state");
		expect(failure.cause).toBeUndefined();
		[lstat, mkdir, open, rename, unlink].forEach((operation) => {
			expect(operation).not.toHaveBeenCalled();
		});
	});

	it("fails runtime creation rather than selecting a library credential default", async () => {
		await expect(createModelRuntime({ stateDir })).rejects.toThrow(
			"user-only ACL verification is not implemented",
		);
		expect(builtinModels).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(mkdir).not.toHaveBeenCalled();
	});
});
