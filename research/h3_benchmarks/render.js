const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const srv=http.createServer((q,res)=>{const f=path.join(__dirname,q.url.split('?')[0]);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':f.endsWith('.js')||f.endsWith('.mjs')?'text/javascript':'text/html'});res.end(d)})}).listen(8765,async()=>{
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--no-sandbox']});const p=await b.newPage({viewport:{width:1344,height:768}});
p.on('console',m=>console.log('console:',m.text()));p.on('pageerror',e=>console.log('err',e.message));
await p.goto('http://localhost:8765/scene.html');await p.waitForFunction('window.ready===true',{timeout:20000});
for(const [n,t] of [['f0',0],['f1',1]]){await p.evaluate(`window.cam(${t})`);await p.locator('#c').screenshot({path:`previs_${n}.png`});}
await b.close();srv.close();});
