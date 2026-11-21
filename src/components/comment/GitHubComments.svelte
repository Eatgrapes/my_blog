<script lang="ts">
import Icon from "@iconify/svelte";
import { onMount } from "svelte";
import { z } from "zod";
import {
	type CommentReaction,
	type CommentThreadData,
	type CommentUser,
	commentThreadSchema,
	commentUserSchema,
	type IssueComment,
	issueCommentSchema,
} from "@/types/comments";

let { path, apiUrl, repo }: { path: string; apiUrl: string; repo: string } =
	$props();
let thread = $state<CommentThreadData>({
	issue: null,
	comments: [],
	total: 0,
	nextPage: null,
});
let user = $state<CommentUser | null>(null);
let draft = $state("");
let session = "";
let loaded = $state(false);
let loading = $state(false);
let sending = $state(false);
let signingIn = $state(false);
let previewing = $state(false);
let preview = $state<string | null>(null);
let loadError = $state("");
let actionError = $state("");
let reacting = $state<number | null>(null);
let reactionMenu = $state<number | null>(null);
let textarea = $state<HTMLTextAreaElement>();
let section: HTMLElement | undefined;
let controller: AbortController;
const sessionKey = "eatgrapes-comments-session";
const loginStateKey = "eatgrapes-comments-login-state";
const draftKey = () => `eatgrapes-comment-draft:${repo}:${path}`;
const reactions: { content: CommentReaction; emoji: string; label: string }[] =
	[
		{ content: "+1", emoji: "👍", label: "Like" },
		{ content: "-1", emoji: "👎", label: "Dislike" },
		{ content: "laugh", emoji: "😄", label: "Laugh" },
		{ content: "hooray", emoji: "🎉", label: "Celebrate" },
		{ content: "confused", emoji: "😕", label: "Confused" },
		{ content: "heart", emoji: "❤️", label: "Heart" },
		{ content: "rocket", emoji: "🚀", label: "Rocket" },
		{ content: "eyes", emoji: "👀", label: "Watching" },
	];

function stored(key: string) {
	try {
		return sessionStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function save(key: string, value: string) {
	try {
		if (value) sessionStorage.setItem(key, value);
		else sessionStorage.removeItem(key);
		return true;
	} catch {
		return false;
	}
}

function signOut() {
	session = "";
	user = null;
	save(sessionKey, "");
	preview = null;
}

async function request<T>(
	route: string,
	schema: z.ZodType<T>,
	body?: unknown,
	authenticated = false,
) {
	const headers = new Headers();
	if (body !== undefined) headers.set("Content-Type", "application/json");
	if (authenticated && session)
		headers.set("Authorization", `Bearer ${session}`);
	const response = await fetch(`${apiUrl}${route}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: controller.signal,
	});
	const data: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		if (response.status === 401) signOut();
		const error = z.object({ error: z.string() }).safeParse(data);
		throw new Error(
			error.success
				? error.data.error
				: "Comments are unavailable. Please try again.",
		);
	}
	return schema.parse(data);
}

function message(error: unknown) {
	return error instanceof Error
		? error.message
		: "Something went wrong. Please try again.";
}

function mergeComments(comments: IssueComment[]) {
	return [
		...new Map(
			[...thread.comments, ...comments].map((comment) => [comment.id, comment]),
		).values(),
	].sort((left, right) => left.id - right.id);
}

async function loadThread(page = 1) {
	if (loading) return;
	loading = true;
	loadError = "";
	try {
		const query = new URLSearchParams({ path, page: String(page) });
		const result = await request(`/thread?${query}`, commentThreadSchema);
		thread = {
			...result,
			comments: page === 1 ? result.comments : mergeComments(result.comments),
		};
		loaded = true;
	} catch (error) {
		if (!controller.signal.aborted) loadError = message(error);
	} finally {
		loading = false;
	}
}

async function loadUser() {
	if (!session) return;
	signingIn = true;
	try {
		user = await request("/me", commentUserSchema, undefined, true);
	} catch (error) {
		if (!controller.signal.aborted) actionError = message(error);
	} finally {
		signingIn = false;
	}
}

function signIn() {
	if (draft && !save(draftKey(), draft)) {
		actionError =
			"Your browser could not save this draft. Copy it before signing in.";
		return;
	}
	const destination = new URL(window.location.href);
	destination.hash = "comments";
	const clientState = crypto.randomUUID();
	if (!save(loginStateKey, clientState)) {
		actionError =
			"GitHub sign-in needs browser session storage. Please allow it and try again.";
		return;
	}
	window.location.assign(
		`${apiUrl}/login?${new URLSearchParams({ return_to: destination.href, client_state: clientState })}`,
	);
}

async function showPreview() {
	if (!user || !draft.trim() || previewing) return;
	previewing = true;
	actionError = "";
	try {
		preview = (
			await request(
				"/preview",
				z.object({ html: z.string() }),
				{ body: draft },
				true,
			)
		).html;
	} catch (error) {
		if (!controller.signal.aborted) actionError = message(error);
	} finally {
		previewing = false;
	}
}

async function submit() {
	if (sending || signingIn || thread.issue?.locked) return;
	if (!user) {
		signIn();
		return;
	}
	if (!draft.trim()) return;
	sending = true;
	actionError = "";
	try {
		const result = await request(
			"/comments",
			z.object({
				comment: issueCommentSchema,
				issue: commentThreadSchema.shape.issue,
			}),
			{ path, body: draft },
			true,
		);
		thread = {
			...thread,
			issue: result.issue,
			comments: mergeComments([result.comment]),
			total: thread.total + 1,
		};
		draft = "";
		preview = null;
		save(draftKey(), "");
	} catch (error) {
		if (!controller.signal.aborted) actionError = message(error);
	} finally {
		sending = false;
	}
}

function reply(comment: IssueComment) {
	preview = null;
	draft = `${draft}${draft ? "\n\n" : ""}@${comment.author.login} `;
	textarea?.focus();
	textarea?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function react(comment: IssueComment, content: CommentReaction) {
	if (!user) {
		signIn();
		return;
	}
	if (reacting !== null) return;
	reacting = comment.id;
	reactionMenu = null;
	actionError = "";
	try {
		const updated = await request(
			"/reaction",
			issueCommentSchema,
			{ path, commentId: comment.id, content },
			true,
		);
		thread = {
			...thread,
			comments: thread.comments.map((item) =>
				item.id === updated.id ? updated : item,
			),
		};
	} catch (error) {
		if (!controller.signal.aborted) actionError = message(error);
	} finally {
		reacting = null;
	}
}

onMount(() => {
	controller = new AbortController();
	draft = stored(draftKey());
	session = stored(sessionKey);
	const hash = new URLSearchParams(window.location.hash.slice(1));
	const returnedSession = hash.get("comment-session");
	const returnedError = hash.get("comment-error");
	if (returnedSession || returnedError) {
		const expectedState = stored(loginStateKey);
		if (expectedState && hash.get("comment-state") === expectedState) {
			if (returnedSession) {
				session = returnedSession;
				save(sessionKey, session);
			}
			if (returnedError) actionError = returnedError;
			save(loginStateKey, "");
		} else
			actionError =
				"This sign-in did not start in this browser. Please sign in again.";
		const location = new URL(window.location.href);
		location.hash = "comments";
		history.replaceState(history.state, "", location);
		section?.scrollIntoView({ block: "start" });
	}
	void loadUser();
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				observer.disconnect();
				void loadThread();
			}
		},
		{ rootMargin: "200px" },
	);
	if (section) observer.observe(section);
	return () => {
		controller.abort();
		observer.disconnect();
		save(draftKey(), draft);
	};
});
</script>

<section
	id="comments"
	class="github-comments"
	bind:this={section}
	aria-labelledby="comments-heading"
>
	<header class="comments-header">
		<div class="comments-title">
			<span class="comments-title-icon">
				<Icon icon="material-symbols:forum-outline-rounded" />
			</span>
			<h2 id="comments-heading">Comments</h2>
			{#if loaded}<span class="comments-count">{thread.total}</span>{/if}
		</div>
		<a
			class="comments-source"
			href={thread.issue?.url ?? `https://github.com/${repo}/issues`}
			target="_blank"
			rel="noopener noreferrer"
		>
			<Icon icon="fa7-brands:github" /><span>GitHub</span><Icon
				icon="material-symbols:arrow-outward-rounded"
			/>
		</a>
	</header>

	{#if thread.issue?.locked}
		<p class="comments-notice">
			<Icon icon="material-symbols:lock-outline" />Comments are closed for this article.
		</p>
	{:else}
		<form
			class="comments-composer"
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div class="composer-header">
				<div class="composer-identity">
					{#if user}<img
							class="comment-avatar"
							src={user.avatarUrl}
							alt=""
							width="40"
							height="40"
						/>
					{:else}<span class="comment-avatar anonymous-avatar">
							<Icon icon="material-symbols:person-outline-rounded" />
						</span>{/if}
					<div>
						<strong>{user ? user.login : "Join the conversation"}</strong><span>
							{user
								? "Share a thought or ask a question"
								: "Write here, then sign in with GitHub to post"}
						</span>
					</div>
				</div>
				{#if user}<button
						type="button"
						class="comment-text-button"
						onclick={signOut}
						disabled={sending}
					>
						Sign out
					</button>{/if}
			</div>
			<div class="composer-tabs" role="tablist" aria-label="Comment editor">
				<button
					type="button"
					role="tab"
					aria-selected={preview === null}
					class:active={preview === null}
					onclick={() => {
						preview = null;
					}}
				>
					Write
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={preview !== null}
					class:active={preview !== null}
					disabled={!user || !draft.trim() || previewing || sending}
					onclick={() => void showPreview()}
				>
					{previewing ? "Loading…" : "Preview"}
				</button>
			</div>
			<div class="composer-body">
				<textarea
					bind:this={textarea}
					bind:value={draft}
					hidden={preview !== null}
					disabled={sending}
					rows="4"
					maxlength="65536"
					placeholder="What are your thoughts?"
					aria-label="Your comment"
					onkeydown={(event) => {
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							void submit();
						}
					}}></textarea>
				{#if preview !== null}<div class="comment-markdown composer-preview">
						{@html preview}
					</div>{/if}
			</div>
			<footer class="composer-footer">
				<span class="markdown-hint">
					<Icon icon="material-symbols:markdown-outline" />Markdown supported
				</span>
				<button
					type="submit"
					class="btn-regular comment-submit"
					disabled={sending || signingIn || (user !== null && !draft.trim())}
				>
					<Icon icon={user ? "material-symbols:send-rounded" : "fa7-brands:github"} />
					{sending
						? "Posting…"
						: signingIn
							? "Signing in…"
							: user
								? "Post comment"
								: "Sign in with GitHub"}
				</button>
			</footer>
		</form>
	{/if}

	{#if actionError}<div class="comments-notice error" role="alert">
			<span>{actionError}</span><button
				type="button"
				class="comment-text-button"
				onclick={() => {
					actionError = "";
				}}
			>
				Dismiss
			</button>
		</div>{/if}
	{#if loadError}<div class="comments-notice error" role="alert">
			<span>{loadError}</span><button
				type="button"
				class="comment-text-button"
				onclick={() => void loadThread()}
			>
				Retry
			</button>
		</div>
	{:else if !loaded}<div class="comments-loading" aria-live="polite">
			<span class="loading-dot"></span>Loading comments…
		</div>
	{:else if thread.comments.length === 0}<div class="comments-empty">
			<span><Icon icon="material-symbols:chat-bubble-outline-rounded" /></span><strong>
				A conversation starts with you
			</strong>
			<p>No comments yet. Leave the first one.</p>
		</div>{/if}

	<div class="comments-list">
		{#each thread.comments as comment (comment.id)}
			<article class="comment-item" id={`comment-${comment.id}`}>
				<a
					class="comment-avatar-link"
					href={comment.author.profileUrl}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`${comment.author.login} on GitHub`}
				>
					<img
						class="comment-avatar"
						src={comment.author.avatarUrl}
						alt=""
						width="40"
						height="40"
						loading="lazy"
					/>
				</a>
				<div class="comment-content">
					<header class="comment-header">
						<div class="comment-author">
							<a href={comment.author.profileUrl} target="_blank" rel="noopener noreferrer">
								{comment.author.login}
							</a>{#if comment.isOwner}<span class="comment-owner">Author</span>{/if}
						</div>
						<a class="comment-time" href={comment.url} target="_blank" rel="noopener noreferrer">
							<time
								datetime={comment.createdAt}
								title={new Date(comment.createdAt).toLocaleString()}
							>
								{new Date(comment.createdAt).toLocaleDateString(undefined, {
									year: "numeric",
									month: "short",
									day: "numeric",
								})}
							</time>
						</a>
					</header>
					<div class="comment-markdown">{@html comment.html}</div>
					<footer class="comment-actions">
						{#each reactions.filter((reaction) => comment.reactions[reaction.content] > 0) as reaction (reaction.content)}<button
								type="button"
								class="comment-reaction"
								disabled={thread.issue?.locked || reacting !== null}
								onclick={() => void react(comment, reaction.content)}
								aria-label={`${reaction.label}: ${comment.reactions[reaction.content]}`}
							>
								{reaction.emoji}<span>{comment.reactions[reaction.content]}</span>
							</button>{/each}
						{#if !thread.issue?.locked}
							<div class="reaction-control">
								<button
									type="button"
									class="comment-text-button icon-button"
									aria-label="Add a reaction"
									aria-expanded={reactionMenu === comment.id}
									disabled={reacting !== null}
									onclick={() => {
										reactionMenu = reactionMenu === comment.id ? null : comment.id;
									}}
								>
									<Icon icon="material-symbols:add-reaction-outline-rounded" />
								</button>{#if reactionMenu === comment.id}<div
										class="reaction-picker"
										role="group"
										aria-label="Choose a reaction"
									>
										{#each reactions as reaction (reaction.content)}<button
												type="button"
												title={reaction.label}
												aria-label={reaction.label}
												onkeydown={(event) => {
													if (event.key === "Escape") reactionMenu = null;
												}}
												onclick={() => void react(comment, reaction.content)}
											>
												{reaction.emoji}
											</button>{/each}
									</div>{/if}
							</div>
							<button
								type="button"
								class="comment-text-button comment-reply"
								onclick={() => reply(comment)}
							>
								<Icon icon="material-symbols:reply-rounded" />Reply
							</button>
						{/if}
					</footer>
				</div>
			</article>
		{/each}
	</div>
	{#if thread.nextPage}<button
			type="button"
			class="btn-regular comments-load-more"
			disabled={loading}
			onclick={() => void loadThread(thread.nextPage ?? 1)}
		>
			{loading ? "Loading…" : "Load more comments"}<Icon
				icon="material-symbols:expand-more-rounded"
			/>
		</button>{/if}
</section>

<style>
.github-comments {
	--comment-ink: rgb(0 0 0 / 0.82);
	--comment-muted: rgb(0 0 0 / 0.48);
	color: var(--comment-ink);
	scroll-margin-top: 6rem;
}
:global(.dark) .github-comments {
	--comment-ink: rgb(255 255 255 / 0.86);
	--comment-muted: rgb(255 255 255 / 0.48);
}
.comments-header,
.comments-title,
.comments-source,
.composer-header,
.composer-identity,
.composer-footer,
.comment-header,
.comment-author,
.comment-actions,
.comment-submit,
.markdown-hint,
.comments-notice {
	display: flex;
	align-items: center;
}
.comments-header {
	justify-content: space-between;
	gap: 1rem;
	margin-bottom: 1.5rem;
}
.comments-title {
	gap: 0.65rem;
}
.comments-title h2 {
	margin: 0;
	font-size: 1.3rem;
	font-weight: 700;
}
.comments-title-icon {
	display: grid;
	place-items: center;
	width: 2.5rem;
	height: 2.5rem;
	border-radius: 0.85rem;
	color: var(--btn-content);
	background: var(--btn-regular-bg);
	font-size: 1.3rem;
}
.comments-count,
.comment-owner {
	padding: 0.1rem 0.55rem;
	border-radius: 0.5rem;
	background: var(--btn-regular-bg);
	color: var(--btn-content);
	font-size: 0.75rem;
	font-weight: 600;
}
.comments-source {
	gap: 0.35rem;
	color: var(--comment-muted);
	font-size: 0.8rem;
}
.comments-source:hover,
.comment-time:hover {
	color: var(--primary);
}
.comments-composer {
	border: 1px solid var(--line-divider);
	border-radius: var(--radius-large);
	background: color-mix(in oklch, var(--btn-regular-bg) 25%, transparent);
	overflow: hidden;
}
.composer-header {
	padding: 1rem 1.15rem 0.85rem;
	justify-content: space-between;
	gap: 0.75rem;
}
.composer-identity {
	gap: 0.75rem;
	min-width: 0;
}
.composer-identity strong {
	display: block;
	font-size: 0.92rem;
	font-weight: 600;
}
.composer-identity div > span {
	display: block;
	margin-top: 0.1rem;
	font-size: 0.76rem;
	color: var(--comment-muted);
}
.comment-avatar {
	width: 2.5rem;
	height: 2.5rem;
	flex-shrink: 0;
	border-radius: 0.85rem;
	object-fit: cover;
}
.anonymous-avatar {
	display: grid;
	place-items: center;
	background: var(--btn-regular-bg);
	color: var(--btn-content);
	font-size: 1.5rem;
}
.composer-tabs {
	display: flex;
	gap: 0.3rem;
	padding: 0 1.15rem 0.7rem;
}
.composer-tabs button {
	padding: 0.3rem 0.75rem;
	border-radius: 0.5rem;
	font-size: 0.8rem;
	color: var(--comment-muted);
}
.composer-tabs button.active {
	color: var(--btn-content);
	background: var(--btn-regular-bg);
	font-weight: 600;
}
.composer-body {
	margin: 0 1.15rem;
	border-radius: 0.75rem;
	background: var(--card-bg);
	border: 1px solid var(--line-divider);
	transition: border-color 0.15s;
}
.composer-body:focus-within {
	border-color: var(--primary);
}
.composer-body textarea {
	display: block;
	width: 100%;
	min-height: 8.5rem;
	resize: vertical;
	box-sizing: border-box;
	border: 0;
	border-radius: inherit;
	outline: none;
	background: transparent;
	color: inherit;
	padding: 0.9rem 1rem;
	font: inherit;
	font-size: 0.92rem;
	line-height: 1.8;
}
.composer-body textarea[hidden] {
	display: none;
}
.composer-body textarea::placeholder {
	color: var(--comment-muted);
}
.composer-preview {
	min-height: 8.5rem;
	padding: 0.9rem 1rem;
}
.composer-footer {
	justify-content: space-between;
	gap: 0.75rem;
	padding: 0.85rem 1.15rem 1rem;
}
.markdown-hint {
	gap: 0.4rem;
	font-size: 0.73rem;
	color: var(--comment-muted);
}
.comment-submit {
	gap: 0.5rem;
	padding: 0.6rem 1rem;
	border-radius: 0.75rem;
	font-size: 0.85rem;
	font-weight: 600;
}
button {
	cursor: pointer;
	transition:
		background-color 0.15s,
		color 0.15s,
		opacity 0.15s;
}
button:disabled {
	cursor: default;
	opacity: 0.45;
}
button:focus-visible,
a:focus-visible {
	outline: 2px solid var(--primary);
	outline-offset: 3px;
}
.comment-text-button {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	color: var(--comment-muted);
	font-size: 0.78rem;
	border-radius: 0.5rem;
	padding: 0.25rem 0.4rem;
}
.comment-text-button:hover {
	color: var(--btn-content);
	background: var(--btn-regular-bg);
}
.comments-notice {
	justify-content: space-between;
	gap: 0.65rem;
	padding: 0.8rem 1rem;
	border-radius: 0.75rem;
	background: var(--btn-regular-bg);
	font-size: 0.85rem;
	margin-top: 1rem;
}
.comments-notice.error {
	border-left: 3px solid var(--primary);
}
.comments-loading {
	display: flex;
	justify-content: center;
	align-items: center;
	gap: 0.6rem;
	min-height: 8rem;
	color: var(--comment-muted);
	font-size: 0.85rem;
}
.loading-dot {
	width: 0.45rem;
	height: 0.45rem;
	border-radius: 50%;
	background: var(--primary);
}
.comments-empty {
	display: flex;
	align-items: center;
	flex-direction: column;
	gap: 0.25rem;
	padding: 2rem 0 0.5rem;
	text-align: center;
}
.comments-empty > span {
	display: grid;
	place-items: center;
	width: 3rem;
	height: 3rem;
	border-radius: 1rem;
	margin-bottom: 0.5rem;
	background: var(--btn-regular-bg);
	color: var(--btn-content);
	font-size: 1.5rem;
}
.comments-empty strong {
	font-size: 0.9rem;
	font-weight: 500;
}
.comments-empty p {
	color: var(--comment-muted);
	font-size: 0.8rem;
	margin: 0;
}
.comment-item {
	display: flex;
	gap: 0.85rem;
	margin-top: 1.5rem;
}
.comment-avatar-link {
	flex-shrink: 0;
}
.comment-content {
	flex: 1;
	min-width: 0;
	padding-bottom: 1.2rem;
	border-bottom: 1px solid var(--line-divider);
}
.comment-item:last-child .comment-content {
	border-bottom: 0;
	padding-bottom: 0;
}
.comment-header {
	justify-content: space-between;
	gap: 0.5rem;
	flex-wrap: wrap;
	min-height: 1.8rem;
}
.comment-author {
	gap: 0.5rem;
	min-width: 0;
}
.comment-author > a {
	font-weight: 600;
	font-size: 0.9rem;
	overflow-wrap: anywhere;
}
.comment-time {
	color: var(--comment-muted);
	font-size: 0.73rem;
}
.comment-markdown {
	overflow-wrap: anywhere;
	font-size: 0.92rem;
	line-height: 1.8;
}
.comment-markdown :global(p) {
	margin: 0.55rem 0;
}
.comment-markdown :global(a) {
	color: var(--btn-content);
	text-decoration: underline;
	text-decoration-color: var(--link-underline);
	text-underline-offset: 0.2em;
}
.comment-markdown :global(img) {
	max-width: 100%;
	height: auto;
	border-radius: 0.65rem;
}
.comment-markdown :global(pre) {
	overflow-x: auto;
	padding: 0.85rem;
	border-radius: 0.65rem;
	background: var(--codeblock-bg);
	font-size: 0.8rem;
	margin: 0.7rem 0;
}
.comment-markdown :global(code) {
	font-family: var(--font-fira-code), monospace;
	font-size: 0.86em;
	background: var(--inline-code-bg);
	border-radius: 0.25rem;
	padding: 0.1em 0.3em;
}
.comment-markdown :global(pre code) {
	background: none;
	padding: 0;
}
.comment-markdown :global(blockquote) {
	border-left: 3px solid var(--primary);
	margin: 0.75rem 0;
	padding-left: 0.85rem;
	color: var(--comment-muted);
}
.comment-markdown :global(ul),
.comment-markdown :global(ol) {
	padding-left: 1.5rem;
	margin: 0.6rem 0;
}
.comment-markdown :global(ul) {
	list-style: disc;
}
.comment-markdown :global(ol) {
	list-style: decimal;
}
.comment-markdown :global(h1),
.comment-markdown :global(h2),
.comment-markdown :global(h3),
.comment-markdown :global(h4) {
	font-weight: 600;
	font-size: 1.1em;
	margin: 0.75rem 0 0.4rem;
}
.comment-markdown :global(table) {
	display: block;
	max-width: 100%;
	overflow-x: auto;
	border-collapse: collapse;
}
.comment-markdown :global(td),
.comment-markdown :global(th) {
	padding: 0.4rem 0.7rem;
	border: 1px solid var(--line-divider);
}
.comment-actions {
	gap: 0.35rem;
	flex-wrap: wrap;
	margin-top: 0.6rem;
}
.comment-reaction {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	border: 1px solid var(--line-divider);
	padding: 0.1rem 0.45rem;
	border-radius: 0.55rem;
	font-size: 0.8rem;
}
.comment-reaction span {
	color: var(--comment-muted);
	font-size: 0.73rem;
}
.comment-reaction:hover {
	background: var(--btn-regular-bg);
	border-color: var(--primary);
}
.comment-reply {
	margin-left: auto;
}
.icon-button {
	font-size: 1.1rem;
}
.reaction-control {
	position: relative;
}
.reaction-picker {
	display: flex;
	flex-wrap: wrap;
	gap: 0.2rem;
	position: absolute;
	z-index: 2;
	bottom: calc(100% + 0.4rem);
	left: 0;
	width: 10rem;
	padding: 0.4rem;
	border-radius: 0.8rem;
	background: var(--float-panel-bg);
	border: 1px solid var(--line-divider);
	box-shadow: 0 0.3rem 1rem rgb(0 0 0 / 0.08);
}
.reaction-picker button {
	width: 2rem;
	height: 2rem;
	border-radius: 0.5rem;
}
.reaction-picker button:hover {
	background: var(--btn-regular-bg);
}
.comments-load-more {
	margin: 1.5rem auto 0;
	gap: 0.4rem;
	padding: 0.65rem 1rem;
	border-radius: 0.75rem;
	font-size: 0.85rem;
}
@media (max-width: 640px) {
	.composer-header,
	.composer-footer {
		padding-left: 0.8rem;
		padding-right: 0.8rem;
	}
	.composer-body {
		margin-left: 0.8rem;
		margin-right: 0.8rem;
	}
	.composer-tabs {
		padding-left: 0.8rem;
	}
	.composer-identity div > span {
		max-width: 13rem;
	}
	.markdown-hint {
		font-size: 0.68rem;
	}
	.markdown-hint :global(svg) {
		display: none;
	}
	.comment-submit {
		font-size: 0.78rem;
		padding: 0.6rem 0.7rem;
	}
	.comments-source > span {
		display: none;
	}
	.comment-item {
		gap: 0.65rem;
	}
	.comment-avatar-link .comment-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 0.7rem;
	}
}
</style>
