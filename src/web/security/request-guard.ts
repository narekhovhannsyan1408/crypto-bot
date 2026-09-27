import { isAbsolute, relative, resolve } from 'node:path';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

export const buildAllowedHosts = (dashboardHost: string, port: number) =>
  new Set(
    [dashboardHost, 'localhost', '127.0.0.1', '[::1]'].map((host) =>
      `${host}:${port}`.toLowerCase(),
    ),
  );

/**
 * Защита локального дашборда от команд со сторонних сайтов и DNS rebinding:
 * - Host должен быть адресом самого дашборда (если он не слушает все интерфейсы);
 * - Origin, если браузер его прислал, должен совпадать с Host.
 */
export const isTrustedRequest = (
  headers: { host?: string; origin?: string },
  dashboardHost: string,
  allowedHosts: Set<string>,
) => {
  const host = headers.host?.toLowerCase();
  if (!host) {
    return false;
  }
  if (!WILDCARD_HOSTS.has(dashboardHost) && !allowedHosts.has(host)) {
    return false;
  }
  if (headers.origin === undefined) {
    return true;
  }
  try {
    return new URL(headers.origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
};

export const createTrustChecker = (dashboardHost: string, port: number) => {
  const allowedHosts = buildAllowedHosts(dashboardHost, port);
  return (headers: { host?: string; origin?: string }) =>
    isTrustedRequest(headers, dashboardHost, allowedHosts);
};

/** Путь к статическому файлу строго внутри root, иначе null (защита от ../). */
export const resolveStaticPath = (root: string, requestPath: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const resolvedRoot = resolve(root);
  const filePath = resolve(
    resolvedRoot,
    `.${decoded.startsWith('/') ? '' : '/'}${decoded}`,
  );
  const relativePath = relative(resolvedRoot, filePath);
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return filePath;
};
