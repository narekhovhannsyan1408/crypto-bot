import { join, resolve } from 'node:path';
import {
  buildAllowedHosts,
  isTrustedRequest,
  resolveStaticPath,
} from './request-guard';

describe('isTrustedRequest', () => {
  const allowed = buildAllowedHosts('127.0.0.1', 3200);

  it('accepts same-origin requests to the dashboard', () => {
    expect(
      isTrustedRequest(
        { host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3200' },
        '127.0.0.1',
        allowed,
      ),
    ).toBe(true);
    expect(
      isTrustedRequest({ host: 'localhost:3200' }, '127.0.0.1', allowed),
    ).toBe(true);
  });

  it('rejects commands sent from another website', () => {
    expect(
      isTrustedRequest(
        { host: '127.0.0.1:3200', origin: 'https://evil.example' },
        '127.0.0.1',
        allowed,
      ),
    ).toBe(false);
  });

  it('rejects DNS rebinding hosts', () => {
    expect(
      isTrustedRequest({ host: 'evil.example:3200' }, '127.0.0.1', allowed),
    ).toBe(false);
  });

  it('allows any host when bound to all interfaces but still checks origin', () => {
    const wildcard = buildAllowedHosts('0.0.0.0', 3200);
    expect(
      isTrustedRequest(
        { host: '192.168.1.5:3200', origin: 'http://192.168.1.5:3200' },
        '0.0.0.0',
        wildcard,
      ),
    ).toBe(true);
    expect(
      isTrustedRequest(
        { host: '192.168.1.5:3200', origin: 'http://evil.example' },
        '0.0.0.0',
        wildcard,
      ),
    ).toBe(false);
  });
});

describe('resolveStaticPath', () => {
  const root = resolve('/srv/public');

  it('resolves files inside the root', () => {
    expect(resolveStaticPath(root, '/home.js')).toBe(join(root, 'home.js'));
  });

  it('blocks path traversal, including encoded', () => {
    expect(resolveStaticPath(root, '/../../.env')).toBeNull();
    expect(resolveStaticPath(root, '/%2e%2e/%2e%2e/.env')).toBeNull();
    expect(resolveStaticPath(root, '/')).toBeNull();
  });
});
