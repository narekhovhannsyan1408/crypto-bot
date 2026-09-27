import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { localizedHttpError } from '../../i18n/http-errors';
import { msg } from '../../i18n/messages';
import { AllocatorEngine } from '../engine/allocator-engine.service';
import {
  parseActivityLimit,
  parseMode,
  parseRange,
  parseStartRequest,
} from './allocator-request';

/** API веб-интерфейса. Сообщения — ключи словаря (поле i18n), см. src/i18n. */
@Controller('api/app')
export class AllocatorController {
  constructor(private readonly engine: AllocatorEngine) {}

  @Get('state')
  async getState(@Query('activity') activity?: string) {
    await this.engine.refreshPricesIfStale();
    return this.engine.getAppState(parseActivityLimit(activity));
  }

  @Get('chart')
  getChart(@Query('range') range?: string) {
    return this.engine.getChart(parseRange(range));
  }

  @Get('balance')
  getBalance(@Query('mode') mode?: string) {
    return this.engine.getAvailableBalance(parseMode(mode));
  }

  @Post('start')
  @HttpCode(200)
  async start(@Body() body: unknown) {
    const result = await this.engine.start(parseStartRequest(body));
    if (!result.success) {
      throw localizedHttpError(HttpStatus.BAD_REQUEST, result.message);
    }
    return { ...result, state: this.engine.getAppState() };
  }

  @Post('stop')
  @HttpCode(200)
  async stop() {
    this.assertRunning();
    const result = await this.engine.stop();
    return { ...result, state: this.engine.getAppState() };
  }

  /** Решение по сигналам прямо сейчас (расширенный режим). Повтор в тот же день идемпотентен. */
  @Post('rebalance')
  @HttpCode(200)
  async rebalance() {
    this.assertRunning();
    const result = await this.engine.rebalanceNow();
    if (!result.success) {
      throw localizedHttpError(HttpStatus.CONFLICT, result.message);
    }
    return { ...result, state: this.engine.getAppState() };
  }

  private assertRunning() {
    if (!this.engine.isRunning()) {
      throw localizedHttpError(HttpStatus.CONFLICT, msg('action.notRunning'));
    }
  }
}
