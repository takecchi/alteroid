import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **着地した機能を「待ち」「無い」と言い続けている散文を測る歯**（着地元は
 * #944。13箇所の実例は同じ PR の本文にある——最初の11件に加え、"fencing"
 * という語を使わずに同じ主張をしていた2件（`onSwap` の doc、
 * `railway/README.md` の既知のざらつき6番）を、マネージャーの検算で
 * 射程内と確認して追加した）。
 *
 * ## この歯が測るもの・測らないもの
 *
 * `#942` の `scripts/agents-md-references.test.ts` が測るのは**参照の形**
 * （行番号で指しているか、逐語が現物に当たるか）だけで、`roadmap M5 PR4`
 * のような散文の**内容**は1件も測っていない（その歯自身が同じことを逐語で
 * 言っている）。ここが埋めるのはその隙間だが、**埋めるのは「この13件と
 * 同じ言い方の再発」だけである。** 字面（正規表現）で追う以上、新しい言い回し
 * で同じ主張が書かれても、この歯は1件も測っていない——**測っていないものを
 * 測ったように見せないこと**（この注意そのものが上の歯の作法である）。
 *
 * ## 「いま緑で、前提が黙って変わったら赤」という向き
 *
 * **⛔ 「いま赤くて、直したら緑」にはしていない。** 直したので現状は緑だが、
 * この歯の値は別のところにある——**実装の目印を現物から読む**ことで、
 * 「着地した」という前提が（例えば `lease.ts` から `judgeLease` が消える形で）
 * 巻き戻ったときに**赤くなる**設計にしてある。目印を `const … = true` の
 * ような定数で固定していない——固定すると、巻き戻っても歯は気づけない。
 *
 * ## 陰性対照が対になっている理由
 *
 * 「目印が無いときは、その言い回しを許す」ことを確かめるテストを対で置く。
 * これが無いと、fencing を巻き戻したときにこの歯が**素通りする**
 * （あるいは巻き戻った状態を指して誤って赤くなる）のが誰にも見えない。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * fencing（二重実行を止める貸し出し期限）が着地しているか。**現物の export
 * から読む** — 巻き戻せば `judgeLease` / `mayClaim` のどちらかが消え、ここが
 * `false` に落ちる。
 */
export function isFencingLanded(leaseSourceText: string): boolean {
  // ⚠️ `.includes` の素の部分一致は使わない — `judgeLease` を
  // `judgeLeaseRenamed` のように接尾辞つきで改名しても部分一致し続け、
  // 目印が「巻き戻っても false にならない」壊れ方をする（変異試験で実測）。
  // `(` まで見て、その識別子で終わることを確かめる。
  return (
    /export function judgeLease\(/.test(leaseSourceText) &&
    /export function mayClaim\(/.test(leaseSourceText)
  );
}

/**
 * 移送（relocation）が着地しているか。**現物の実装から読む** —
 * `ManagerPool#relocateFrom` の本体（宣言だけでなく実装）と、
 * `apps/daemon` が `onLost` からそれを起こしていることの両方を見る。
 */
export function isRelocationLanded(managerSourceText: string, daemonSourceText: string): boolean {
  return (
    managerSourceText.includes('relocateFrom(runnerId: string): void {') &&
    daemonSourceText.includes('relocateOnLost(runnerId)')
  );
}

export interface StaleLandedClaimCheck {
  readonly feature: string;
  /** 呼び出し側が現物から計算した値を渡す。ここでは判定しない（純粋な走査にするため）。 */
  readonly isLanded: boolean;
  readonly forbidden: readonly RegExp[];
  /** 赤の意味 — 何が着地したから、この言い回しが偽になったのか。 */
  readonly redMeaning: string;
}

export type StaleLandedClaimViolation = {
  file: string;
  line: number;
  feature: string;
  pattern: string;
  text: string;
  redMeaning: string;
};

/**
 * `entries` の各行を `checks` の禁じた言い回しと突き合わせる。
 *
 * **`isLanded` が `false` の check は測らない。** 着地していない機能について
 * 「待ち」「無い」と書くのは嘘ではないので、その check の言い回しは対象から
 * 外れる——これが陰性対照側の中身である。
 */
export function findStaleLandedClaims(
  entries: readonly { file: string; text: string }[],
  checks: readonly StaleLandedClaimCheck[],
): StaleLandedClaimViolation[] {
  const out: StaleLandedClaimViolation[] = [];
  for (const check of checks) {
    if (!check.isLanded) continue;
    for (const { file, text } of entries) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const pattern of check.forbidden) {
          if (pattern.test(line)) {
            out.push({
              file,
              line: i + 1,
              feature: check.feature,
              pattern: pattern.source,
              text: line.trim(),
              redMeaning: check.redMeaning,
            });
          }
        }
      }
    }
  }
  return out;
}

/** この歯自身。走査対象から名前1つで除く（自己参照——自分の doc / fixture が引っかかるため）。 */
const SELF_FILE = 'scripts/stale-landed-claims.test.ts';

/** `git ls-files -z` で追跡済みファイルの相対パスを列挙する（他の歯と同じ形）。 */
function listTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0 && p !== SELF_FILE);
}

const FENCING_FORBIDDEN: readonly RegExp[] = [
  /fencing[^。\n]{0,30}待ち/,
  /fencing(?:（[^）]{0,40}）)?が無い/,
  /fencing[^。\n]{0,10}(?:が|は)[^。\n]{0,20}入って(?:から)/,
  // 「解決するのは fencing（…）である」「…形にするのは fencing（…）である」の
  // どちらも捕まえる（#944 への追い作業。railway/README.md「既知のざらつき」6番の
  // 原文は後者の形で、"待ち" 系の語を1つも含まないため上のパターンには掛からない）。
  /のは fencing[^。\n]{0,20}である/,
  // onSwap / onLost の doc がそれぞれ持っていた「貸し出し期限（lease）が揃って
  // 初めて…できる」という言い回し。"fencing" の語を使っていないため上の
  // パターンには一切掛からないが、同じ「まだ着地していないかのように書く」形。
  /貸し出し期限（lease）が揃って初めて/,
];

const RELOCATION_FORBIDDEN: readonly RegExp[] = [/移送は[^。\n]{0,30}fencing[^。\n]{0,30}の後/];

describe('着地した機能を「待ち」と言い続けている散文（fencing / 移送）', () => {
  const leaseText = readRepoFile('packages/core/src/lease.ts');
  const managerText = readRepoFile('packages/core/src/manager.ts');
  const daemonText = readRepoFile('apps/daemon/src/index.ts');

  it('目印: lease.ts が judgeLease / mayClaim を export している（fencing 着地の確認）', () => {
    // ⚠️ これが false になったら、下の回帰テストは「何も測っていない」緑に
    // 化ける（isLanded が false なら該当 check は測らないため）。だから
    // 目印そのものが実際に true であることを、ここで先に確認しておく。
    expect(isFencingLanded(leaseText)).toBe(true);
  });

  it('目印: ManagerPool#relocateFrom の実装と apps/daemon の onLost 経路が在る（移送着地の確認）', () => {
    expect(isRelocationLanded(managerText, daemonText)).toBe(true);
  });

  it('陽性対照: 目印が在るとき（isLanded=true）、禁じた言い回しは検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '二重実行を止める仕組みは roadmap M5 PR4 の fencing 待ちの既知のギャップである。',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 目印が無いとき（isLanded=false）、同じ言い回しは許される', () => {
    // **これが無いと、fencing を巻き戻したときにこの歯が誤って赤くなる
    // （あるいは何も測っていないことが見えなくなる）ことが誰にも見えない。**
    // fencing が本当に無い間は「fencing 待ち」は嘘ではないので、この歯は
    // 何も言わない——それを直接確かめる。
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '二重実行を止める仕組みは roadmap M5 PR4 の fencing 待ちの既知のギャップである。',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 「のは fencing…である」形（"待ち"を含まない）も検出される（railway/README.md「既知のざらつき」6番の原文）', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '片側だけで言える形にするのは fencing（roadmap M5 PR4）である',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 「のは fencing…である」形も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '片側だけで言える形にするのは fencing（roadmap M5 PR4）である',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 「貸し出し期限（lease）が揃って初めて」形（onSwap / onLost の元の文言）も検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '貸し出し期限（lease）が揃って初めて引き取りの契機にできる。この口が出すのは知らせだけである。',
        },
      ],
      [
        {
          feature: 'fencing（合成）',
          isLanded: true,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 「貸し出し期限（lease）が揃って初めて」形も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '貸し出し期限（lease）が揃って初めて引き取りの契機にできる。この口が出すのは知らせだけである。',
        },
      ],
      [
        {
          feature: 'fencing（合成・未着地のふり）',
          isLanded: false,
          forbidden: FENCING_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('陽性対照: 移送も同様に、目印が在れば検出される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '減らす操作は、移送は fencing の後（roadmap M5 PR4 → PR5）でしかできない。',
        },
      ],
      [
        {
          feature: '移送（合成）',
          isLanded: true,
          forbidden: RELOCATION_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('陰性対照: 移送も、目印が無ければ許される', () => {
    const violations = findStaleLandedClaims(
      [
        {
          file: 'synthetic.md',
          text: '減らす操作は、移送は fencing の後（roadmap M5 PR4 → PR5）でしかできない。',
        },
      ],
      [
        {
          feature: '移送（合成・未着地のふり）',
          isLanded: false,
          forbidden: RELOCATION_FORBIDDEN,
          redMeaning: '合成テスト',
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it('本物: 追跡ファイルのどこにも、着地済み機能を「待ち」と言う散文が残っていない（回帰）', () => {
    const files = listTrackedFiles();
    // 「走査対象が0件なので緑」を緑と読まないための足場（check-no-grep-vc.test.ts と同じ形）。
    expect(files.length).toBeGreaterThan(100);

    const entries: { file: string; text: string }[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readRepoFile(file);
      } catch {
        continue; // 追跡されているが読めないもの（symlink の切れ端など）
      }
      if (text.includes('\0')) continue; // バイナリ
      entries.push({ file, text });
    }

    const violations = findStaleLandedClaims(entries, [
      {
        feature: 'fencing（#160。二重実行を止める貸し出し期限）',
        isLanded: isFencingLanded(leaseText),
        forbidden: FENCING_FORBIDDEN,
        redMeaning:
          'fencing は #160 で着地済み。同名2台の併存も #209 が貸し出しの引き取り側で ' +
          '塞ぎ、Issue #200 は CLOSED——ただし Registry#get 自身の一意性はいまも未解決 ' +
          '（主張は残し、住所を #160・#200・#209・#485 へ倒すこと）。',
      },
      {
        feature: '移送（relocation。#485 PR-2 / apps/daemon の onLost ハンドラ）',
        isLanded: isRelocationLanded(managerText, daemonText),
        forbidden: RELOCATION_FORBIDDEN,
        redMeaning:
          '移送は #485 PR-2（`POST /runners/vacate` / `ManagerPool#relocateFrom`）と ' +
          '`apps/daemon` の `onLost` ハンドラで着地済み。「まだ fencing 待ち」ではなく、' +
          '「どの器を空けるかの判断はクローンの仕事で、このスクリプトはまだその口を呼ばない」' +
          'が正しい理由である。',
      },
    ]);

    expect(
      violations.map(
        (v) =>
          `${v.file}:${v.line} [${v.feature}] /${v.pattern}/ ← "${v.text}"\n  赤の意味: ${v.redMeaning}`,
      ),
    ).toEqual([]);
  });
});
