const path=require('path');const pw=require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
(async()=>{const b=await pw.chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--force-color-profile=srgb']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
for(const f of ['a-edge-glow','b-orb-timeline','c-answer-sheet'])for(const s of ['done','working']){
 await p.goto('file://'+path.resolve(__dirname,f+'.html')+'?'+s);await p.waitForTimeout(400);
 const o=path.resolve(__dirname,f+'-'+s+'.png');await p.screenshot({path:o});console.log(o);}
await b.close();})();
