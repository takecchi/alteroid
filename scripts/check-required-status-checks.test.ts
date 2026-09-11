import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import {
  compareRequiredStatusChecks,
  contextsFromProtection,
  formatComparison,
} from './check-required-status-checks-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * **required contexts の宣言が、ブランチ保護からずれたら赤くなること（#836）。**
 *
 * ## 何が穴だったか
 *
 * `scripts/ci-draft-gating.test.ts` は required contexts を宣言として持ち、それが
 * `ci.yml` の実在のジョブ名に対応していることを固定していた。**`ci.yml` 側には
 * 正しく当たるが、ブランチ保護の側には誰も当たっていなかった** ⟹ protection を
 * 変えると、あの歯は**緑のまま守っている対象だけが変わる。**
 *
 * 「いま一致している」ことは、ずれない理由にならない。**機構は動いているのに、
 * ずれたことを観測する口が無い**——#830（止められたことが見えない）と同じ形である。
 *
 * ## ここで測るもの・測らないもの
 *
 * - **測る**: 突き合わせの判定（純関数）。合成した protection の応答に対して、
 *   一致／ずれ／読めなかった の3つを正しく分けること。
 * - **測る**: 宣言の形（`.github/required-status-checks.json` が読めて、
 *   `contexts` が文字列の配列であること）。
 * - **⚠️ 測らない**: **本物のブランチ保護と一致しているか。** それは
 *   `pnpm check:required-status-checks` の仕事で、ネットワークと administration
 *   権限のトークンが要る（理由は `check-required-status-checks-core.mjs` の doc）。
 *   **この歯が緑でも「いま protection と一致している」ことは1文字も言えない。**
 */

interface Comparison {
  verdict: 'match' | 'drift' | 'unreadable';
  declared: string[];
  live?: string[];
  missing?: string[];
  extra?: string[];
  disagreement?: { contexts: string[]; checks: string[] } | null;
}

/** 本物の応答と同じ形（実測 2026-09-11 の応答は contexts と checks の両方を持っていた）。 */
function protectionWith(names: string[], checkNames: string[] = names): unknown {
  return {
    required_status_checks: {
      strict: false,
      contexts: names,
      checks: checkNames.map((context) => ({ context, app_id: 15368 })),
    },
  };
}

const declaration = JSON.parse(
  readFileSync(path.join(ROOT, '.github/required-status-checks.json'), 'utf8'),
) as { contexts?: unknown; observedAt?: unknown };

describe('宣言の形（.github/required-status-checks.json）', () => {
  it('contexts が文字列の配列である', () => {
    expect(Array.isArray(declaration.contexts)).toBe(true);
    for (const name of declaration.contexts as unknown[]) {
      expect(typeof name).toBe('string');
    }
  });

  /**
   * **いつ測った値なのかを宣言自身が持つ。** 持たないと、読む人は「この値は
   * どのくらい信じてよいか」の線を自分で引けない（AGENTS.md「報告の形」の
   * 「その報告がいつの観測か」と同じ理由）。
   */
  it('observedAt を持つ（いつ測った写しなのかが値自身から取れる）', () => {
    expect(typeof declaration.observedAt).toBe('string');
    expect(Number.isNaN(Date.parse(declaration.observedAt as string))).toBe(false);
  });
});

describe('protection の応答から required contexts を取り出す', () => {
  it('contexts と checks が揃っていれば取り出せる', () => {
    expect(contextsFromProtection(protectionWith(['ci', 'image']))).toEqual({
      names: ['ci', 'image'],
      disagreement: null,
    });
  });

  it('並び順が違っても同じものとして扱う（GitHub は順序を約束していない）', () => {
    expect(contextsFromProtection(protectionWith(['image', 'ci']))?.names).toEqual(['ci', 'image']);
  });

  /**
   * **片方だけが動いた回を取り逃さない。** GitHub は同じものを `contexts`（後方
   * 互換）と `checks`（新しい側）の2つの欄で返す。片方だけ読むと、もう片方だけが
   * 動いた形が見えない。
   */
  it('contexts と checks が食い違っていたら、その食い違い自体を報告する', () => {
    const result = contextsFromProtection(protectionWith(['ci'], ['ci', 'image'])) as {
      names: string[];
      disagreement: { contexts: string[]; checks: string[] } | null;
    };
    expect(result.names).toEqual(['ci', 'image']);
    expect(result.disagreement).toEqual({ contexts: ['ci'], checks: ['ci', 'image'] });
  });

  /**
   * **「読めなかった」と「required が1つも無い」を同じ値にしない。** 空配列は
   * 「保護は在るが required が空」という別の事実で、`null` は「読めていない」で
   * ある。混ぜると、権限が無くて読めていない回が「required が無い」に化ける。
   */
  it('required_status_checks が無ければ null（＝読めなかった）を返す', () => {
    expect(contextsFromProtection({})).toBeNull();
    expect(contextsFromProtection(null)).toBeNull();
  });

  it('required が空でも null にはしない（空は空という事実である）', () => {
    expect(contextsFromProtection(protectionWith([]))).toEqual({ names: [], disagreement: null });
  });
});

describe('宣言と protection の突き合わせ', () => {
  it('一致していれば match', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'image'])),
    ) as Comparison;
    expect(result.verdict).toBe('match');
    expect(formatComparison(result)).toContain('OK');
  });

  it('protection 側に増えていたら drift（宣言に無い側を名指しする）', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'image', 'lint'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.extra).toEqual(['lint']);
    expect(formatComparison(result)).toContain('protection に在って宣言に無い: lint');
  });

  it('protection 側から消えていたら drift（宣言に在る側を名指しする）', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.missing).toEqual(['image']);
    expect(formatComparison(result)).toContain('宣言に在って protection に無い: image');
  });

  it('名前が入れ替わっていたら、両方向を同時に名指しする', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci', 'build'])),
    ) as Comparison;
    expect(result.verdict).toBe('drift');
    expect(result.missing).toEqual(['image']);
    expect(result.extra).toEqual(['build']);
  });

  /**
   * **「読めなかった」を緑へ倒さない。** ここが `match` に化けると、権限が無くて
   * 読めていない状態が「ずれていない」として出力から消える——それは #836 が塞ぐ
   * 穴（ずれても誰も気づかない）を、検査自身の中に作り直すことである。
   */
  it('読めなかったら unreadable。match にも drift にもしない', () => {
    const result = compareRequiredStatusChecks(['ci', 'image'], null) as Comparison;
    expect(result.verdict).toBe('unreadable');
    const text = formatComparison(result);
    expect(text).toContain('判定できなかった');
    expect(text).toContain('これは「ずれていない」ではない');
    // **緑の文言（`OK — 宣言と protection が一致`）を名乗らない。**
    // ⚠️ 素の `OK` で見ないこと —— 本文は `GITHUB_TOKEN` を含み、その中に
    // `OK` の2文字が在るので、素で見ると常に当たる（この歯を書いた最初の版が
    // 実際にそれで赤くなった）。**見るべきは接頭辞のほうである。**
    expect(text).not.toContain('OK — ');
    expect(text.startsWith('check-required-status-checks: 判定できなかった')).toBe(true);
  });
});

describe('赤の意味が、失敗の文そのものに書いてある', () => {
  /**
   * **ずれたときに読む人が最初に知りたいのは「どちらを直すのか」である。**
   * それはこの検査には決められない（宣言が古いのか protection が意図せず変わった
   * のかは、突き合わせからは分からない）。⟹ **決められないことを決められないと
   * 書く**のが、この文の役目である。
   */
  it('drift の文は、どちらが正しいかを決めつけず「決める必要がある」と言う', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'])),
    ) as Comparison;
    const text = formatComparison(result);

    expect(text).toContain('【赤の意味】');
    expect(text).toContain('どちらが正しいかは、この検査には決められない');
    expect(text).toContain('どちらを直すかを人間が決めること');
    // 両側の値がそのまま出る（読む人が自分で判断できる材料になる）。
    expect(text).toContain('宣言: ci / image');
    expect(text).toContain('protection: ci');
    // 直し先が両方とも名指しされている。
    expect(text).toContain('.github/required-status-checks.json');
    expect(text).toContain('リポジトリの設定');
  });

  it('contexts と checks の食い違いは、宣言を直す前にそちらを見ろと言う', () => {
    const result = compareRequiredStatusChecks(
      ['ci', 'image'],
      contextsFromProtection(protectionWith(['ci'], ['ci', 'image'])),
    ) as Comparison;
    const text = formatComparison(result);
    expect(text).toContain('contexts と checks が食い違っている');
    expect(text).toContain('宣言を直す前にそちらを見ること');
  });
});
