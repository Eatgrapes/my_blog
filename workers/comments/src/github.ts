import { createAppAuth } from "@octokit/auth-app";
import { z } from "zod";
import { reactionSchema } from "../../../src/types/comments";
import { ApiError, type Env } from "./env";

export const userSchema = z.object({
	login: z.string(),
	avatar_url: z.url(),
	html_url: z.url(),
});

export const issueSchema = z.object({
	number: z.number().int().positive(),
	title: z.string(),
	html_url: z.url(),
	locked: z.boolean(),
	comments: z.number().int().nonnegative(),
});

export const githubCommentSchema = z.object({
	id: z.number().int().positive(),
	user: userSchema,
	body_html: z.string(),
	created_at: z.string(),
	html_url: z.url(),
	author_association: z.string(),
	issue_url: z.url().optional(),
	reactions: z.record(z.string(), z.unknown()),
});

export async function github(
	path: string,
	token: string,
	options: { method?: string; body?: unknown; html?: boolean } = {},
) {
	const response = await fetch(`https://api.github.com${path}`, {
		method: options.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: options.html
				? "application/vnd.github.html+json"
				: "application/vnd.github+json",
			"Content-Type": "application/json",
			"User-Agent": "Eatgrapes-Blog-Comments",
			"X-GitHub-Api-Version": "2026-03-10",
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(12000),
	});
	if (!response.ok) {
		if (response.status === 401)
			throw new ApiError(
				401,
				"Your GitHub session has expired. Please sign in again.",
			);
		if (response.status === 404)
			throw new ApiError(404, "This discussion could not be found.");
		if (response.status === 403 || response.status === 429) {
			throw new ApiError(
				response.status,
				"GitHub could not accept this request. Please try again later.",
			);
		}
		throw new ApiError(
			502,
			`GitHub returned HTTP ${response.status}. Please try again.`,
		);
	}
	return response;
}

const clients = new WeakMap<Env, ReturnType<typeof createAppAuth>>();
const installations = new WeakMap<Env, Promise<number>>();

export async function appToken(env: Env) {
	let auth = clients.get(env);
	if (!auth) {
		auth = createAppAuth({
			appId: env.GITHUB_APP_ID,
			privateKey: env.GITHUB_PRIVATE_KEY,
		});
		clients.set(env, auth);
	}
	let installation = installations.get(env);
	if (!installation) {
		const appAuth = auth;
		installation = (async () => {
			const { token } = await appAuth({ type: "app" });
			const response = await github(
				`/repos/${env.GITHUB_REPO}/installation`,
				token,
			);
			return z.object({ id: z.number() }).parse(await response.json()).id;
		})();
		installations.set(env, installation);
	}
	try {
		return (
			await auth({ type: "installation", installationId: await installation })
		).token;
	} catch (error) {
		installations.delete(env);
		throw error;
	}
}

export function publicUser(user: z.infer<typeof userSchema>) {
	return {
		login: user.login,
		avatarUrl: user.avatar_url,
		profileUrl: user.html_url,
	};
}

export function publicComment(comment: z.infer<typeof githubCommentSchema>) {
	return {
		id: comment.id,
		author: publicUser(comment.user),
		html: comment.body_html,
		createdAt: comment.created_at,
		url: comment.html_url,
		isOwner: comment.author_association === "OWNER",
		reactions: Object.fromEntries(
			reactionSchema.options.map((reaction) => [
				reaction,
				z.number().parse(comment.reactions[reaction] ?? 0),
			]),
		),
	};
}
