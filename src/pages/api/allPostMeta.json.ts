import { getSortedPosts } from "@/utils/content-utils";
import { getPostPublicDescription } from "@/utils/post-card-content";
import { getPostUrl } from "@/utils/url-utils";

export async function GET() {
	const posts = await getSortedPosts();

	const allPostsData = posts
		.map((post) => ({
			id: post.id,
			title: post.data.title,
			description: getPostPublicDescription(post.data),
			published: post.data.published.getTime(),
			category: post.data.category || "",
			password: !!post.data.password,
			comment: post.data.comment ?? true,
			url: getPostUrl(post),
		}))
		// 按发布日期降序排列
		.sort((a, b) => {
			const timeDifference = b.published - a.published;
			if (timeDifference !== 0) {
				return timeDifference;
			}
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

	return new Response(JSON.stringify(allPostsData), {
		headers: { "Content-Type": "application/json" },
	});
}
