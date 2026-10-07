import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { STEPS } from './verify-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readPackageJsonCheckScripts(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith('check:'));
}

// `check:*` の名前は `package.json` から導出する: ベタ書きすると次に足された門がここに現れず、歯が黙って陳腐化するため。
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

// `ci.yml` 1本ではなく `.github/workflows/` 全体を走査する: required な門が `ci.yml` の外に実在しうり（`no-attribution-trailers`）、1本だけだと免除表に嘘を書く圧力が生まれるため。
export const WORKFLOW_FILES: string[] = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();

const WORKFLOW_TEXTS: string[] = WORKFLOW_FILES.map((name) =>
  readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'),
);

// 文字列の出現ではなく `run:` の行を見る: workflow のコメント中の言及を「呼ばれている」と誤読しないため。
function wiredInWorkflows(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm');
  return WORKFLOW_TEXTS.some((text) => pattern.test(text));
}

// `why` に「他の `check:*` は一般にこう扱われている」と書かない: この歯は `why` の中身が正しいかを測らず、誤った一般則を書いても赤くならないため。
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
  {
    script: 'check:verified-head',
    why:
      '記録（`.git/alteroid-verify.json` の `tree`）は手元の `.git` の中にしか無く、' +
      'CI の checkout には無い（Issue #1763 が明記して避けている——CI の門にはしない。' +
      '記録を PR へ運ぶ仕組みが要り、それは新しい workflow を足す方向でオーナーの方針' +
      '「テストやビルド以外の無駄なワークフローを消してほしい」（2026-09-24）と逆になる）。' +
      'STEPS（scripts/verify-core.mjs）にも入れない —— `pnpm verify` 自身がこの記録を' +
      '一式の最後に書くので、STEPS の中で自分の直後の記録を確かめても常に一致し、何も測らない' +
      '（記録される前に呼べば記録が無いので必ず判定できない側になる。どちらの順で置いても' +
      '意味のある検査にならない）。使うのは push・ready の前に人・エージェントが手元で' +
      '`pnpm check:verified-head -- <rev>` として叩く場面である' +
      '（`check:pr-green` と同じ「引数を取る手動/エージェント用の道具」の形）。',
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

// `STEPS` を import して共有せず、二重に持つ配列の一致を歯で測る: bash から Node の配列を直接読む口が無く、変換を持ち込むより手で揃えるほうを選んだため。
function readGateArray(shellText: string, varName: string): string[] | null {
  const re = new RegExp(String.raw`${varName}=\(([\s\S]*?)\)`);
  const m = re.exec(shellText);
  if (!m || m[1] === undefined) return null;
  return m[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const quoted = /^'(.*)'$/.exec(line);
      return quoted && quoted[1] !== undefined ? quoted[1] : line;
    });
}

describe('verify-for-sdk-pr.sh の GATE_NAMES / GATE_COMMANDS が STEPS と一致する（ソースの静的な読み、Issue #1954）', () => {
  const VERIFY_FOR_SDK_PR_SH = path.join(ROOT, '.github/scripts/verify-for-sdk-pr.sh');
  const shellText = readFileSync(VERIFY_FOR_SDK_PR_SH, 'utf8');
  const steps = STEPS as { name: string; cmd: string; args: string[] }[];

  it('前提: STEPS が1本以上ある（空集合で緑にならない）', () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it('前提: GATE_NAMES / GATE_COMMANDS をソースから読めた（配列の書き方が変わっていない）', () => {
    expect(readGateArray(shellText, 'GATE_NAMES')).not.toBeNull();
    expect(readGateArray(shellText, 'GATE_COMMANDS')).not.toBeNull();
  });

  it('GATE_NAMES の名前と順序が STEPS と一致する（STEPS に足した門の反映漏れを捕まえる。実例: PR #1952）', () => {
    const gateNames = readGateArray(shellText, 'GATE_NAMES');
    expect(
      gateNames,
      '【赤の意味】.github/scripts/verify-for-sdk-pr.sh の GATE_NAMES が ' +
        'scripts/verify-core.mjs の STEPS と名前・順序で一致しない。STEPS に門を足す/消す/' +
        '並べ替えるときは GATE_NAMES と GATE_COMMANDS も同じ形へ揃えること。',
    ).toEqual(steps.map((step) => step.name));
  });

  it('GATE_COMMANDS の各コマンドが STEPS の cmd + args と一致する（写し間違いを捕まえる）', () => {
    const gateCommands = readGateArray(shellText, 'GATE_COMMANDS');
    const expected = steps.map((step) => [step.cmd, ...step.args].join(' '));
    expect(
      gateCommands,
      '【赤の意味】.github/scripts/verify-for-sdk-pr.sh の GATE_COMMANDS が ' +
        'scripts/verify-core.mjs の STEPS から作った「cmd + args」と一致しない。',
    ).toEqual(expected);
  });
});

function runsOnPullRequestUpdates(workflowText: string): boolean {
  const lines = workflowText.split('\n');
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex === -1) return false;
  let inPullRequest = false;
  let sawPullRequest = false;
  for (const line of lines.slice(onIndex + 1)) {
    if (/^\S/.test(line)) break;
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

function wiredInPullRequestWorkflows(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(String.raw`run:\s*pnpm ${escaped}(?:\s|$)`, 'm');
  return WORKFLOW_TEXTS.some((text) => runsOnPullRequestUpdates(text) && pattern.test(text));
}

// 逆向き（workflow にだけ在る）は赤にしない: `pr-*` / `base-overlap` は PR 番号やネットワークが要り `STEPS` に置けないため。
describe('STEPS にだけ配線された check:* を作らない（PR の CI で一度も走らない穴、Issue #1297）', () => {
  const wiredSteps = wiredInVerifySteps();

  it('前提: STEPS に check:* が1つ以上在る（空集合で緑にならない）', () => {
    expect(wiredSteps.size).toBeGreaterThan(0);
  });

  it('前提: PR の更新で起動する workflow の判定が、実物の ci.yml と issue-done-trailer.yml を正しく分ける', () => {
    const textOf = (file: string) => WORKFLOW_TEXTS[WORKFLOW_FILES.indexOf(file)] ?? '';
    expect(runsOnPullRequestUpdates(textOf('ci.yml'))).toBe(true);
    expect(runsOnPullRequestUpdates(textOf('issue-done-trailer.yml'))).toBe(false);
    expect(runsOnPullRequestUpdates(textOf('release-prod.yml'))).toBe(false);
  });

  it('STEPS に在る check:* は、PR の更新で起動する workflow の run: にも在る', () => {
    const stepsOnly = [...wiredSteps].filter((name) => !wiredInPullRequestWorkflows(name));
    expect(
      stepsOnly,
      `【赤の意味】次の check:* は scripts/verify-core.mjs の STEPS にしか無く、PR の CI で一度も走らない: ` +
        `${stepsOnly.join(' / ')}\n` +
        'ci.yml の検査 job（checks など。または pull_request の更新で起動する別の workflow）へ `- run: pnpm <name>` を足すこと。' +
        'STEPS から外して黙らせないこと —— 手元の一式からも消えるだけで、PR で走らないことは変わらない。',
    ).toEqual([]);
  });
});

// 両側を要求（AND）しない: 片側だけが正しい門が実在し、向きは門の側が宣言するしかないため。
// 宣言に「いま配線されている場所」を写さない: 写すと宣言が実物の控えになり、ずれても誰も気づかないため。
type Route = 'steps' | 'pr' | 'other';

interface DeclaredRoutes {
  readonly routes: readonly Route[];
  readonly why?: string;
}

const ONLY_ON_PR_BECAUSE_NEEDS_PR =
  'PR の番号・本文・コミット列を GitHub から読む門で、`STEPS`（offline で走る手元の一式）には置けない。';

const DECLARED_ROUTES: Record<string, DeclaredRoutes> = {
  'check:no-env-passthrough': { routes: ['steps', 'pr'] },
  'check:restart-before-check-advice': { routes: ['steps', 'pr'] },
  'check:sdk-quotes': { routes: ['steps', 'pr'] },
  'check:stale-token-restart-advice': { routes: ['steps', 'pr'] },
  'check:web-bundle-node-traces': { routes: ['steps', 'pr'] },
  'check:web-bundle-size': { routes: ['steps', 'pr'] },
  'check:web-css-comment-classnames': { routes: ['steps', 'pr'] },
  'check:web-css-no-inline-fonts': { routes: ['steps', 'pr'] },
  'check:agents-md-size': {
    routes: ['pr'],
    why:
      '`STEPS` への組み込みは #1191 の着地後の別便と決めてあり、いまは ci.yml の1行だけが門である' +
      "（逐語は `grep -Fn -- 'あちらは #1191 で別の担当が改修中で' .github/workflows/ci.yml`）。",
  },
  'check:no-attribution-trailers': { routes: ['pr'], why: ONLY_ON_PR_BECAUSE_NEEDS_PR },
  'check:dockerfile-railway': {
    routes: ['pr'],
    why:
      '手元の `pnpm test` は `scripts/check-dockerfile-railway.test.ts` の「実際の repo」の歯が同じ判定を実物の Dockerfile に当てるので、' +
      '`STEPS` へは足さない（二重に走らせない）。PR の CI では ci.yml の checks job が1行で呼ぶ（#2685）。',
  },
};

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
