/* Guidewise cloud backup.
   Order of events: sign in (email code) -> POPIA consent -> backup passphrase -> encrypted backup.
   Nothing about the tour leaves the phone before consent. The server only stores AES-256-GCM
   ciphertext. Format 2: a random data key encrypts the tour; that key is stored twice, wrapped
   by the passphrase and by a one-time recovery code. No key ever leaves the device unwrapped.
   Shares globals with index.html: S, KEY, save, render, tab, toast, esc, $, dLabel. */
const SB_URL='https://bqevxxhdtzlywjoqbogt.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxZXZ4eGhkdHpseXdqb3Fib2d0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2OTczMjksImV4cCI6MjEwOTI3MzMyOX0.ih_90aBSe0XLXbs_6JduPTtHQbNLdTL-mHjk4EdlJBQ';
const CONSENT='popia-v2', ITER=600000, REC_ITER=100000, MIN_PASS=8, SYNC_KEY='guidewise.sync', AUTO_MS=15000;

let sync=(()=>{try{return JSON.parse(localStorage.getItem(SYNC_KEY))||{}}catch(e){return{}}})();
const saveSync=()=>{try{localStorage.setItem(SYNC_KEY,JSON.stringify(sync))}catch(e){}};
if(sync.auto===undefined)sync.auto=true;

let sb=null,sbLoad=null,user=null,consented=false,bk=null,meta=null,loaded=false;
let step='email',email='',busy='',msg='',restoreOffer=false,lastJSON=null,autoT=null,quiet=false,changing=false,suggest='',recMode=false,recShow='',newRec=false;

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
/* Key wrapping: kek = key-encrypting key derived from the passphrase or recovery code. */
const kekFrom=(secret,salt,iter)=>deriveKey(secret,salt,iter);
async function wrap(raw,kek){const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc('dek:'+user.id)},kek,raw);return b64(iv)+'.'+b64(new Uint8Array(ct))}
async function unwrap(w,kek){const[i,c]=w.split('.');return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(i),additionalData:enc('dek:'+user.id)},kek,unb64(c)))}
const importDEK=raw=>crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
const REC_AB='ABCDEFGHJKMNPQRSTVWXYZ23456789';
function newRecoveryCode(){const r=crypto.getRandomValues(new Uint8Array(20));let c='';for(const x of r)c+=REC_AB[x%30];return c.match(/.{4}/g).join('-')}
const normRec=c=>c.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
async function passWrap(raw,pass){const salt=crypto.getRandomValues(new Uint8Array(16));return{pass_salt:b64(salt),pass_wrap:await wrap(raw,await kekFrom(pass,salt,ITER))}}
async function recWrap(raw,code){const salt=crypto.getRandomValues(new Uint8Array(16));return{rec_salt:b64(salt),rec_wrap:await wrap(raw,await kekFrom(normRec(code),salt,REC_ITER))}}
const unwrapPass=async(row,pass)=>unwrap(row.pass_wrap,await kekFrom(pass,unb64(row.pass_salt),row.kdf_iter||ITER));
const unwrapRec=async(row,code)=>unwrap(row.rec_wrap,await kekFrom(normRec(code),unb64(row.rec_salt),REC_ITER));
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
const getMeta=async()=>{const{data,error}=await sb.from('backups').select('rev,updated_at,format,key_id,kdf_iter,pass_salt,pass_wrap').maybeSingle();if(error)throw error;return data};
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
    if(bk&&!bk.kid)bk=null; // key from the first version: set up again
    if(bk&&meta&&bk.kid!==meta.key_id)bk=null; // backup was replaced elsewhere
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
    if(m&&m.key_id!==bk.kid){bk=null;throw new Error('rekeyed')}
    const row={iv,ciphertext,format:2,rev:(m?.rev||0)+1};
    if(!m)throw new Error('nobackup');
    const q=m?sb.from('backups').update(row).eq('user_id',user.id).eq('rev',m.rev):sb.from('backups').insert(row);
    const{data,error}=await q.select('rev,updated_at');
    if(error)throw error;
    if(!data||!data.length){sync.conflict=1;throw new Error('conflict')}
    Object.assign(sync,{rev:data[0].rev,at:data[0].updated_at,pending:0,conflict:0});lastJSON=snap;meta={...m,...data[0]};
  }catch(e){
    if(e.message==='rekeyed'){bk=null;msg='Your backup was reset on another device. Unlock it again below.'}
    else if(e.message==='nobackup'){meta=null;bk=null}
    else if(e.message!=='conflict'){sync.pending=1;msg=navigator.onLine?'Backup failed. It will retry automatically.':'No signal. Backup will run when you are back online.'}
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

/* Catch typos like gmail.coma or gmial.com before a code goes to a dead address. */
const DOMAINS=['gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com','hotmail.com','hotmail.co.uk','live.com','icloud.com','me.com','aol.com','protonmail.com','proton.me','mweb.co.za','telkomsa.net','vodamail.co.za','webmail.co.za','afrihost.co.za','iafrica.com','xsinet.co.za'];
function lev(a,b){const d=Array.from({length:a.length+1},(_,i)=>[i]);for(let j=1;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1)}return d[a.length][b.length]}
function emailSuggestion(e){const at=e.lastIndexOf('@');if(at<1)return'';const dom=e.slice(at+1).toLowerCase();if(DOMAINS.includes(dom))return'';
  const max=dom.length>=10?2:1;let best='',bd=max+1;for(const k of DOMAINS){const d=lev(dom,k);if(d<bd){bd=d;best=k}}return best?e.slice(0,at+1)+best:''}

function acctHTML(){
  if(!sb||!loaded)return `<p class="note">${esc(msg)||'Loading…'}</p>`;
  const m=msg?`<div class="alert">${esc(msg)}</div>`:'',bz=busy?`<p class="note"><b>${esc(busy)}</b></p>`:'';
  if(!user){
    if(step==='code')return m+`<p>We sent a code to <b>${esc(email)}</b>. Enter it below, or tap the link in the email on this device.</p>
      <div class="field"><span class="lbl">6-digit code</span><input id="a-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></div>
      <div class="acts"><button class="btn pri" data-a="verify">Sign in</button><button class="btn" data-a="restart">Use another email</button></div>${bz}`;
    if(suggest)return m+`<div class="alert">Did you mean <b>${esc(suggest)}</b>?<div class="acts"><button class="btn pri" data-a="usesug">Yes, use ${esc(suggest)}</button><button class="btn" data-a="keepmail">No, send to ${esc(email)}</button></div></div>${bz}`;
    return m+`<p>Back up your tour so a lost or broken phone does not cost you your planning. It is off until you switch it on.</p>
      <div class="field"><span class="lbl">Your email</span><input id="a-email" type="email" autocomplete="email" value="${esc(email)}"></div>
      <div class="acts"><button class="btn pri" data-a="send">Email me a sign-in code</button></div>
      <p class="note">Signing in sends only your email address. Your tour and guest details stay on this device until you agree to the terms on the next screen.</p>${bz}`;
  }
  if(!consented)return m+`<h2>Before anything leaves this device</h2>
    <p class="note">Your backup includes guest details. Dietary needs and health notes are special personal information under POPIA, so we need your clear agreement. <a href="privacy.html" target="_blank" rel="noopener">Privacy notice</a></p>
    <label class="opt"><input type="checkbox" class="a-ok"><span>My guests know I keep their details to run the tour, and have agreed to dietary and health notes being recorded.</span></label>
    <label class="opt"><input type="checkbox" class="a-ok"><span>I agree to an encrypted backup being stored with Supabase in London, UK, outside South Africa.</span></label>
    <label class="opt"><input type="checkbox" class="a-ok"><span>I understand Guidewise cannot read or recover my backup. If I lose both my passphrase and my recovery code, the cloud copy is lost.</span></label>
    <div class="acts"><button class="btn pri" data-a="consent" id="a-consent" disabled>I agree, continue</button><button class="btn" data-a="signout">Not now, sign out</button></div>${bz}`;
  if(recShow)return `<h2>Your recovery code</h2>
    <p class="rec" id="a-rec">${esc(recShow)}</p>
    <p class="note">This unlocks your backup if you forget your passphrase. Screenshot it or write it down, and keep it away from this phone. It is shown only once.</p>
    <div class="acts"><button class="btn" data-a="reccopy">Copy</button><button class="btn pri" data-a="recdone">I have saved it</button></div>`;
  if(!bk){
    const fresh=!meta||meta.format!==2;
    if(!fresh&&recMode)return m+`<p>Enter your recovery code, then choose a new passphrase.</p>
      <div class="field"><span class="lbl">Recovery code</span><input id="a-rc" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"></div>
      <div class="field" style="margin-top:8px"><span class="lbl">New passphrase (${MIN_PASS}+ characters)</span><input id="a-p1" type="password" autocomplete="new-password"></div>
      <div class="field" style="margin-top:8px"><span class="lbl">Type it again</span><input id="a-p2" type="password" autocomplete="new-password"></div>
      <div class="acts"><button class="btn pri" data-a="recunlock">Unlock</button><button class="btn" data-a="recback">Back</button></div>${bz}`;
    if(!fresh)return m+`<p>Enter your backup passphrase to unlock your backup${meta.updated_at?' from '+esc(when(meta.updated_at)):''} on this device.</p>
      <div class="field"><span class="lbl">Backup passphrase</span><input id="a-p1" type="password" autocomplete="current-password"></div>
      <div class="acts"><button class="btn pri" data-a="unlock">Unlock</button><button class="btn" data-a="recmode">Use recovery code</button></div>
      <p class="note">Lost both? <button class="btn sm" data-a="replace" data-arm="Tap again: deletes the cloud copy">Start a new backup</button></p>${bz}`;
    return m+`<p>${meta?'Backups now come with a recovery code. Set your passphrase to update yours.':'Choose a backup passphrase. Your tour is locked with it before upload, so only you can open it.'}</p>
      <div class="field"><span class="lbl">Passphrase (${MIN_PASS}+ characters)</span><input id="a-p1" type="password" autocomplete="new-password"></div>
      <div class="field" style="margin-top:8px"><span class="lbl">Type it again</span><input id="a-p2" type="password" autocomplete="new-password"></div>
      <p class="note">Tip: two or three words, like <i>table mountain fog</i>. You also get a recovery code next.</p>
      <div class="acts"><button class="btn pri" data-a="create">Encrypt and back up</button></div>${bz}`;
  }
  if(newRec)return m+`<h2>New recovery code</h2><p class="note">Enter your passphrase. Your old recovery code will stop working.</p>
    <div class="field"><span class="lbl">Backup passphrase</span><input id="a-p0" type="password" autocomplete="current-password"></div>
    <div class="acts"><button class="btn pri" data-a="recnew">Create new code</button><button class="btn" data-a="recnewcancel">Cancel</button></div>${bz}`;
  if(changing)return m+`<h2>Change passphrase</h2>
    <div class="field"><span class="lbl">Current passphrase</span><input id="a-p0" type="password" autocomplete="current-password"></div>
    <div class="field" style="margin-top:8px"><span class="lbl">New passphrase (${MIN_PASS}+ characters)</span><input id="a-p1" type="password" autocomplete="new-password"></div>
    <div class="field" style="margin-top:8px"><span class="lbl">Type the new one again</span><input id="a-p2" type="password" autocomplete="new-password"></div>
    <p class="note">The old passphrase stops working. Your recovery code and your other devices keep working.</p>
    <div class="acts"><button class="btn pri" data-a="chsave">Change passphrase</button><button class="btn" data-a="chcancel">Cancel</button></div>${bz}`;
  let h=m;
  if(restoreOffer)h+=`<div class="alert"><b>Cloud backup unlocked.</b> Restore it to this device? This replaces the tour on this device.<div class="acts"><button class="btn pri" data-a="restore1">Restore backup</button><button class="btn" data-a="keep">Keep this device's tour</button></div></div>`;
  if(sync.conflict)h+=`<div class="alert"><b>The cloud has a newer backup, probably from another device.</b> Restore it here, or replace it with this device's tour.<div class="acts"><button class="btn pri" data-a="restore1">Restore cloud backup</button><button class="btn" data-a="force">Replace with this device</button></div></div>`;
  const last=sync.at?'Last backup: '+when(sync.at):'Not backed up yet';
  h+=`<p><b>${esc(last)}</b>${sync.pending&&!busy?`<br><span class="note">${navigator.onLine?'Changes waiting to back up.':'No signal. Will back up when you are online.'}</span>`:''}</p>
    <label class="opt"><input type="checkbox" id="a-auto" ${sync.auto?'checked':''}><span>Back up automatically after changes</span></label>
    <div class="acts"><button class="btn pri" data-a="now">Back up now</button><button class="btn" data-a="restore" data-arm="Tap again to replace this device's tour">Restore from cloud</button></div>${bz}
    <p class="note">Encrypted on this device before upload. Documents stay on this device only for now.</p>
    <h2>Account</h2><p class="note">Signed in as ${esc(user.email)}</p>
    <div class="acts"><button class="btn" data-a="chpass">Change passphrase</button><button class="btn" data-a="newrec">New recovery code</button><button class="btn" data-a="signout">Sign out</button><button class="btn" data-a="delbk" data-arm="Tap again to delete">Delete cloud backup</button><button class="btn" data-a="delacct" data-arm="Tap again: deletes everything" style="color:var(--alert)">Delete account</button></div>
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
      suggest=emailSuggestion(email);if(suggest)return paint()}
    if(a==='usesug'){email=suggest;suggest=''}
    if(a==='keepmail')suggest='';
    if(a==='send'||a==='usesug'||a==='keepmail'){
      busy='Sending…';paint();const{error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:location.origin+location.pathname}});
      busy='';if(error){msg=/rate|seconds/i.test(error.message)?'Too many attempts. Wait a minute, then try again.':'Could not send the email. Check your signal and try again.';return paint()}
      step='code';return paint()}
    if(a==='restart'){step='email';suggest='';return paint()}
    if(a==='verify'){const token=val('#a-code').replace(/\s/g,'');busy='Checking…';paint();
      const{error}=await sb.auth.verifyOtp({email,token,type:'email'});busy='';if(error){msg='That code did not work. Check it, or request a new one.';return paint()}return}
    if(a==='consent'){busy='Saving…';paint();const{error}=await sb.from('consents').insert({version:CONSENT});busy='';if(error)throw error;consented=true;return paint()}
    if(a==='create'){const p1=val('#a-p1'),p2=val('#a-p2');
      if(p1.length<MIN_PASS){msg=`Use at least ${MIN_PASS} characters.`;return paint()}if(p1!==p2){msg='The two passphrases do not match.';return paint()}
      if(!navigator.onLine){msg='Setting up backup needs a signal.';return paint()}
      busy='Encrypting…';paint();
      const raw=crypto.getRandomValues(new Uint8Array(32)),kid=b64(crypto.getRandomValues(new Uint8Array(12))),code=newRecoveryCode();
      const key=await importDEK(raw),wp=await passWrap(raw,p1),wr=await recWrap(raw,code);raw.fill(0);
      const snap=JSON.stringify(S);const{iv,ciphertext}=await seal(key,{app:'guidewise',v:1,at:new Date().toISOString(),S:JSON.parse(snap)});
      const m=await getMeta();
      const row={iv,ciphertext,format:2,kdf_iter:ITER,salt:null,key_id:kid,...wp,...wr,rev:(m?.rev||0)+1};
      const q=m?sb.from('backups').update(row).eq('user_id',user.id).eq('rev',m.rev):sb.from('backups').insert(row);
      const{data,error}=await q.select('rev,updated_at');if(error)throw error;
      if(!data||!data.length){busy='';msg='The backup changed on another device. Try again.';return paint()}
      bk={key,kid};await kPut(user.id,bk);Object.assign(sync,{rev:data[0].rev,at:data[0].updated_at,pending:0,conflict:0,auto:true});saveSync();lastJSON=snap;
      meta={...row,...data[0]};busy='';recShow=code;return paint()}
    if(a==='unlock'){const p=val('#a-p1');busy='Unlocking…';paint();
      const row=await getFull();if(!row){busy='';meta=null;return paint()}
      let raw;try{raw=await unwrapPass(row,p)}catch(x){busy='';msg='That passphrase does not match this backup.';return paint()}
      const key=await importDEK(raw);raw.fill(0);await unseal(key,row);
      bk={key,kid:row.key_id};await kPut(user.id,bk);meta=row;busy='';restoreOffer=true;return paint()}
    if(a==='recmode'){recMode=true;return paint()}
    if(a==='recback'){recMode=false;return paint()}
    if(a==='recunlock'){const c=val('#a-rc'),p1=val('#a-p1'),p2=val('#a-p2');
      if(p1.length<MIN_PASS){msg=`Use at least ${MIN_PASS} characters for the new passphrase.`;return paint()}if(p1!==p2){msg='The two passphrases do not match.';return paint()}
      busy='Unlocking…';paint();const row=await getFull();if(!row){busy='';meta=null;return paint()}
      let raw;try{raw=await unwrapRec(row,c)}catch(x){busy='';msg='That recovery code does not match this backup.';return paint()}
      const key=await importDEK(raw),wp=await passWrap(raw,p1);raw.fill(0);await unseal(key,row);
      const{error}=await sb.from('backups').update(wp).eq('user_id',user.id);if(error)throw error;
      bk={key,kid:row.key_id};await kPut(user.id,bk);meta={...row,...wp};recMode=false;busy='';restoreOffer=true;toast('Unlocked. New passphrase saved');return paint()}
    if(a==='reccopy'){navigator.clipboard.writeText(recShow).then(()=>toast('Recovery code copied')).catch(()=>toast('Long-press the code to copy'));return}
    if(a==='recdone'){recShow='';toast('Backup is on');return paint()}
    if(a==='newrec'){newRec=true;return paint()}
    if(a==='recnewcancel'){newRec=false;return paint()}
    if(a==='recnew'){const p=val('#a-p0');if(!navigator.onLine){msg='This needs a signal.';return paint()}
      busy='Checking…';paint();const m=await getMeta();
      let raw;try{raw=await unwrapPass(m,p)}catch(x){busy='';msg='That passphrase is not right.';return paint()}
      const code=newRecoveryCode(),wr=await recWrap(raw,code);raw.fill(0);
      const{error}=await sb.from('backups').update(wr).eq('user_id',user.id);if(error)throw error;
      newRec=false;busy='';recShow=code;return paint()}
    if(a==='replace'){busy='Deleting old backup…';paint();const{error}=await sb.from('backups').delete().eq('user_id',user.id);busy='';if(error)throw error;meta=null;bk=null;await kDel(user.id).catch(()=>{});sync.rev=0;sync.at=null;saveSync();return paint()}
    if(a==='keep'){restoreOffer=false;sync.rev=meta?.rev||0;sync.conflict=0;saveSync();return backupNow()}
    if(a==='restore'||a==='restore1')return restoreNow();
    if(a==='force'){sync.conflict=0;return backupNow(true)}
    if(a==='now')return backupNow();
    if(a==='chpass'){changing=true;return paint()}
    if(a==='chcancel'){changing=false;return paint()}
    if(a==='chsave'){const p0=val('#a-p0'),p1=val('#a-p1'),p2=val('#a-p2');
      if(p1.length<MIN_PASS){msg=`Use at least ${MIN_PASS} characters for the new passphrase.`;return paint()}
      if(p1!==p2){msg='The two new passphrases do not match.';return paint()}
      if(p1===p0){msg='The new passphrase is the same as the current one.';return paint()}
      if(!navigator.onLine){msg='Changing the passphrase needs a signal.';return paint()}
      busy='Checking…';paint();const m=await getMeta();
      let raw;try{raw=await unwrapPass(m,p0)}catch(x){busy='';msg='Your current passphrase is not right.';return paint()}
      const wp=await passWrap(raw,p1);raw.fill(0);
      const{error}=await sb.from('backups').update(wp).eq('user_id',user.id);if(error)throw error;
      meta={...meta,...wp};busy='';changing=false;toast('Passphrase changed');return paint()}
    if(a==='delbk'){busy='Deleting…';paint();const{error}=await sb.from('backups').delete().eq('user_id',user.id);busy='';if(error)throw error;
      meta=null;bk=null;await kDel(user.id).catch(()=>{});Object.assign(sync,{rev:0,at:null,pending:0,auto:false});saveSync();toast('Cloud backup deleted');return paint()}
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
