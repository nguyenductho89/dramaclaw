// Render toast.html to numbered PNGs: node render.js <out_dir>. Needs `npm i playwright` and `npx playwright install chromium`.
const {chromium}=require('playwright'),path=require('path'),fs=require('fs');
const FPS=24,SECONDS=18,out=process.argv[2];
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
  const p=await b.newPage({viewport:{width:1920,height:1080}});
  p.on('pageerror',e=>console.error(e));
  await p.goto('file://'+path.join(__dirname,'toast.html'));
  await p.waitForFunction('window.ready===true',{timeout:60000});
  for(let i=0;i<FPS*SECONDS;i++){
    await p.evaluate(`window.frame(${i/FPS})`);
    await p.screenshot({path:path.join(out,`f_${String(i).padStart(4,'0')}.png`)});
  }
  await b.close();
})();
