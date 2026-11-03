/* Guidewise AI import (Plus): itineraries, rooming lists and confirmations become a draft tour to review.
   Spreadsheets and text are read and cleaned on the phone first: passport, visa, flight, phone, email,
   address and insurance columns are dropped, and dates of birth become MM-DD birthdays. PDFs and photos
   are sent as they are, and the AI is told never to copy those details. Nothing is stored on the server;
   the draft lives only in this page until the guide creates the tour.
   Shares globals with index.html (T, S, tab, save, render, openTour, uid, toast, esc, $, toMin, fmt, dLabel)
   and backup.js (sb, user, plan, plus, loadSB, refresh, SB_URL, SB_KEY). Loaded after both. */
(()=>{
const AI_CONSENT='ai-v1', MAX_FILES=5, MAX_BYTES=12e6, LIMIT=5;
let files=[], st='pick', draft=null, err='', mode='new', agreed=false, t0=0, tick=null, mine=[];

/* ---------- on-device cleaning ---------- */
const DROP=/passport|visa|\bid\b|id\s*(no|num)|identity|flight|pnr|e-?ticket|ticket\s*(no|num)|phone|mobile|\bcell|\btel\b|whats\s*app|e-?mail|insurance|policy|nationality|citizen|address|emergency|next of kin|frequent flyer/i;
const DOB=/birth|\bdob\b|d\.o\.b/i;
const HEAD=/name|surname|room|diet|title|gender|\bage\b|notes?|remarks|date|time|\bday\b|pax|guest|sharing|bed/i;
/* A heading row: at least one private-looking heading, and two or more short headings without digits. */
const isHead=h=>h.filter(x=>x&&(DROP.test(x)||DOB.test(x))).length>=1&&h.filter(x=>x&&!/\d/.test(x)&&(DROP.test(x)||DOB.test(x)||HEAD.test(x))).length>=2;
const MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
const p2=n=>String(n).padStart(2,'0');
const okMD=(m,d)=>m>=1&&m<=12&&d>=1&&d<=31?p2(m)+'-'+p2(d):'';
function mmdd(v){
  if(typeof v==='number'&&v>1&&v<80000){const d=new Date(Math.round((v-25569)*864e5));return okMD(d.getUTCMonth()+1,d.getUTCDate())}
  const s=String(v??'').trim();let m;
  if(m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))return okMD(+m[2],+m[3]);
  if(m=s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))return +m[2]>12?okMD(+m[1],+m[2]):okMD(+m[2],+m[1]); // day first, as in SA and UK
  if(m=s.match(/^(\d{1,2})[-/ ]+([a-z]{3})[a-z]*\.?[-/ ,]*\d{0,4}$/i))return MON[m[2].toLowerCase()]?okMD(MON[m[2].toLowerCase()],+m[1]):'';
  if(m=s.match(/^([a-z]{3})[a-z]*\.? +(\d{1,2})(st|nd|rd|th)?,? *\d{0,4}$/i))return MON[m[1].toLowerCase()]?okMD(MON[m[1].toLowerCase()],+m[2]):'';
  return '';
}
/* Emails and phone numbers inside any text. Dates and times are left alone. */
function scrubText(s){
  return String(s).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g,'[email removed]')
    .replace(/(?:\+|\b0)\d[\d ()-]{7,}\d/g,(x,i,all)=>(x.replace(/\D/g,'').length>=9&&!/[\d\/.:-]/.test(all[i-1]||'')&&!/^\d{1,2}[-\/]\d{1,2}[-\/]/.test(x))?'[phone removed]':x);
}
let xl=null;
const loadXL=()=>xl||(xl=new Promise((res,rej)=>{const s=document.createElement('script');s.src='vendor/xlsx-mini-0.18.5.js';s.onload=()=>res(window.XLSX);s.onerror=()=>{xl=null;rej(new Error('offline'))};document.head.appendChild(s)}));
/* A spreadsheet becomes plain text, one row per line. A row that looks like headings decides which columns to drop. */
function sheetText(wb){
  const X=window.XLSX,out=[];let dropped=0,bdays=0;
  for(const name of wb.SheetNames){const ws=wb.Sheets[name];if(!ws['!ref'])continue;
    const r=X.utils.decode_range(ws['!ref']);let drop=new Set(),dob=new Set();const lines=[];
    for(let y=r.s.r;y<=Math.min(r.e.r,r.s.r+3000);y++){
      const row=[];for(let x=r.s.c;x<=Math.min(r.e.c,r.s.c+60);x++){const c=ws[X.utils.encode_cell({r:y,c:x})];row.push(c?{v:c.v,w:c.w??String(c.v??'')}:{v:'',w:''})}
      const heads=row.map(c=>typeof c.v==='string'&&c.v.length<40?c.v:'');
      if(isHead(heads)){drop=new Set();dob=new Set();heads.forEach((h,i)=>{if(DOB.test(h))dob.add(i);else if(DROP.test(h))drop.add(i)});
        lines.push(row.map((c,i)=>drop.has(i)?'':dob.has(i)?'Birthday (MM-DD)':c.w).filter(Boolean).join(' | '));continue}
      const cells=row.map((c,i)=>{if(drop.has(i)){if(c.w)dropped++;return''}if(dob.has(i)){const b=mmdd(c.v);if(b)bdays++;return b}return scrubText(c.w)});
      if(cells.some(Boolean))lines.push(cells.join(' | ').replace(/( \| )+$/,''));
    }
    out.push(`Sheet "${name}":\n`+lines.join('\n'));
  }
  return{text:out.join('\n\n').slice(0,400000),dropped,bdays};
}
const b64=buf=>{const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)};
async function shrinkImage(f){
  const img=await createImageBitmap(f);const k=Math.min(1,2000/Math.max(img.width,img.height));
  const c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.85));return b64(await blob.arrayBuffer());
}
async function prepare(f){
  const n=f.name.toLowerCase();
  if(f.type==='application/pdf'||n.endsWith('.pdf'))return{name:f.name,kind:'pdf',data:b64(await f.arrayBuffer()),how:'PDF: sent as is'};
  if(f.type.startsWith('image/'))return{name:f.name,kind:'image',media_type:'image/jpeg',data:await shrinkImage(f),how:'Photo: resized'};
  if(/\.(xlsx|xlsm|csv)$/.test(n)){const X=await loadXL();
    const wb=n.endsWith('.csv')?X.read(await f.text(),{type:'string',raw:true}):X.read(await f.arrayBuffer(),{type:'array'});
    const r=sheetText(wb);return{name:f.name,kind:'text',text:r.text,how:`Spreadsheet: ${r.dropped?r.dropped+' private details removed':'checked'}${r.bdays?', '+r.bdays+' birthdays kept as day and month':''}`}}
  if(/\.(txt|eml|md)$/.test(n)||f.type.startsWith('text/'))return{name:f.name,kind:'text',text:scrubText(await f.text()).slice(0,400000),how:'Text: emails and phone numbers removed'};
  throw new Error('type');
}

/* ---------- draft to Guidewise tour ---------- */
const bd=g=>/^\d{2}-\d{2}$/.test(g.bday||'')?g.bday:mmdd(g.bday); // never keep a year
const hm=t=>/^\d{1,2}:\d{2}$/.test(String(t||'').trim())?toMin(t):null;
const isoOk=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&!isNaN(new Date(s+'T12:00'));
const nextIso=s=>{const d=new Date((s||new Date().toISOString().slice(0,10))+'T12:00');d.setDate(d.getDate()+1);return d.toISOString().slice(0,10)};
/* The AI gives clock times; Guidewise plans in drive and stay minutes, so convert. Missing times get a sensible guess. */
function convDay(d,prev){
  const stops=d.stops||[];const times=stops.map(s=>hm(s.arrive)??hm(s.leave)).filter(x=>x!=null);
  let start=hm(d.start);if(start==null)start=times.length?Math.max(0,times[0]-30):480;else if(times.length&&times[0]<start)start=times[0]; // e.g. breakfast before departure
  let cur=start;const out=stops.map((s,i)=>{
    let a=hm(s.arrive),l=hm(s.leave);const last=i===stops.length-1;
    const nextA=stops.slice(i+1).map(x=>hm(x.arrive)).find(x=>x!=null);
    if(a==null)a=l!=null?Math.max(cur,l-60):cur+15;
    if(a<cur)a=cur;
    if(l==null||l<a)l=last?a:(nextA!=null&&nextA>=a?Math.min(a+60,nextA):a+60);
    const dr=a-cur;cur=l;
    return{place:String(s.place||'Stop'),drive:dr,stay:l-a,note:(s.check?'⚠ Check: ':'')+String(s.note||''),lunch:!!s.lunch};
  });
  return{date:isoOk(d.date)?d.date:nextIso(prev),title:String(d.title||'Day'),meet:String(d.meet||''),start:fmt(start),weather:'',dress:'',bring:'',
    stops:out,checklist:(d.checklist||[]).filter(Boolean).map(t=>({t:String(t),d:false}))};
}
function apply(){
  const today=new Date().toISOString().slice(0,10);let prev=null;
  const days=(draft.days||[]).map(d=>{const x=convDay(d,prev);prev=x.date;return x});
  const guests=(draft.guests||[]).map(g=>({name:String(g.name||''),room:String(g.room||''),diet:String(g.diet||''),bday:bd(g),notes:(g.check?'⚠ Check: ':'')+String(g.notes||'')}));
  const intel=[...(draft.warnings||[]).map(w=>({t:'Import note: '+w,d:today})),...(draft.days||[]).map((d,i)=>d.notes?{t:`Day ${i+1}${days[i]?' ('+dLabel(days[i].date)+')':''}: ${d.notes}`,d:today}:null).filter(Boolean)];
  if(mode==='add'){
    const have=new Set(S.guests.map(g=>g.name.trim().toLowerCase()));
    S.days.push(...days);S.guests.push(...guests.filter(g=>!have.has(g.name.trim().toLowerCase())));S.intel.unshift(...intel);
    save();reset();tab='plan';render();toast(days.length+' days and '+guests.length+' guests added');return}
  const t={id:uid(),tour:($('#ik-name')?.value||draft.tour||'Imported tour').trim(),day:0,days:days.length?days:[{...convDay({stops:[]},null)}],guests,intel};
  T.tours.push(t);reset();openTour(t.id);toast('Tour created. Check the ⚠ items');
}
function reset(){files=[];draft=null;st='pick';err='';agreed=false;mine=[]}

/* ---------- server ---------- */
const ERR={plus_required:'AI import is part of Guidewise Plus. Your trial or subscription has ended.',limit:`You have used your ${LIMIT} imports for this month. They reset on the 1st.`,
  too_large:'These files are too big together. Try fewer, or a smaller PDF.',too_many_files:`Up to ${MAX_FILES} files at a time.`,declined:'The AI could not read these documents. Try a different file.',
  too_long:'This tour is too long to read in one go. Import a part of the itinerary at a time.',unauthorised:'Please sign in again under Back up.',consent:'Please tick the box to agree first.'};
async function send(){
  st='busy';err='';t0=Date.now();paintImp();clearInterval(tick);tick=setInterval(()=>{const el=$('#ik-sec');if(el)el.textContent=Math.round((Date.now()-t0)/1000)+'s'},1000);
  try{
    const{data}=await sb.auth.getSession();const tok=data.session?.access_token;if(!tok)throw{code:'unauthorised'};
    const ac=new AbortController(),to=setTimeout(()=>ac.abort(),170000);
    const r=await fetch(SB_URL+'/functions/v1/ai-import',{method:'POST',signal:ac.signal,headers:{Authorization:'Bearer '+tok,apikey:SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({consent:AI_CONSENT,files:mine.map(({how,doc,...f})=>f)})});clearTimeout(to);
    const b=await r.json().catch(()=>({}));
    if(!r.ok||!b.draft)throw{code:b.error||'x'};
    draft=b.draft;mode=S.tour.includes('(sample)')?'new':mode;st='review';
  }catch(e){st='pick';err=ERR[e.code]||(e.name==='AbortError'?'This took too long. Try fewer documents at a time.':!navigator.onLine?'No signal. AI import needs the internet.':'Something went wrong reading the documents. Please try again.')}
  clearInterval(tick);if(tab==='import'){paintImp();scrollTo(0,0)}else toast(st==='review'?'Import ready: Tours, then Import':'Import did not work: Tours, then Import');
}

/* ---------- screens ---------- */
const ready=()=>!!(typeof user!=='undefined'&&user);
function gate(){
  if(!navigator.onLine)return`<div class="alert">AI import needs a signal. Your tours and documents still work offline.</div>`;
  if(!sb||!loaded)return(err?`<div class="alert">${esc(err)}</div>`:'')+`<p class="note">Loading…</p>`;
  if(!ready())return`<div class="alert">AI import is part of <b>Guidewise Plus</b>, with 30 days free for new accounts. Sign in first.</div><div class="acts"><button class="btn pri" data-tab="acct">Sign in under Back up</button></div>`;
  if(!plus())return`<div class="alert">AI import is part of <b>Guidewise Plus</b>. Your trial or subscription has ended.</div><div class="acts"><button class="btn pri" data-tab="acct">See plans</button></div>`;
  return'';
}
function pickHTML(){
  const g=gate();if(g)return g;
  const list=mine.length?`<div class="card">${mine.map((f,i)=>`<div style="display:flex;gap:8px;align-items:center"><div style="flex:1;min-width:0"><b>${esc(f.name)}</b><br><span class="note">${esc(f.how)}</span></div><button class="x" data-ik="rm" data-i="${i}" aria-label="Remove file">×</button></div>`).join('')}</div>`:'';
  return`${err?`<div class="alert">${esc(err)}</div>`:''}
  <p>Add the tour's itinerary, rooming list, recap or confirmations. Guidewise reads them and builds a draft tour for you to check.</p>
  <div class="acts"><button class="btn${mine.length?'':' pri'}" data-ik="pick">${mine.length?'+ Add another file':'Choose documents'}</button></div>
  <input type="file" id="ik-file" multiple hidden accept="application/pdf,image/*,.xlsx,.xlsm,.csv,.txt,.eml">
  <p class="note">PDF, Excel (.xlsx), CSV, text or photos. Up to ${MAX_FILES} files. Older .xls or Word files: save as PDF first.</p>
  <div id="ik-saved"></div>
  ${list}
  <div class="card" style="background:var(--soft)"><b>Before you send</b>
    <span class="note">On your phone, spreadsheets lose passport, visa, flight, phone, email and address columns, and dates of birth become day and month only. PDFs and photos go as they are; the AI is told never to copy those details.</span>
    <span class="note">The files go through our server to <b>Anthropic</b> (USA), the AI provider, to be read. We do not keep them. Anthropic does not train on them and deletes them within 30 days. <a href="privacy.html#ai">More</a></span>
    <label style="display:flex;gap:10px;align-items:flex-start"><input type="checkbox" id="ik-ok" ${agreed?'checked':''} style="width:22px;height:22px;flex:none;margin-top:2px"><span>I am allowed to share these documents for this purpose (check your operator's policy), and I agree to them being sent to Anthropic in the USA to be read.</span></label>
    <div class="acts"><button class="btn pri" data-ik="go" ${agreed&&mine.length?'':'disabled'}>Read my documents</button></div>${mine.length?'':'<span class="note">Add at least one document above first.</span>'}${mine.length&&!agreed?'<span class="note">Tick the box to continue.</span>':''}</div>
  <p class="note">${LIMIT} imports a month are included in Plus. Each one usually takes about a minute.</p>`;
}
function busyHTML(){return`<div class="card" style="text-align:center;padding:28px 14px"><b>Reading your documents…</b><span class="note">Usually about a minute. Keep Guidewise open. <span id="ik-sec">0s</span></span></div>`}
function reviewHTML(){
  const d=draft,chk=x=>x?' <span class="flag">⚠ check</span>':'';
  const days=(d.days||[]).map((x,i)=>`<details class="card"${i===0?' open':''}><summary><b>Day ${i+1}${x.date?' · '+esc(dLabel(x.date)):''}</b> ${esc(x.title)}${chk((x.stops||[]).some(s=>s.check))}</summary>
    ${x.start?`<span class="note">Depart ${esc(x.start)}${x.meet?' from '+esc(x.meet):''}</span>`:''}
    ${(x.stops||[]).map(s=>`<div><b>${esc(s.arrive||'··:··')}</b> ${esc(s.place)}${s.lunch?' 🍽':''}${chk(s.check)}${s.note?`<br><span class="note">${esc(s.note)}</span>`:''}</div>`).join('')||'<span class="note">No stops found.</span>'}
    ${(x.checklist||[]).length?`<span class="note">Checklist: ${x.checklist.map(esc).join(' · ')}</span>`:''}</details>`).join('');
  const guests=(d.guests||[]).map(g=>`<div><b>${esc(g.name)}</b>${chk(g.check)}<br><span class="note">${[g.room&&'Room: '+g.room,g.diet&&'Diet: '+g.diet,bd(g)&&'Birthday: '+bd(g),g.notes].filter(Boolean).map(esc).join(' · ')||'No details'}</span></div>`).join('');
  return`<p>Here is what Guidewise found. Check the <span class="flag">⚠ check</span> items against your documents after creating the tour; they are marked in the plan too.</p>
  ${(d.warnings||[]).length?`<div class="alert"><b>Worth checking</b><br>${d.warnings.map(esc).join('<br>')}</div>`:''}
  <div class="field"><span class="lbl">Tour name</span><input id="ik-name" value="${esc(d.tour||'Imported tour')}"></div>
  <h2>${(d.days||[]).length} days</h2>${days||'<p class="note">No days found.</p>'}
  <h2>${(d.guests||[]).length} guests</h2>${guests?`<div class="card">${guests}</div>`:'<p class="note">No guests found.</p>'}
  <h2>Where to put it</h2>
  <div class="seg"><button class="${mode==='new'?'on':''}" data-ik="mode" data-m="new">New tour</button><button class="${mode==='add'?'on':''}" data-ik="mode" data-m="add">Add to ${esc(S.tour.slice(0,28))}</button></div>
  <div class="acts" style="margin-top:12px"><button class="btn pri" data-ik="apply">${mode==='add'?'Add to this tour':'Create tour'}</button><button class="btn" data-ik="discard">Discard</button></div>
  <p class="note">Times are turned into drive and stay minutes. Where a time was missing Guidewise guessed, so glance over each day.</p>`;
}
window.renderImport=()=>`<h2>Import from documents</h2><div id="imp">${st==='busy'?busyHTML():st==='review'?reviewHTML():pickHTML()}</div>`;
function paintImp(){const el=$('#imp');if(el&&tab==='import'){el.outerHTML=renderImport().replace(/^<h2>[^<]*<\/h2>/,'');fillSaved()}}
/* Documents already saved under Docs for this tour can be imported without picking them again. */
const usable=f=>/\.(pdf|xlsx|xlsm|csv|txt|eml)$/i.test(f.name)||/^image\//.test(f.type);
async function fillSaved(){const box=$('#ik-saved');if(!box)return;
  let all=[];try{all=(await dbAll()).filter(f=>docMine(f)&&usable(f))}catch(e){return}
  const left=all.filter(f=>!mine.some(m=>m.doc===f.id));if(!left.length){box.innerHTML='';return}
  box.innerHTML=`<p class="note" style="margin-top:14px"><b>Or use documents saved in this tour</b></p><div class="acts">${left.map(f=>`<button class="btn sm" data-ik="usedoc" data-id="${f.id}">+ ${esc(f.name)}</button>`).join('')}</div>`}
window.fillImport=()=>{fillSaved();if(sb&&loaded||fillImport._p)return;
  fillImport._p=loadSB().then(()=>sb.auth.getSession()).then(async({data})=>{user=data.session?.user||null;await refresh()})
    .catch(()=>{err='AI import needs a signal.'}).finally(()=>{fillImport._p=null;paintImp()})};

document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-ik]');if(!b)return;const a=b.dataset.ik;
  if(a==='pick'){$('#ik-file').click();return}
  if(a==='rm'){mine.splice(+b.dataset.i,1);paintImp();return}
  if(a==='usedoc'){const r=await dbGet(+b.dataset.id);if(!r)return;err='';
    if(mine.length>=MAX_FILES){err=ERR.too_many_files;return paintImp()}
    try{const p=await prepare(new File([r.blob],r.name,{type:r.type}));p.doc=r.id;mine.push(p)}catch(x){err=x.message==='offline'?'Reading spreadsheets needs a signal the first time.':`Could not read ${r.name}.`}
    return paintImp()}
  if(a==='go'){if(!mine.length)return;if(!agreed){err=ERR.consent;return paintImp()}return send()}
  if(a==='mode'){mode=b.dataset.m;return paintImp()}
  if(a==='discard'){reset();tab='home';render();return}
  if(a==='apply')return apply();
});
document.addEventListener('change',async e=>{
  if(e.target.id==='ik-ok'){agreed=e.target.checked;paintImp();return}
  if(e.target.id!=='ik-file')return;const picked=[...e.target.files];e.target.value='';err='';
  for(const f of picked){
    if(mine.length>=MAX_FILES){err=ERR.too_many_files;break}
    try{mine.push(await prepare(f))}catch(x){err=x.message==='offline'?'Reading spreadsheets needs a signal the first time.':`Could not read ${f.name}. Use PDF, Excel (.xlsx), CSV, text or a photo.`}
  }
  const size=mine.reduce((n,f)=>n+(f.data?f.data.length*.75:f.text.length),0);
  if(size>MAX_BYTES){mine.pop();err=ERR.too_large}
  paintImp();
});
})();
