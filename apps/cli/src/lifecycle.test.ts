import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start, status, stop } from './daemon.js';

/**
 * 鍵を置いたデーモンを、CLI が**自分のものとして認識できる**こと。
 *
 * ここは偽物では確かめられない。`alteroid chat` は `GET /health` の応答で
 * 「いま応答しているのが自分の記録したデーモンか」を確かめてから動くので、
 * その1本に鍵が付いていないだけで、**走っているデーモンが「停止中」に見える**。
 * そうなると同じポートへもう1つ起こそうとして延々と失敗し、`status` は停止中、
 * `stop` は状態ファイルを消すだけになる。鍵を置いた瞬間に持ち主が締め出される
 * という、いちばん避けたい壊れ方である。
 */

const TOKEN = 'cli-integration-key';
let home: string;
let saved: NodeJS.ProcessEnv;

/** 実際に起こすので、他のテストや本人の記憶と器を分ける。 */
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'alteroid-cli-'));
  saved = { ...process.env };
  process.env.ALTEROID_HOME = home;
  // 3〜4万番台の適当な空き。並列実行でぶつからないよう pid を混ぜる
  process.env.ALTEROID_PORT = String(30000 + (process.pid % 20000));
  process.env.ALTEROID_API_TOKEN = TOKEN;
  // 自律の起点は止める（このテストで見たいのは器の生き死にだけ）
  process.env.ALTEROID_DAILY_REPORT_AT = 'off';
  process.env.ALTEROID_INITIATIVE_EVERY = 'off';
  delete process.env.ALTEROID_DATABASE_URL;
  delete process.env.ALTEROID_RUNNER_URL;
});

afterEach(async () => {
  await stop().catch(() => undefined);
  process.env = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('鍵を置いたデーモンと CLI', () => {
  it('start → status → stop が鍵ありでも通る', async () => {
    const info = await start();
    expect(info.port).toBe(Number(process.env.ALTEROID_PORT));

    // **ここが本題。** 鍵を名乗れないと running: false に見える
    const running = await status();
    expect(running.running).toBe(true);
    expect(running.info?.token).toBe(info.token);

    const outcome = await stop();
    expect(outcome).toBe('stopped');

    expect((await status()).running).toBe(false);
  }, 60_000);

  it('鍵をファイルで置いた構成でも、CLI は名乗れる', async () => {
    const tokens = join(home, 'tokens');
    writeFileSync(tokens, `${TOKEN}\n`);
    delete process.env.ALTEROID_API_TOKEN;
    process.env.ALTEROID_API_TOKEN_FILE = tokens;

    await start();

    expect((await status()).running).toBe(true);
    expect(await stop()).toBe('stopped');
  }, 60_000);
});
