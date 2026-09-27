/**
 * Запись ежедневного решения для публикации в блокчейн (Memo-программа Solana).
 *
 * Решение принимается по закрытой дневной свече и публикуется до исполнения ордеров.
 * Время блока нельзя изменить задним числом, поэтому история решений бота
 * проверяема: любой может сверить цены закрытия и сигналы с публичными данными.
 */
export type DecisionProof = {
  sessionId: string;
  mode: string;
  day: number;
  equity: number;
  quote: string;
  signals: Array<{
    asset: string;
    close: number;
    votes: number;
    total: number;
    targetWeight: number;
  }>;
  orders: Array<{ side: 'BUY' | 'SELL'; asset: string; amount: number }>;
};

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Memo должен поместиться в транзакцию (1232 байта) вместе с подписью и счетами
export const MAX_MEMO_BYTES = 560;

const round = (value: number, digits: number) => Number(value.toFixed(digits));

export const encodeDecisionMemo = (proof: DecisionProof) => {
  const payload: Record<string, unknown> = {
    app: 'crypto-bot',
    v: 1,
    kind: 'daily-decision',
    day: new Date(proof.day).toISOString().slice(0, 10),
    session: proof.sessionId,
    mode: proof.mode,
    equity: round(proof.equity, 2),
    quote: proof.quote,
    signals: Object.fromEntries(
      proof.signals.map((signal) => [
        signal.asset,
        {
          close: signal.close,
          sma: `${signal.votes}/${signal.total}`,
          target: round(signal.targetWeight, 4),
        },
      ]),
    ),
    orders: proof.orders.map(
      (order) => `${order.side} ${order.asset} ${order.amount.toFixed(2)}`,
    ),
  };
  let memo = JSON.stringify(payload);
  if (Buffer.byteLength(memo) > MAX_MEMO_BYTES) {
    // Ордера восстанавливаются из сигналов и капитала — жертвуем ими первыми
    payload.orders = proof.orders.length;
    memo = JSON.stringify(payload);
  }
  if (Buffer.byteLength(memo) > MAX_MEMO_BYTES) {
    throw new Error(
      `Запись решения не помещается в транзакцию (${Buffer.byteLength(memo)} байт)`,
    );
  }
  return memo;
};
