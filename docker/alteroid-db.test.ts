// 本物の `docker-entrypoint.sh` にも postgres にも触らず、PATH の先頭に偽の entrypoint を置く: 固定するのは「URL をどう割って、何を環境に残し、何を残さないか」だけで、postgres を起動するかはシムの責務ではないため。
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'alteroid-db');

type Result = { exitCode: number; stdout: string; stderr: string };

function setupFakeEntrypoint(root: string): string {
  const bin = join(root, 'docker-entrypoint.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      "node -e '",
      'const has = (k) => Object.prototype.hasOwnProperty.call(process.env, k);',
      'console.log(JSON.stringify({',
      '  args: process.argv.slice(1),',
      '  POSTGRES_USER: process.env.POSTGRES_USER ?? null,',
      '  POSTGRES_DB: process.env.POSTGRES_DB ?? null,',
      '  POSTGRES_PASSWORD_FILE: process.env.POSTGRES_PASSWORD_FILE ?? null,',
      '  hasAlteroidDatabaseUrl: has("ALTEROID_DATABASE_URL"),',
      '  hasPostgresPassword: has("POSTGRES_PASSWORD"),',
      '}));',
      '\' -- "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return root;
}

function run(args: string[], databaseUrl: string | undefined): Result {
  const root = mktemp();
  setupFakeEntrypoint(root);

  const env: Record<string, string> = {
    // 動いている node の実体のディレクトリも PATH に足す: nvm / volta / Homebrew 経由だと /usr/bin や /bin には node が無いため。
    PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
    // パスワードファイルの置き場所は使い捨ての一時ディレクトリへ向ける: コンテナの外では `/run` が無い・書けないため。
    ALTEROID_DB_PASSWORD_FILE: join(root, 'password'),
  };
  if (databaseUrl !== undefined) {
    env.ALTEROID_DATABASE_URL = databaseUrl;
  }

  try {
    const stdout = execFileSync(SCRIPT, args, { env, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
    };
  }
}

function mktemp(): string {
  return makeTempDirSync('alteroid-db-test-');
}

describe('docker/alteroid-db', () => {
  it('ALTEROID_DATABASE_URL が無ければ exit 1 で理由を言う', () => {
    const result = run(['postgres'], undefined);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ALTEROID_DATABASE_URL');
  });

  it('user / password / db 名を割り、docker-entrypoint.sh へ引数をそのまま渡す', () => {
    const result = run(
      ['postgres', '-c', 'shared_buffers=128MB'],
      'postgres://alteroid:hunter2@db:5432/alteroid',
    );
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.args).toEqual(['postgres', '-c', 'shared_buffers=128MB']);
    expect(out.POSTGRES_USER).toBe('alteroid');
    expect(out.POSTGRES_DB).toBe('alteroid');
    expect(typeof out.POSTGRES_PASSWORD_FILE).toBe('string');
  });

  it('パスワードは環境変数としては渡さず、ファイル経由で渡す', () => {
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/alteroid');
    const out = JSON.parse(result.stdout);
    expect(out.hasPostgresPassword).toBe(false);
    expect(out.POSTGRES_PASSWORD_FILE).toBeTruthy();
    expect(readFileSync(out.POSTGRES_PASSWORD_FILE, 'utf8')).toBe('hunter2');
  });

  it('exec の前に ALTEROID_DATABASE_URL を落とす', () => {
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/alteroid');
    const out = JSON.parse(result.stdout);
    expect(out.hasAlteroidDatabaseUrl).toBe(false);
  });

  it('パスワードに : / @ / パーセントエンコードが混じっても正しく割ってデコードする', () => {
    const result = run(['postgres'], 'postgres://alteroid:p%40ss%3Aword@db:5432/alteroid');
    const out = JSON.parse(result.stdout);
    expect(readFileSync(out.POSTGRES_PASSWORD_FILE, 'utf8')).toBe('p@ss:word');
    expect(out.POSTGRES_USER).toBe('alteroid');
    expect(out.POSTGRES_DB).toBe('alteroid');
  });

  it('ユーザー名/パスワードが無い URL は exit 1 で理由を言う', () => {
    const result = run(['postgres'], 'postgres://db:5432/alteroid');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ユーザー名とパスワード');
  });

  it('db 名（末尾の /名前）が無い URL は exit 1 で理由を言う', () => {
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('db 名');
  });

  it('db 名以外のパスセグメントが混じっても末尾のセグメントを db 名として扱わない誤りを作らない', () => {
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/alteroid');
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_DB).toBe('alteroid');
  });

  it('パスワードにパーセントエンコードされた改行が混じっても、後続フィールドをずらさない', () => {
    const result = run(['postgres'], 'postgres://alteroid:hello%0Aworld@db:5432/alteroid');
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_USER).toBe('alteroid');
    expect(out.POSTGRES_DB).toBe('alteroid');
    expect(readFileSync(out.POSTGRES_PASSWORD_FILE, 'utf8')).toBe('hello\nworld');
  });

  it('db 名がパーセントエンコードされていてもデコードして渡す', () => {
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/my%20db');
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_DB).toBe('my db');
  });
});
