import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { getBotConfig } from '../../config/bot-config';
import { createConnection, loadKeypair } from '../solana-wallet';

// Одна запись решения стоит 5000 лампортов: 0.05 SOL хватит примерно на 10 000 дней
const LOW_BALANCE_SOL = 0.05;
const AIRDROP_SOL = 1;

const HELP = `
Кошелёк для журнала решений в Solana (Memo-программа).

  npm run solana:proof-wallet            создать кошелёк (если нет), показать адрес и баланс,
                                         в devnet/testnet запросить бесплатные SOL
  npm run solana:proof-wallet -- --help  эта справка

Файл ключа: SOLANA_PROOF_KEYPAIR_PATH (по умолчанию .solana/proof-keypair.json, в .gitignore).
Сеть: SOLANA_PROOF_CLUSTER (devnet по умолчанию), RPC: SOLANA_PROOF_RPC_URL.
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
    console.log(`Создан новый кошелёк: ${shownPath}`);
  }

  const address = keypair.publicKey.toBase58();
  const connection = createConnection(settings.rpcUrl);
  console.log(`Адрес:  ${address}`);
  console.log(`Сеть:   ${settings.cluster} (${settings.rpcUrl})`);

  let balance =
    (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
  console.log(`Баланс: ${balance} SOL`);

  if (balance < LOW_BALANCE_SOL && settings.cluster !== 'mainnet-beta') {
    console.log(`Запрашиваю ${AIRDROP_SOL} SOL в ${settings.cluster}…`);
    try {
      const txId = await connection.requestAirdrop(
        keypair.publicKey,
        AIRDROP_SOL * LAMPORTS_PER_SOL,
      );
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature: txId, ...latest });
      balance =
        (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL;
      console.log(`Готово, баланс: ${balance} SOL`);
    } catch (error) {
      console.log(
        `Faucet отказал (${error instanceof Error ? error.message : String(error)}).\n` +
          `Пополните кошелёк вручную: https://faucet.solana.com — адрес ${address}, сеть ${settings.cluster}.`,
      );
    }
  } else if (balance < LOW_BALANCE_SOL) {
    console.log(
      `Мало SOL для записей в основной сети: переведите немного SOL на ${address}.`,
    );
  }

  if (!settings.enabled) {
    console.log(
      '\nЧтобы бот публиковал решения, добавьте в .env строку SOLANA_PROOF_ENABLED=true и перезапустите бота.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
