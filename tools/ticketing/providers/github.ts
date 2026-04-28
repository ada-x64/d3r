// GitHub-backed TicketingProvider. Reads GITHUB_TOKEN lazily on first
// use so that the registry stays importable without the token set;
// throws a typed MissingGithubTokenError when the token is absent so
// callers can surface a clear message.

import { Octokit } from "@octokit/rest";

import type { TicketRef, TicketingProvider } from "../index.ts";

const PROVIDER_NAME = "github";
const ENV_VAR = "GITHUB_TOKEN";

export class MissingGithubTokenError extends Error {
	override readonly name = "MissingGithubTokenError";
	readonly envVar: string;
	constructor(envVar: string) {
		super(
			`${envVar} is not set; ticketing tools require a GitHub personal-access token with repo scope`,
		);
		this.envVar = envVar;
	}
}

const splitRepo = (repo: string): { owner: string; name: string } => {
	const slash = repo.indexOf("/");
	return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

export const createGithubProvider = ({
	token,
}: {
	token: string;
}): TicketingProvider => {
	const octokit = new Octokit({ auth: token });
	return {
		createIssue: async ({ repo, title, body, labels }): Promise<TicketRef> => {
			const { owner, name } = splitRepo(repo);
			const response = await octokit.rest.issues.create({
				owner,
				repo: name,
				title,
				body,
				labels,
			});
			return {
				provider: PROVIDER_NAME,
				repo,
				number: response.data.number,
			};
		},
		commentIssue: async ({ ref, body }): Promise<void> => {
			const { owner, name } = splitRepo(ref.repo);
			await octokit.rest.issues.createComment({
				owner,
				repo: name,
				issue_number: ref.number,
				body,
			});
		},
	};
};

export const defaultProvider = (): TicketingProvider => {
	const token = process.env[ENV_VAR];
	if (!token) {
		throw new MissingGithubTokenError(ENV_VAR);
	}
	return createGithubProvider({ token });
};
