import type { ProfileConfig } from "../types/config";

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.png",
	name: "Eatgrapes",
	bio: "Developer",
	typewriter: { enable: true, speed: 80 },
	links: [
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/Eatgrapes",
		},
		{
			name: "Telegram",
			icon: "fa7-brands:telegram",
			url: "https://t.me/Eatgrapes232",
		},
		{
			name: "Email",
			icon: "fa7-regular:envelope",
			url: "mailto:admin@tanikaze.icu",
		},
		{ name: "Website", icon: "fa7-solid:globe", url: "https://tanikaze.icu" },
		{
			name: "Bilibili",
			icon: "fa7-brands:bilibili",
			url: "https://space.bilibili.com/1455394496",
		},
	],
};
