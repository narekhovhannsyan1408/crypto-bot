import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetBotConfigCache } from '../../config/bot-config';
import { AppLogger } from '../../observability/app-logger';
import { MemorySink } from '../../observability/rotating-file-sink';
import { SessionStore } from './session-store';

describe('SessionStore', () => {
  let dir: string;
  let stateFile: string;
  const previous = process.env.BOT_ALLOCATOR_STATE_FILE;

  const createStore = () =>
    new SessionStore(new AppLogger(new MemorySink(), 'trace'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-store-'));
    stateFile = join(dir, 'state.json');
    process.env.BOT_ALLOCATOR_STATE_FILE = stateFile;
    resetBotConfigCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.BOT_ALLOCATOR_STATE_FILE;
    else process.env.BOT_ALLOCATOR_STATE_FILE = previous;
    resetBotConfigCache();
  });

  it('starts empty without a state file', () => {
    const store = createStore();

    expect(store.getCurrent()).toBeNull();
    expect(store.getHistory()).toEqual([]);
  });

  it('refuses to start over a corrupted file and keeps it untouched', () => {
    writeFileSync(stateFile, '{"version": 2, "current": {');

    expect(createStore).toThrow(stateFile);
    expect(readFileSync(stateFile, 'utf8')).toBe('{"version": 2, "current": {');
  });
});
