import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiAuth } from './auth.js';

/**
 * 本人確認そのものの性質。
 *
 * ここで固定したいのは「通ること」より **「壊れたときに開かないこと」** である。
 * 守りは、置き忘れや読めない設定のときに黙って全開になるのがいちばん危ない。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('API の鍵', () => {
  it('鍵が無ければ本人確認そのものをしない（ローカルの体験を壊さない）', async () => {
    const auth = createApiAuth({});
    expect(await auth.enabled()).toBe(false);
  });

  it('複数配れる（端末ごとに配って、1本だけ消せる）', async () => {
    const auth = createApiAuth({ tokens: 'phone-key, laptop-key' });

    expect(await auth.accepts('phone-key')).toBe(true);
    expect(await auth.accepts('laptop-key')).toBe(true);
    expect(await auth.accepts('someone-else')).toBe(false);
  });

  it('ファイルの鍵は差し替えが即座に効く（デーモンを止めずに締め出せる）', async () => {
    const path = join(dir, 'tokens');
    writeFileSync(path, 'phone-key\nlaptop-key\n');
    const auth = createApiAuth({ file: path });

    expect(await auth.accepts('phone-key')).toBe(true);

    // 失くした端末の鍵を消す
    writeFileSync(path, 'laptop-key\n');

    expect(await auth.accepts('phone-key')).toBe(false);
    expect(await auth.accepts('laptop-key')).toBe(true);
  });

  it('鍵ファイルが読めないとき、開くのではなく閉じる', async () => {
    const auth = createApiAuth({ file: join(dir, 'ここには無い') });

    // **守ると決めた事実は消えない。** 鍵が読めないなら、誰も通さない
    expect(await auth.enabled()).toBe(true);
    expect(await auth.accepts('phone-key')).toBe(false);
    expect(await auth.accepts('')).toBe(false);
  });

  it('空文字は鍵として通らない', async () => {
    const auth = createApiAuth({ tokens: 'real-key' });
    expect(await auth.accepts('')).toBe(false);
  });

  it('空白だけの設定は「鍵が置かれていない」と同じ', async () => {
    const auth = createApiAuth({ tokens: '  ,  ' });
    expect(await auth.enabled()).toBe(false);
  });
});

/**
 * 鍵を消したら、その鍵で開いた画面もその場で閉まること。
 *
 * ここが効かないと「端末ごとに配れば1台だけ締め出せる」が言葉だけになる。
 * cookie の寿命（30日）まで居座られたら、失くした端末を止める手段が
 * 「デーモンを作り直す」＝走行中の仕事を殺すことだけになる。
 */
describe('鍵を消したときの画面', () => {
  it('発行元の鍵が消えれば、その印は知らないものになる', async () => {
    const path = join(dir, 'tokens');
    writeFileSync(path, 'phone-key\nlaptop-key\n');
    const auth = createApiAuth({ file: path });

    const phone = await auth.identify('phone-key');
    const laptop = await auth.identify('laptop-key');
    expect(phone).not.toBeNull();
    expect(laptop).not.toBeNull();
    // 印は鍵そのものではない
    expect(phone).not.toContain('phone-key');

    // 失くした端末の鍵だけを消す
    writeFileSync(path, 'laptop-key\n');

    expect(await auth.knows(phone as string)).toBe(false);
    expect(await auth.knows(laptop as string)).toBe(true);
  });
});
