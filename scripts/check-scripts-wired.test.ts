import { readdirSync, readFileSync } from 'node:fs';
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
 * 手元の一式）か `.github/workflows/` 配下のどれかに `run:` / `args`
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
 * - `.github/workflows/` 配下の**どれか**に `run: pnpm check:<name>` の行が在る
 * - 下の `EXEMPT`（理由付きの免除表）に載っている
 *
 * ## この歯が測っていないこと
 *
 * - **`STEPS` / workflow に載っていることは見るが、実行されることまでは見ない。**
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

const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');

/**
 * `.github/workflows/` 配下の workflow ファイル全部。
 *
 * **⚠️ ここはかつて `ci.yml` 1本だけを読んでいた。** それは「門はすべて
 * `ci.yml` の中に在る」という前提に乗っていて、**その前提は 2026-09-16 に崩れた**
 * —— Issue #1097 の `pr-title-type` は、PR タイトルの後からの書き換えを捕まえる
 * ために `pull_request.types` へ `edited` が要り、それを `ci.yml` へ足すと
 * required な `ci` / `image` が本文の編集ごとに焼き直される。だから別 workflow
 * （`.github/workflows/pr-title.yml`）へ置いた。
 *
 * ⟹ **`ci.yml` だけを見る形のままだと、この歯は「配線されているのに配線されて
 * いない」と言う。** そして残る直し方は `EXEMPT` へ載せることだけで、それは
 * **免除表に嘘を書く**ことになる（実際には呼ばれているのだから）。**免除表が嘘を
 * 持つと、本物の穴——その workflow ごと消えて本当に呼ばれなくなった回——を
 * この歯が二度と捕まえられない。**
 *
 * ⟹ 走査を `.github/workflows/` 全体へ広げる。**これは緩和ではなく、この歯の
 * 元の意図（「どの門からも呼ばれていない穴を作らない」）そのものである** ——
 * 門が `ci.yml` の中に在るかどうかは、その意図に一度も含まれていなかった。
 */
export const WORKFLOW_FILES: string[] = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

const WORKFLOW_TEXTS: string[] = WORKFLOW_FILES.map((name) =>
  readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'),
);

/**
 * `.github/workflows/` 配下のどれかに `run: pnpm check:<name>` の形で実際に
 * 呼ぶ行が在るか。
 *
 * **単なる文字列の出現ではなく `run:` の行を見る。** workflow はこの検査自身の
 * doc コメントの中で他の `check:*` の名前に触れることがあるので、コメント中の
 * 言及を「呼ばれている」と誤読しないよう、実行行の形に絞る。
 */
function wiredInWorkflows(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm');
  return WORKFLOW_TEXTS.some((text) => pattern.test(text));
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

const EXEMPT: Exemption[] = [
  {
    script: 'check:keyword-closed-issues',
    why:
      '「閉じるキーワードで閉じた疑いのある Issue」を後から一覧する報告ツールであって、CI の門ではない' +
      '（Issue #1128）。何を赤くするかの基準（閾値の確からしさ）を確定させる機構が無いため required にはしない。' +
      'STEPS（scripts/verify-core.mjs）にも入れない —— `gh api` / `gh pr list` でネットワークへ出るため' +
      '（`check:pr-green` の免除理由と同じ形。あちらも「引数を取る手動/エージェント用の道具」として' +
      'STEPS からも workflow からも意図的に外れている）。' +
      '非 required の schedule workflow（門ではなく警報の回。`check:required-status-checks` の免除欄が' +
      '挙げている置き場所）から呼ぶ形も考えられるが、いまは足していない —— ' +
      '(1) 出力先（コメント/新規 Issue/Slack 等）を1つも決めておらず、この repo は出自の刻印（#893）のような' +
      '自動投稿の仕組みを「使われていない」として明示的にやめた前例を持つ（新しい自動投稿の宛先を無断で作らない）。' +
      '(2) `issues/events` の全履歴走査は呼ぶたびにネットワーク費用が掛かる。' +
      '(3) 依頼の時点でこの道具は「手で走らせる報告ツール」として明示的に切り出されている' +
      '（Issue #1128 本文も「報告の形が合うかもしれない」と言うだけで、自動配信までは要求していない）。' +
      'schedule 経由に広げるかどうかは人間の判断であり、この PR の範囲外。',
  },
  {
    script: 'check:pr-green',
    why:
      '引数に sha を取る手動/エージェント用の道具であり、CI の門ではない（Issue #933）。' +
      'STEPS（scripts/verify-core.mjs）には入れない —— `pnpm test` は offline でも走るが、' +
      'この道具は `gh api` でネットワークへ出るので同じ理由で足せない' +
      '（`check:required-status-checks` の免除理由と同じ形）。' +
      'ci.yml にも足さない —— この道具が答える問いは「指定した sha の最新世代の CI が緑か」で、' +
      '呼ぶとしたら「まさにいま走っている CI 自身」を対象にすることになり、' +
      '自分自身の未完了を自分で問い合わせる循環になる。使うのは push 後に' +
      '`gh pr ready` や rebase を挟んだ後、エージェントが手元で ' +
      '`pnpm check:pr-green -- <sha>` として叩く場面である。',
  },
  {
    script: 'check:required-status-checks',
    why:
      'ブランチ保護の読み出しに administration 相当の権限が要り、**CI の既定の GITHUB_TOKEN には付けられない**' +
      '（GitHub Actions の `permissions:` に指定できるスコープに administration が無い。実測 2026-09-11、' +
      '公式の workflow syntax から取得した全16個は actions / artifact-metadata / attestations / checks / ' +
      'code-quality / contents / deployments / discussions / id-token / issues / packages / pages / ' +
      'pull-requests / security-events / statuses / vulnerability-alerts）。' +
      'STEPS（手元の一式）にも入れていない —— `pnpm test` は offline でも走るので、ネットワークを足すと' +
      '「ずれている」と「繋がらなかった」が同じ赤になる。' +
      '⚠️ **この免除は「配線しなくてよい」ではなく「いまの手持ちのトークンでは配線できない」である。**' +
      'administration を読めるトークンを secret として置けるなら、ci.yml の schedule の回' +
      '（門ではなく警報の回）へ `run: pnpm check:required-status-checks` を足すのが本来の置き場所である。',
  },
];

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

  /**
   * **走査が空・1本だけ、を「該当なし」として静かに通さない。**
   *
   * `WORKFLOW_FILES` が0本になれば `wiredInWorkflows` は常に false を返し、
   * 全部の `check:*` が「配線されていない」側へ倒れる——これは赤くなるので
   * 気付ける。**気付けないのは逆で、走査が `ci.yml` 1本へ戻ったとき**である:
   * そのとき落ちるのは「別 workflow に置かれた門」だけなので、`EXEMPT` へ
   * 載せて黙らせる圧力が生まれる（上の `WORKFLOW_FILES` の doc を見よ）。
   * **⟹ 走査が複数本を見ていることそのものを歯にする。**
   */
  it('走査対象の workflow が ci.yml 1本ではない（別 workflow の門を見落とさない）', () => {
    expect(WORKFLOW_FILES).toContain('ci.yml');
    expect(WORKFLOW_FILES).toContain('pr-title.yml');
    expect(WORKFLOW_FILES.length).toBeGreaterThan(1);
  });

  it('どの check:* も、STEPS・workflow・免除表のどれかに載っている', () => {
    const exempt = new Set(EXEMPT.map((e) => e.script));
    const uncovered = checkScripts.filter(
      (name) => !wiredSteps.has(name) && !wiredInWorkflows(name) && !exempt.has(name),
    );
    expect(
      uncovered,
      `【赤の意味】次の check:* が、scripts/verify-core.mjs の STEPS にも ` +
        '.github/workflows/ 配下のどの run: にも免除表にも載っていない: ' +
        `${uncovered.join(' / ')}\n` +
        '足した check:* は、STEPS（scripts/verify-core.mjs）へ足すか .github/workflows/ のどれかの run: へ足すか、' +
        'この歯（scripts/check-scripts-wired.test.ts）の EXEMPT へ理由付きで載せること。',
    ).toEqual([]);
  });
});
