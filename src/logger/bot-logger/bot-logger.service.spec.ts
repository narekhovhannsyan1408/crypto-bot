import { Test, TestingModule } from '@nestjs/testing';
import { BotLoggerService } from './bot-logger.service';

describe('BotLoggerService', () => {
  let service: BotLoggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BotLoggerService],
    }).compile();

    service = module.get<BotLoggerService>(BotLoggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
