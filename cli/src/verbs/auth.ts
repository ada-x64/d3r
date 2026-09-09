import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isCancel, password, select } from "@clack/prompts";
import {
	createModelRuntime,
	getAuthStatus,
	listProviders,
	loginProvider,
	logoutProvider,
	type AuthEvent,
	type AuthPrompt,
	type AuthType,
	type Models,
} from "@d3r/adapter-pi/auth";
import { defineCommand, type CommandDef } from "citty";

/** Only user-state composition supplies the default; workspace settings are never read. */
export const defaultAuthStateDir = (): string =>
	join(homedir(), ".agents", "d3r", "private");

/** Runtime injection supports composition and network-free tests. */
export interface AuthCommandDeps {
	readonly models?: Models;
	readonly stateDir?: string;
	readonly createRuntime?: typeof createModelRuntime;
	readonly interactive?: () => boolean;
	readonly write?: (message: string) => void;
}

/** Terminal login is a standalone human command, not part of the ACP stdio transport. */
export interface TerminalLoginOptions {
	readonly provider?: string;
	readonly type?: AuthType;
	readonly signal?: AbortSignal;
}

/** Prevent provider text from emitting terminal escape sequences or embedded controls. */
const terminalText = (text: string): string =>
	stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ");

/** URL and device-code events are intentionally shown only during explicit login. */
const notifyTerminal = (
	event: AuthEvent,
	write: (message: string) => void,
): void => {
	switch (event.type) {
		case "auth_url": {
			write(`Open: ${terminalText(event.url)}\n`);
			if (event.instructions) {
				write(`${terminalText(event.instructions)}\n`);
			}
			break;
		}
		case "device_code": {
			write(
				`Open: ${terminalText(event.verificationUri)}\nDevice code: ${terminalText(event.userCode)}\n`,
			);
			break;
		}
		case "info": {
			write(`${terminalText(event.message)}\n`);
			event.links?.forEach((link) => write(`${terminalText(link.url)}\n`));
			break;
		}
		case "progress": {
			write(`${terminalText(event.message)}\n`);
			break;
		}
	}
};

/** Cancel through Clack's regular input path so it restores the terminal. */
const cancelPrompt = (): void => {
	process.stdin.emit("keypress", "", { name: "escape" });
};

/**
 * Clack 0.11 has no public prompt signal option. Sending its normal Escape key
 * on abort runs its own readline/raw-mode cleanup before this promise settles.
 * All free-form input is masked, including OAuth callback URLs and manual codes.
 */
const promptTerminal = async (
	prompt: AuthPrompt,
	controller: AbortController,
	signal: AbortSignal,
): Promise<string> => {
	const combined = prompt.signal
		? AbortSignal.any([signal, prompt.signal])
		: signal;
	if (combined.aborted) {
		throw new Error("Authentication cancelled");
	}

	combined.addEventListener("abort", cancelPrompt, { once: true });
	try {
		const message = terminalText(prompt.message);
		const value = await (prompt.type === "select"
			? select({
					message,
					options: prompt.options.map((option) => ({
						value: option.id,
						label: terminalText(option.label),
						hint: option.description && terminalText(option.description),
					})),
				})
			: password({
					message,
					mask: "*",
					validate: (input: string) =>
						input.trim() ? undefined : "A value is required",
				}));
		if (combined.aborted) {
			throw new Error("Authentication cancelled");
		}
		if (isCancel(value)) {
			controller.abort();
			throw new Error("Authentication cancelled");
		}
		return value;
	} finally {
		combined.removeEventListener("abort", cancelPrompt);
	}
};

/** Stable public failures contain no provider response, credential or error cause. */
const requireTerminal = (deps: AuthCommandDeps): void => {
	const interactive =
		deps.interactive ??
		(() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
	if (!interactive()) {
		throw new Error(
			"Authentication requires an interactive terminal; run d3r auth login in a terminal",
		);
	}
};

/** Build a runtime only after rejecting noninteractive login; never import Pi global state. */
const commandRuntime = async (deps: AuthCommandDeps): Promise<Models> =>
	deps.models ??
	(deps.createRuntime ?? createModelRuntime)({
		stateDir: deps.stateDir ?? defaultAuthStateDir(),
	});

/** Select only provider-advertised login methods, never fabricate OAuth support. */
const chooseLogin = async (
	models: Models,
	options: TerminalLoginOptions,
	prompt: (prompt: AuthPrompt) => Promise<string>,
): Promise<{ provider: string; type: AuthType; subscription: boolean }> => {
	const providers = listProviders(models);
	if (
		!options.provider &&
		!providers.some((provider) => provider.methods.length > 0)
	) {
		throw new Error("No providers support terminal login");
	}
	const providerId =
		options.provider ??
		(await prompt({
			type: "select",
			message: "Provider",
			options: providers
				.filter((provider) => provider.methods.length > 0)
				.map((provider) => ({ id: provider.id, label: provider.name })),
		}));
	const provider = providers.find((entry) => entry.id === providerId);
	if (!provider) {
		throw new Error("Unknown authentication provider; use d3r auth list");
	}
	if (provider.methods.length === 0) {
		throw new Error(
			"This provider uses ambient authentication and has no terminal login",
		);
	}
	const type =
		options.type ??
		(provider.methods.length === 1
			? provider.methods[0].type
			: await prompt({
					type: "select",
					message: "Authentication method",
					options: provider.methods.map((method) => ({
						id: method.type,
						label: method.name,
					})),
				}));
	const method = provider.methods.find((entry) => entry.type === type);
	if (!method) {
		throw new Error("Unsupported authentication method");
	}
	return {
		provider: provider.id,
		type: method.type,
		subscription: method.subscription,
	};
};

/**
 * Composition API for `d3r acp --terminal-login`: await this, then RETURN instead
 * of starting ACP. Clack 0.11 renders prompts on stdout, so both stdin/stdout
 * must be TTYs. Never call it inside a running protocol session. Cancellation
 * rejects with a redacted error; the caller owns exit status. No secrets in argv.
 */
export const runTerminalLogin = async (
	options: TerminalLoginOptions = {},
	deps: AuthCommandDeps = {},
): Promise<void> => {
	requireTerminal(deps);
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const cancel = (): void => {
		controller.abort();
	};
	const write =
		deps.write ??
		((message: string) => {
			process.stderr.write(message);
		});
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	process.stdin.once("end", cancel);
	process.stdin.once("close", cancel);
	try {
		signal.throwIfAborted();
		const models = await commandRuntime(deps);
		const prompt = (request: AuthPrompt): Promise<string> =>
			promptTerminal(request, controller, signal);
		const chosen = await chooseLogin(models, options, prompt);
		if (chosen.subscription) {
			write(
				"OAuth support is provided by the library, not a guarantee of subscription eligibility or compliance with provider terms.\n",
			);
		}
		await loginProvider(models, chosen.provider, chosen.type, {
			signal,
			prompt,
			notify: (event) => notifyTerminal(event, write),
		});
		write("Authentication saved in D3R private user state.\n");
	} catch {
		throw new Error(
			signal.aborted
				? "Authentication cancelled"
				: "Terminal login failed; use d3r auth list to check supported providers and retry",
		);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		process.stdin.removeListener("end", cancel);
		process.stdin.removeListener("close", cancel);
	}
};

/** Dispatch explicit auth actions; list/status are local metadata only. */
export const executeAuth = async (
	action: string,
	provider?: string,
	deps: AuthCommandDeps = {},
): Promise<void> => {
	if (!["list", "status", "login", "logout"].includes(action)) {
		throw new Error("Usage: d3r auth list|status|login|logout [provider]");
	}
	if (action === "login") {
		return runTerminalLogin({ provider }, deps);
	}
	if (action === "logout" && !provider) {
		throw new Error("Specify a provider to log out");
	}
	const models = await commandRuntime(deps);
	const write =
		deps.write ??
		((message: string) => {
			process.stdout.write(message);
		});
	if (action === "logout") {
		await logoutProvider(models, provider!);
		write(
			"Removed D3R's stored credential; ambient credentials and remote tokens are unchanged.\n",
		);
		return;
	}
	const metadata =
		action === "status"
			? await getAuthStatus({
					models,
					stateDir: deps.stateDir ?? defaultAuthStateDir(),
					provider,
				})
			: listProviders(models).filter(
					(entry) => provider === undefined || entry.id === provider,
				);
	if (provider !== undefined && metadata.length === 0) {
		throw new Error("Unknown authentication provider; use d3r auth list");
	}
	metadata.forEach((entry) => {
		const methods =
			entry.methods.map((method) => method.type).join(", ") || "ambient only";
		let status = methods;
		if ("stored" in entry) {
			status = entry.stored ? `stored ${entry.storedType}` : "not stored";
		}
		write(`${terminalText(entry.id)}\t${status}\n`);
	});
	if (action === "status") {
		write(
			"Local credential metadata only; no validity check, token refresh or ambient-auth discovery was performed.\n",
		);
	}
};

/** Registration is deliberately left to the main CLI composition. */
const command = defineCommand({
	meta: {
		name: "auth",
		description: "Manage native provider authentication in private user state",
	},
	args: {
		action: {
			type: "positional",
			required: true,
			description: "list, status, login or logout",
		},
		provider: {
			type: "positional",
			required: false,
			description: "Provider ID (see auth list)",
		},
	},
	run: ({ args }) => executeAuth(args.action, args.provider),
});

export default command as CommandDef;
