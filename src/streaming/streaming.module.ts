import { Module } from '@nestjs/common';
import { LiveStreamService } from './live-stream/live-stream.service';

@Module({
  providers: [LiveStreamService],
  exports: [LiveStreamService],
})
export class StreamingModule {}
