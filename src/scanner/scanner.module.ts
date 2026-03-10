import { Module } from '@nestjs/common';
import { SymbolScannerService } from './symbol-scanner/symbol-scanner.service';

@Module({
  providers: [SymbolScannerService],
  exports: [SymbolScannerService],
})
export class ScannerModule {}
