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
  await ctx.route(/\/\/api\.open-meteo/,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({daily:{time:['x'],weather_code:[61],temperature_2m_max:[21],temperature_2m_min:[14],precipitation_probability_max:[70],wind_speed_10m_max:[45],sunrise:['2026-11-03T05:32'],sunset:['2026-11-03T19:41']}})}));
  await ctx.route(/date\.nager\.at/,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify([{date:new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10),name:'Test Day',global:true}])}));
  const pg=await ctx.newPage();pg.on('pageerror',e=>errs.push(e.message+' @ '+(e.stack||'').split('\n').slice(1,3).join(' ')));
  await pg.goto(BASE);await pg.evaluate(()=>localStorage.clear());await pg.reload();await pg.waitForTimeout(600);

  console.log('First run');
  ok(await pg.evaluate(()=>tab)==='welcome','welcome shows on a fresh install');
  ok(await pg.evaluate(()=>/rgb\(95, 128, 72\)/.test(getComputedStyle(document.querySelector('.onb .intro')).backgroundImage)),'welcome intro sits on the bush-to-sky panel');
  await pg.click('[data-onb="sample"]');ok(await pg.evaluate(()=>tab==='today'&&localStorage.getItem('guidewise.onb')==='1'),'explore opens Today and is remembered');
  await pg.reload();await pg.waitForTimeout(500);ok(await pg.evaluate(()=>tab==='home'),'app opens on Tours every time');

  console.log('Navigation');
  for(const t of ['home','today','plan','guests','brief','more'])await pg.click(`nav [data-tab=${t}]`),ok(await pg.evaluate(t=>tab===t,t),`bottom bar opens ${t}`);
  await pg.evaluate(()=>{tab='today';render()});ok(await pg.evaluate(()=>/rgb\(95, 128, 72\)/.test(getComputedStyle(document.querySelector('.hero')).backgroundImage)),'Today hero uses the bush-to-sky colours');
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

  await pg.waitForTimeout(600);await pg.evaluate(()=>render());
  ok(await pg.$$eval('.step b',x=>x.some(e=>/Public holiday today: Test Day/.test(e.textContent))),'public holiday becomes a next step');
  ok(/05:32/.test(await pg.textContent('.hero')),'sunrise and sunset on the Today card');
  await pg.evaluate(()=>{tab='intel';render()});ok(/Test Day/.test(await pg.textContent('#main')),'local intel lists the holiday');

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

  console.log('Venue and driver messages');
  const m=await pg.evaluate(()=>{const i=S.days[0].stops.findIndex(s=>s.lunch);S.days[0].stops[i].phone='021 123 4567';
    return{url:waTo(S.days[0].stops[i].phone,dietText(0,i)),diet:dietText(0,i),plan:planText(0),names:S.guests.map(g=>g.name.split(' ')[0])}});
  ok(m.url.startsWith('https://wa.me/27211234567?text='),'dietaries go to the venue WhatsApp (+27)');
  ok(/Gluten free/i.test(m.diet)&&/Shellfish/i.test(m.diet),'dietary message lists the needs');
  ok(!m.names.some(n=>m.plan.includes(n)),'driver plan has no guest names');
  console.log('Departure reminders');
  const rm=await pg.evaluate(()=>{const d=S.days[0];d.date=todayIso();const now=new Date(),mm=now.getHours()*60+now.getMinutes();
    d.start=fmt(mm-30);d.stops[0].drive=0;d.stops[0].stay=35;remOn=true;remDone.clear();remindTick();return document.querySelector('#toast').textContent});
  ok(/Leave in 5 min/.test(rm),'reminder fires 10 min before leaving a stop: '+rm);
  await pg.evaluate(()=>{remOn=false});

  console.log('Receipts');
  await pg.evaluate(()=>{cashCat='entry';tab='cash';render()});await pg.setInputFiles('#rcptFile',path.join(__dirname,'fixture-receipt.jpg'));await pg.waitForTimeout(500);
  await pg.fill('#cashAmt','120');await pg.fill('#cashWhat','Penguins');await pg.click('[data-cashadd]');await pg.waitForTimeout(300);
  const rc=await pg.evaluate(async()=>{const e=S.cash.find(x=>x.what==='Penguins');const f=e&&e.rec?await dbGet(e.rec):null;return{has:!!f,type:f&&f.type,named:f&&/Receipt · Penguins/.test(f.name)}});
  ok(rc.has&&rc.type==='image/jpeg'&&rc.named,'receipt photo is saved with the cash entry');
  ok(await pg.$$eval('[data-rcptshare]',x=>x.length)===1,'share receipts button appears');

  console.log('Day templates');
  await pg.evaluate(()=>{window.prompt=()=>'Peninsula day';S.day=0;tab='tpl';render()});await pg.click('[data-tplsave]');
  const nT=await pg.evaluate(()=>(T.templates||[]).length);ok(nT===1,'day saved as a template');
  await pg.click('[data-tpluse][data-mode="add"]');const ad=await pg.evaluate(()=>({n:S.days.length,title:D().title,stops:D().stops.length,src:S.days[0].stops.length,checked:D().checklist.some(c=>c.d)}));
  ok(ad.title===(await pg.evaluate(()=>S.days[0].title))&&ad.stops===ad.src&&!ad.checked,'template adds a new day with the same stops, checklist unticked');

  console.log('Print');
  await pg.evaluate(()=>{tab='print';prOpt={scope:'tour',room:true,diet:true,notes:false,check:true};render()});await pg.click('[data-prgo]').catch(()=>{});
  const ph=await pg.evaluate(()=>printHTML());ok(/Rooming list/.test(ph)&&/Gluten free/i.test(ph),'printout has the rooming list and dietaries');
  ok(!(await pg.evaluate(()=>S.guests.filter(g=>g.bday).some(g=>printHTML().includes(g.bday)))),'printout never shows birthdays');
  await pg.emulateMedia({media:'print'});ok(await pg.evaluate(()=>getComputedStyle(document.querySelector('header')).display==='none'&&getComputedStyle(document.querySelector('#printOut')).display==='block'),'print hides the app and shows only the printout');
  await pg.emulateMedia({media:'screen'});

  console.log('Guest list import');
  await pg.evaluate(()=>{S.guests=[];tab='gimport';render()});await pg.setInputFiles('#glFile',path.join(__dirname,'fixture-guests.csv'));await pg.waitForTimeout(900);
  await pg.click('[data-gl="add"]');const gg=await pg.evaluate(()=>S.guests.map(g=>[g.name,g.room,g.diet,g.bday,g.notes].join('|')));
  ok(gg.length===3&&gg.includes('Carol Example|12|Melon allergy|06-16|Queen bed'),'guest list import fills names, rooms, dietaries, birthdays, notes');
  ok(!gg.join().includes('X123'),'passport numbers are never imported');
  await pg.evaluate(()=>{S.guests=[];tab='docs';render()});await pg.setInputFiles('#docFile',path.join(__dirname,'fixture-guests.csv'));await pg.waitForTimeout(1200);
  ok(await pg.$$eval('[data-docguests="1"]',x=>x.length)===1,'a guest list added to Documents offers to fill in Guests');
  await pg.click('[data-docguests="1"]');await pg.click('[data-gl="add"]');ok(await pg.evaluate(()=>S.guests.length===3),'guests added from the Documents prompt');
  await pg.evaluate(()=>{S.guests=[{name:'Robert Smith',room:'412',diet:'',bday:'',notes:''},{name:'Linda Smith',room:'412',diet:'Gluten free',bday:'11-05',notes:''},{name:'Megan Lee',room:'415',diet:'Vegetarian',bday:'',notes:''},{name:'Tom Lee',room:'415',diet:'Shellfish allergy',bday:'',notes:''}];save()});

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
  ok(!d.leak,'stored document is unreadable');
  const d2=await pg.evaluate(async()=>{const store=new Map();sb={storage:{from:()=>({upload:async(p,bl)=>{store.set(p,new Uint8Array(await bl.arrayBuffer()));return{error:null}},download:async p=>({data:new Blob([store.get(p)])}),remove:async()=>({error:null}),list:async()=>({data:[...store.keys()].map(k=>({name:k.split('/')[1]}))})})}};
    user={id:'u1'};bk={key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};sync.up=[];sync.man=[];sync.docDel=[];
    for(const f of await dbAll())await tx('readwrite',st=>st.delete(f.id));
    await tx('readwrite',st=>st.add({tour:S.id,name:'voucher.pdf',type:'application/pdf',size:9,day:'0',added:'2026-01-01',blob:new Blob(['%PDF-1.4 x'])}));
    const man=await docManifest();await uploadDocs(man.files);
    // an old v1 file with no header and no manifest entry
    const iv=crypto.getRandomValues(new Uint8Array(12)),ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:docAAD('old1')},bk.key,new TextEncoder().encode('%PDF-1.3 old')));
    const o=new Uint8Array(12+ct.length);o.set(iv);o.set(ct,12);store.set('u1/old1',o);
    for(const f of await dbAll())await tx('readwrite',st=>st.delete(f.id));sync.up=[];
    const r=await restoreDocs([]);const back=(await dbAll()).map(f=>f.name+'|'+f.type).sort();user=null;bk=null;return{r,back}});
  ok(d2.r.got===2,'documents come back even with no list in the backup');
  ok(d2.back.includes('voucher.pdf|application/pdf')&&d2.back.some(x=>/^Recovered document\.pdf\|application\/pdf/.test(x)),'names come from the file itself; old files are recovered as PDFs: '+d2.back.join(', '));ok(d.res.got===1&&d.txt==='Secret entry','document restores exactly');

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
  ok(await pg.evaluate(()=>document.querySelectorAll('nav button').length===6),'app opens with no signal');await ctx.setOffline(false);

  ok(!errs.length,'no JavaScript errors'+(errs.length?': '+errs.join(' | '):''));
  await b.close();srv.kill();console.log(fails?`\n${fails} check(s) failed`:'\nAll checks passed');process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
