import { Test, TestingModule } from '@nestjs/testing';
import { BinanceMarketService } from './binance-market.service';

describe('BinanceMarketService', () => {
  let service: BinanceMarketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BinanceMarketService],
    }).compile();

    service = module.get<BinanceMarketService>(BinanceMarketService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
