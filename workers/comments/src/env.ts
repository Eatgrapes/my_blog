export interface Env {
	SITE_URL: string;
	GITHUB_REPO: string;
	GITHUB_APP_ID: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITHUB_PRIVATE_KEY: string;
	SESSION_SECRET: string;
	THREADS: DurableObjectNamespace;
}

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}
