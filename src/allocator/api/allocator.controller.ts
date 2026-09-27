import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { AllocatorEngine } from '../engine/allocator-engine.service';
import {
  parseActivityLimit,
  parseMode,
  parseRange,
  parseStartRequest,
} from './allocator-request';

/** API простого веб-интерфейса. */
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
      throw new BadRequestException(result.message);
    }
    return { ...result, state: this.engine.getAppState() };
  }

  @Post('stop')
  @HttpCode(200)
  async stop() {
    if (this.engine.getAppState().status !== 'running') {
      throw new ConflictException('Бот сейчас не работает');
    }
    const result = await this.engine.stop();
    return { ...result, state: this.engine.getAppState() };
  }
}
