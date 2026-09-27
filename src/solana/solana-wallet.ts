import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SolanaCluster } from '../config/bot-config';
import { LocalizedError, msg } from '../i18n/messages';

const SECRET_KEY_BYTES = 64;
// Без таймаута зависший RPC навсегда блокирует очередь операций бота
const RPC_TIMEOUT_MS = 20_000;

/**
 * Секретный ключ из base58 (экспорт Phantom/Solflare) или JSON-массива (solana-keygen).
 * Сообщения об ошибках намеренно не содержат фрагментов ключа.
 */
export const parseSecretKey = (value: string) => {
  const text = value.trim();
  let bytes: Uint8Array;
  try {
    bytes = text.startsWith('[')
      ? Uint8Array.from(JSON.parse(text) as number[])
      : bs58.decode(text);
  } catch {
    throw new LocalizedError(msg('err.solana.keyFormat'));
  }
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new LocalizedError(
      msg('err.solana.keyLength', {
        expected: SECRET_KEY_BYTES,
        actual: bytes.length,
      }),
    );
  }
  return bytes;
};

export const loadKeypair = (source: {
  privateKey?: string;
  keypairPath?: string;
}) => {
  if (source.privateKey) {
    return Keypair.fromSecretKey(parseSecretKey(source.privateKey));
  }
  if (source.keypairPath) {
    const path = resolve(source.keypairPath);
    if (!existsSync(path)) {
      throw new LocalizedError(msg('err.solana.keyFile', { path }));
    }
    return Keypair.fromSecretKey(parseSecretKey(readFileSync(path, 'utf8')));
  }
  return null;
};

export const createConnection = (rpcUrl: string) =>
  new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  });

// Ссылка на транзакцию в блокчейне (поле не называется signature: такие ключи журнал маскирует)
export type ChainTx = { txId: string; cluster: SolanaCluster };

export const explorerTxUrl = (txId: string, cluster: SolanaCluster) =>
  `https://explorer.solana.com/tx/${txId}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;

export const shortAddress = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
