import { Test, TestingModule } from '@nestjs/testing';
import { BotLoggerService } from './bot-logger.service';
import { LiveStreamService } from '../../streaming/live-stream/live-stream.service';

describe('BotLoggerService', () => {
  let service: BotLoggerService;
  let publishMock: jest.Mock;

  beforeEach(async () => {
    publishMock = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotLoggerService,
        {
          provide: LiveStreamService,
          useValue: { publish: publishMock },
        },
      ],
    }).compile();

    service = module.get<BotLoggerService>(BotLoggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('normalizes nested errors without recursive overflow', () => {
    const error = new Error('scanner failed');
    const payload = { symbol: 'BTCUSDT', error } as Record<string, unknown>;
    payload.self = payload;

    expect(() => service.logError('nested error', payload)).not.toThrow();
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          symbol: 'BTCUSDT',
          error: expect.objectContaining({
            message: 'scanner failed',
          }),
          self: '[circular]',
        }),
      }),
    );
  });
});
