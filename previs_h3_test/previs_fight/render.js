const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path'),cp=require('child_process');
const N=124; const FR=path.join(__dirname,'frames'); fs.mkdirSync(FR,{recursive:true});
const srv=http.createServer((q,res)=>{const f=path.join(__dirname,q.url.split('?')[0]);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return}
 res.writeHead(200,{'content-type':f.endsWith('.js')||f.endsWith('.mjs')?'text/javascript':'text/html'});res.end(d)})}).listen(8767,async()=>{
 const b=await chromium.launch({executablePath:process.env.CHROME,args:['--use-gl=swiftshader','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
 const p=await b.newPage({viewport:{width:768,height:1344}});
 p.on('pageerror',e=>console.error('pageerror',e.message));
 await p.goto('http://localhost:8767/scene.html');await p.waitForFunction('window.ready===true',{timeout:30000});
 for(let i=0;i<N;i++){await p.evaluate(`window.frame(${i/(N-1)})`);await p.locator('#c').screenshot({path:path.join(FR,`f_${String(i).padStart(4,'0')}.png`)});}
 await b.close();srv.close();
 fs.copyFileSync(path.join(FR,'f_0000.png'),path.join(__dirname,'fight_f0.png'));
 cp.execFileSync('ffmpeg',['-y','-framerate','24','-i',path.join(FR,'f_%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','18',path.join(__dirname,'fight_previs.mp4')],{stdio:'inherit'});
 console.log('done',N);});
