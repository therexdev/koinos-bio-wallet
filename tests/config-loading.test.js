'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
(async () => {
 const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
 const code = source.slice(source.indexOf('  async function loadConfig()'), source.indexOf('  cfg = await loadConfig();'));
 for (const failure of ['503', 'network', 'html']) {
  const button = {}, note = {}; let calls = 0;
  const context = { $: id => id === '#btn-go' ? button : note, WalletClient:{android:false,apiPath:p=>p}, AbortSignal,
   setTimeout:fn=>{assert.equal(button.disabled,true);assert.match(note.textContent,/Reconnecting/);fn();},
   fetch:async()=>{
    if (++calls === 1) {
     if (failure === 'network') throw new Error('network unavailable');
     if (failure === 'html') return {ok:false,json:async()=>{throw new Error('Unexpected token <')}};
     return {ok:false,json:async()=>({error:'Wallet is starting'})};
    }
    return {ok:true,json:async()=>({ok:true,demo:false,nativeSymbol:'KOIN'})};
   }
  };
  const result = await vm.runInNewContext(code + '\nloadConfig()',context);
  assert.equal(result.demo,false); assert.equal(calls,2); assert.equal(note.hidden,true);
 }
 console.log('✓ Startup 503, network failures, and HTML errors retry without inventing demo mode');
})().catch(e=>{console.error(e);process.exitCode=1});
