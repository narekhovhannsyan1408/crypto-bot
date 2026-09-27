import {
  BeforeApplicationShutdown,
  Global,
  Injectable,
  Module,
} from '@nestjs/common';
import { AppLogger, getAppLogger } from './app-logger';

@Injectable()
class ShutdownLogger implements BeforeApplicationShutdown {
  constructor(private readonly logger: AppLogger) {}

  beforeApplicationShutdown(signal?: string) {
    this.logger.info('process.shutdown', 'Приложение останавливается', {
      signal: signal ?? null,
    });
  }
}

/** Диагностический журнал доступен во всех модулях через внедрение AppLogger. */
@Global()
@Module({
  providers: [{ provide: AppLogger, useFactory: getAppLogger }, ShutdownLogger],
  exports: [AppLogger],
})
export class ObservabilityModule {}
