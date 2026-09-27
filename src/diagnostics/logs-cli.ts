/**
 * Просмотр диагностического журнала.
 *
 *   npm run logs -- --since 6h --level warn
 *   npm run logs -- --event "allocator.rebalance.*" --since 3d
 *   npm run logs -- --op tick-lx2k9-3fa1c2 --full
 *   npm run logs -- --request req-... --json
 */
import { getBotConfig } from '../config/bot-config';
import { LogLevel } from '../observability/log.types';
import { formatRecord } from './log-format';
import { LogQuery, parseTimeArg, readLogs } from './log-reader';

const USAGE = `Использование: npm run logs -- [опции]

  --since <6h|2d|2026-09-27T10:00>   С какого момента (по умолчанию 24h)
  --until <...>                      До какого момента
  --level <trace|debug|info|warn|error|fatal>  Минимальный уровень (по умолчанию debug)
  --event <шаблон[,шаблон]>          Имена событий, * — любая подстрока (allocator.*, *.failed)
  --session <id>                     Только события сессии
  --op <opId>                        Только одна операция (tick-…, start-…)
  --request <requestId>              Только один HTTP-запрос (заголовок X-Request-Id)
  --grep <текст>                     Поиск подстроки в записи
  --limit <N>                        Последние N записей (по умолчанию 200, 0 — все)
  --full                             Показывать данные и стек полностью
  --json                             Сырые JSON-строки
  --dir <путь>                       Папка журнала (по умолчанию BOT_LOG_DIR или ./logs)
`;

type Options = { query: LogQuery; limit: number; full: boolean; json: boolean };

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    query: {
      dir: getBotConfig().logging.dir,
      since: parseTimeArg('24h'),
      minLevel: 'debug',
    },
    limit: 200,
    full: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Для ${flag} нужно значение`);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--since':
        options.query.since = parseTimeArg(value());
        break;
      case '--until':
        options.query.until = parseTimeArg(value());
        break;
      case '--level':
        options.query.minLevel = value() as LogLevel;
        break;
      case '--event':
        options.query.events = value()
          .split(',')
          .map((item) => item.trim());
        break;
      case '--session':
        options.query.sessionId = value();
        break;
      case '--op':
        options.query.opId = value();
        break;
      case '--request':
        options.query.requestId = value();
        break;
      case '--grep':
        options.query.text = value();
        break;
      case '--limit':
        options.limit = Number(value());
        break;
      case '--dir':
        options.query.dir = value();
        break;
      case '--full':
        options.full = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Неизвестная опция: ${flag}\n\n${USAGE}`);
    }
  }
  return options;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { records, files, malformedLines } = await readLogs(options.query);
  const shown = options.limit > 0 ? records.slice(-options.limit) : records;

  if (options.json) {
    for (const record of shown) console.log(JSON.stringify(record));
    return;
  }

  console.log(
    `Журнал: ${options.query.dir} · файлов ${files.length} · найдено ${records.length}` +
      (records.length > shown.length
        ? ` · показаны последние ${shown.length}`
        : '') +
      (malformedLines ? ` · битых строк ${malformedLines}` : '') +
      ' · время UTC\n',
  );
  for (const record of shown) {
    console.log(formatRecord(record, options.full));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
