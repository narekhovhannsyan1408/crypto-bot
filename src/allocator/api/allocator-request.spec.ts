import { HttpException } from '@nestjs/common';
import {
  parseActivityLimit,
  parseRange,
  parseStartRequest,
} from './allocator-request';

describe('allocator request parsing', () => {
  it('parses a valid start request', () => {
    expect(
      parseStartRequest({
        mode: 'paper',
        capitalUsdt: '1000',
        autoStopLossPct: 0.3,
      }),
    ).toEqual({ mode: 'paper', capitalUsdt: 1000, autoStopLossPct: 0.3 });
  });

  it('rejects unknown modes and missing amounts', () => {
    expect(() =>
      parseStartRequest({ mode: 'margin', capitalUsdt: 1000 }),
    ).toThrow(HttpException);
    expect(() => parseStartRequest({ mode: 'paper' })).toThrow(HttpException);
    expect(() => parseStartRequest(null)).toThrow(HttpException);
  });

  it('falls back to safe defaults for query parameters', () => {
    expect(parseRange('decade')).toBe('all');
    expect(parseRange('week')).toBe('week');
    expect(parseActivityLimit('abc')).toBe(30);
    expect(parseActivityLimit('100000')).toBe(500);
  });
});
