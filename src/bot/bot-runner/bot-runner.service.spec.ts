import { Test, TestingModule } from '@nestjs/testing';
import { BotRunnerService } from './bot-runner.service';

describe('BotRunnerService', () => {
  let service: BotRunnerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BotRunnerService],
    }).compile();

    service = module.get<BotRunnerService>(BotRunnerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
