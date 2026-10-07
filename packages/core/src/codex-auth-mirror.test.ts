import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CodexAuthMirror,
  codexAuthFingerprintOf,
  type CodexAuthNotice,
} from './codex-auth-mirror.js';

const V1 = '{"tokens":{"refresh_token":"rt-1-fake"}}';
const V2 = '{"tokens":{"refresh_token":"rt-2-fake"}}';
const REFRESHED = '{"tokens":{"refresh_token":"rt-refreshed-fake"}}';

let dir: string;
let notices: CodexAuthNotice[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alteroid-codex-mirror-'));
  notices = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mirror(): CodexAuthMirror {
  return new CodexAuthMirror({
    codexHome: join(dir, 'codex-home'),
    onNotice: (notice) => notices.push(notice),
  });
}

describe('runner の CODEX_HOME への写し（#3939）', () => {
  it('ログインが降りていなければ何も触らない（CODEX_HOME を返さず、ファイルも作らない）', async () => {
    const m = mirror();
    expect(await m.prepare()).toBeUndefined();
    await m.check();
    await expect(stat(join(dir, 'codex-home'))).rejects.toThrow();
    expect(notices).toEqual([]);
  });

  it('降ろされたら auth.json を 0600 で書き出し、prepare が CODEX_HOME を返す', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    expect(await m.prepare()).toBe(join(dir, 'codex-home'));
    const path = join(dir, 'codex-home', 'auth.json');
    expect(await readFile(path, 'utf8')).toBe(V1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(m.status()).toEqual({
      placed: true,
      revision: 'r1',
      fingerprint: codexAuthFingerprintOf(V1),
    });
  });

  it('Codex が書き換えたら、値ではなく指紋と読んだ版だけを知らせ、値は取りに来たときだけ渡す', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    await writeFile(join(dir, 'codex-home', 'auth.json'), REFRESHED);
    await m.check();
    expect(notices).toEqual([
      { kind: 'changed', baseRevision: 'r1', fingerprint: codexAuthFingerprintOf(REFRESHED) },
    ]);
    expect(JSON.stringify(notices)).not.toContain('rt-refreshed-fake');
    expect(m.takeWriteBack('other')).toBeNull();
    expect(m.takeWriteBack(codexAuthFingerprintOf(REFRESHED))).toEqual({
      value: REFRESHED,
      baseRevision: 'r1',
      fingerprint: codexAuthFingerprintOf(REFRESHED),
    });
    // 同じ書き換えは2度知らせない。
    await m.check();
    expect(notices).toHaveLength(1);
  });

  it('新しい版が降りてきたら上書きする（他の runner の更新が勝った）', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    await writeFile(join(dir, 'codex-home', 'auth.json'), REFRESHED);
    await m.set({ value: V2, revision: 'r2' });
    // 上書きの前に、まだ知らせていなかった書き換えを拾って知らせている（失わない）。
    expect(notices.map((n) => n.kind)).toEqual(['changed']);
    expect(await readFile(join(dir, 'codex-home', 'auth.json'), 'utf8')).toBe(V2);
    expect(m.status().revision).toBe('r2');
  });

  it('同じ版の降ろし直しは、書き戻しの最中の新しい中身を古い正本で潰さない', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    await writeFile(join(dir, 'codex-home', 'auth.json'), REFRESHED);
    await m.check();
    await m.set({ value: V1, revision: 'r1' });
    expect(await readFile(join(dir, 'codex-home', 'auth.json'), 'utf8')).toBe(REFRESHED);
    // 書き戻しが通って同じ中身の新しい版が降りてきたら、書き直さずに版だけ進む。
    await m.set({ value: REFRESHED, revision: 'r2' });
    expect(m.status().revision).toBe('r2');
    await m.check();
    expect(notices).toHaveLength(1);
  });

  it('外されたら（ログアウト）ファイルを消し、以後は何もしない', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    await m.set(null);
    await expect(stat(join(dir, 'codex-home', 'auth.json'))).rejects.toThrow();
    expect(await m.prepare()).toBeUndefined();
  });

  it('消えていたら prepare が書き直す', async () => {
    const m = mirror();
    await m.set({ value: V1, revision: 'r1' });
    await rm(join(dir, 'codex-home', 'auth.json'));
    await m.prepare();
    expect(await readFile(join(dir, 'codex-home', 'auth.json'), 'utf8')).toBe(V1);
  });

  it('失敗の知らせは降りている版つきで出す。降りていなければ出さない', async () => {
    const m = mirror();
    m.reportFailure('x');
    expect(notices).toEqual([]);
    await m.set({ value: V1, revision: 'r1' });
    m.reportFailure('refresh token expired');
    expect(notices).toEqual([
      { kind: 'failed', baseRevision: 'r1', reason: 'refresh token expired' },
    ]);
  });

  it('持ち主が指定されていれば、ディレクトリと（rename の前の）ファイルの持ち主を変える', async () => {
    const chowns: { path: string; uid: number }[] = [];
    const files = new Map<string, string>();
    const m = new CodexAuthMirror({
      codexHome: '/home/worker/.codex',
      owner: { uid: 1001, gid: 1001 },
      onNotice: () => undefined,
      fs: {
        mkdir: async () => undefined,
        writeFile: async (path, data, owner) => {
          if (owner !== undefined) chowns.push({ path: `${path}(tmp)`, uid: owner.uid });
          files.set(path, data);
        },
        readFile: async (path) => files.get(path) ?? null,
        chown: async (path, uid) => {
          chowns.push({ path, uid });
        },
        rm: async (path) => {
          files.delete(path);
        },
      },
    });
    await m.set({ value: V1, revision: 'r1' });
    expect(chowns).toEqual([
      { path: '/home/worker/.codex', uid: 1001 },
      { path: '/home/worker/.codex/auth.json(tmp)', uid: 1001 },
    ]);
  });
});
