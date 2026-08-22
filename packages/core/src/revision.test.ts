import { describe, expect, it } from 'vitest';

import { describeBuildRevision, reportRunnerRevision, resolveBuildRevision } from './revision.js';

/**
 * 「自分がどのコミットで走っているか」を解決する唯一の場所（roadmap M5 相当、
 * デーモン/runner が別々にデプロイされる窓に気づくための計器）。
 *
 * **本体は「埋まらなかったときに『取れなかった』と出る」側である。** 埋まった
 * ときに正しい値が出るのは当然として、埋まらなかったときに既定値・プレース
 * ホルダを返さないことを、別の `it()` で明示的に測る。
 *
 * `resolveBuildRevision` の第2引数（`baked`）は `vi.mock` を使わずに「焼き込みが
 * 無かったら」を再現するための DI（このリポジトリは実引数の差し替えを好む —
 * `runner-registry.test.ts` 冒頭のコメント）。**本番コードはこの引数を渡さない**
 * ——渡さなければ実際に焼かれた `CANON_REVISION` が使われる（`revision.ts` の
 * `REAL_BAKED_REVISION`）。
 */

const NONE = { revision: '', source: '' };
const BAKED_BUILD = { revision: 'a'.repeat(40), source: 'build' };
const BAKED_WORKSPACE = { revision: 'b'.repeat(40), source: 'workspace' };

describe('resolveBuildRevision', () => {
  it('焼き込みも実行時変数も無い → 全項目 null（プレースホルダを作らない）', () => {
    const rev = resolveBuildRevision({}, NONE);

    expect(rev).toEqual({ commit: null, short: null, source: null });
    // **これが本体。** 「取れなかった」を、それらしい文字列に化けさせていないこと
    // を明示的に確かめる——実装が誤って `'unknown'` のような固定文字列を返す形へ
    // 書き換わっても、この assert だけは `.toEqual` の形一致で落ちる。
    expect(rev.commit).not.toBe('unknown');
    expect(rev.short).not.toBe('unknown');
    expect(rev.commit).toBeNull();
    expect(rev.short).toBeNull();
    expect(rev.source).toBeNull();
  });

  it('焼き込みがある → commit はフル sha、source は build', () => {
    const rev = resolveBuildRevision({}, BAKED_BUILD);

    expect(rev.commit).toBe(BAKED_BUILD.revision);
    expect(rev.commit).toHaveLength(40);
    expect(rev.source).toBe('build');
    expect(rev.short).not.toBeNull();
  });

  it('焼き込みがある → commit はフル sha、source は workspace', () => {
    const rev = resolveBuildRevision({}, BAKED_WORKSPACE);

    expect(rev.commit).toBe(BAKED_WORKSPACE.revision);
    expect(rev.source).toBe('workspace');
  });

  it('実行時 ALTEROID_BUILD_REV だけがある → source は env', () => {
    const rev = resolveBuildRevision({ ALTEROID_BUILD_REV: 'c'.repeat(40) }, NONE);

    expect(rev.commit).toBe('c'.repeat(40));
    expect(rev.source).toBe('env');
  });

  it('実行時 RAILWAY_GIT_COMMIT_SHA だけがある → source は platform', () => {
    const rev = resolveBuildRevision({ RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40) }, NONE);

    expect(rev.commit).toBe('d'.repeat(40));
    expect(rev.source).toBe('platform');
  });

  it('優先順位: 焼き込みが実行時変数（env）に勝つ', () => {
    const rev = resolveBuildRevision(
      { ALTEROID_BUILD_REV: 'runtime-env-value-should-lose-xxxxxxxxx' },
      BAKED_BUILD,
    );

    expect(rev.commit).toBe(BAKED_BUILD.revision);
    expect(rev.source).toBe('build');
  });

  it('優先順位: 実行時 ALTEROID_BUILD_REV（env）が RAILWAY_GIT_COMMIT_SHA（platform）に勝つ', () => {
    const rev = resolveBuildRevision(
      {
        ALTEROID_BUILD_REV: 'e'.repeat(40),
        RAILWAY_GIT_COMMIT_SHA: 'f'.repeat(40),
      },
      NONE,
    );

    expect(rev.commit).toBe('e'.repeat(40));
    expect(rev.source).toBe('env');
  });

  it('空白だけの環境変数は「無い」として扱う', () => {
    const rev = resolveBuildRevision({ ALTEROID_BUILD_REV: '   ' }, NONE);

    expect(rev).toEqual({ commit: null, short: null, source: null });
  });

  it('焼き込みの source が build/workspace のどちらでもない値なら null 扱いにする', () => {
    // **書き込み側（write-canon.mjs）が壊れて未知の文字列を書いても、
    // 読む側が「知らない出所」をそれらしい値として通さない。**
    const rev = resolveBuildRevision({}, { revision: 'g'.repeat(40), source: 'not-a-real-source' });

    expect(rev.source).toBeNull();
  });
});

describe('describeBuildRevision', () => {
  it('取れなかったとき「不明」と分かる文字列を返す（腐る既定値・それらしい sha を含まない）', () => {
    const text = describeBuildRevision(resolveBuildRevision({}, NONE));

    expect(text).toContain('不明');
    // プレースホルダの sha（全0・全f 等）や 'unknown' のような取り繕いを含まない。
    expect(text).not.toMatch(/[0-9a-f]{40}/);
    expect(text).not.toMatch(/unknown/i);
  });

  it('焼き込みがあるとき、フル sha と短縮の両方を含む1行を返す', () => {
    const text = describeBuildRevision(resolveBuildRevision({}, BAKED_BUILD));

    expect(text).toContain(BAKED_BUILD.revision);
    expect(text).toContain('イメージに焼き込み済み');
  });
});

describe('reportRunnerRevision', () => {
  it('全項目 null の BuildRevision → { status: "unknown" }', () => {
    const report = reportRunnerRevision(resolveBuildRevision({}, NONE));

    expect(report).toEqual({ status: 'unknown' });
  });

  it('揃った BuildRevision → { status: "known", ... }（unreachable にはならない）', () => {
    const report = reportRunnerRevision(resolveBuildRevision({}, BAKED_BUILD));

    expect(report).toEqual({
      status: 'known',
      commit: BAKED_BUILD.revision,
      short: expect.any(String),
      source: 'build',
    });
  });
});
