/** Setup deadlines cap read-only discovery independently of model turn limits. */
const RESOURCE_TIMEOUT_MS = 30_000;

/** Resource setup is read-only, but must not pin a cancelled session on stalled IO. */
export const withResourceDeadline = async <T>(
	{
		signal,
		timeoutMs = RESOURCE_TIMEOUT_MS,
	}: { signal: AbortSignal; timeoutMs?: number },
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
	const maxTimeout = 120_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
		throw new Error("Invalid resource timeout");
	}
	signal.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error(`Resource loading timed out after ${timeoutMs}ms`),
			),
		timeoutMs,
	);
	let onAbort: (() => void) | undefined = undefined;
	try {
		const interrupted = new Promise<never>((_, reject) => {
			onAbort = () => reject(controller.signal.reason);
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([interrupted, operation(controller.signal)]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		if (onAbort) {
			controller.signal.removeEventListener("abort", onAbort);
		}
	}
};
