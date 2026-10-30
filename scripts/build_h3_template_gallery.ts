// Builds docs/h3-templates/index.html: a static, offline reference page that
// lists every MiniMax-H3 prompt template of the Freezone video node (prompt,
// input pictures with their image prompts, sample video).
//
//   bun scripts/build_h3_template_gallery.ts
//
// Besides the Freezone templates it lists the community prompts in
// community-prompts.json (apimodels.app / awesome-minimax-h3-prompts, English).
// The 25 originals in Japanese/Chinese live in docs/zh/h3-templates/ (the repo
// keeps CJK text out of the other docs) and are loaded by the page at runtime.
// Those are free-form, so they carry no <Picture N> inputs and are not in the
// Freezone picker; the gallery is reference only.
//
// Sample media is not in git. `python scripts/fetch_h3_gallery_media.py` fills
// docs/h3-templates/media/<id>/ (preview.mp4, preview.jpg, ref-N.webp) from
// media-sources.json; the page hides whatever is missing.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  H3_PROMPT_TEMPLATES,
  H3_TEMPLATE_CATEGORIES,
  h3TemplateGenMode,
  h3TemplateRunnablePrompt,
} from "../frontend/src/features/canvas/domain/h3PromptTemplates";

const here = dirname(fileURLToPath(import.meta.url));
const galleryDir = join(here, "..", "docs", "h3-templates");
const out = join(galleryDir, "index.html");

const sources: Record<string, Record<string, string>> = JSON.parse(
  readFileSync(join(galleryDir, "media-sources.json"), "utf-8"),
);

function mediaFor(id: string) {
  const entry = sources[id] ?? {};
  const refs = Object.keys(entry)
    .filter((k) => /^ref\d+$/.test(k))
    .sort((x, y) => parseInt(x.slice(3), 10) - parseInt(y.slice(3), 10))
    .map((k) => `ref-${k.slice(3)}.webp`);
  return { video: "vid" in entry, refs };
}

interface CommunityEntry {
  id: string;
  category: string;
  title: { en: string; vi: string };
  author: string | null;
  authorUrl: string | null;
  postUrl: string | null;
  aspectRatio: string;
  durationSec: number | null;
  prompt: string;
}
const community: CommunityEntry[] = JSON.parse(
  readFileSync(join(galleryDir, "community-prompts.json"), "utf-8"),
);

const data = H3_PROMPT_TEMPLATES.map((t) => ({
  id: t.id,
  source: t.source,
  category: t.category,
  title: t.title,
  description: t.description,
  mode: t.mode,
  genMode: h3TemplateGenMode(t),
  aspectRatio: t.aspectRatio,
  durationSec: t.durationSec,
  inputs: t.inputs,
  prompt: h3TemplateRunnablePrompt(t),
  media: mediaFor(t.id),
  credit: null as null | { author: string | null; authorUrl: string | null; postUrl: string | null },
}));

for (const c of community) {
  data.push({
    id: c.id,
    source: "apimodels" as never,
    category: c.category as never,
    title: c.title,
    description: { en: "", vi: "" },
    mode: "" as never,
    genMode: "" as never,
    aspectRatio: c.aspectRatio as never,
    durationSec: c.durationSec as never,
    inputs: [],
    prompt: c.prompt,
    media: mediaFor(c.id),
    credit: { author: c.author, authorUrl: c.authorUrl, postUrl: c.postUrl },
  });
}

const json = JSON.stringify({ categories: H3_TEMPLATE_CATEGORIES, templates: data })
  .replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MiniMax H3 - Thu vien template</title>
<style>
:root{--bg:#fff;--fg:#1c1d21;--mut:#686c78;--card:#f5f6f8;--line:#dfe1e6;--acc:#4f46e5;--code:#eceef2}
@media(prefers-color-scheme:dark){:root{--bg:#14151a;--fg:#e8e9ee;--mut:#9a9eab;--card:#1d1f26;--line:#2e313b;--acc:#8b87ff;--code:#101116}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
h1{font-size:18px;margin:0 0 8px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
input[type=search]{flex:1;min-width:180px}
button{cursor:pointer}button:hover{border-color:var(--acc)}
.count{color:var(--mut);font-size:13px}
main{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.card h2{font-size:16px;margin:0}
.badges{display:flex;flex-wrap:wrap;gap:6px}
.b{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.b.acc{color:var(--acc);border-color:var(--acc)}
p{margin:0;color:var(--mut)}
.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.slot{border:1px dashed var(--line);border-radius:8px;overflow:hidden;background:var(--code);position:relative}
.slot img,.slot video{display:block;width:100%;height:100%;object-fit:cover}
.slot .ph{padding:8px;font-size:11px;color:var(--mut);word-break:break-all;display:flex;align-items:center;justify-content:center;text-align:center;height:100%}
.vid{aspect-ratio:var(--ar);max-height:420px;margin:0 auto}
.vid video{object-fit:contain;background:#000}
.slot .ph{padding:8px;font-size:12px;color:var(--mut);text-align:center}
.cap a{color:var(--acc)}
.nomedia,.cap{font-size:12px;color:var(--mut)}
.media .slot{aspect-ratio:1}
.inp{font-size:13px;border-top:1px solid var(--line);padding-top:6px}
.inp code{color:var(--acc)}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between}
details>summary{cursor:pointer;color:var(--acc);font-size:13px}
pre{margin:6px 0 0;background:var(--code);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;max-height:420px;overflow:auto}
.small{font-size:12px;padding:2px 8px}
</style>
</head>
<body>
<header>
<h1>MiniMax H3 &middot; Thu vien template Freezone</h1>
<div class="bar">
<input id="q" type="search" placeholder="Tim theo ten, mo ta, prompt...">
<select id="cat"></select>
<select id="mode"><option value="">Mọi mode</option><option>fl2va</option><option>flf2va</option><option>ref2va</option></select>
<select id="ar"><option value="">Mọi tỉ lệ</option><option>16:9</option><option>9:16</option></select>
<select id="src"><option value="">Mọi nguồn</option><option>pixo</option><option>fal</option><option>apimodels</option></select>
<button id="lang">VI / EN</button>
<span class="count" id="count"></span>
</div>
</header>
<div id="warn" hidden style="padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line);font-size:13px">Video/ảnh mẫu chưa có trên máy này (không nằm trong git). Chạy <code>python scripts/fetch_h3_gallery_media.py</code> rồi tải lại trang.</div>
<main id="list"></main>
<script src="../zh/h3-templates/community-prompts-cjk.js"></script>
<script id="data" type="application/json">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
if(window.H3_CJK_TEMPLATES)D.templates.push(...window.H3_CJK_TEMPLATES);
let lang='vi';
const $=id=>document.getElementById(id);
const L=o=>o[lang]||o.en;
const MODE={fl2va:'chỉ first frame',flf2va:'first + last frame',ref2va:'first frame + ảnh tham chiếu'};
function fillCats(){const s=$('cat');const v=s.value;s.innerHTML='<option value="">Mọi nhóm</option>'+D.categories.map(c=>'<option>'+c+'</option>').join('');s.value=v}
function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function copy(btn,text){navigator.clipboard.writeText(text).then(()=>{const o=btn.textContent;btn.textContent='Đã chép';setTimeout(()=>btn.textContent=o,1200)})}
function card(t){
  const ar=t.aspectRatio.replace(':','/');
  const inputs=t.inputs.map(i=>{
    const ip=i.imagePrompt?'<details><summary>Image prompt</summary><pre>'+esc(i.imagePrompt)+'</pre><button class="small" data-copy="ip">Chép</button></details>':'';
    return '<div class="inp"><code>'+esc(i.label)+'</code> '+esc(L(i.role))+ip+'</div>';
  }).join('');
  return '<article class="card" data-id="'+t.id+'">'+
   '<div class="row"><h2>'+esc(L(t.title))+'</h2><button class="small" data-copy="id">'+esc(t.id)+'</button></div>'+
   '<div class="badges"><span class="b acc">'+t.category+'</span>'+(t.mode?'<span class="b">'+t.mode+' &middot; '+MODE[t.mode]+'</span>':'<span class="b">prompt tự do</span>')+'<span class="b">'+t.aspectRatio+'</span>'+(t.durationSec?'<span class="b">'+t.durationSec+'s</span>':'')+'<span class="b">'+t.source+'</span></div>'+
   (t.description.en||t.description.vi?'<p>'+esc(L(t.description))+'</p>':'')+
   (t.credit?'<div class="cap">'+(t.credit.author?'Tác giả '+(t.credit.authorUrl?'<a href="'+t.credit.authorUrl+'" target="_blank" rel="noopener">'+esc(t.credit.author)+'</a>':esc(t.credit.author))+(t.credit.postUrl?' &middot; <a href="'+t.credit.postUrl+'" target="_blank" rel="noopener">bài gốc</a>':''):'Nguồn: apimodels.app')+'</div>':'')+
   (t.media.video?'<div class="slot vid" style="--ar:'+ar+'"><video src="media/'+t.id+'/preview.mp4" poster="media/'+t.id+'/preview.jpg" controls loop muted preload="metadata"></video><div class="ph" hidden>Chưa tải media</div></div>':'<div class="nomedia">Chưa có video mẫu</div>')+
   (t.media.refs.length?'<div class="media">'+t.media.refs.map(r=>'<a class="slot" href="media/'+t.id+'/'+r+'" target="_blank"><img src="media/'+t.id+'/'+r+'" alt="" loading="lazy"></a>').join('')+'</div><div class="cap">Ảnh tham chiếu của ví dụ gốc (chỉ để xem; không trùng số với &lt;Picture N&gt; của template)</div>':'')+
   inputs+
   '<details><summary>Prompt đầy đủ</summary><pre>'+esc(t.prompt)+'</pre><button class="small" data-copy="prompt">Chép prompt</button></details>'+
   '</article>';
}
function render(){
  const q=$('q').value.toLowerCase(),c=$('cat').value,m=$('mode').value,a=$('ar').value,s=$('src').value;
  const items=D.templates.filter(t=>(!c||t.category===c)&&(!m||t.mode===m)&&(!a||t.aspectRatio===a)&&(!s||t.source===s)&&
    (!q||(t.id+' '+t.title.en+' '+t.title.vi+' '+t.description.en+' '+t.description.vi+' '+t.prompt).toLowerCase().includes(q)));
  $('list').innerHTML=items.map(card).join('');
  $('count').textContent=items.length+' / '+D.templates.length;
  $('list').querySelectorAll('video').forEach(v=>v.addEventListener('error',()=>{v.hidden=true;v.nextElementSibling.hidden=false;$('warn').hidden=false},{once:true}));
  $('list').querySelectorAll('.media img').forEach(i=>i.addEventListener('error',()=>{i.parentElement.hidden=true},{once:true}));
}
$('list').addEventListener('click',e=>{
  const b=e.target.closest('[data-copy]');if(!b)return;
  const t=D.templates.find(x=>x.id===b.closest('.card').dataset.id);
  const k=b.dataset.copy;
  copy(b,k==='id'?t.id:k==='prompt'?t.prompt:b.previousElementSibling.textContent);
});
['q','cat','mode','ar','src'].forEach(id=>$(id).addEventListener('input',render));
$('lang').onclick=()=>{lang=lang==='vi'?'en':'vi';fillCats();render()};
fillCats();render();
</script>
</body>
</html>
`;
writeFileSync(out, html);
console.log(`wrote ${out} (${data.length} templates)`);
