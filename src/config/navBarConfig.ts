import type { NavBarConfig } from "../types/config";
import { LinkPreset } from "../types/config";

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		LinkPreset.Archive,
		LinkPreset.About,
		{
			name: "Write",
			url: "https://app.pagescms.org/Eatgrapes/my_blog/main/collection/posts/new",
			icon: "material-symbols:edit-note-rounded",
			external: true,
		},
		{
			name: "GitHub",
			url: "https://github.com/Eatgrapes",
			icon: "fa7-brands:github",
			external: true,
		},
	],
};
