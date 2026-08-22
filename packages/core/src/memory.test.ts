import { describe, expect, it } from 'vitest';

import {
  assertNeverMemoryProtectionStatus,
  describeMemoryProtectionStatus,
  memoryProtectionAllowsFullReplace,
  renderMemoryDocument,
  renderMemoryDocuments,
} from './memory.js';
import type { MemoryProtectionStatus } from './schema.js';

/**
 * 記憶をクローンの文脈へ載せる形。
 *
 * **ここが器（fs / pg / インメモリ）から移ってきたもの**なので、形そのものを
 * 1か所で固定する。器ごとに持っていた頃、インメモリ実装だけが見出しを付けて
 * おらず、しかもそれに気づける検査がどこにも無かった。
 *
 * 見出しの形（`<!-- memory: slug.md -->`）は**上の層が依存している**。走行中に
 * 変わった文書だけを載せ直すとき、システムプロンプトに載っている塊と同じ見出しで
 * 指せることが前提になっている（`clone.ts` の `#withFreshMemory`）。
 */
describe('記憶の載せ方', () => {
  it('人間が開くファイル名と同じ見出しを付ける', () => {
    expect(renderMemoryDocument({ slug: 'values', content: '# 価値観\n\nあ' })).toBe(
      '<!-- memory: values.md -->\n# 価値観\n\nあ',
    );
  });

  /**
   * 末尾の空白を落とす。**落とさないと文書の境目が見た目で動く** — 人間が
   * エディタで末尾に改行を足しただけで、載せ直しの差分に出る本文が変わる。
   */
  it('末尾の空白だけを落とす（先頭と本文には触らない）', () => {
    const rendered = renderMemoryDocument({ slug: 'a', content: '\n  先頭は残す\n\n\n' });

    expect(rendered).toBe('<!-- memory: a.md -->\n\n  先頭は残す');
    expect(rendered.endsWith('先頭は残す')).toBe(true);
  });

  it('文書のあいだは空行1つで、渡された順序のまま並ぶ', () => {
    expect(
      renderMemoryDocuments([
        { slug: 'b', content: 'に\n' },
        { slug: 'a', content: 'い\n' },
      ]),
    ).toBe('<!-- memory: b.md -->\nに\n\n<!-- memory: a.md -->\nい');
  });

  it('記憶が1つも無ければ空文字（「空」を言うのは呼び手の仕事である）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });
});

/**
 * `MemoryProtectionStatus` の3状態の網羅性。
 *
 * **`unknown` を `clone-only` に畳まないこと。** 判定（`memoryProtectionAllowsFullReplace`）
 * と描画（`describeMemoryProtectionStatus`）のどちらも `switch` の `default` で
 * `assertNeverMemoryProtectionStatus`（引数の型は `never`）へ渡している。
 *
 * **これが型レベルの網羅性チェックである。** 状態を1つ足すと、その `switch` の
 * どの分岐にも当たらなくなった値が `default` まで落ち、`never` へ代入できずに
 * `tsc` が落ちる——分岐を書き足し忘れたまま黙って `unknown` 側に倒れる実装を
 * 防いでいる。ここでは同じ構造の**実行時の裏付け**を確かめる: 3状態それぞれで
 * 例外を投げずに判定・描画ができること（正の保証）と、型で弾かれるはずの
 * 未知の状態が来たら `default` 節が実際に例外を投げること（負の保証。
 * 黙って何かを返して嘘をつかないことの確認）。
 */
describe('MemoryProtectionStatus の網羅性', () => {
  const ALL_STATUSES: MemoryProtectionStatus[] = [
    { kind: 'human' },
    { kind: 'clone-only' },
    { kind: 'unknown' },
  ];

  it('3状態それぞれで判定・描画が例外を投げずに返る', () => {
    for (const status of ALL_STATUSES) {
      expect(() => memoryProtectionAllowsFullReplace(status)).not.toThrow();
      expect(() => describeMemoryProtectionStatus(status)).not.toThrow();
    }
  });

  it('human / unknown は distill からの全文置換を許さず、clone-only だけ許す', () => {
    expect(memoryProtectionAllowsFullReplace({ kind: 'human' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'unknown' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'clone-only' })).toBe(true);
  });

  it('3状態それぞれが異なる一言を返す（unknown を human や clone-only に読み替えない）', () => {
    const labels = new Set(ALL_STATUSES.map((status) => describeMemoryProtectionStatus(status)));
    expect(labels.size).toBe(3);
  });

  it('未知の状態（型では弾かれるはずの値）が来たら、黙って倒れず例外を投げる', () => {
    // `as unknown as MemoryProtectionStatus` は型チェックを迂回する——ここは
    // 「実行時にここへ来たら」という if の話であって、通常の呼び出し経路では
    // 型で弾かれる（switch の default が `never` を要求するのがその強制力）。
    const unknownVariant = { kind: 'new-kind' } as unknown as MemoryProtectionStatus;

    expect(() => memoryProtectionAllowsFullReplace(unknownVariant)).toThrow();
    expect(() => describeMemoryProtectionStatus(unknownVariant)).toThrow();
  });

  it('assertNeverMemoryProtectionStatus 自体も、渡されたものを含めて例外を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryProtectionStatus(bogus)).toThrow(/bogus/);
  });
});
