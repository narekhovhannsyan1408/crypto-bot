import { Injectable } from '@nestjs/common';

type LiveEventType = 'log' | 'trade' | 'portfolio' | 'system';

export type LiveEvent = {
  id: string;
  type: LiveEventType;
  tag: string;
  title: string;
  timestamp: number;
  payload: unknown;
};

export type LiveSnapshot = {
  recentEvents: LiveEvent[];
  recentTrades: LiveEvent[];
  latestPortfolio: LiveEvent | null;
  equityHistory: Array<{ timestamp: number; equity: number }>;
};

@Injectable()
export class LiveStreamService {
  private readonly recentEvents: LiveEvent[] = [];
  private readonly recentTrades: LiveEvent[] = [];
  private readonly equityHistory: Array<{ timestamp: number; equity: number }> =
    [];
  private latestPortfolio: LiveEvent | null = null;
  private readonly subscribers = new Set<(event: LiveEvent) => void>();

  publish(event: Omit<LiveEvent, 'id' | 'timestamp'>) {
    const nextEvent: LiveEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      ...event,
    };

    this.recentEvents.push(nextEvent);
    if (this.recentEvents.length > 400) {
      this.recentEvents.shift();
    }

    if (nextEvent.type === 'trade') {
      this.recentTrades.push(nextEvent);
      if (this.recentTrades.length > 400) {
        this.recentTrades.shift();
      }
    }

    if (nextEvent.type === 'portfolio') {
      this.latestPortfolio = nextEvent;
      const equity = this.extractEquity(nextEvent.payload);
      if (equity !== null) {
        this.equityHistory.push({ timestamp: nextEvent.timestamp, equity });
        if (this.equityHistory.length > 600) {
          this.equityHistory.shift();
        }
      }
    }

    for (const subscriber of this.subscribers) {
      subscriber(nextEvent);
    }
  }

  subscribe(subscriber: (event: LiveEvent) => void) {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getSnapshot(): LiveSnapshot {
    return {
      recentEvents: [...this.recentEvents],
      recentTrades: [...this.recentTrades],
      latestPortfolio: this.latestPortfolio,
      equityHistory: [...this.equityHistory],
    };
  }

  private extractEquity(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const value = (payload as Record<string, unknown>).капитал;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    return value;
  }
}
