const { HDKoinos } = require("@koinosbox/hdkoinos");

// replace with your own mnemonic if you have one
const mnemonic = HDKoinos.randomMnemonic();

const hdKoinos = new HDKoinos(mnemonic);
const accounts = [];
const totalAccounts = 3;
for (let i = 0; i < totalAccounts; i += 1) {
  const account = hdKoinos.deriveKeyAccount(i);
  delete account.privateKey;
  accounts.push(account);
}
console.log(`
##############
KEYS GENERATED
##############

Mnemonic phrase:
${mnemonic}

First ${totalAccounts} accounts derived from mnemonic:

${accounts.map((a, i) => `account #${i}\n${JSON.stringify(a, null, 2)}`).join("\n\n")}
`);
