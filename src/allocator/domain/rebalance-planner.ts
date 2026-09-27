export type AllocatorHolding = {
  symbol: string;
  quantity: number;
  price: number;
};

export type RebalanceOrder = {
  symbol: string;
  side: 'BUY' | 'SELL';
  quoteAmount: number;
  quantity: number;
  price: number;
  currentWeight: number;
  targetWeight: number;
};

export type RebalancePlanInput = {
  cash: number;
  holdings: AllocatorHolding[];
  // Целевая доля капитала для каждого символа (сумма <= 1)
  targetWeights: Record<string, number>;
  // Не торговать, если отклонение меньше этой доли от выделенного активу капитала
  rebalanceThresholdPct: number;
  minOrderUsdt: number;
  // Доля выделенного на актив капитала: 1 / число активов
  allocationPerAsset: number;
};

export type RebalancePlan = {
  equity: number;
  orders: RebalanceOrder[];
  skipped: Array<{ symbol: string; reason: string }>;
};

/**
 * Считает ордера, приводящие "карман" аллокатора (его USDT и монеты) к целевым весам.
 *
 * Идемпотентен: если портфель уже в пределах порога, ордеров нет. Поэтому повторный
 * запуск после рестарта процесса не приводит к двойным сделкам. Продажи идут первыми,
 * чтобы освободить USDT под покупки.
 */
export const planRebalance = (input: RebalancePlanInput): RebalancePlan => {
  const holdingsValue = input.holdings.reduce(
    (sum, holding) => sum + holding.quantity * holding.price,
    0,
  );
  const equity = input.cash + holdingsValue;
  const orders: RebalanceOrder[] = [];
  const skipped: RebalancePlan['skipped'] = [];

  if (equity <= 0) {
    return { equity, orders, skipped };
  }

  const threshold =
    equity * input.allocationPerAsset * input.rebalanceThresholdPct;

  for (const holding of input.holdings) {
    const targetWeight = input.targetWeights[holding.symbol] ?? 0;
    const currentValue = holding.quantity * holding.price;
    const targetValue = equity * targetWeight;
    const delta = targetValue - currentValue;
    const fullExit = targetWeight === 0 && currentValue >= input.minOrderUsdt;

    if (Math.abs(delta) < threshold && !fullExit) {
      continue;
    }

    if (Math.abs(delta) < input.minOrderUsdt) {
      skipped.push({
        symbol: holding.symbol,
        reason: `Difference ${delta.toFixed(2)} USDT is below the minimum order of ${input.minOrderUsdt} USDT`,
      });
      continue;
    }

    orders.push({
      symbol: holding.symbol,
      side: delta > 0 ? 'BUY' : 'SELL',
      quoteAmount: Math.abs(delta),
      quantity:
        targetWeight === 0 ? holding.quantity : Math.abs(delta) / holding.price,
      price: holding.price,
      currentWeight: currentValue / equity,
      targetWeight,
    });
  }

  const sells = orders.filter((order) => order.side === 'SELL');
  const buys = orders.filter((order) => order.side === 'BUY');
  const cashAfterSells =
    input.cash + sells.reduce((sum, order) => sum + order.quoteAmount, 0);
  const buyTotal = buys.reduce((sum, order) => sum + order.quoteAmount, 0);

  // Покупки не могут превысить доступный USDT (комиссии, округления, чужие средства)
  if (buyTotal > cashAfterSells && buyTotal > 0) {
    const scale = Math.max(cashAfterSells, 0) / buyTotal;
    for (const order of buys) {
      order.quoteAmount *= scale;
      order.quantity = order.quoteAmount / order.price;
    }
  }

  return {
    equity,
    orders: [
      ...sells,
      ...buys.filter((order) => {
        if (order.quoteAmount >= input.minOrderUsdt) {
          return true;
        }
        skipped.push({
          symbol: order.symbol,
          reason: 'Not enough free USDT for the minimum order',
        });
        return false;
      }),
    ],
    skipped,
  };
};
