import { RequestError } from "@agentclientprotocol/sdk";

/** Composition code can throw this plain tag without depending on ACP or an error class. */
export interface NativeAuthRequiredError {
	readonly tag: "native_auth_required";
}
/** No provider details belong in a request-level auth failure. */
export const nativeAuthRequired = (): NativeAuthRequiredError => ({
	tag: "native_auth_required",
});
/** Translate only the explicit auth tag; all other backend failures are sanitized. */
export const runtimeError = (error: unknown, message: string): RequestError =>
	typeof error === "object" &&
	error !== null &&
	"tag" in error &&
	error.tag === "native_auth_required"
		? RequestError.authRequired()
		: RequestError.internalError(undefined, message);
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
