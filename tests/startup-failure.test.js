'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..');
 for(const kind of ['wallet_process_conflict','funding_ledger_unreadable']) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vault-failure-'));const data=path.join(dir,'data');fs.mkdirSync(data);
  const lock=path.join(data,'funding-worker.lock'),ledger=path.join(data,'funding.json');
  if(kind==='wallet_process_conflict')fs.writeFileSync(lock,String(process.pid));
  else fs.writeFileSync(ledger,'{broken-ledger');
  const preload=path.join(dir,'preload.cjs');fs.writeFileSync(preload,`require(${JSON.stringify(path.join(root,'tools/chain.js'))}).sponsorAddress=()=> 'test-sponsor';`);
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['--require',preload,'server.js'],{cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DATA_DIR:data,KOINOS_NETWORK:'mainnet',SPONSOR_WIF:'unused',VERIFIER_ADDR:'unused',MOD_SIGN_WEBAUTHN_ADDR:'unused',MOD_VALIDATION_SIGNATURE_ADDR:'unused'},stdio:'ignore'});
  try {
   let res;const deadline=Date.now()+3000;
   while(Date.now()<deadline){try{res=await fetch(`http://127.0.0.1:${port}/api/health`);break}catch{await new Promise(r=>setTimeout(r,30))}}
   assert.equal(res?.status,503,'HTTP must survive startup failure');const state=await res.json();assert.equal(state.startup.failure,kind);assert.equal(child.exitCode,null);
   assert.ok(!JSON.stringify(state).includes(dir),'No private paths');
   if(kind==='wallet_process_conflict')assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid),'Do not remove another process lock');
   else assert.equal(fs.readFileSync(ledger,'utf8'),'{broken-ledger','Never replace an unreadable ledger');
  } finally {child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
 }
 console.log('✓ Mainnet startup failures remain diagnosable without bypassing locks or modifying ledgers');
})().catch(e=>{console.error(e);process.exitCode=1});
