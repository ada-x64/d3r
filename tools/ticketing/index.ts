// Ticketing tools: harness-agnostic interface plus the two v1 tool
// functions (create_issue, comment_issue). Backend implementations live
// under ./providers; the registry wires the default provider lazily so
// that importing this module never requires a backend credential.

import { z } from "zod";

const REPO_PATTERN = /^[^/]+\/[^/]+$/;
const repoSchema = z
	.string()
	.regex(REPO_PATTERN, 'repo must be in "owner/name" form');

export interface TicketRef {
	provider: string;
	repo: string;
	number: number;
}

export interface TicketingProvider {
	createIssue(args: {
		repo: string;
		title: string;
		body: string;
		labels?: string[];
	}): Promise<TicketRef>;
	commentIssue(args: { ref: TicketRef; body: string }): Promise<void>;
}

export const CreateIssueParams = z.object({
	repo: repoSchema,
	title: z.string().min(1),
	body: z.string().min(1),
	labels: z.array(z.string()).optional(),
});
export type CreateIssueParams = z.infer<typeof CreateIssueParams>;

export const CommentIssueParams = z.object({
	repo: repoSchema,
	issue_number: z.number().int().positive(),
	body: z.string().min(1),
});
export type CommentIssueParams = z.infer<typeof CommentIssueParams>;

export interface CommentIssueResult {
	ref: TicketRef;
}

export const createIssueTool = async (
	params: CreateIssueParams,
	provider: TicketingProvider,
): Promise<TicketRef> =>
	provider.createIssue({
		repo: params.repo,
		title: params.title,
		body: params.body,
		labels: params.labels,
	});

export const commentIssueTool = async (
	params: CommentIssueParams,
	provider: TicketingProvider,
): Promise<CommentIssueResult> => {
	const ref: TicketRef = {
		provider: "github",
		repo: params.repo,
		number: params.issue_number,
	};
	await provider.commentIssue({ ref, body: params.body });
	return { ref };
};
