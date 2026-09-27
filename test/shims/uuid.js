// Jest не загружает ESM-only uuid, который тянет @solana/web3.js (через rpc-websockets).
// В тестах websocket-подписки Solana не используются, поэтому хватает случайных id.
const { randomUUID } = require('node:crypto');

module.exports = { v1: randomUUID, v4: randomUUID };
