import { Injectable, Optional } from '@nestjs/common';
import { AllocatorEngine } from '../../allocator/engine/allocator-engine.service';
import { BotRunnerService } from '../../bot/bot-runner/bot-runner.service';
import { getBotConfig } from '../../config/bot-config';

/**
 * Снимок состояния для расширенного дашборда (/advanced).
 * BotRunnerService есть только в режиме intraday — в режиме аллокатора его модуль не загружается.
 */
@Injectable()
export class LegacyRuntimeService {
  private readonly strategyMode = getBotConfig().strategyMode;

  constructor(
    private readonly allocator: AllocatorEngine,
    @Optional() private readonly botRunner?: BotRunnerService,
  ) {}

  get intradayRunner() {
    return this.botRunner ?? null;
  }

  build() {
    return {
      ...(this.botRunner?.getDashboardSnapshot() ?? {
        generatedAt: Date.now(),
      }),
      strategyMode: this.strategyMode,
      allocator:
        this.strategyMode === 'trend_allocator'
          ? this.allocator.getLegacySnapshot()
          : null,
    };
  }
}
