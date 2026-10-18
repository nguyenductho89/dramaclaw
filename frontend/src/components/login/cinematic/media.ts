const CDN_BASE = "https://nfg-web-assets.cdnfg.com/dramaclaw";

/** The single assembly point for all external resources on the login page - switching CDN only changes `CDN_BASE`. */
export const cdn = (path: string) => encodeURI(`${CDN_BASE}/${path}`);

export const businessWechatQrUrl = cdn("contact/wechat.png");

// Display content: the showcased works' own titles and one-line synopses (taken from the works themselves), not UI copy.
export const cinematicVideoLibrary = [
  {
    id: "luban",
    title: "Luban",
    type: "TRAILER",
    stat: "12 SHOTS",
    logline: "Machinery and ancient craft re-mesh on a single timeline.",
    video: cdn("luban/luban-ep01.mp4"),
  },
  {
    id: "guilingsi",
    title: "Guilingsi",
    type: "SCENE",
    stat: "08 SHOTS",
    logline: "Every reflective surface in the city is haunted, and the spirit-catcher is forced to trace the source in the mirror.",
    video: cdn("guilingsi/guilingsi-ep01.mp4"),
  },
  {
    id: "shixiong-butianle",
    title: "Senior Brother, Why Did You Stop Simping?",
    type: "CHARACTER",
    stat: "09 SHOTS",
    logline: "The first thing after rebirth is to refuse to keep being a supporting character in fate.",
    video: cdn("shixiong-butianle/shixiong-butianle-ep01.mp4"),
  },
  {
    id: "tianmingbukeqi",
    title: "Fate Cannot Be Deceived",
    type: "WORLD",
    stat: "14 SHOTS",
    logline: "On the wedding day, the way home and the dynasty's secret surface at the same time.",
    video: cdn("tianmingbukeqi/tianmingbukeqi-ep02.mp4"),
  },
  {
    id: "wulongxiantu",
    title: "The Bungled Path to Immortality",
    type: "TRAILER",
    stat: "11 SHOTS",
    logline: "The ascension system finally activates, only to steer the cultivation path in another absurd direction.",
    video: cdn("wulongxiantu/wulongxiantu-ep01.mp4"),
  },
  {
    id: "feiyi-zhouwu",
    title: "Intangible Heritage Nuo Dance",
    type: "WORLD",
    stat: "07 SHOTS",
    logline: "Traditional postures, rhythm and camera work are re-choreographed into a watchable clip.",
    video: cdn("feiyi-zhouwu/feiyi-zhouwu.mp4"),
  },
  {
    id: "3d-anime-montage-demo",
    title: "3D Anime Montage",
    type: "SCENE",
    stat: "10 SHOTS",
    logline: "Multiple animation clips are cut into one dense run of shot rhythm.",
    video: cdn("3d-anime-montage-demo/3d-anime-montage-demo.mp4"),
  },
  {
    id: "dongtai-dadou",
    title: "Dynamic Fight",
    type: "ACTION",
    stat: "06 SHOTS",
    logline: "Action, speed lines and the pressure of the camera advance continuously through the short.",
    video: cdn("dongtai-dadou/dongtai-dadou.mp4"),
  },
] as const;

/** The login dialog's left main visual uses a separate finished video, independent of the login page's gallery. */
export const loginModalShowcaseVideo = cdn("login/login20260826-174426.mp4");

export const cinematicVideos = {
  cs: cinematicVideoLibrary[7].video,
  jqr: cinematicVideoLibrary[1].video,
  pk: cinematicVideoLibrary[0].video,
} as const;
