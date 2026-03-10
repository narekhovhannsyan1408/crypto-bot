import { Test, TestingModule } from '@nestjs/testing';
import { BotLoggerService } from './bot-logger.service';
import { LiveStreamService } from '../../streaming/live-stream/live-stream.service';

describe('BotLoggerService', () => {
  let service: BotLoggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotLoggerService,
        {
          provide: LiveStreamService,
          useValue: { publish: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<BotLoggerService>(BotLoggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
