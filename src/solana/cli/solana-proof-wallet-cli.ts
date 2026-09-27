import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { getBotConfig } from '../../config/bot-config';
import { createConnection, loadKeypair } from '../solana-wallet';

// Одна запись решения стоит 5000 лампортов: 0.05 SOL хватит примерно на 10 000 дней
const LOW_BALANCE_SOL = 0.05;
const AIRDROP_SOL = 1;

const HELP = `
Wallet for the Solana decision journal (Memo program).

  npm run solana:proof-wallet            create the wallet (if missing), show its address and balance,
                                         request free SOL on devnet/testnet
  npm run solana:proof-wallet -- --help  this help

Key file: SOLANA_PROOF_KEYPAIR_PATH (default .solana/proof-keypair.json, git-ignored).
Network: SOLANA_PROOF_CLUSTER (devnet by default), RPC: SOLANA_PROOF_RPC_URL.
`;

async function main() {
  if (process.argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  const settings = getBotConfig().solana.proof;
  const path = settings.keypairPath;
  const shownPath = relative(process.cwd(), path) || path;

  let keypair = existsSync(path) ? loadKeypair({ keypairPath: path }) : null;
  if (!keypair) {
    keypair = Keypair.generate();
    mkdirSync(dirname(path), { recursive: true });
    // Формат solana-keygen: JSON-массив из 64 байт; читать файл может только владелец
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
      mode: 0o600,
    });
    console.log(`Created a new wallet: ${shownPath}`);
  }

  const address = keypair.publicKey.toBase58();
  const connection = createConnection(settings.rpcUrl);
  console.log(`Address: ${address}`);
  console.log(`Network: ${settings.cluster} (${settings.rpcUrl})`);

  let balance =
    (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`Balance: ${balance} SOL`);

  if (balance < LOW_BALANCE_SOL && settings.cluster !== 'mainnet-beta') {
    console.log(`Requesting ${AIRDROP_SOL} SOL on ${settings.cluster}…`);
    try {
      const txId = await connection.requestAirdrop(
        keypair.publicKey,
        AIRDROP_SOL * LAMPORTS_PER_SOL,
      );
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature: txId, ...latest });
      balance =
        (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
      console.log(`Done, balance: ${balance} SOL`);
    } catch (error) {
      console.log(
        `The faucet refused (${error instanceof Error ? error.message : String(error)}).\n` +
          `Top the wallet up manually at https://faucet.solana.com — address ${address}, network ${settings.cluster}.`,
      );
    }
  } else if (balance < LOW_BALANCE_SOL) {
    console.log(
      `Not enough SOL for mainnet records: send a little SOL to ${address}.`,
    );
  }

  if (!settings.enabled) {
    console.log(
      '\nTo make the bot publish its decisions, add SOLANA_PROOF_ENABLED=true to .env and restart the bot.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
