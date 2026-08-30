"use strict";

// Unit helpers for the funding assets (from the desktop app's send modules).

const { ethers } = require("ethers");
const RC = require("./route-constants");

const parseUsdt = (amount) => ethers.parseUnits(String(amount), RC.USDT_DECIMALS);
const formatUsdt = (sats) => ethers.formatUnits(BigInt(sats), RC.USDT_DECIMALS);
const parseUsdc = (amount) => ethers.parseUnits(String(amount), RC.USDC_DECIMALS);
const formatUsdc = (sats) => ethers.formatUnits(BigInt(sats), RC.USDC_DECIMALS);
const parseVkoin = (amount) => ethers.parseUnits(String(amount), RC.VKOIN_DECIMALS);
const formatVkoin = (sats) => ethers.formatUnits(BigInt(sats), RC.VKOIN_DECIMALS);
const formatKoin = formatVkoin; // 8-dec, 1:1

module.exports = { parseUsdt, formatUsdt, parseUsdc, formatUsdc, parseVkoin, formatVkoin, formatKoin };
