// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type LoginCommunityWork = {
  id: string;
  /** Literal display title (the source video's name). */
  title: string;
  /** Literal short description (from the work's synopsis file; empty if none). */
  description: string;
  likes: number;
  cover: string;
  preview: string;
  gradient: string;
};

const CDN_BASE = "https://nfg-web-assets.cdnfg.com/dramaclaw";

// Build a CDN media URL from a human-readable path. `encodeURI` percent-encodes
// non-ASCII characters, spaces and brackets in the filenames (the CDN serves them
// percent-encoded) while leaving the `https://` and the `/` separators intact.
function cdn(path: string): string {
  return encodeURI(`${CDN_BASE}/${path}`);
}

// Display content (the works' own titles and synopses), not UI text.
export const loginCommunityWorks: LoginCommunityWork[] = [
  {
    id: "neon-patrol",
    title: "Luban",
    description: "",
    likes: 124,
    cover: cdn("luban/luban-cover.png"),
    preview: cdn("luban/luban-ep01.mp4"),
    gradient: "linear-gradient(135deg, #132674 0%, #e52c3b 48%, #1a0d23 100%)",
  },
  {
    id: "glass-signal",
    title: "Guilingsi",
    description:
      "Every reflective surface in the city is haunted and faces dissolve into thin air! Lu Lingxi, the Guilingsi's best spirit-catcher, is sent to investigate, only to discover that she herself is the source of the spirit plague: the mirror spirit has spent a thousand years searching for its master.",
    likes: 33,
    cover: cdn("guilingsi/guilingsi-cover.png"),
    preview: cdn("guilingsi/guilingsi-ep01.mp4"),
    gradient: "linear-gradient(135deg, #dfe8ec 0%, #61a8b8 42%, #21313e 100%)",
  },
  {
    id: "silent-arcade",
    title: "Senior Brother, Why Did You Stop Simping?",
    description: "Lin Yuan, head of the mighty Heavenly Dao Sect, is reborn, and the very first thing he does is refuse to be a simp!",
    likes: 71,
    cover: cdn("shixiong-butianle/shixiong-butianle-cover.png"),
    preview: cdn("shixiong-butianle/shixiong-butianle-ep01.mp4"),
    gradient: "linear-gradient(135deg, #1b1730 0%, #b7477e 44%, #1a8baa 100%)",
  },
  {
    id: "floating-market",
    title: "Fate Cannot Be Deceived",
    description:
      "On the wedding day, troubles at home and abroad erupt at once. The Imperial Ancestral Temple offers a book of \"ways home\" to the modern world, and tells Yun Zhizhi a shocking secret...",
    likes: 95,
    cover: cdn("tianmingbukeqi/tianmingbukeqi-cover.png"),
    preview: cdn("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
    gradient: "linear-gradient(135deg, #233a2b 0%, #d69d55 48%, #1b1e28 100%)",
  },
  {
    id: "last-take",
    title: "The Bungled Path to Immortality",
    description: "After eighteen years of transmigration the ascension system finally activates, only to turn out to be a dud.",
    likes: 118,
    cover: cdn("wulongxiantu/wulongxiantu-cover.png"),
    preview: cdn("wulongxiantu/wulongxiantu-ep01.mp4"),
    gradient: "linear-gradient(135deg, #2e1020 0%, #d65041 44%, #f4c16e 100%)",
  },
  {
    id: "paper-city",
    title: "Intangible Heritage Nuo Dance",
    description: "",
    likes: 57,
    cover: cdn("feiyi-zhouwu/feiyi-zhouwu-cover.png"),
    preview: cdn("feiyi-zhouwu/feiyi-zhouwu.mp4"),
    gradient: "linear-gradient(135deg, #e9d6b8 0%, #a4574b 45%, #25253a 100%)",
  },
  {
    id: "rainy-night",
    title: "3D Anime Montage",
    description: "",
    likes: 42,
    cover: "/login-community/rainy-night.jpg",
    preview: cdn("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
    gradient: "linear-gradient(135deg, #0d5877 0%, #48c2d7 42%, #1a2535 100%)",
  },
  {
    id: "ember-crown",
    title: "Dynamic Fight",
    description: "",
    likes: 86,
    cover: "/login-community/ember-crown.jpg",
    preview: cdn("dongtai-dadou/dongtai-dadou.mp4"),
    gradient: "linear-gradient(135deg, #1f1b2e 0%, #8d3b2f 48%, #f0a23a 100%)",
  },
];
