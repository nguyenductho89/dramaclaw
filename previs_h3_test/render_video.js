const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const N=124; fs.mkdirSync(path.join(__dirname,'frames'),{recursive:true});
const srv=http.createServer((q,res)=>{const f=path.join(__dirname,q.url.split('?')[0]);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':f.endsWith('.js')||f.endsWith('.mjs')?'text/javascript':'text/html'});res.end(d)})}).listen(8766,async()=>{
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--no-sandbox']});const p=await b.newPage({viewport:{width:1344,height:768}});
await p.goto('http://localhost:8766/scene.html');await p.waitForFunction('window.ready===true',{timeout:20000});
for(let i=0;i<N;i++){const t=i/(N-1);await p.evaluate(`window.cam(${t})`);await p.locator('#c').screenshot({path:path.join(__dirname,'frames',`f_${String(i).padStart(4,'0')}.png`)});}
await b.close();srv.close();console.log('frames',N);});
