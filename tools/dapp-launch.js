'use strict';
const { Transaction, Signer, Contract, utils } = require('koilib');
const ORIGINS = new Set(['https://ouro.lifestyle', 'https://www.ouro.lifestyle']);
async function validateLaunch(session, input, chain) {
  if (!ORIGINS.has(session.origin)) throw new Error('Only OURO may request a collection launch');
  const tx = JSON.parse(JSON.stringify(input || {}));
  if (Buffer.byteLength(JSON.stringify(tx)) > 400 * 1024) throw new Error('Launch request too large');
  if (!tx.header || !Array.isArray(tx.operations) || tx.operations.length !== 2) throw new Error('Expected a launch fee and contract upload');
  const [fee, upload] = tx.operations;
  if (Object.keys(fee).length !== 1 || !fee.call_contract || Object.keys(upload).length !== 1 || !upload.upload_contract) throw new Error('Unexpected launch operations');
  const u = upload.upload_contract;
  if (Object.keys(u).some(k => !['contract_id', 'bytecode'].includes(k)) || !chain.isAddr(u.contract_id) || typeof u.bytecode !== 'string' || !/^[A-Za-z0-9+/_=-]+$/.test(u.bytecode)) throw new Error('Invalid collection upload');
  if (tx.header.payee !== u.contract_id || !chain.isAddr(tx.header.payer) || [tx.header.payer, session.address].includes(u.contract_id) || tx.header.payer === session.address) throw new Error('Invalid launch payer or collection');
  if (BigInt(tx.header.rc_limit) <= 0n || BigInt(tx.header.rc_limit) > 20000000000n) throw new Error('Launch mana limit exceeds 200');
  if (tx.header.chain_id !== await chain.chainId()) throw new Error('Launch is for a different chain');
  const prepared = await Transaction.prepareTransaction(JSON.parse(JSON.stringify(tx)));
  if (prepared.id !== tx.id || JSON.stringify(prepared.header) !== JSON.stringify(tx.header)) throw new Error('Launch transaction was altered');
  if (!Array.isArray(tx.signatures) || tx.signatures.length !== 1 || utils.decodeBase64url(tx.signatures[0]).length !== 65 || !(await Signer.recoverAddresses(tx)).includes(u.contract_id)) throw new Error('Collection upload must be signed by its new account');
  const abi = JSON.parse(JSON.stringify(utils.tokenAbi));
  const types = abi.koilib_types?.nested?.koinos?.nested;
  if (types) { delete types.btype; delete types._btype; }
  if (fee.call_contract.contract_id !== chain.net().koinContract) throw new Error('Launch fee must use KOIN');
  const decoded = await new Contract({ id: chain.net().koinContract, abi }).decodeOperation(fee);
  const args = decoded.args;
  if (decoded.name !== 'transfer' || args.from !== session.address || !chain.isAddr(args.to) || BigInt(args.value) <= 0n) throw new Error('Invalid launch fee');
  const sats = BigInt(args.value);
  const amount = `${sats / 100000000n}.${(sats % 100000000n).toString().padStart(8, '0')}`;
  return { transaction: tx, operations: tx.operations, mode: 'launch', summary: {
    title: 'Launch an OURO collection', network: 'mainnet',
    detail: `Pay ${amount} KOIN to ${args.to}. Deploy collection ${u.contract_id}. Fee and upload happen together. OURO pays mana and submits after approval.`,
  } };
}
module.exports = { validateLaunch };
