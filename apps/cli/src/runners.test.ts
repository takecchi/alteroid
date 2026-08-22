import { describe, expect, it } from 'vitest';

import { renderRunners } from './runners.js';

/**
 * `alteroid runners` の**文言**。
 *
 * ここで固定したいのは、**端末に居る人間がクローンと同じ材料を読めること**である。
 * 同じ状態をクローンは `runner_list` で読み（`packages/core/src/tools.test.ts` の
 * 「デーモンの版と runner の版を、同じ出力に並べて出す」）、人間は Web UI の設定画面
 * （`apps/web/app/routes/settings.test.tsx`）とこの口で読む。**3つのどれかにだけ
 * 出ると、「自分が走っているコードはどれか」の答えが口によって違うことになる。**
 */

const KNOWN_DAEMON = {
  status: 'known',
  commit: 'b'.repeat(40),
  short: 'b'.repeat(12),
  source: 'build',
} as const;

const RUNNER = {
  label: 'https://runner-a.internal',
  state: 'connected',
  runnerId: 'runner-a',
  workspacePath: '/work',
};

describe('renderRunners', () => {
  it('デーモンの版と runner の版を、同じ出力に並べて出す', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
        },
      ],
      daemonRevision: KNOWN_DAEMON,
    });

    // フル sha を両方出す（短縮だけだと `gh api .../compare` へ貼れない）。
    expect(text).toContain('a'.repeat(40));
    expect(text).toContain('b'.repeat(40));
  });

  /**
   * **0台のときこそ版が要る。** 0台は「まだ配線されていない」状態、つまり版を
   * 確かめたい状態そのものである。早期 return の側に版を載せ忘れると、そこでだけ
   * 答えが消える——1台以上のテストは通るので、落ちる場所がここにしか無い。
   */
  it('runner が0台でも、デーモンの版は出す', () => {
    const text = renderRunners({ runners: [], daemonRevision: KNOWN_DAEMON });

    expect(text).toContain('0台');
    expect(text).toContain('b'.repeat(40));
  });

  /**
   * **`unknown` と `unheard` を畳まない。** 前者は器の設定を疑う側、後者は登録と
   * ネットワークを疑う側で、次の手が違う。
   */
  it('版の「不明」と「未確認」を、別の言葉で出す', () => {
    const text = renderRunners({
      runners: [
        { ...RUNNER, revision: { status: 'unknown' } },
        {
          label: 'https://runner-silent.internal',
          state: 'unreachable',
          revision: { status: 'unheard' },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('不明');
    expect(text).toContain('未確認');
  });

  it('版が取れていないとき、それらしい sha を作らない', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).not.toMatch(/[0-9a-f]{7,}/);
  });

  /**
   * **いま応えているプロセスも出す（版と並べて）。**
   *
   * クローンの `runner_list` と Web UI の設定画面は既に両方を出している
   * （`packages/core/src/tools.test.ts` / `apps/web/app/routes/settings.test.tsx`）。
   * **ここに片方しか出ないと、この口でだけ判定材料が欠ける** — まさにこの PR が
   * 直している非対称と同じ形である。
   */
  it('応えているプロセスと版を、両方出す', () => {
    const text = renderRunners({
      runners: [
        {
          ...RUNNER,
          instanceId: 'boot-2',
          instanceSince: '2026-08-22T03:04:00.000Z',
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('boot-2');
    expect(text).toContain('a'.repeat(40));
  });

  /**
   * **名乗らない器について黙らない。** 空欄にすると「入れ替わっていない」と
   * 「判定できない」が同じに見える。
   */
  it('プロセスを名乗らない器では「判定できない」と書く', () => {
    const text = renderRunners({
      runners: [{ ...RUNNER, revision: { status: 'unheard' } }],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('入れ替わりを判定できない');
  });

  /**
   * **state を5値のまま出す。** `unreachable`（まだ開けていない）と `lost`
   * （開けていたのに黙った）を畳むと、走っていた仕事ごと黙った器を人間が見逃す。
   */
  it('state を畳まずそのまま出す', () => {
    const text = renderRunners({
      runners: [
        { ...RUNNER, state: 'lost', revision: { status: 'unheard' } },
        {
          label: 'https://runner-b.internal',
          state: 'unreachable',
          revision: { status: 'unheard' },
        },
      ],
      daemonRevision: { status: 'unknown' },
    });

    expect(text).toContain('[lost]');
    expect(text).toContain('[unreachable]');
  });
});
