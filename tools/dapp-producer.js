"use strict";
const { Contract, utils } = require("koilib");
const { isDeepStrictEqual } = require("node:util");
const pobAbi = require("../abi/pob-abi.json");
const tokenAbi = require("../abi/token-abi.json");
const ORIGIN = "https://koinosai.com";
const CONTRACTS = { koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv" };
const abi = input => { const a = JSON.parse(JSON.stringify(input)); const n = a.koilib_types?.nested?.koinos?.nested; if (n) { delete n.btype; delete n._btype; } return a; };
const amount = value => { if (!/^[1-9][0-9]{0,19}$/.test(String(value)) || BigInt(value) > 18446744073709551615n) throw new Error("Invalid producer amount"); const n = BigInt(value); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };

// KAI's approval text is decoded here from the actual contract calls. Ignore
// app-supplied summaries. This origin cannot upload contracts, change wallet
// authority or add an unrelated approval to a producer transaction.
async function reviewProducer(operations, address, network) {
  if (network !== "mainnet") throw new Error("KAI producer requests require Mainnet");
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 2) throw new Error("Invalid producer operations");
  const decoded = [];
  for (const op of operations) {
    const c = op.call_contract;
    const kind = Object.keys(CONTRACTS).find(k => CONTRACTS[k] === c?.contract_id);
    if (!kind) throw new Error("Unknown producer contract");
    const contract = new Contract({ id: c.contract_id, abi: abi(kind === "pob" ? pobAbi : tokenAbi) });
    const d = await contract.decodeOperation(op);
    const allowed = kind === "pob" ? ["register_public_key", "burn"] : kind === "koin" ? ["transfer", "approve"] : ["transfer"];
    if (!allowed.includes(d.name)) throw new Error("Unsupported producer operation");
    const encoded = await contract.functions[d.name](d.args, { onlyOperation: true });
    if (!isDeepStrictEqual(encoded.operation, op)) throw new Error("Noncanonical producer operation");
    decoded.push({ kind, ...d });
  }
  const last = decoded.at(-1), a = last.args;
  let title, detail;
  if (last.name === "register_public_key" && decoded.length === 1) {
    if (a.producer !== address) throw new Error("Producer must be the connected wallet");
    const key = utils.decodeBase64url(a.public_key);
    if (key.length !== 33 || ![2, 3].includes(key[0])) throw new Error("Invalid hot production public key");
    title = "Register KAI node hot key";
    detail = `Producer: ${address}. Hot public key: ${a.public_key}. This key will produce blocks for your wallet. No tokens move.`;
  } else if (last.name === "burn") {
    if (a.burn_address !== address || a.vhp_address !== address) throw new Error("Burn and VHP destination must be the connected wallet");
    const value = amount(a.token_amount);
    if (decoded.length === 2) {
      const approval = decoded[0];
      if (approval.kind !== "koin" || approval.name !== "approve" || approval.args.owner !== address || approval.args.spender !== CONTRACTS.pob || approval.args.value !== a.token_amount) throw new Error("Burn approval must exactly match the burn amount");
    }
    title = "Burn KOIN for node VHP";
    detail = `Permanently burn ${value} KOIN from ${address}. Receive ${value} VHP at the same wallet. VHP converts back gradually through block production.`;
  } else if (last.name === "transfer" && decoded.length === 1) {
    if (a.from !== address) throw new Error("Transfer must use the connected wallet");
    title = `Transfer ${last.kind.toUpperCase()} from producer`;
    detail = `Send ${amount(a.value)} ${last.kind.toUpperCase()} from ${address} to ${a.to}. Approving submits this transfer.`;
  } else throw new Error("Unsupported producer operation combination");
  return { title, detail, network: "mainnet" };
}
module.exports = { ORIGIN, CONTRACTS, reviewProducer };
