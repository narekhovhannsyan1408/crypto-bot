import { Candle } from '../market/types';
import { ExecutionResult } from './types';

export type ExecutionMode = 'paper' | 'live_testnet' | 'live_real';
export type ExecutionMarketType = 'spot' | 'futures';

export type ExecutionStatus = {
  mode: ExecutionMode;
  marketType: ExecutionMarketType;
  label: string;
  canTradeShort: boolean;
  liveTradingEnabled: boolean;
  usingTestnet: boolean;
  allowLiveReal: boolean;
  apiConfigured: boolean;
  accountConnectivity: 'unknown' | 'ok' | 'error';
  quoteAsset: string;
  quoteFree?: number | null;
  quoteTotal?: number | null;
  lastSyncAt?: number;
  lastError?: string | null;
  warnings: string[];
};

export type TraderService = {
  tryOpenLong(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> | ExecutionResult;
  tryCloseLong(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ): Promise<ExecutionResult | null> | ExecutionResult | null;
  tryOpenShort(
    symbol: string,
    interval: string,
    strategyId: string,
    strategyName: string,
    price: number,
    timestamp: number,
    reason: string,
    positionSizeUsdt: number,
  ): Promise<ExecutionResult> | ExecutionResult;
  tryCloseShort(
    symbol: string,
    strategyId: string,
    price: number,
    timestamp: number,
    reason: string,
  ): Promise<ExecutionResult | null> | ExecutionResult | null;
  checkStops(candle: Candle): Promise<ExecutionResult[]> | ExecutionResult[];
};
