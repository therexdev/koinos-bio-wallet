"use strict";

// SOL unit helpers — lamports are 9 decimals.
const { ethers } = require("ethers");
const { SOL_DECIMALS } = require("./sol-constants");

const parseSol = (amount) => ethers.parseUnits(String(amount), SOL_DECIMALS);
const formatSol = (lamports) => ethers.formatUnits(BigInt(lamports), SOL_DECIMALS);

module.exports = { parseSol, formatSol };
