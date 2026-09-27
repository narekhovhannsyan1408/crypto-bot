import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';

// И в src (ts-node), и в dist (после nest build) статика лежит рядом: web/public
export const PUBLIC_DIR = join(__dirname, 'web', 'public');

/** Общая настройка HTTP-приложения — используется в main.ts и в e2e-тестах. */
export const setupHttpApp = (app: NestExpressApplication) => {
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  app.useStaticAssets(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    dotfiles: 'deny',
    setHeaders: (res: ServerResponse) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  });
  return app;
};
