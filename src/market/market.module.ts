import { Module } from '@nestjs/common';
import { BinanceMarketService } from './binance-market/binance-market.service';

@Module({
  providers: [BinanceMarketService],
  exports: [BinanceMarketService],
})
export class MarketModule {}
