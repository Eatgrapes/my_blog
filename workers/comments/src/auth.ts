import { base64url, EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { ApiError, type Env } from "./env";
import { github, publicUser, userSchema } from "./github";

const COOKIE = "__Host-blog-oauth";
const oauthSchema = z.object({
	returnUrl: z.url(),
	verifier: z.string(),
	nonce: z.string(),
	clientState: z.uuid(),
});
const tokenSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().positive().optional(),
});
const sessionSchema = z.object({ token: z.string().min(1) });

function key(env: Env) {
	return base64url.decode(env.SESSION_SECRET);
}

async function seal(
	env: Env,
	audience: string,
	payload: Record<string, unknown>,
	seconds: number,
) {
	return new EncryptJWT(payload)
		.setProtectedHeader({ alg: "dir", enc: "A256GCM" })
		.setIssuer("eatgrapes-blog-comments")
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
		.encrypt(key(env));
}

async function open(env: Env, audience: string, value: string) {
	try {
		return (
			await jwtDecrypt(value, key(env), {
				issuer: "eatgrapes-blog-comments",
				audience,
			})
		).payload;
	} catch {
		throw new ApiError(
			401,
			"Your sign-in has expired. Please sign in with GitHub again.",
		);
	}
}

function returnUrl(value: string, env: Env) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ApiError(400, "Invalid return URL.");
	}
	const site = new URL(env.SITE_URL);
	if (
		url.origin !== site.origin ||
		!url.pathname.startsWith(site.pathname) ||
		url.username ||
		url.password
	) {
		throw new ApiError(400, "Invalid return URL.");
	}
	return url;
}

export async function login(request: Request, env: Env) {
	const requestUrl = new URL(request.url);
	const destination = returnUrl(
		requestUrl.searchParams.get("return_to") ?? "",
		env,
	);
	const clientState = z
		.uuid()
		.parse(requestUrl.searchParams.get("client_state"));
	const nonce = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);
	const state = await seal(
		env,
		"oauth",
		{ returnUrl: destination.href, verifier, nonce, clientState },
		600,
	);
	const authorize = new URL("https://github.com/login/oauth/authorize");
	for (const [name, value] of Object.entries({
		client_id: env.GITHUB_CLIENT_ID,
		redirect_uri: `${requestUrl.origin}/callback`,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}))
		authorize.searchParams.set(name, value);
	return new Response(null, {
		status: 302,
		headers: {
			Location: authorize.href,
			"Set-Cookie": `${COOKIE}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
			"Cache-Control": "no-store",
		},
	});
}

export async function callback(request: Request, env: Env) {
	const url = new URL(request.url);
	const state = oauthSchema.parse(
		await open(env, "oauth", url.searchParams.get("state") ?? ""),
	);
	const cookie = request.headers
		.get("Cookie")
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
	if (!cookie || cookie !== state.nonce)
		throw new ApiError(
			400,
			"The sign-in request does not match this browser. Please start again.",
		);
	const destination = returnUrl(state.returnUrl, env);
	const headers = new Headers({
		"Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (url.searchParams.has("error")) {
		destination.hash = new URLSearchParams({
			"comment-error": "GitHub sign-in was cancelled.",
			"comment-state": state.clientState,
		}).toString();
	} else {
		const code = url.searchParams.get("code");
		if (!code) throw new ApiError(400, "Missing GitHub authorization code.");
		const response = await fetch(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					client_id: env.GITHUB_CLIENT_ID,
					client_secret: env.GITHUB_CLIENT_SECRET,
					code,
					code_verifier: state.verifier,
					redirect_uri: `${url.origin}/callback`,
				}),
				signal: AbortSignal.timeout(12000),
			},
		);
		const result = tokenSchema.safeParse(await response.json());
		if (!response.ok || !result.success)
			throw new ApiError(
				502,
				"GitHub sign-in could not be completed. Please try again.",
			);
		const { access_token: token, expires_in: expiresIn } = result.data;
		const user = userSchema.parse(await (await github("/user", token)).json());
		const session = await seal(
			env,
			"session",
			{ token, sub: user.login },
			Math.min(expiresIn ?? 28800, 28800),
		);
		destination.hash = new URLSearchParams({
			"comment-session": session,
			"comment-state": state.clientState,
		}).toString();
	}
	headers.set("Location", destination.href);
	return new Response(null, { status: 302, headers });
}

export async function sessionToken(request: Request, env: Env) {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer "))
		throw new ApiError(401, "Sign in with GitHub to comment.");
	return sessionSchema.parse(await open(env, "session", header.slice(7))).token;
}

export async function sessionUser(request: Request, env: Env) {
	const token = await sessionToken(request, env);
	return publicUser(
		userSchema.parse(await (await github("/user", token)).json()),
	);
}
