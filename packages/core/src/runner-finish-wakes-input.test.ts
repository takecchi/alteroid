import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * 横断レビューで指摘された穴の実害を測る歯。`RunnerSession#finishBody`
 * （`runner.ts`）が呼ぶ `this.#sdkSession.wakeInput()`（口は
 * `RunnerSdkSession`、#1611 で `RunnerSession` から切り出された）を消しても、
 * 既存のテストは全部緑のままだった——ここはその1本を単独で測る。
 *
 * ## 何が起きるはずか（`runner.ts` の逐語）
 *
 * `#inputStream()` はターンの境界で積まれた入力が無いとき
 * `await this.#sdkSession.waitForInput()` で眠る
 * （`RunnerSdkSession#waitForInput` の doc「`#wakeInput` が呼ばれるまで
 * 解決しない」）。`#finishBody` は最初の行で `markStopped()` を呼び
 * `#sdkSession.stopped` を真にしてから、`closeQuery()` の直前で
 * `wakeInput()` を呼ぶ——起こされた `#inputStream` はループの先頭へ戻り、
 * `if (this.#sdkSession.stopped) return;` で `done: true` になって終わる。
 * `#finishBody` のコメント自身が「読み取りが終わっても入力側を起こして
 * 本体を閉じる。怠ると閉じられない Query と起きない `#inputStream` が残る」
 * と言っている——この歯はその主張を実測する。
 *
 * ## 足場について
 *
 * `wakeInput()` を消したときに何が起きるかを見るには、`#inputStream()` の
 * 戻り値（`params.prompt`）を**継続的に**消費する読み手が要る——1回だけ
 * `.next()` を呼んでも、積まれた入力（`start()` が積む最初の1件）を
 * 読み切るまでは `waitForInput()` にすら到達しない。`runner-wakeup.test.ts`
 * / `runner-stop-finish-order.test.ts` の `fakeSdk` と同じ形の背景 drain
 * （`for await (const message of params.prompt) …` を投げっぱなしにする）を
 * 使い、その `for await` が終わったこと（`done: true` を受け取ったこと）を
 * 別の Promise で観測できるようにしてある。
 *
 * 本物の SDK（`packages/core/src/sdk-withdrawn-delivery/` の足場、#1609）を
 * 使う必要は無い——`#inputStream` を起こす／起こさないの分岐は
 * `RunnerSdkSession` の中だけで完結しており、SDK 本体の挙動には依存しない。
 */

interface FakeSession {
  /** ストリームが `result` を伴わず自然終了する（SDK が黙って閉じる形）。 */
  end(): void;
  /** 背景の drain（`params.prompt` を読み続ける `for await`）が終わったか。 */
  promptEnded(): boolean;
  /** 背景の drain が終わるまで待つ Promise。上限は呼び出し側が付ける。 */
  waitForPromptEnded(): Promise<void>;
}

function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let ended = false;
    let endedResolve!: () => void;
    const endedPromise = new Promise<void>((resolve) => {
      endedResolve = resolve;
    });

    const push = (message: SDKMessage | null) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(message);
      } else if (message !== null) {
        buffered.push(message);
      }
    };

    // **背景の読み手。** 本物の SDK が control channel 越しに `#inputStream()`
    // を継続して読み進めるのを模す。積まれた入力を読み切ると
    // `waitForInput()` で眠る——`wakeInput()` が来なければ、この `for await`
    // は二度と終わらない（`ended` が真にならない）。
    void (async () => {
      for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      ended = true;
      endedResolve();
    })();

    const session: FakeSession = {
      end() {
        push(null);
      },
      promptEnded: () => ended,
      waitForPromptEnded: () => endedPromise,
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        push(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-finish-wakes-input-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function firstSession(sessions: readonly FakeSession[]): Promise<FakeSession> {
  return vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
}

/**
 * 上限付きで待つ——ハングさせない（`AGENTS.md` の「CI の完了を待つ形」と
 * 同じ理由。上限に当たったら reject し、テストを赤くする）。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    }),
  ]);
}

describe('#finishBody の wakeInput(): 入力待ちの #inputStream generator を起こす', () => {
  it('自然終了（result なしで for await が抜ける経路）の #finish 後、#inputStream の drain が終わる', async () => {
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-finish-wakes-input',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });
    const session = await firstSession(sessions);

    // sanity: #finish の前は、まだ入力待ちで眠っているだけで drain は終わっていない。
    expect(session.promptEnded()).toBe(false);

    // ストリームが result を伴わず自然終了する
    // → `#read` の `for await` が抜ける → `#finish('done', …)` → `#finishBody`。
    session.end();

    // ⭐ ここが歯の本体。`#finishBody` が `wakeInput()` を呼べば、眠っていた
    // `#inputStream` が起こされて `stopped` を見て return し、背景の drain が
    // 終わる。`wakeInput()` を消すと、この待ちは上限に当たって reject する
    // （赤——`.claude/skills/mutation-testing/SKILL.md` の変異で確認済み）。
    await withTimeout(
      session.waitForPromptEnded(),
      1000,
      '#finishBody の後に #inputStream の generator が終わらなかった(wakeInput() が呼ばれていない疑い)',
    );

    expect(session.promptEnded()).toBe(true);
  });
});
