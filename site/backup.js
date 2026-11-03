/* Guidewise cloud backup.
   Order of events: sign in (email code) -> POPIA consent -> backup passphrase -> encrypted backup.
   Nothing about the tour leaves the phone before consent. The server only stores AES-256-GCM
   ciphertext; the key is derived from the passphrase on this device and never uploaded.
   Shares globals with index.html: S, KEY, save, render, tab, toast, esc, $, dLabel. */
const SB_URL='https://bqevxxhdtzlywjoqbogt.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxZXZ4eGhkdHpseXdqb3Fib2d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2OTczMjksImV4cCI6MjEwOTI3MzMyOX0.ih_90aBSe0XLXbs_6JduPTtHQbNLdTL-mHjk4EdlJBQ';
const CONSENT='popia-v1', ITER=600000, SYNC_KEY='guidewise.sync', AUTO_MS=15000;

let sync=(()=>{try{return JSON.parse(localStorage.getItem(SYNC_KEY))||{}}catch(e){return{}}})();
const saveSync=()=>{try{localStorage.setItem(SYNC_KEY,JSON.stringify(sync))}catch(e){}};
if(sync.auto===undefined)sync.auto=true;

let sb=null,sbLoad=null,user=null,consented=false,bk=null,meta=null,loaded=false;
let step='email',email='',busy='',msg='',restoreOffer=false,lastJSON=null,autoT=null,quiet=false;

/* ---------- Supabase client, loaded only when needed ---------- */
function loadSB(){
  if(sbLoad)return sbLoad;
  sbLoad=new Promise((res,rej)=>{
    const s=document.createElement('script');s.src='vendor/supabase-2.45.4.js';
    s.onload=()=>{sb=window.supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:'guidewise.auth'}});
      sb.auth.onAuthStateChange((ev,ses)=>{const u=ses?.user||null;if((u&&u.id)!==(user&&user.id)){user=u;refresh()}});
      res(sb)};
    s.onerror=()=>{sbLoad=null;rej(new Error('offline'))};
    document.head.appendChild(s);
  });
  return sbLoad;
}

/* ---------- key storage: non-extractable CryptoKey kept in IndexedDB ---------- */
const KDB=new Promise((res,rej)=>{try{const r=indexedDB.open('guidewise-keys',1);r.onupgradeneeded=()=>r.result.createObjectStore('k');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}catch(e){rej(e)}});
const kOp=(mode,fn)=>KDB.then(db=>new Promise((res,rej)=>{const t=db.transaction('k',mode),r=fn(t.objectStore('k'));t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error)}));
const kGet=id=>kOp('readonly',s=>s.get(id)),kPut=(id,v)=>kOp('readwrite',s=>s.put(v,id)),kDel=id=>kOp('readwrite',s=>s.delete(id));

/* ---------- crypto ---------- */
const enc=s=>new TextEncoder().encode(s);
const b64=u=>{let s='';for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return btoa(s)};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function deriveKey(pass,salt,iter){
  const base=await crypto.subtle.importKey('raw',enc(pass.normalize('NFKC')),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function seal(key,obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc(user.id)},key,enc(JSON.stringify(obj)));
  return{iv:b64(iv),ciphertext:b64(new Uint8Array(ct))};
}
async function unseal(key,row){
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(row.iv),additionalData:enc(user.id)},key,unb64(row.ciphertext));
  const o=JSON.parse(new TextDecoder().decode(pt));
  if(o.app!=='guidewise'||!o.S||!Array.isArray(o.S.days))throw new Error('format');
  return o;
}

/* ---------- server calls ---------- */
const getMeta=async()=>{const{data,error}=await sb.from('backups').select('rev,updated_at,salt,kdf_iter').maybeSingle();if(error)throw error;return data};
const getFull=async()=>{const{data,error}=await sb.from('backups').select('*').maybeSingle();if(error)throw error;return data};

async function refresh(){
  loaded=false;paint();
  if(!user){consented=false;bk=null;meta=null;loaded=true;paint();return}
  sync.acct=1;saveSync();
  try{
    const c=await sb.from('consents').select('id').eq('version',CONSENT).limit(1);if(c.error)throw c.error;
    consented=c.data.length>0;
    meta=await getMeta();
    bk=(await kGet(user.id))||null;
    if(bk&&meta&&bk.salt!==meta.salt)bk=null; // backup was replaced elsewhere with a new passphrase
    if(meta&&sync.rev&&meta.rev>sync.rev)sync.conflict=meta.rev;
    step=consented?(bk?'ready':'pass'):'consent';
  }catch(e){msg='Could not reach the backup service. Check your signal and try again.'}
  loaded=true;paint();
  if(ready()&&sync.pending)backupNow();
}
const ready=()=>!!(user&&consented&&bk);

/* ---------- backup and restore ---------- */
async function backupNow(force){
  if(!ready()||busy)return;
  if(!navigator.onLine){sync.pending=1;saveSync();paint();return}
  busy='Backing up…';msg='';paint();
  try{
    const m=await getMeta();
    if(m&&m.rev>(sync.rev||0)&&!force){sync.conflict=m.rev;saveSync();throw new Error('conflict')}
    const snap=JSON.stringify(S);
    const{iv,ciphertext}=await seal(bk.key,{app:'guidewise',v:1,at:new Date().toISOString(),S:JSON.parse(snap)});
    const row={iv,ciphertext,salt:bk.salt,kdf_iter:ITER,format:1,rev:(m?.rev||0)+1};
    const q=m?sb.from('backups').update(row).eq('user_id',user.id).eq('rev',m.rev):sb.from('backups').insert(row);
    const{data,error}=await q.select('rev,updated_at');
    if(error)throw error;
    if(!data||!data.length){sync.conflict=1;throw new Error('conflict')}
    Object.assign(sync,{rev:data[0].rev,at:data[0].updated_at,pending:0,conflict:0});lastJSON=snap;meta={...m,...data[0],salt:bk.salt};
  }catch(e){
    if(e.message!=='conflict'){sync.pending=1;msg=navigator.onLine?'Backup failed. It will retry automatically.':'No signal. Backup will run when you are back online.'}
  }
  saveSync();busy='';paint();
}
async function restoreNow(){
  busy='Restoring…';msg='';paint();
  try{
    const row=await getFull();if(!row)throw new Error('none');
    const o=await unseal(bk.key,row);
    try{localStorage.setItem(KEY+'.beforeRestore',JSON.stringify(S))}catch(e){}
    quiet=true;S=o.S;save();quiet=false;lastJSON=JSON.stringify(S);
    Object.assign(sync,{rev:row.rev,at:row.updated_at,pending:0,conflict:0});saveSync();
    restoreOffer=false;busy='';render();toast('Tour restored from backup');return;
  }catch(e){msg=e.message==='none'?'There is no cloud backup yet.':'Could not restore. Check your signal and try again.'}
  busy='';paint();
}

/* Called by save() in index.html after every local change. */
window.onSaved=function(){
  if(quiet||!ready()||!sync.auto)return;
  const j=JSON.stringify(S);if(j===lastJSON)return;
  sync.pending=1;saveSync();paintBtn();
  clearTimeout(autoT);autoT=setTimeout(()=>{autoT=null;backupNow()},AUTO_MS);
};
addEventListener('online',()=>{if(ready()&&sync.pending)backupNow()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&autoT){clearTimeout(autoT);autoT=null;backupNow()}});

/* ---------- UI ---------- */
const when=iso=>{if(!iso)return'';const d=new Date(iso);return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+', '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})};
function status(){
  if(!user)return['Back up','off'];
  if(!ready())return['Finish setup','warn'];
  if(sync.conflict)return['Check backup','warn'];
  if(busy)return['Backing up','busy'];
  if(sync.pending)return[sync.auto?'Waiting':'Not backed up',sync.auto?'busy':'warn'];
  return sync.at?['Backed up','ok']:['Back up','warn'];
}
function paintBtn(){const b=$('#acctBtn');if(!b)return;const[t,c]=status();b.className='acct '+c;b.querySelector('span').textContent=t}
function paint(){paintBtn();const el=$('#acct');if(el)el.innerHTML=acctHTML()}

window.renderAcct=()=>`<h2>Backup</h2><div id="acct">${acctHTML()}</div>`;
window.fillAcct=()=>{if(!sb)loadSB().then(()=>{if(!user)sb.auth.getSession().then(({data})=>{user=data.session?.user||null;refresh()})}).catch(()=>{msg='Backup needs a signal the first time. Try again when you are online.';loaded=true;paint()});else paint()};

function acctHTML(){
  if(!sb||!loaded)return `<p class="note">${esc(msg)||'Loading…'}</p>`;
  const m=msg?`<div class="alert">${esc(msg)}</div>`:'',bz=busy?`<p class="note"><b>${esc(busy)}</b></p>`:'';
  if(!user){
    if(step==='code')return m+`<p>We sent a code to <b>${esc(email)}</b>. Enter it below, or tap the link in the email on this device.</p>
      <div class="field"><span class="lbl">6-digit code</span><input id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></div>
      <div class="acts"><button class="btn pri" data-a="verify">Sign in</button><button class="btn" data-a="restart">Use another email</button></div>${bz}`;
    return m+`<p>Back up your tour so a lost or broken phone does not cost you your planning. It is off until you switch it on.</p>
      <div class="field"><span class="lbl">Your email</span><input id="a-email" type="email" autocomplete="email" value="${esc(email)}"></div>
      <div class="acts"><button class="btn pri" data-a="send">Email me a sign-in code</button></div>
      <p class="note">Signing in sends only your email address. Your tour and guest details stay on this device until you agree to the terms on the next screen.</p>${bz}`;
  }
  if(!consented)return m+`<h2>Before anything leaves this device</h2>
    <p class="note">Your backup includes guest details. Dietary needs and health notes are special personal information under POPIA, so we need your clear agreement. <a href="privacy.html" target="_blank" rel="noopener">Privacy notice</a></p>
    <label class="opt"><input type="checkbox" class="a-ok"><span>My guests know I keep their details to run the tour, and have agreed to dietary and health notes being recorded.</span></label>
    <label class="opt"><input type="checkbox" class="a-ok"><span>I agree to an encrypted backup being stored with Supabase in London, UK, outside South Africa.</span></label>
    <label class="opt"><input type="checkbox" class="a-ok"><span>I understand Guidewise cannot read or recover my backup. If I forget my passphrase, the cloud copy is lost.</span></label>
    <div class="acts"><button class="btn pri" data-a="consent" id="a-consent" disabled>I agree, continue</button><button class="btn" data-a="signout">Not now, sign out</button></div>${bz}`;
  if(!bk){
    if(meta)return m+`<p>You already have a cloud backup${meta.updated_at?' from '+esc(when(meta.updated_at)):''}. Enter your backup passphrase to unlock it on this device.</p>
      <div class="field"><span class="lbl">Backup passphrase</span><input id="a-p1" type="password" autocomplete="current-password"></div>
      <div class="acts"><button class="btn pri" data-a="unlock">Unlock</button></div>
      <p class="note">Forgotten it? <button class="btn sm" data-a="replace">Start a new backup</button> This permanently deletes the old cloud copy.</p>${bz}`;
    return m+`<p>Create a backup passphrase. Your tour is encrypted with it on this device before upload, so nobody else can read it, including us.</p>
      <div class="field"><span class="lbl">Passphrase (10+ characters)</span><input id="a-p1" type="password" autocomplete="new-password"></div>
      <div class="field" style="margin-top:8px"><span class="lbl">Type it again</span><input id="a-p2" type="password" autocomplete="new-password"></div>
      <p class="note">Tip: three or four random words. Write it down somewhere safe, not in this app. It cannot be reset.</p>
      <div class="acts"><button class="btn pri" data-a="create">Encrypt and back up</button></div>${bz}`;
  }
  let h=m;
  if(restoreOffer)h+=`<div class="alert"><b>Cloud backup unlocked.</b> Restore it to this device? This replaces the tour on this device.<div class="acts"><button class="btn pri" data-a="restore1">Restore backup</button><button class="btn" data-a="keep">Keep this device's tour</button></div></div>`;
  if(sync.conflict)h+=`<div class="alert"><b>The cloud has a newer backup, probably from another device.</b> Restore it here, or replace it with this device's tour.<div class="acts"><button class="btn pri" data-a="restore1">Restore cloud backup</button><button class="btn" data-a="force">Replace with this device</button></div></div>`;
  const last=sync.at?'Last backup: '+when(sync.at):'Not backed up yet';
  h+=`<p><b>${esc(last)}</b>${sync.pending&&!busy?`<br><span class="note">${navigator.onLine?'Changes waiting to back up.':'No signal. Will back up when you are online.'}</span>`:''}</p>
    <label class="opt"><input type="checkbox" id="a-auto" ${sync.auto?'checked':''}><span>Back up automatically after changes</span></label>
    <div class="acts"><button class="btn pri" data-a="now">Back up now</button><button class="btn" data-a="restore" data-arm="Tap again to replace this device's tour">Restore from cloud</button></div>${bz}
    <p class="note">Encrypted on this device before upload. Documents stay on this device only for now.</p>
    <h2>Account</h2><p class="note">Signed in as ${esc(user.email)}</p>
    <div class="acts"><button class="btn" data-a="signout">Sign out</button><button class="btn" data-a="delbk" data-arm="Tap again to delete">Delete cloud backup</button><button class="btn" data-a="delacct" data-arm="Tap again: deletes everything" style="color:var(--alert)">Delete account</button></div>
    <p class="note">Signing out or deleting keeps the tour on this device.</p>`;
  return h;
}

document.addEventListener('change',e=>{
  if(e.target.classList.contains('a-ok')){const all=[...document.querySelectorAll('.a-ok')];$('#a-consent').disabled=!all.every(x=>x.checked)}
  if(e.target.id==='a-auto'){sync.auto=e.target.checked;saveSync();if(sync.auto&&sync.pending)backupNow();paintBtn()}
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-a]');if(!b||busy)return;
  if(b.dataset.arm&&!b.classList.contains('arm')){const t=b.textContent;b.classList.add('arm');b.textContent=b.dataset.arm;setTimeout(()=>{b.classList.remove('arm');b.textContent=t},3500);return}
  const a=b.dataset.a,val=id=>($(id)||{}).value||'';msg='';
  try{
    if(a==='send'){email=val('#a-email').trim();if(!/^\S+@\S+\.\S+$/.test(email)){msg='Enter a valid email address.';return paint()}
      busy='Sending…';paint();const{error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});
      busy='';if(error){msg=/rate|seconds/i.test(error.message)?'Too many attempts. Wait a minute, then try again.':'Could not send the email. Check your signal and try again.';return paint()}
      step='code';return paint()}
    if(a==='restart'){step='email';return paint()}
    if(a==='verify'){const token=val('#a-code').replace(/\s/g,'');busy='Checking…';paint();
      const{error}=await sb.auth.verifyOtp({email,token,type:'email'});busy='';if(error){msg='That code did not work. Check it, or request a new one.';return paint()}return}
    if(a==='consent'){busy='Saving…';paint();const{error}=await sb.from('consents').insert({version:CONSENT});busy='';if(error)throw error;consented=true;return paint()}
    if(a==='create'){const p1=val('#a-p1'),p2=val('#a-p2');
      if(p1.length<10){msg='Use at least 10 characters.';return paint()}if(p1!==p2){msg='The two passphrases do not match.';return paint()}
      busy='Encrypting…';paint();const salt=crypto.getRandomValues(new Uint8Array(16));const key=await deriveKey(p1,salt,ITER);
      bk={key,salt:b64(salt)};await kPut(user.id,bk);busy='';sync.rev=0;sync.at=null;saveSync();await backupNow();toast('Backup is on');return}
    if(a==='unlock'){const p=val('#a-p1');busy='Unlocking…';paint();
      const row=await getFull();if(!row){busy='';meta=null;return paint()}
      const key=await deriveKey(p,unb64(row.salt),row.kdf_iter);
      try{await unseal(key,row)}catch(x){busy='';msg='That passphrase does not match this backup.';return paint()}
      bk={key,salt:row.salt};await kPut(user.id,bk);meta=row;busy='';restoreOffer=true;return paint()}
    if(a==='replace'){busy='Deleting old backup…';paint();const{error}=await sb.from('backups').delete().eq('user_id',user.id);busy='';if(error)throw error;meta=null;sync.rev=0;sync.at=null;saveSync();return paint()}
    if(a==='keep'){restoreOffer=false;sync.rev=meta?.rev||0;sync.conflict=0;saveSync();return backupNow()}
    if(a==='restore'||a==='restore1')return restoreNow();
    if(a==='force'){sync.conflict=0;return backupNow(true)}
    if(a==='now')return backupNow();
    if(a==='delbk'){busy='Deleting…';paint();const{error}=await sb.from('backups').delete().eq('user_id',user.id);busy='';if(error)throw error;
      meta=null;Object.assign(sync,{rev:0,at:null,pending:0,auto:false});saveSync();toast('Cloud backup deleted. Automatic backup is off');return paint()}
    if(a==='delacct'){busy='Deleting account…';paint();const{error}=await sb.functions.invoke('delete-account',{method:'POST'});if(error){busy='';throw error}
      await kDel(user.id).catch(()=>{});await sb.auth.signOut({scope:'local'});sync={auto:true};saveSync();busy='';step='email';toast('Account and cloud data deleted');return}
    if(a==='signout'){const id=user.id;busy='Signing out…';paint();await sb.auth.signOut({scope:'local'});await kDel(id).catch(()=>{});sync={auto:true};saveSync();busy='';step='email';return paint()}
  }catch(x){busy='';msg='Something went wrong. Check your signal and try again.';paint()}
});

/* Start quietly: only load the backup service for guides who use it, or when returning from an email link. */
const fromLink=/access_token|error_description|[?&]code=/.test(location.hash+location.search);
if(sync.acct||fromLink)addEventListener('load',()=>{loadSB().then(()=>sb.auth.getSession()).then(({data})=>{user=data.session?.user||null;refresh();
  if(fromLink){history.replaceState(null,'',location.pathname);tab='acct';render()}}).catch(()=>{})});
paintBtn();
