import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// И из src/observability, и из dist/observability корень проекта на два уровня выше
const PROJECT_ROOT = join(__dirname, '..', '..');

const git = (command: string) => {
  try {
    return execSync(`git ${command}`, {
      cwd: PROJECT_ROOT,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

export type BuildInfo = {
  version: string | null;
  gitCommit: string | null;
  gitBranch: string | null;
  // Есть незакоммиченные изменения — поведение может отличаться от коммита
  gitDirty: boolean | null;
  node: string;
  platform: string;
};

let cached: BuildInfo | null = null;

export const getBuildInfo = (): BuildInfo => {
  if (cached) return cached;

  let version: string | null = null;
  try {
    version =
      (
        JSON.parse(
          readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'),
        ) as {
          version?: string;
        }
      ).version ?? null;
  } catch {
    version = null;
  }

  const status = git('status --porcelain');
  cached = {
    version,
    gitCommit: git('rev-parse --short HEAD'),
    gitBranch: git('rev-parse --abbrev-ref HEAD'),
    gitDirty: status === null ? null : status.length > 0,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  return cached;
};
