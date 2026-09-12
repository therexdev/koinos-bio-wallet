'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { Provider } = require('koilib');
const { installFailover } = require('../tools/rpc-failover');

(async () => {
  let mode = 'html', primary = 0, backup = 0;
  const servers = [];
  async function serve(handler) {
    const s = http.createServer(handler);
    servers.push(s);
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${s.address().port}`;
  }
  try {
    const a = await serve((req, res) => {
      primary++;
      if (mode === 'timeout') return;
      res.end(mode === 'html' ? '<html>Bad Gateway</html>' : JSON.stringify({ error: { message: 'contract rejected' } }));
    });
    const b = await serve((req, res) => { backup++; res.end(JSON.stringify({ result: { value: '42' } })); });
    const make = () => installFailover(new Provider([a, b]), { timeoutMs: 100 });
    assert.deepEqual(await make().call('chain.get_account_rc', {}), { value: '42' });
    assert.equal(backup, 1);
    mode = 'timeout';
    assert.deepEqual(await make().call('chain.read_contract', {}), { value: '42' });
    mode = 'html';
    const before = backup;
    await assert.rejects(make().call('chain.submit_transaction', {}));
    assert.equal(backup, before, 'never retry a submission');
    mode = 'rejection';
    await assert.rejects(make().call('chain.read_contract', {}), /contract rejected/);
    assert.equal(backup, before, 'do not retry contract rejections');
    mode = 'html';
    const count = primary;
    await assert.rejects(installFailover(new Provider([a, a])).call('chain.get_head_info', {}));
    assert.equal(primary - count, 2, 'stop after one pass through endpoints');
    console.log('rpc failover tests passed');
  } finally {
    for (const s of servers) { s.closeAllConnections(); s.close(); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
