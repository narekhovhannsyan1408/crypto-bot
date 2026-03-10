import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { BotRunnerService } from './../src/bot/bot-runner/bot-runner.service';

describe('AppController (e2e)', () => {
  let moduleFixture: TestingModule;

  beforeEach(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  it('builds the worker application context', () => {
    expect(moduleFixture.get(BotRunnerService)).toBeDefined();
  });
});
