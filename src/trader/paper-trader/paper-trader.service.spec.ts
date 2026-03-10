import { Test, TestingModule } from '@nestjs/testing';
import { PaperTraderService } from './paper-trader.service';

describe('PaperTraderService', () => {
  let service: PaperTraderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaperTraderService],
    }).compile();

    service = module.get<PaperTraderService>(PaperTraderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
