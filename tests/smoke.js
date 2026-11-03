/* Guidewise smoke test. Run from the repo root:  node tests/smoke.js
   Needs Playwright (require('playwright')) and Python 3 for a local web server. Everything external
   (Supabase, weather, WhatsApp) is faked, so it runs offline and never touches real data. */
const {chromium}=require('playwright');const {spawn}=require('child_process');const path=require('path');const fs=require('fs');
const PORT=8799,BASE=`http://localhost:${PORT}/`;let fails=0;
const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m);if(!c)fails++};
(async()=>{
  const srv=spawn('python3',['-m','http.server',String(PORT)],{cwd:path.join(__dirname,'..','site'),stdio:'ignore'});await new Promise(r=>setTimeout(r,800));
  const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:390,height:844}});const errs=[];
  await ctx.route(/supabase\.co|wa\.me|maps\.google|google\.com\/maps/,r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await ctx.route(/geocoding-api\.open-meteo/,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({results:[{latitude:-34.19,longitude:18.43,name:'Simon\'s Town',country_code:'ZA'}]})}));
  await ctx.route(/\/\/api\.open-meteo/,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({daily:{time:['x'],weather_code:[61],temperature_2m_max:[21],temperature_2m_min:[14],precipitation_probability_max:[70],wind_speed_10m_max:[45]}})}));
  const pg=await ctx.newPage();pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto(BASE);await pg.evaluate(()=>localStorage.clear());await pg.reload();await pg.waitForTimeout(600);

  console.log('First run');
  ok(await pg.evaluate(()=>tab)==='welcome','welcome shows on a fresh install');
  await pg.click('[data-onb="sample"]');ok(await pg.evaluate(()=>tab==='today'&&localStorage.getItem('guidewise.onb')==='1'),'explore opens Today and is remembered');

  console.log('Navigation');
  for(const t of ['today','plan','guests','brief','more'])await pg.click(`nav [data-tab=${t}]`),ok(await pg.evaluate(t=>tab===t,t),`bottom bar opens ${t}`);
  for(const t of ['pack','docs','intel','count','cash','late','report','venues','import','home','acct'])await pg.evaluate(t=>{tab=t;render()},t),ok(await pg.evaluate(()=>!!document.querySelector('#main').textContent.trim()),`${t} renders`);

  console.log('Day plan');
  await pg.evaluate(()=>{tab='plan';S.day=0;editDay=true;render()});const t0=await pg.evaluate(()=>schedule(D()).map(x=>x.arrive));
  await pg.fill('#st-0','50');await pg.dispatchEvent('#st-0','change');const t1=await pg.evaluate(()=>schedule(D()).map(x=>x.arrive));
  ok(t1[1]-t0[1]===30&&t1[4]-t0[4]===30,'changing a stay moves every later stop');
  await pg.fill('#ph-1','+27 21 000 0000');await pg.dispatchEvent('#ph-1','change');await pg.click('[data-editday="0"]');
  ok(await pg.$$eval('.sacts a[href^="tel:"]',x=>x.length)===1,'call button appears for a stop with a phone');

  console.log('Weather');
  await pg.evaluate(()=>{S.days[0].date=todayIso();S.days[0].weather='';tab='today';render()});await pg.waitForTimeout(800);
  ok(await pg.evaluate(()=>/Rain, 14 to 21/.test(S.days[0].weather)),'forecast fills the briefing weather');
  ok(await pg.$$eval('.step b',x=>x.some(e=>/Strong wind/.test(e.textContent))),'strong wind becomes a next step');

  console.log('Running late');
  await pg.evaluate(()=>{tab='late';lateDone=null;lateFrom=null;render()});const before=await pg.evaluate(()=>schedule(D()).map(x=>x.arrive));
  await pg.click('[data-latemin="20"]');await pg.click('[data-lateapply]');const after=await pg.evaluate(()=>schedule(D()).map(x=>x.arrive));
  ok(after[after.length-1]-before[before.length-1]===20,'last stop moves by 20 min');
  ok(/20 minutes behind/.test(await pg.textContent('#lateMsg')),'update message is ready');
  await pg.click('[data-lateundo]');ok((await pg.evaluate(()=>schedule(D()).map(x=>x.arrive))).join()===before.join(),'undo restores the times');

  console.log('Cash and tips');
  await pg.evaluate(()=>{S.cash=[];tab='cash';render()});
  for(const [c,a] of [['float','5000'],['entry','1 240,50'],['mytip','800']]){await pg.click(`[data-cashcat="${c}"]`);await pg.fill('#cashAmt',a);await pg.click('[data-cashadd]')}
  const tt=await pg.evaluate(()=>cashTotals());ok(tt.bal===3759.5&&tt.tip===800,'balance excludes tips received, comma decimals work');

  console.log('Briefing translation');
  await ctx.route(/functions\/v1\/ai-translate/,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({text:'Guten Abend zusammen 🌍',left:29})}));
  await pg.evaluate(async()=>{await loadSB();user={id:'u1'};plan={status:'comp'};loaded=true;sb.auth.getSession=async()=>({data:{session:{access_token:'t',user}}});S.lang='German';tab='brief';render()});
  await pg.click('[data-tr]');await pg.waitForSelector('#trBubble');ok(/Guten Abend/.test(await pg.textContent('#trBubble')),'briefing translates and shows send options');
  ok(await pg.$$eval('[data-wa2]',x=>x.length)===2,'send translation or both');
  await pg.evaluate(()=>{user=null;plan=null;loaded=false;S.lang=''});

  console.log('Headcount');
  await pg.evaluate(()=>{hc.clear();tab='count';render()});await pg.click('[data-hc="0"]');ok(/1 of 4/.test(await pg.textContent('.hc-top')),'counts guests on board');

  console.log('Tour switcher');
  await pg.evaluate(()=>{tab='today';render()});await pg.click('#tsw');ok(await pg.isVisible('#tpanel'),'panel opens');
  await pg.click('#tpanel [data-tnew="1"]');ok(await pg.evaluate(()=>T.tours.length===2&&S.tour==='New tour'),'new tour from the panel');
  await pg.evaluate(()=>{openTour(T.tours[0].id)});

  console.log('AI import conversion');
  const draft=JSON.parse(fs.readFileSync(path.join(__dirname,'fixture-draft.json'),'utf8')).draft;
  const r=await pg.evaluate(d=>{const t=gwImportBuild(d),bad=[];t.days.forEach((day,i)=>{const sc=schedule(day);day.stops.forEach((s,k)=>{
      if(s.drive>90&&!/transfer|border|road/i.test(day.stops[k-1]?.place||''))bad.push(`D${i+1} drive ${s.drive}`);if(k&&sc[k].arrive<sc[k-1].arrive)bad.push(`D${i+1} order`)})});
    d.days.forEach((sd,i)=>{const day=t.days[i],sc=schedule(day);sd.stops.forEach(s=>{if(!s.arrive)return;const k=day.stops.findIndex(x=>x.place.replace(/^✈ /,'')===s.place);if(k>=0&&fmt(sc[k].arrive)!==s.arrive)bad.push(`D${i+1} time ${s.place}`)})});
    return{days:t.days.length,bad}},draft);
  ok(r.days===13,'13 days built');ok(!r.bad.length,'no fake drives, times ascending, source times kept'+(r.bad.length?': '+r.bad.join(', '):''));

  console.log('Document backup crypto');
  const d=await pg.evaluate(async()=>{const store=new Map();sb={storage:{from:()=>({upload:async(p,bl)=>{store.set(p,new Uint8Array(await bl.arrayBuffer()));return{error:null}},download:async p=>({data:new Blob([store.get(p)])}),remove:async ps=>{ps.forEach(p=>store.delete(p));return{error:null}},list:async()=>({data:[]})})}};
    user={id:'u1'};bk={key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};sync.up=[];sync.man=[];sync.docDel=[];
    for(const f of await dbAll())await tx('readwrite',st=>st.delete(f.id));
    await tx('readwrite',st=>st.add({tour:S.id,name:'v.txt',type:'text/plain',size:12,day:'0',added:'2026-01-01',blob:new Blob(['Secret entry'])}));
    const man=await docManifest();await uploadDocs(man.files);const leak=new TextDecoder().decode([...store.values()][0]).includes('Secret');
    for(const f of await dbAll())await tx('readwrite',st=>st.delete(f.id));sync.up=[];const res=await restoreDocs(man.list);
    const txt=await (await dbAll())[0].blob.text();user=null;bk=null;return{leak,res,txt}});
  ok(!d.leak,'stored document is unreadable');ok(d.res.got===1&&d.txt==='Secret entry','document restores exactly');

  console.log('Phone layout and accessibility');
  for(const w of [320,390]){await pg.setViewportSize({width:w,height:800});
    for(const t of ['today','plan','guests','brief','more','cash','late','venues']){await pg.evaluate(t=>{tab=t;editDay=false;render()},t);
      const o=await pg.evaluate(()=>document.documentElement.scrollWidth-innerWidth);ok(o<=1,`${t} fits ${w}px with no sideways scroll`)}}
  await pg.setViewportSize({width:390,height:844});
  for(const t of ['today','plan','guests','more','cash']){await pg.evaluate(t=>{tab=t;render()},t);
    const unnamed=await pg.evaluate(()=>[...document.querySelectorAll('button,a')].filter(e=>e.offsetParent&&!(e.textContent.trim()||e.getAttribute('aria-label'))).length);ok(!unnamed,`${t}: every button has a name`)}
  await pg.setViewportSize({width:360,height:800});await pg.evaluate(()=>document.documentElement.style.fontSize='130%');
  for(const t of ['today','plan','guests','cash']){await pg.evaluate(t=>{tab=t;render()},t);ok(await pg.evaluate(()=>document.documentElement.scrollWidth-innerWidth<=1),`${t} fits with large text`)}
  await pg.evaluate(()=>document.documentElement.style.fontSize='');await pg.setViewportSize({width:390,height:844});
  await pg.goto(BASE+'guides.html');ok(await pg.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'landing page fits a phone');

  console.log('Offline');
  await pg.goto(BASE);await pg.waitForTimeout(1200);await pg.reload();await pg.waitForTimeout(800);await ctx.setOffline(true);await pg.reload();await pg.waitForTimeout(800);
  ok(await pg.evaluate(()=>document.querySelectorAll('nav button').length===5),'app opens with no signal');await ctx.setOffline(false);

  ok(!errs.length,'no JavaScript errors'+(errs.length?': '+errs.join(' | '):''));
  await b.close();srv.kill();console.log(fails?`\n${fails} check(s) failed`:'\nAll checks passed');process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
