/**
 * `docker/alteroid-db`（`ALTEROID_DATABASE_URL` 1本から内蔵 PostgreSQL を起こすシム）
 * を固定する。
 *
 * **本物の `docker-entrypoint.sh` にも本物の postgres にも一切触らない。** PATH の
 * 先頭に「偽の `docker-entrypoint.sh`」を置き、渡された引数と、その時点の環境変数
 * （`POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD_FILE` / `ALTEROID_DATABASE_URL`
 * の有無）を JSON で1行 stdout へ出すだけの偽物に差し替える。実際に postgres を
 * 起動するかどうかはこのシムの責務ではない——ここで固定するのは「URL をどう割って、
 * 何を環境に残し、何を残さないか」だけである。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'alteroid-db');

type Result = { exitCode: number; stdout: string; stderr: string };

/** 偽の `docker-entrypoint.sh` を1本用意し、その PATH を返す。 */
function setupFakeEntrypoint(root: string): string {
  const bin = join(root, 'docker-entrypoint.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      // 引数と、注目している環境変数の有無・値だけを1行 JSON で吐く。
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

/** `docker/alteroid-db` を、本物の `docker-entrypoint.sh` に一切触れない PATH で実行する。 */
function run(args: string[], databaseUrl: string | undefined): Result {
  const root = mktemp();
  setupFakeEntrypoint(root);

  const env: Record<string, string> = {
    // 偽の entrypoint を先頭に、実際に動いている node の実体のディレクトリも足す
    // （nvm / volta / Homebrew 経由だと /usr/bin や /bin には node が無いため）。
    PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
    // コンテナの外（`/run` が無い・書けない環境）から実行するので、パスワード
    // ファイルの置き場所も使い捨ての一時ディレクトリへ向ける。
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
  return mkdtempSync(join(tmpdir(), 'alteroid-db-test-'));
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
    // 生のパスワードは `p@ss:word` で、`:` と `@` を含むパーセントエンコード済み。
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
    // path が /alteroid（1階層）である素直な形だけを対象にする——多階層は今回のスコープ外
    // だが、少なくとも先頭の / を1つ剥がすだけの実装で壊れないことを固定する。
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/alteroid');
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_DB).toBe('alteroid');
  });

  it('パスワードにパーセントエンコードされた改行が混じっても、後続フィールドをずらさない', () => {
    // 生のパスワードは `hello\nworld`。`\n` 区切り + `sed -n 'Np'` で受け渡すと、
    // デコード後に現れるこの改行がフィールド区切りと衝突し、以降がずれて壊れる
    // （コードレビューで見つかった実バグ）。
    const result = run(['postgres'], 'postgres://alteroid:hello%0Aworld@db:5432/alteroid');
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_USER).toBe('alteroid');
    expect(out.POSTGRES_DB).toBe('alteroid');
    expect(readFileSync(out.POSTGRES_PASSWORD_FILE, 'utf8')).toBe('hello\nworld');
  });

  it('db 名がパーセントエンコードされていてもデコードして渡す', () => {
    // 実際に接続するクライアント（pg-connection-string）はデコードした db 名を
    // 使うので、ここでデコードを怠ると `POSTGRES_DB` と食い違う
    // （コードレビューで見つかった実バグ）。
    const result = run(['postgres'], 'postgres://alteroid:hunter2@db:5432/my%20db');
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.POSTGRES_DB).toBe('my db');
  });
});
