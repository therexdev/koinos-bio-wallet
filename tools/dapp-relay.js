'use strict';

const crypto = require('node:crypto');

const SESSION_TTL = 30 * 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
const MAX_OPERATIONS = 6;
const sessions = new Map();

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const cleanText = (value, max) => String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const sameSecret = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
};

function prune() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expires < now) sessions.delete(id);
    else for (const [rid, request] of session.requests) if (request.expires < now) session.requests.delete(rid);
  }
}

function create({ origin, name, icon }) {
  prune();
  const id = token(18);
  const secret = token(32);
  sessions.set(id, {
    id, secret, origin: cleanText(origin, 180), name: cleanText(name, 60) || 'Koinos app',
    icon: /^https:\/\//i.test(String(icon || '')) ? cleanText(icon, 300) : '',
    address: null, connectedAt: null, expires: Date.now() + SESSION_TTL, requests: new Map(),
  });
  return { id, secret, expiresAt: Date.now() + SESSION_TTL };
}

function get(id, secret) {
  prune();
  const session = sessions.get(String(id || ''));
  if (!session || !sameSecret(session.secret, secret)) return null;
  return session;
}

function publicSession(session) {
  return {
    id: session.id, name: session.name, origin: session.origin, icon: session.icon,
    connected: !!session.address, address: session.address, connectedAt: session.connectedAt,
    expiresAt: session.expires,
  };
}

function connect(session, address) {
  session.address = address;
  session.connectedAt = Date.now();
  return publicSession(session);
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_OPERATIONS) {
    throw new Error(`a request must contain 1-${MAX_OPERATIONS} operations`);
  }
  const encoded = Buffer.byteLength(JSON.stringify(operations));
  if (encoded > 48 * 1024) throw new Error('transaction request is too large');
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('invalid operation');
    if (!operation.call_contract) throw new Error('connected apps may request contract calls only');
    if (Object.keys(operation).length !== 1) throw new Error('mixed operation types are not allowed');
    const call = operation.call_contract;
    if (!/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(call.contract_id || ''))) throw new Error('invalid contract address');
    if (!/^\d+$/.test(String(call.entry_point ?? ''))) throw new Error('invalid contract entry point');
    if (typeof call.args !== 'string' || !/^[A-Za-z0-9+/_=-]*$/.test(call.args)) throw new Error('invalid contract arguments');
  }
  return operations;
}

function addRequest(session, { operations, summary, transaction }) {
  if (!session.address) throw new Error('connect the wallet first');
  if ([...session.requests.values()].some((r) => r.status === 'pending')) throw new Error('finish the pending wallet request first');
  const id = token(18);
  const request = {
    id, operations: validateOperations(operations), transaction,
    summary: {
      title: cleanText(summary && summary.title, 80) || 'Transaction request',
      detail: cleanText(summary && summary.detail, 300),
      network: cleanText(summary && summary.network, 30),
    },
    status: 'pending', createdAt: Date.now(), expires: Date.now() + REQUEST_TTL,
    txid: null, error: null,
  };
  session.requests.set(id, request);
  return request;
}

function pending(session) {
  return [...session.requests.values()].filter((r) => r.status === 'pending').map((r) => ({
    id: r.id, summary: r.summary, transaction: r.transaction, operations: r.operations,
    createdAt: r.createdAt, expiresAt: r.expires,
  }));
}

function request(session, id) { return session.requests.get(String(id || '')) || null; }
function settle(request, status, extra = {}) { Object.assign(request, { status, ...extra }); }
function disconnect(session) { sessions.delete(session.id); }

module.exports = { create, get, publicSession, connect, addRequest, pending, request, settle, disconnect, validateOperations, _sessions: sessions };
