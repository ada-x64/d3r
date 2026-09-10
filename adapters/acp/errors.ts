import { RequestError } from "@agentclientprotocol/sdk";
import { formatRuntimeFailure, readRuntimeFailure } from "@d3r/core/runtime";
import { types } from "node:util";

/** Composition code can throw this plain tag without depending on ACP or an error class. */
export interface NativeAuthRequiredError {
	readonly tag: "native_auth_required";
}
/** No provider details belong in a request-level auth failure. */
export const nativeAuthRequired = (): NativeAuthRequiredError => ({
	tag: "native_auth_required",
});
/** Explicit auth tags must be inert data, not diagnostic-owned getters or proxies. */
const isAuthRequired = (error: unknown): boolean => {
	if (error === null || typeof error !== "object" || types.isProxy(error)) {
		return false;
	}
	return (
		Object.getOwnPropertyDescriptor(error, "tag")?.value ===
		"native_auth_required"
	);
};
/** Preserve only validated reporting data; arbitrary backend exceptions remain sanitized. */
export const runtimeError = (error: unknown, message: string): RequestError => {
	if (isAuthRequired(error)) {
		return RequestError.authRequired();
	}
	const failure = readRuntimeFailure(error);
	return failure
		? RequestError.internalError({ failure }, formatRuntimeFailure(failure))
		: RequestError.internalError(undefined, message);
};
/** Cooperative SDK cancellation does not settle its promise until the client responds. */
export const waitFor = <T>(
	pending: Promise<T>,
	signal: AbortSignal,
): Promise<T> =>
	new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Observe late failures even when cancellation has released the caller.
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) {
			onAbort();
		}
	});
