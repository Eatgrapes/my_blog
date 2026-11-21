import { z } from "zod";

const httpsUrl = z.url({ protocol: /^https$/ });

export const commentPathSchema = z
	.string()
	.max(512)
	.regex(/^\/(?:posts\/[\p{L}\p{N}._/-]+|about\/?|friends\/?)$/u);

export const commentUserSchema = z.object({
	login: z.string(),
	avatarUrl: httpsUrl,
	profileUrl: httpsUrl,
});

export const reactionSchema = z.enum([
	"+1",
	"-1",
	"laugh",
	"hooray",
	"confused",
	"heart",
	"rocket",
	"eyes",
]);

export const issueCommentSchema = z.object({
	id: z.number().int().positive(),
	author: commentUserSchema,
	html: z.string(),
	createdAt: z.string(),
	url: httpsUrl,
	isOwner: z.boolean(),
	reactions: z.record(reactionSchema, z.number()),
});

export const commentThreadSchema = z.object({
	issue: z
		.object({
			number: z.number().int().positive(),
			url: httpsUrl,
			locked: z.boolean(),
		})
		.nullable(),
	comments: z.array(issueCommentSchema),
	total: z.number().int().nonnegative(),
	nextPage: z.number().int().positive().nullable(),
});

export type CommentUser = z.infer<typeof commentUserSchema>;
export type IssueComment = z.infer<typeof issueCommentSchema>;
export type CommentThreadData = z.infer<typeof commentThreadSchema>;
export type CommentReaction = z.infer<typeof reactionSchema>;
