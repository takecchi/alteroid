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
 * （`.github/workflows/pr-title.yml`）へ置いた。**`pr-title-type` 自身は
 * 2026-09-22 に takecchi の判断で廃止され、`pr-title.yml` ごと消えた**
 * （逐語「『PR title』ワークフロー、これ無駄なので消してください」）。**ただし
 * 走査を `.github/workflows/` 全体へ広げた理由——required な門が `ci.yml` の外に
 * 実在しうること——はそのまま残る。** 現に `no-attribution-trailers`
 * （`.github/workflows/no-attribution-trailers.yml`）は required のまま別
 * workflow に在り続けている。
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
 *
 * **⛔ `why` に「他の `check:*` は一般にこう扱われている」と書かないこと。**
 * 引くのは**実在する先例の名前と、その具体の理由**だけにする。上の doc が
 * 言うとおり、**この歯は `why` の中身が正しいかを測っていない**——誤った
 * 一般則を書いても赤くならず、次に `why` を書く人はここを根拠に判断する。
 *
 * 実例（2026-09-17、`check:keyword-closed-issues` を足したとき）: 最初の
 * `why` は「required にしない以上 workflow から呼ぶ理由も無い
 * （`check:pr-closing-keywords` と同じ理由）」と書いていた。**どちらも誤り
 * だった**——`check:pr-closing-keywords` はこの免除表に載っておらず、
 * `.github/workflows/pr-closing-keywords.yml` から呼ばれている。⟹
 * **required でない門が workflow から呼ばれている実例が同じ repo に在り、
 * 「required でない ⟹ workflow から呼ばない」という一般則はその時点で
 * 偽だった。** 人のレビューで見つかるまで、どの歯も鳴らなかった。
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
      '⚠️ **この免除は「配線しなくてよい」ではない。そして「いまの手持ちのトークンでは配線できない」でもない' +
      ' —— 2026-09-23 に「配線しない」と決めた**（#1320。クローンの判断であって、人間のオーナーの回答ではない）。' +
      'administration を読めるトークンを secret に置けば ci.yml の schedule の回から呼べるが、' +
      '**それはやってはいけない側である** —— この repo の `main` は `enforce_admins: true`' +
      '（管理者すら CI を迂回できない、という明示の判断。実測 2026-09-23）であり、' +
      '**administration スコープは protection の「読む」と「書く」を分けられない**ので、' +
      '読むためだけに置いたトークンが、その判断を取り消せる鍵になる。' +
      '⟹ **機械に権限を渡す代わりに、権限を既に持っている側（クローン）が' +
      '`pnpm check:required-status-checks` を定期的に打つ。**' +
      '⭐ **「自動化できない」と「自動化してはいけない」は別である。**' +
      '後者の答えは「人（またはクローン）が定期的に見る」であって、「配線を諦めた」ではない。',
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
    expect(WORKFLOW_FILES).toContain('no-attribution-trailers.yml');
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

/**
 * workflow の**トップレベルの `on:` に、PR の更新で起動する `pull_request:` が
 * 在るか**（Issue #1297）。
 *
 * `pull_request:` が在っても、`types:` を絞って `synchronize` を外している
 * workflow（例: `issue-done-trailer.yml` は `types: [closed]`）は、PR へ push
 * しても走らない。⟹ `types:` が在るなら `synchronize` を含むことまで見る。
 * `types:` が無ければ GitHub の既定（`opened` / `synchronize` / `reopened`）で
 * 走るので、それでよい。
 *
 * **YAML パーサは使わない**（この repo の他の歯と同じく文字列で読む）。見るのは
 * `on:` 直下の2字下げのキーと、`pull_request:` 直下の `types:` の行だけである。
 */
function runsOnPullRequestUpdates(workflowText: string): boolean {
  const lines = workflowText.split('\n');
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex === -1) return false;
  let inPullRequest = false;
  let sawPullRequest = false;
  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line)) break; // `on:` の塊を抜けた
    const key = /^ {2}([a-z_]+):/.exec(line);
    if (key) {
      inPullRequest = key[1] === 'pull_request';
      if (inPullRequest) sawPullRequest = true;
      continue;
    }
    const types = inPullRequest ? /^ {4}types:\s*\[([^\]]*)\]/.exec(line) : null;
    if (types) {
      return (types[1] ?? '').split(',').some((t) => t.trim() === 'synchronize');
    }
  }
  return sawPullRequest;
}

/** PR の更新で起動する workflow のどれかに `run: pnpm check:<name>` が在るか。 */
function wiredInPullRequestWorkflows(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm');
  return WORKFLOW_TEXTS.some((text) => runsOnPullRequestUpdates(text) && pattern.test(text));
}

/**
 * **「`STEPS` だけ」に配線された門を赤にする**（Issue #1297）。
 *
 * 上の「どれかに載っている」は OR なので、`STEPS` にだけ載せても緑になる。
 * だが `ci.yml` の `ci` job は `pnpm verify` を呼ばず、門を1本ずつ `run:` で
 * 並べる形であり、オーナーは「ローカルで `pnpm verify` を通しで回す必要はない。
 * CI に任せる」と指示している。⟹ **`STEPS` にしか無い門は、誰にも当たらない。**
 * 実例: PR #1286 の `check:stale-token-restart-advice` は `STEPS` にだけ配線されて
 * 緑で通り、`ci.yml` へ足して初めて実物に当たると、最初から赤だった。
 *
 * **逆向き（workflow にだけ在る）は赤にしない。**`pr-*` / `base-overlap` は PR
 * 番号やネットワークが要るので `STEPS`（offline で走る手元の一式）に置けず、
 * 片側だけが正しい門が実在する（Issue #1297 の実測）。⟹ 要求するのは
 * 「`STEPS` に在るなら、PR の更新で起動する workflow にも在る」の片向きだけである。
 *
 * **この歯が測っていないこと**: `run:` の行が在ることは見るが、job やステップの
 * `if:` で実際に実行されるかは見ない（上の doc の断りと同じ範囲）。
 */
describe('STEPS にだけ配線された check:* を作らない（PR の CI で一度も走らない穴、Issue #1297）', () => {
  const wiredSteps = wiredInVerifySteps();

  it('前提: STEPS に check:* が1つ以上在る（空集合で緑にならない）', () => {
    expect(wiredSteps.size).toBeGreaterThan(0);
  });

  it('前提: PR の更新で起動する workflow の判定が、実物の ci.yml と issue-done-trailer.yml を正しく分ける', () => {
    const textOf = (file: string) => WORKFLOW_TEXTS[WORKFLOW_FILES.indexOf(file)] ?? '';
    expect(runsOnPullRequestUpdates(textOf('ci.yml'))).toBe(true);
    // `pull_request:` は在るが `types: [closed]` なので、PR へ push しても走らない。
    expect(runsOnPullRequestUpdates(textOf('issue-done-trailer.yml'))).toBe(false);
    // `pull_request:` が無い（schedule / workflow_dispatch だけ）。
    expect(runsOnPullRequestUpdates(textOf('release-prod.yml'))).toBe(false);
  });

  it('STEPS に在る check:* は、PR の更新で起動する workflow の run: にも在る', () => {
    const stepsOnly = [...wiredSteps].filter((name) => !wiredInPullRequestWorkflows(name));
    expect(
      stepsOnly,
      `【赤の意味】次の check:* は scripts/verify-core.mjs の STEPS にしか無く、PR の CI で一度も走らない: ` +
        `${stepsOnly.join(' / ')}\n` +
        'ci.yml の ci job（または pull_request の更新で起動する別の workflow）へ `- run: pnpm <name>` を足すこと。' +
        'STEPS から外して黙らせないこと —— 手元の一式からも消えるだけで、PR で走らないことは変わらない。',
    ).toEqual([]);
  });
});

/**
 * **各 `check:*` が「どの経路で当たるべきか」を宣言させ、実際の配線と突き合わせる**
 * （Issue #1297 の本命）。
 *
 * 上の2つの歯はどちらも**向きを知らない**。「どれかに載っている」は OR なので片側だけで
 * 満たせ、「STEPS にだけ在るものを作らない」は1つの向きしか見ない。⟹ **「この門は
 * PR で当たるべきなのに、手元の一式にしか居ない」も「手元で当たるべきなのに、PR にしか
 * 居ない」も、どちらが正しいかを歯が知らない**（Issue #1297「逆向きにも正しい形と、
 * 放置された形の両方が在る」）。
 *
 * **⛔ 両側を要求する（AND）では直らない。**片側だけが正しい門が実在する（`pr-*` /
 * `base-overlap` は PR 番号やネットワークが要るので `STEPS` に置けない）。⟹ 向きは
 * 門ごとに違い、**門の側が宣言するしかない。**
 *
 * ## 宣言と実物の分け方（判定の入力を腐らせない）
 *
 * - **宣言（`DECLARED_ROUTES`）は意図だけを持つ。**どの経路に居るべきか、と、片側だけ
 *   にする理由。
 * - **実物は毎回取り直す。**`STEPS`（`scripts/verify-core.mjs`）と `.github/workflows/`
 *   の本文から導出する（上の2つの歯と同じ関数）。宣言に「いま配線されている場所」を
 *   写さない——写すと、宣言が実物の控えになり、ずれても誰も気づかない。
 * - **宣言が要るのは配線される門だけである。**どこにも配線しない門は、上の `EXEMPT`
 *   が理由付きで持っている（二重に持たない）。ここでは `EXEMPT` の門が**実際にどこにも
 *   配線されていないこと**だけを足して見る——免除しておきながら配線されていれば、免除の
 *   `why` が現物とずれている。
 *
 * 経路は3つ:
 * - `steps` —— `STEPS` の `args` に在る（手元の `pnpm verify`）
 * - `pr` —— PR の更新で起動する workflow の `run:` に在る（`runsOnPullRequestUpdates`）
 * - `other` —— それ以外の workflow（`push` / `schedule` 等）の `run:` に在る
 *
 * **この歯が測っていないこと**: 上の2つと同じく、`run:` の行が在ることは見るが、job や
 * ステップの `if:` で実際に実行されるかは見ない。そして **`why` が正しいかは測っていない**
 * （非空であることしか見ない。`EXEMPT` の doc と同じ限界）。
 */
type Route = 'steps' | 'pr' | 'other';

interface DeclaredRoutes {
  readonly routes: readonly Route[];
  /** `steps` と `pr` の両方でない（＝片側だけ・`other` を含む）ときは必須。 */
  readonly why?: string;
}

const ONLY_ON_PR_BECAUSE_NEEDS_PR =
  'PR の番号・本文・コミット列を GitHub から読む門で、`STEPS`（offline で走る手元の一式）には置けない。';

const DECLARED_ROUTES: Record<string, DeclaredRoutes> = {
  'check:restart-before-check-advice': { routes: ['steps', 'pr'] },
  'check:sdk-quotes': { routes: ['steps', 'pr'] },
  'check:stale-token-restart-advice': { routes: ['steps', 'pr'] },
  'check:web-bundle-node-traces': { routes: ['steps', 'pr'] },
  'check:web-bundle-size': { routes: ['steps', 'pr'] },
  'check:web-css-comment-classnames': { routes: ['steps', 'pr'] },
  'check:agents-md-size': {
    routes: ['pr'],
    why:
      '`STEPS` への組み込みは #1191 の着地後の別便と決めてあり、いまは ci.yml の1行だけが門である' +
      "（逐語は `grep -Fn -- 'あちらは #1191 で別の担当が改修中で' .github/workflows/ci.yml`）。",
  },
  'check:base-overlap': {
    routes: ['pr'],
    why:
      'PR の base と head の重なりを見る門で、PR が無ければ問いが立たない。' +
      ONLY_ON_PR_BECAUSE_NEEDS_PR,
  },
  'check:required-gate-workflows': {
    routes: ['pr'],
    why:
      '`gh api repos/…/actions/workflows` でネットワークへ出る（`actions: read`）。`STEPS` は offline で' +
      '走る一式なので、繋がらなかったことと門が死んでいることが同じ赤になる。',
  },
  'check:no-attribution-trailers': { routes: ['pr'], why: ONLY_ON_PR_BECAUSE_NEEDS_PR },
  'check:pr-closing-keywords': { routes: ['pr'], why: ONLY_ON_PR_BECAUSE_NEEDS_PR },
  'check:pr-line-number-citations': { routes: ['pr'], why: ONLY_ON_PR_BECAUSE_NEEDS_PR },
  'check:pr-vanished-footprint': { routes: ['pr'], why: ONLY_ON_PR_BECAUSE_NEEDS_PR },
  'check:main-commit-trailers': {
    routes: ['other'],
    why:
      '`main` へ入った squash コミットを見る門で、squash コミットはマージした瞬間に初めて存在する' +
      '（Issue #1314）。PR の run からは原理的に見えないので `push` の workflow にだけ居る。',
  },
};

/** 実物の経路（毎回取り直す）。 */
function actualRoutes(name: string, wiredSteps: ReadonlySet<string>): Route[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm');
  const routes: Route[] = [];
  if (wiredSteps.has(name)) routes.push('steps');
  if (WORKFLOW_TEXTS.some((text) => runsOnPullRequestUpdates(text) && pattern.test(text))) {
    routes.push('pr');
  }
  if (WORKFLOW_TEXTS.some((text) => !runsOnPullRequestUpdates(text) && pattern.test(text))) {
    routes.push('other');
  }
  return routes;
}

const sortedRoutes = (routes: readonly Route[]): Route[] => [...routes].sort();

describe('各 check:* は、宣言した経路にだけ配線されている（Issue #1297）', () => {
  const scripts = readPackageJsonCheckScripts();
  const wiredSteps = wiredInVerifySteps();
  const exempt = new Set(EXEMPT.map((e) => e.script));

  it('どの check:* も、DECLARED_ROUTES か EXEMPT のちょうど一方に載っている（足した門は宣言を強制される）', () => {
    const undeclared = scripts.filter((name) => !(name in DECLARED_ROUTES) && !exempt.has(name));
    const both = scripts.filter((name) => name in DECLARED_ROUTES && exempt.has(name));
    expect(
      { undeclared, both },
      '【赤の意味】undeclared の門は、どの経路で当たるべきかが宣言されていない。' +
        'この歯（scripts/check-scripts-wired.test.ts）の DECLARED_ROUTES へ経路を宣言すること' +
        '（どこにも配線しないなら EXEMPT へ理由付きで）。both の門は両方に載っている。',
    ).toEqual({ undeclared: [], both: [] });
  });

  it('DECLARED_ROUTES に、package.json に無い門が残っていない（消した門の宣言を残さない）', () => {
    const stale = Object.keys(DECLARED_ROUTES).filter((name) => !scripts.includes(name));
    expect(stale).toEqual([]);
  });

  it('片側だけ（steps と pr の両方ではない）と宣言した門は、why が非空である', () => {
    const missingWhy = Object.entries(DECLARED_ROUTES)
      .filter(([, d]) => {
        const both = d.routes.length === 2 && d.routes.includes('steps') && d.routes.includes('pr');
        return !both && (d.why ?? '').trim().length === 0;
      })
      .map(([name]) => name);
    expect(missingWhy).toEqual([]);
  });

  it('宣言した経路と、実物の経路が門ごとに一致する（どちらの向きのずれも赤）', () => {
    const mismatches = Object.entries(DECLARED_ROUTES)
      .map(([name, d]) => ({
        name,
        declared: sortedRoutes(d.routes),
        actual: sortedRoutes(actualRoutes(name, wiredSteps)),
      }))
      .filter((m) => m.declared.join(',') !== m.actual.join(','));
    expect(
      mismatches,
      '【赤の意味】次の門は、宣言した経路（declared）と実際に配線されている経路（actual）が違う。' +
        'steps = scripts/verify-core.mjs の STEPS、pr = PR の更新で起動する workflow の run:、' +
        'other = それ以外の workflow の run:。配線を宣言に合わせるか、意図が変わったなら宣言と why を直すこと。',
    ).toEqual([]);
  });

  it('EXEMPT の門は、実際にどこにも配線されていない（免除の why が現物とずれていない）', () => {
    const wiredAnyway = EXEMPT.map((e) => ({
      name: e.script,
      actual: actualRoutes(e.script, wiredSteps),
    })).filter((m) => m.actual.length > 0);
    expect(wiredAnyway).toEqual([]);
  });
});
