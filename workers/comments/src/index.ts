import { z } from "zod";
import {
	commentPathSchema,
	commentThreadSchema,
	issueCommentSchema,
	reactionSchema,
} from "../../../src/types/comments";
import { callback, login, sessionToken, sessionUser } from "./auth";
import { ApiError, type Env } from "./env";
import {
	appToken,
	github,
	githubCommentSchema,
	issueSchema,
	publicComment,
} from "./github";

const textSchema = z.string().trim().min(1).max(65536);
const commentInput = z.object({ path: commentPathSchema, body: textSchema });
const reactionInput = z.object({
	path: commentPathSchema,
	commentId: z.number().int().positive(),
	content: reactionSchema,
});
const postSchema = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().default(""),
	comment: z.boolean(),
	url: z.string(),
});

async function readJson(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new ApiError(400, "Missing request body.");
	let size = 0;
	let text = "";
	const decoder = new TextDecoder();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 524288) {
				await reader.cancel();
				throw new ApiError(413, "The comment is too long.");
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(400, "Invalid request body.");
	} finally {
		reader.releaseLock();
	}
}

function errorResponse(error: unknown) {
	if (error instanceof ApiError)
		return Response.json({ error: error.message }, { status: error.status });
	if (error instanceof z.ZodError)
		return Response.json(
			{ error: "The request or GitHub response was invalid." },
			{ status: 400 },
		);
	return Response.json(
		{ error: "Comments are temporarily unavailable. Please try again." },
		{ status: 502 },
	);
}

function ready(env: Env) {
	return Boolean(
		env.GITHUB_APP_ID &&
			env.GITHUB_CLIENT_ID &&
			env.GITHUB_CLIENT_SECRET &&
			env.GITHUB_PRIVATE_KEY &&
			env.SESSION_SECRET,
	);
}

async function route(request: Request, env: Env) {
	const url = new URL(request.url);
	const siteOrigin = new URL(env.SITE_URL).origin;
	const origin = request.headers.get("Origin");
	if (origin && origin !== siteOrigin)
		throw new ApiError(403, "This origin is not allowed.");
	if (request.method === "OPTIONS") return new Response(null, { status: 204 });
	if (url.pathname === "/health" && request.method === "GET")
		return Response.json({ ready: ready(env) });
	if (!ready(env))
		throw new ApiError(
			503,
			"Comment sign-in is being configured. Please try again shortly.",
		);
	if (url.pathname === "/login" && request.method === "GET")
		return login(request, env);
	if (url.pathname === "/callback" && request.method === "GET")
		return callback(request, env);
	if (url.pathname === "/me" && request.method === "GET")
		return Response.json(await sessionUser(request, env));
	if (url.pathname === "/thread" && request.method === "GET") {
		const path = commentPathSchema.parse(url.searchParams.get("path"));
		const page = z.coerce
			.number()
			.int()
			.min(1)
			.max(1000)
			.parse(url.searchParams.get("page") ?? 1);
		const target = new URL("https://comments.internal/thread");
		target.searchParams.set("path", path);
		target.searchParams.set("page", String(page));
		return env.THREADS.get(env.THREADS.idFromName(path)).fetch(target.href);
	}
	if (url.pathname === "/preview" && request.method === "POST") {
		const token = await sessionToken(request, env);
		const { body } = z
			.object({ body: textSchema })
			.parse(await readJson(request));
		const response = await github("/markdown", token, {
			method: "POST",
			body: { text: body, mode: "gfm", context: env.GITHUB_REPO },
		});
		return Response.json({ html: await response.text() });
	}
	if (
		(url.pathname === "/comments" || url.pathname === "/reaction") &&
		request.method === "POST"
	) {
		const token = await sessionToken(request, env);
		const body =
			url.pathname === "/comments"
				? commentInput.parse(await readJson(request))
				: reactionInput.parse(await readJson(request));
		const target = new URL(`https://comments.internal${url.pathname}`);
		target.searchParams.set("path", body.path);
		return env.THREADS.get(env.THREADS.idFromName(body.path)).fetch(
			target.href,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
	}
	throw new ApiError(404, "Not found.");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let response: Response;
		try {
			response = await route(request, env);
		} catch (error) {
			response = errorResponse(error);
		}
		const result = new Response(response.body, response);
		result.headers.set(
			"Access-Control-Allow-Origin",
			new URL(env.SITE_URL).origin,
		);
		result.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		result.headers.set(
			"Access-Control-Allow-Headers",
			"Authorization, Content-Type",
		);
		result.headers.set("Vary", "Origin");
		result.headers.set("Cache-Control", "no-store");
		result.headers.set("Referrer-Policy", "no-referrer");
		result.headers.set("X-Content-Type-Options", "nosniff");
		return result;
	},
};

export class CommentThread {
	private issueNumber?: number;
	private pages = new Map<number, { expires: number; data: unknown }>();

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) {
		this.state.blockConcurrencyWhile(async () => {
			this.issueNumber = await this.state.storage.get<number>("issue");
		});
	}

	async fetch(request: Request): Promise<Response> {
		try {
			return await this.state.blockConcurrencyWhile(() => this.handle(request));
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async resolve(path: string, token: string) {
		if (this.issueNumber) {
			try {
				return issueSchema.parse(
					await (
						await github(
							`/repos/${this.env.GITHUB_REPO}/issues/${this.issueNumber}`,
							token,
						)
					).json(),
				);
			} catch (error) {
				if (!(error instanceof ApiError) || error.status !== 404) throw error;
				this.issueNumber = undefined;
				await this.state.storage.delete("issue");
			}
		}
		const query = new URLSearchParams({
			q: `"${path}" in:title repo:${this.env.GITHUB_REPO} is:issue`,
			per_page: "100",
		});
		const response = await github(`/search/issues?${query}`, token);
		const result = z
			.object({ items: z.array(issueSchema) })
			.parse(await response.json());
		const issue = result.items.find((item) => item.title === path);
		if (issue) {
			this.issueNumber = issue.number;
			await this.state.storage.put("issue", issue.number);
		}
		return issue;
	}

	private async article(path: string) {
		if (path.replace(/\/$/, "") === "/about")
			return {
				title: "About Eatgrapes",
				description: "",
				url: new URL("about/", this.env.SITE_URL).href,
			};
		const response = await fetch(
			new URL("api/allPostMeta.json", this.env.SITE_URL),
			{ signal: AbortSignal.timeout(8000) },
		);
		if (!response.ok)
			throw new ApiError(
				503,
				"The article could not be verified. Please try again.",
			);
		const posts = z.array(postSchema).parse(await response.json());
		const post = posts.find(
			(item) =>
				`/posts/${item.id.replace(/\.(md|mdx|markdown)$/i, "")}` === path,
		);
		if (!post?.comment)
			throw new ApiError(404, "This article is not available for comments.");
		return {
			...post,
			url: new URL(post.url, this.env.SITE_URL).href,
		};
	}

	private async handle(request: Request) {
		const url = new URL(request.url);
		const path = commentPathSchema.parse(url.searchParams.get("path"));
		const page = Number(url.searchParams.get("page") ?? 1);
		const cached = this.pages.get(page);
		if (request.method === "GET" && cached && cached.expires > Date.now()) {
			return Response.json(cached.data);
		}
		const token = await appToken(this.env);
		let issue = await this.resolve(path, token);
		if (request.method === "GET") {
			if (!issue) {
				const data = commentThreadSchema.parse({
					issue: null,
					comments: [],
					total: 0,
					nextPage: null,
				});
				this.pages.set(page, { data, expires: Date.now() + 30000 });
				return Response.json(data);
			}
			const response = await github(
				`/repos/${this.env.GITHUB_REPO}/issues/${issue.number}/comments?per_page=20&page=${page}`,
				token,
				{ html: true },
			);
			const comments = z
				.array(githubCommentSchema)
				.parse(await response.json());
			const data = commentThreadSchema.parse({
				issue: {
					number: issue.number,
					url: issue.html_url,
					locked: issue.locked,
				},
				comments: comments.map(publicComment),
				total: issue.comments,
				nextPage: response.headers.get("Link")?.includes('rel="next"')
					? page + 1
					: null,
			});
			this.pages.set(page, { data, expires: Date.now() + 30000 });
			return Response.json(data);
		}
		const userToken = request.headers.get("Authorization")?.slice(7);
		if (!userToken) throw new ApiError(401, "Sign in with GitHub to comment.");
		if (issue?.locked)
			throw new ApiError(403, "Comments are closed for this article.");
		if (url.pathname === "/comments") {
			const input = commentInput.parse(await readJson(request));
			const article = await this.article(path);
			if (!issue) {
				await github("/user", userToken);
				issue = issueSchema.parse(
					await (
						await github(`/repos/${this.env.GITHUB_REPO}/issues`, token, {
							method: "POST",
							body: {
								title: path,
								body: `# ${article.title}\n\n${article.description}\n\n[Read the article](${article.url})`,
							},
						})
					).json(),
				);
				this.issueNumber = issue.number;
				await this.state.storage.put("issue", issue.number);
			}
			const response = await github(
				`/repos/${this.env.GITHUB_REPO}/issues/${issue.number}/comments`,
				userToken,
				{ method: "POST", body: { body: input.body }, html: true },
			);
			const comment = issueCommentSchema.parse(
				publicComment(githubCommentSchema.parse(await response.json())),
			);
			this.pages.clear();
			return Response.json({
				comment,
				issue: {
					number: issue.number,
					url: issue.html_url,
					locked: issue.locked,
				},
			});
		}
		if (url.pathname === "/reaction" && issue) {
			const input = reactionInput.parse(await readJson(request));
			const commentPath = `/repos/${this.env.GITHUB_REPO}/issues/comments/${input.commentId}`;
			const comment = githubCommentSchema.parse(
				await (await github(commentPath, token, { html: true })).json(),
			);
			if (
				comment.issue_url?.toLowerCase() !==
				`https://api.github.com/repos/${this.env.GITHUB_REPO}/issues/${issue.number}`.toLowerCase()
			)
				throw new ApiError(400, "This comment does not belong to the article.");
			const reaction = await github(`${commentPath}/reactions`, userToken, {
				method: "POST",
				body: { content: input.content },
			});
			if (reaction.status === 200) {
				const existing = z
					.object({ id: z.number().int().positive() })
					.parse(await reaction.json());
				await github(`${commentPath}/reactions/${existing.id}`, userToken, {
					method: "DELETE",
				});
			}
			const updated = githubCommentSchema.parse(
				await (await github(commentPath, token, { html: true })).json(),
			);
			this.pages.clear();
			return Response.json(issueCommentSchema.parse(publicComment(updated)));
		}
		throw new ApiError(404, "Not found.");
	}
}
