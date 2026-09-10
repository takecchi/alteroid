import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { STEPS } from './verify-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * **族の歯。`check:web-css-comment-classnames` が、実装は在るのにどの門からも
 * 呼ばれていなかった穴（このコミットで塞いだ）の再発を防ぐ。**
 *
 * ## 何のためにここが在るか
 *
 * `package.json` の `scripts` に `check:*` を足しても、それだけでは何も検査
 * しない——`scripts/verify-core.mjs` の `STEPS`（`pnpm verify` / `pnpm test` 前の
 * 手元の一式）か `.github/workflows/ci.yml`（CI）のどちらかに `run:` / `args`
 * として書かない限り、その道具は一度も実行されない。`check:sdk-quotes`
 * （#646）と `check:web-css-comment-classnames`（#317）は、どちらも実装が
 * 揃ってから配線されるまで期間が空いた。**「実装した」と「配線した」は別の
 * 事実で、後者を機械で見ていなかった。**
 *
 * ## 測っているもの
 *
 * `package.json` の `scripts` から `check:` 始まりの名前を**導出**し（ベタ書き
 * しない——導出しないと、次に足された5本目がここに現れず、歯自体が黙って
 * 陳腐化する）、各名前が次のどれかに載っているかを見る。
 *
 * - `scripts/verify-core.mjs` の `STEPS` の `args` に `check:<name>` が在る
 * - `.github/workflows/ci.yml` に `run: pnpm check:<name>` の行が在る
 * - 下の `EXEMPT`（理由付きの免除表）に載っている
 *
 * ## この歯が測っていないこと
 *
 * - **`STEPS` / `ci.yml` に載っていることは見るが、実行されることまでは見ない。**
 *   `if:` 条件で実行されない形に変わっても、この歯は「書いてある」を見て緑を
 *   返す（`.github/scripts/verify-for-sdk-pr.test.ts` の同種の断りと同じ形）。
 * - **`EXEMPT` の `why` が正しいかは測っていない。** 非空の文字列が在ることしか
 *   見ない——「後で配線する」と書いて放置されても、ここでは捕まらない。
 */

function readPackageJsonCheckScripts(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith('check:'));
}

/** `STEPS` の `args` に現れる `check:*` の集合。値をベタ書きせず STEPS から導出する。 */
function wiredInVerifySteps(): Set<string> {
  const wired = new Set<string>();
  for (const step of STEPS as { args: readonly string[] }[]) {
    for (const arg of step.args) {
      if (arg.startsWith('check:')) wired.add(arg);
    }
  }
  return wired;
}

const CI_YML_TEXT = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/**
 * `ci.yml` の中に `run: pnpm check:<name>` の形で実際に呼ぶ行が在るか。
 *
 * **単なる文字列の出現ではなく `run:` の行を見る。** `ci.yml` はこの検査自身の
 * doc コメントの中で他の `check:*` の名前に触れることがあるので、コメント中の
 * 言及を「呼ばれている」と誤読しないよう、実行行の形に絞る。
 */
function wiredInCiYml(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm').test(CI_YML_TEXT);
}

/**
 * 表に載せない `check:*` と、その理由。
 *
 * **`why` は非空でなければならない**（下の歯が測る）。「あとで配線する」を
 * 空文字で表せると、免除表は数合わせの場所になる。
 */
interface Exemption {
  readonly script: string;
  readonly why: string;
}

const EXEMPT: Exemption[] = [];

describe('check:* がどの門からも呼ばれていない穴を作らない（package.json から導出）', () => {
  const checkScripts = readPackageJsonCheckScripts();
  const wiredSteps = wiredInVerifySteps();

  it('前提: package.json に check:* が1つ以上在る', () => {
    expect(checkScripts.length).toBeGreaterThan(0);
  });

  it('免除表の each entry が package.json に実在し、why が非空である', () => {
    const known = new Set(checkScripts);
    for (const entry of EXEMPT) {
      expect(
        known.has(entry.script),
        `免除表の \`${entry.script}\` が package.json の check:* に無い（消えたなら免除表からも消すこと）`,
      ).toBe(true);
      expect(
        entry.why.trim().length > 0,
        `免除表の \`${entry.script}\` の why が空——理由を書くこと`,
      ).toBe(true);
    }
  });

  it('どの check:* も、STEPS・ci.yml・免除表のどれかに載っている', () => {
    const exempt = new Set(EXEMPT.map((e) => e.script));
    const uncovered = checkScripts.filter(
      (name) => !wiredSteps.has(name) && !wiredInCiYml(name) && !exempt.has(name),
    );
    expect(
      uncovered,
      `【赤の意味】次の check:* が、scripts/verify-core.mjs の STEPS にも ` +
        '.github/workflows/ci.yml の run: にも免除表にも載っていない: ' +
        `${uncovered.join(' / ')}\n` +
        '足した check:* は、STEPS（scripts/verify-core.mjs）へ足すか ci.yml の run: へ足すか、' +
        'この歯（scripts/check-scripts-wired.test.ts）の EXEMPT へ理由付きで載せること。',
    ).toEqual([]);
  });
});
