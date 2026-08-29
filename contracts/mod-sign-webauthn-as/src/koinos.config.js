const path = require("path");
const { HDKoinos } = require("@koinosbox/hdkoinos");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const hdKoinosMainnet = process.env.MAINNET_MNEMONIC
  ? new HDKoinos(process.env.MAINNET_MNEMONIC)
  : undefined;

const hdKoinosHarbinger = process.env.HARBINGER_MNEMONIC
  ? new HDKoinos(process.env.HARBINGER_MNEMONIC)
  : undefined;

function keysMainnet(index) {
  if (!hdKoinosMainnet) return { privateKeyWif: "", address: "" };
  return hdKoinosMainnet.deriveKeyAccount(index);
}

function keysHarbinger(index) {
  if (!hdKoinosHarbinger) return { privateKeyWif: "", address: "" };
  return hdKoinosHarbinger.deriveKeyAccount(index);
}

module.exports = {
  class: "ModSignWebauthn",
  proto: ["./proto/modsignwebauthn.proto"],
  files: ["./ModSignWebauthn.ts"],
  supportAbi1: true,
  sourceDir: "./assembly",
  buildDir: "../build",
  filesImport: [
    {
      dependency: "@veive-io/mod-sign-as",
      path: "../node_modules/@veive-io/mod-sign-as/dist/ModSign.ts",
    }
  ],
  protoImport: [
    {
      name: "@veive-io/mod-sign-as",
      path: "../node_modules/@veive-io/mod-sign-as/dist/proto/modsign",
    },
    {
      name: "@koinosbox/contracts",
      path: "../node_modules/@koinosbox/contracts/koinosbox-proto",
    },
    {
      name: "@koinos/sdk-as",
      path: "../node_modules/koinos-precompiler-as/koinos-proto/koinos",
    },
    {
      name: "__",
      path: "../node_modules/koinos-precompiler-as/koinos-proto/google",
    },
  ],
  networks: {
    harbinger: {
      rpcNodes: ["https://harbinger-api.koinos.io"],
      accounts: {
        freeManaSharer: { id: "1K6oESWG87m3cB3M2WVkzxdTr38po8WToN" },
        manaSharer: {
          privateKeyWif: process.env.HARBINGER_MANA_SHARER_PRIVATE_KEY,
        },
        contract: {
          privateKeyWif: process.env.HARBINGER_CONTRACT_PRIVATE_KEY,
        },
        /**
         * you can also derive the private keys from the seed:
         *
         * contract: keysHarbinger(0),
         */
      },
    },
    mainnet: {
      rpcNodes: ["https://api.koinos.io"],
      accounts: {
        freeManaSharer: {
          id: "162GhJwsciDiKsgwzj2t6VoFHt3RMzGKdG", // @freemanasharer
        },
        manaSharer: {
          privateKeyWif: process.env.MAINNET_MANA_SHARER_PRIVATE_KEY,
        },
        contract: {
          privateKeyWif: process.env.MAINNET_CONTRACT_PRIVATE_KEY,
        },
        /**
         * you can also derive the private keys from the seed:
         *
         * contract: keysMainnet(0),
         */
      },
    },
  },
};
