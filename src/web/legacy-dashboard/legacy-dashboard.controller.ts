import { Controller, Get } from '@nestjs/common';
import { LiveStreamService } from '../../streaming/live-stream/live-stream.service';
import { LegacyRuntimeService } from './legacy-runtime.service';

@Controller('api')
export class LegacyDashboardController {
  constructor(
    private readonly liveStream: LiveStreamService,
    private readonly runtime: LegacyRuntimeService,
  ) {}

  @Get('state')
  getState() {
    return {
      stream: this.liveStream.getSnapshot(),
      runtime: this.runtime.build(),
    };
  }
}
