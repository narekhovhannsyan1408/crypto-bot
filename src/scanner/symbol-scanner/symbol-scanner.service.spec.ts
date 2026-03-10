import { Test, TestingModule } from '@nestjs/testing';
import { SymbolScannerService } from './symbol-scanner.service';

describe('SymbolScannerService', () => {
  let service: SymbolScannerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SymbolScannerService],
    }).compile();

    service = module.get<SymbolScannerService>(SymbolScannerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
