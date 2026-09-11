import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`.github/workflows/ci.yml` が「draft の pull_request では重い CI（`ci` / `image`）を
 * 走らせない」を正しく実装していることを固定する歯。**
 *
 * ⚠️ **偽陽性を避けるため、`if:` の文字列を期待値と突き合わせる形（string match）には
 * していない。** 足場（この歯）が測定対象（`ci.yml` の `if:` 式）と同じ文字列を
 * 直書きで持つと、条件の書き方を変えただけ（当てすぎではない等価な書き換え）で
 * 歯が赤くなる——それは「挙動が変わった」ことの検出ではなく「見た目が変わった」
 * ことの検出でしかない。**代わりに、`ci.yml` から実際の `if:` 式を文字列として
 * 読み出し、その式を評価する小さな GitHub 式エバリュエータをこのファイル自身に
 * 持つ。** 合成したイベント文脈（push / pull_request draft / pull_request ready /
 * schedule / workflow_dispatch）の行列に対して評価することで、「条件の書き方を
 * 変えても挙動が同じなら緑のまま」「挙動が変われば赤」になる。
 *
 * **この歯が固定する4つ（依頼の要求そのもの）:**
 *
 * 1. `push`（main）では `ci` と `image` の両方が走る（罠1が塞がっている）。
 *    `workflow_dispatch` でも両方走り、`schedule` では `image` だけが走って
 *    `ci` は走らない（既存挙動の保存）。
 * 2. draft の `pull_request` では `ci` も `image` も走らない（節約が効いている）。
 * 3. `on.pull_request.types` に `ready_for_review` が在る（罠3。GitHub の既定
 *    `[opened, synchronize, reopened]` にはこれが無く、無いと draft → ready の
 *    遷移そのものが `pull_request` イベントを起こさない）。
 * 4. required contexts（`ci` / `image`）が ci.yml の実在のジョブ名にすべて対応
 *    しており、かつ「draft のあいだだけ skip が許される」という主張——
 *    `ready_for_review` が `types` に在ること **と** `draft == false` の
 *    `pull_request` 文脈で required な全ジョブが走ること——を1本の歯で結び付ける。
 *
 * **罠1（いちばん危ない書き方）**: `github.event.pull_request.draft == false` だけを
 * 条件にすると、`push` / `schedule` / `workflow_dispatch` では `github.event.pull_request`
 * そのものが存在せず（GitHub 式では未定義のプロパティは `null` になる）、
 * GitHub Actions の式は `null == false` を **false** と評価する。⟹ この条件だけだと
 * **main への push で `ci` が丸ごと skip される**——required チェックが「失敗」では
 * なく「そもそも走っていない」状態のまま、ブランチ保護だけが通ってしまう。だから
 * `ci.yml` 側は必ず `github.event_name` で先に分けてから `draft` を見る形にして
 * ある。この歯の評価器はこの罠を「null == false は偽」という固定の仕様として
 * 実装し、その仕様自体にも自己テストを1本持つ（下の「評価器の自己テスト」）。
 *
 * **罠2（`skipped` が required を満たす）**: GitHub のブランチ保護は、required な
 * ジョブが `if:` で skip されても「失敗」として扱わない（`neutral`/`skipped` は
 * マージを妨げない）。⟹ 「draft では ci/image を skip する」という改修そのものが、
 * 「ready にしても本物の run が起きない」という別の事故と表裏一体になりうる。
 * この歯の4番目のテストは、まさにこの表裏——「skip が許されるのは draft のあいだ
 * だけであること」——を直接固定する。
 *
 * **罠3（`ready_for_review` が既定に無い）**: 上の3番目のテストが直接固定する。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_YML_PATH = path.join(ROOT, '.github/workflows/ci.yml');

// ============================================================================
// GitHub Actions の式のミニ評価器
//
// 扱うのは `&&` / `||` / `!` / `==` / `!=` / 括弧 / 真偽値リテラル / 文字列
// リテラル / `github.event_name` と `github.event.pull_request.draft` の2つの
// 識別子だけである。この repo の ci.yml の if: 式を評価するのに必要十分な範囲に
// 絞ってあり、未対応の識別子・型の組み合わせに出会ったら「たぶんこう」とは
// 推測せず、その場で例外を投げる（fail-closed）。
// ============================================================================

/** GitHub 式が扱う値。`null` は「プロパティが存在しない」を表す。 */
type GHValue = string | boolean | null;

/**
 * 合成したイベント文脈。`pullRequestDraft` が `null` なのは、そのイベントに
 * `github.event.pull_request` というキー自体が存在しない状態を表す
 * （push / schedule / workflow_dispatch の実際の挙動そのもの）。
 */
interface GithubEventContext {
  eventName: string;
  pullRequestDraft: boolean | null;
}

function resolveIdentifier(identifierPath: string, ctx: GithubEventContext): GHValue {
  if (identifierPath === 'github.event_name') return ctx.eventName;
  if (identifierPath === 'github.event.pull_request.draft') return ctx.pullRequestDraft;
  throw new Error(
    `この評価器が対応していない識別子: "${identifierPath}"（対応済み: github.event_name, github.event.pull_request.draft）`,
  );
}

/**
 * GitHub Actions の等価比較。**`null == false` を偽と評価するのがこの関数の核心**
 * （GitHub Actions の仕様。上の「罠1」の逐語どおり）。`null` はそれ自身としか
 * 等しくならない——`null` と非 `null` の比較は常に不一致になる。
 */
function ghEqual(a: GHValue, b: GHValue): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (typeof a !== typeof b) {
    throw new Error(
      `ghEqual: 型が揃っていない比較には対応していない（${typeof a} と ${typeof b}）`,
    );
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // GitHub Actions の文字列比較は大文字小文字を区別しない。
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** GitHub 式の truthy 判定（`if:` の最終評価と同じ規則）。 */
function toBool(v: GHValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  return v.length > 0;
}

type Token =
  | { t: 'LPAREN' | 'RPAREN' | 'AND' | 'OR' | 'NOT' | 'EQ' | 'NEQ' }
  | { t: 'STRING'; v: string }
  | { t: 'BOOL'; v: boolean }
  | { t: 'IDENT'; v: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'LPAREN' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'RPAREN' });
      i++;
      continue;
    }
    if (expr.startsWith('&&', i)) {
      tokens.push({ t: 'AND' });
      i += 2;
      continue;
    }
    if (expr.startsWith('||', i)) {
      tokens.push({ t: 'OR' });
      i += 2;
      continue;
    }
    if (expr.startsWith('==', i)) {
      tokens.push({ t: 'EQ' });
      i += 2;
      continue;
    }
    if (expr.startsWith('!=', i)) {
      tokens.push({ t: 'NEQ' });
      i += 2;
      continue;
    }
    if (c === '!') {
      tokens.push({ t: 'NOT' });
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let buf = '';
      while (j < expr.length && expr[j] !== "'") {
        buf += expr[j];
        j++;
      }
      if (expr[j] !== "'") {
        throw new Error(`未終端の文字列リテラル: ${expr.slice(i)}（式全体: ${expr}）`);
      }
      tokens.push({ t: 'STRING', v: buf });
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][\w.]*/.exec(expr.slice(i));
    if (m) {
      const word = m[0];
      if (word === 'true') tokens.push({ t: 'BOOL', v: true });
      else if (word === 'false') tokens.push({ t: 'BOOL', v: false });
      else tokens.push({ t: 'IDENT', v: word });
      i += word.length;
      continue;
    }
    throw new Error(
      `GitHub 式の評価器が読めないトークン: ${JSON.stringify(expr.slice(i, i + 10))}（式全体: ${expr}）`,
    );
  }
  return tokens;
}

/** 再帰下降パーサ。優先順位は GitHub Actions と同じ: `!` > `==`/`!=` > `&&` > `||`。 */
class ExprParser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly ctx: GithubEventContext,
    private readonly sourceForError: string,
  ) {}

  parse(): GHValue {
    const v = this.parseOr();
    if (this.pos !== this.tokens.length) {
      throw new Error(`式の末尾に余分なトークンが残っている: ${this.sourceForError}`);
    }
    return v;
  }

  private parseOr(): GHValue {
    let left = this.parseAnd();
    while (this.match('OR')) {
      const right = this.parseAnd();
      left = toBool(left) || toBool(right);
    }
    return left;
  }

  private parseAnd(): GHValue {
    let left = this.parseEquality();
    while (this.match('AND')) {
      const right = this.parseEquality();
      left = toBool(left) && toBool(right);
    }
    return left;
  }

  private parseEquality(): GHValue {
    const left = this.parseUnary();
    if (this.match('EQ')) return ghEqual(left, this.parseUnary());
    if (this.match('NEQ')) return !ghEqual(left, this.parseUnary());
    return left;
  }

  private parseUnary(): GHValue {
    if (this.match('NOT')) return !toBool(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): GHValue {
    const token = this.tokens[this.pos];
    if (!token) throw new Error(`式が途中で終わっている: ${this.sourceForError}`);
    if (token.t === 'LPAREN') {
      this.pos++;
      const v = this.parseOr();
      if (!this.match('RPAREN')) throw new Error(`閉じ括弧が無い: ${this.sourceForError}`);
      return v;
    }
    if (token.t === 'STRING') {
      this.pos++;
      return token.v;
    }
    if (token.t === 'BOOL') {
      this.pos++;
      return token.v;
    }
    if (token.t === 'IDENT') {
      this.pos++;
      return resolveIdentifier(token.v, this.ctx);
    }
    throw new Error(
      `ここに来てはいけないトークン: ${JSON.stringify(token)}（式全体: ${this.sourceForError}）`,
    );
  }

  private match(t: Token['t']): boolean {
    if (this.tokens[this.pos]?.t === t) {
      this.pos++;
      return true;
    }
    return false;
  }
}

/** `ci.yml` の `if:` の値をそのまま渡し、合成した文脈のもとで真偽を返す。 */
function evaluateGithubExpression(expr: string, ctx: GithubEventContext): boolean {
  const tokens = tokenize(expr);
  const parser = new ExprParser(tokens, ctx, expr);
  return toBool(parser.parse());
}

// ============================================================================
// ci.yml からの抽出
//
// YAML パーサは使わない——`js-yaml` はこの repo では他パッケージの推移的依存の
// override としてしか固定されておらず（`pnpm-workspace.yaml` の overrides）、
// root からは import できない。新しい依存を足すのはこの PR の範囲外（触ってよい
// のは ci.yml と新規テストだけ）なので、素の文字列走査で読む。
// ============================================================================

/**
 * `on.pull_request.types` を抽出する。フロースタイル（`types: [a, b, c]`）と
 * ブロックスタイル（`types:\n  - a\n  - b`）の両方に対応する——将来この配列の
 * 書き方だけが変わる「当てすぎではない書き換え」で歯が空振りしないため。
 * `types:` が見つからなければ `null`（GitHub の既定が使われている＝
 * `ready_for_review` を含まない）を返す。
 */
/**
 * 一致した位置が YAML コメント（`#` より後ろ）の中かどうかを判定する。
 *
 * **これが要る理由——このファイル自身のドキュメントコメントが house style の
 * 先例を逐語で引用しており、コメントの中にも `types: [...]` という文字列が
 * 現れる。** 実際にこの関数の最初の実装はこれを踏んだ——`ci.yml` の
 * `pull_request:` の doc コメントが `types: [ opened, synchronize,
 * reopened,\n    # ready_for_review ]`（改行を挟んだ引用）を含んでいたため、
 * 素朴なフロースタイルの正規表現が本物の `types:` より先にこの引用へ
 * 一致し、`ready_for_review` を含まない配列を返して偽陰性になった。
 * 「足場（この関数）が測定対象と同じ文字列を含むと偽陽性・偽陰性になる」の
 * 実例がテスト対象の doc コメント自身から出た形である。
 */
function isInsideYamlComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(lineStart, index).includes('#');
}

function extractPullRequestTypes(ciYml: string): string[] | null {
  const blockMatch = /\n {2}pull_request:\n([\s\S]*?)(?=\n {2}[A-Za-z_]+:)/.exec(ciYml);
  if (!blockMatch) return null;
  const block = blockMatch[1];

  // フロースタイル（1行）。**改行を跨がせない**（この repo の実際の書き方は
  // 常に1行）ことと、**一致した行が YAML コメントの中でないこと**の両方を
  // 確かめてから採用する（上の `isInsideYamlComment` の doc を見よ）。
  for (const m of block.matchAll(/types:\s*\[([^\]\n]*)\]/g)) {
    if (isInsideYamlComment(block, m.index ?? 0)) continue;
    return m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  for (const m of block.matchAll(/types:\s*\n((?:[ \t]*-\s*\S+\n?)+)/g)) {
    if (isInsideYamlComment(block, m.index ?? 0)) continue;
    return [...m[1].matchAll(/-\s*(\S+)/g)].map((x) => x[1]);
  }

  return null;
}

/** `jobs:` セクションの生テキスト（`jobs:` 自身の行は含まない）を返す。 */
function extractJobsSection(ciYml: string): string {
  const marker = '\njobs:\n';
  const idx = ciYml.indexOf(marker);
  if (idx === -1) throw new Error('ci.yml に "jobs:" セクションが見つからない');
  return ciYml.slice(idx + marker.length);
}

/** `jobs:` 直下のジョブ名（2-space インデントの見出し）を全部返す。 */
function extractJobNames(jobsSection: string): string[] {
  return [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
}

/** 指定したジョブの本文（次のジョブの手前まで）を返す。無ければ `null`。 */
function extractJobBlock(jobsSection: string, jobName: string): string | null {
  const padded = `\n${jobsSection}`;
  const re = new RegExp(`\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:|$)`);
  const m = re.exec(padded);
  return m ? m[1] : null;
}

/** ジョブ本文からジョブレベルの `if:` の値を抽出する。無ければ `null`（＝常に走る）。 */
function extractJobIf(jobBlock: string): string | null {
  const m = /^\s*if:\s*(.+)$/m.exec(jobBlock);
  return m ? m[1].trim() : null;
}

// ============================================================================
// 合成イベント文脈
// ============================================================================

const PUSH_CONTEXT: GithubEventContext = { eventName: 'push', pullRequestDraft: null };
const SCHEDULE_CONTEXT: GithubEventContext = { eventName: 'schedule', pullRequestDraft: null };
const DISPATCH_CONTEXT: GithubEventContext = {
  eventName: 'workflow_dispatch',
  pullRequestDraft: null,
};
const PR_DRAFT_CONTEXT: GithubEventContext = { eventName: 'pull_request', pullRequestDraft: true };
const PR_READY_CONTEXT: GithubEventContext = { eventName: 'pull_request', pullRequestDraft: false };

// ============================================================================
// 評価器の自己テスト
//
// 「null == false は偽」を GitHub Actions の仕様として固定する（罠1の核）。
// この自己テストが赤くならないことが、下の ci.yml 由来のテストの前提になる。
// ============================================================================

describe('評価器の自己テスト', () => {
  it('null == false は偽と評価される（GitHub Actions の仕様。罠1の核）', () => {
    expect(ghEqual(null, false)).toBe(false);
  });

  it('null != false は真と評価される', () => {
    expect(!ghEqual(null, false)).toBe(true);
  });

  it('github.event.pull_request.draft は push 文脈では存在しない（null）', () => {
    expect(resolveIdentifier('github.event.pull_request.draft', PUSH_CONTEXT)).toBeNull();
  });

  it('括弧・&&・||・! を正しく結合する（対照式）', () => {
    expect(evaluateGithubExpression('true && (false || true)', PUSH_CONTEXT)).toBe(true);
    expect(evaluateGithubExpression('!(true && false)', PUSH_CONTEXT)).toBe(true);
    expect(evaluateGithubExpression("'a' != 'b'", PUSH_CONTEXT)).toBe(true);
  });

  it('未対応の識別子には推測せず例外を投げる（fail-closed）', () => {
    expect(() => evaluateGithubExpression('github.event.something_new', PUSH_CONTEXT)).toThrow();
  });

  /**
   * **罠1そのものを、ci.yml に依存せずこの評価器の単体テストとして固定する。**
   * `github.event.pull_request.draft == false` **だけ**を条件にすると、
   * push（や schedule / workflow_dispatch）ではこの式が偽になり——つまり
   * 「draft ではない」ではなく「push だから required チェックが丸ごと
   * skip される」という事故そのものが再現できる。
   */
  it('罠1: draft==false 単独の条件は push で偽になる（required チェックが丸ごと skip される事故の再現）', () => {
    expect(evaluateGithubExpression('github.event.pull_request.draft == false', PUSH_CONTEXT)).toBe(
      false,
    );
  });
});

// ============================================================================
// ci.yml 由来のテスト
// ============================================================================

const ciYmlText = readFileSync(CI_YML_PATH, 'utf8');
const jobsSection = extractJobsSection(ciYmlText);
const jobNames = extractJobNames(jobsSection);

const JOB_IF_EXPRESSIONS = new Map<string, string | null>(
  jobNames.map((name) => {
    const block = extractJobBlock(jobsSection, name);
    if (block === null) throw new Error(`ジョブ "${name}" の本文を抽出できなかった`);
    return [name, extractJobIf(block)];
  }),
);

/** ジョブが指定した文脈で走るかどうか。`if:` が無いジョブは常に走る。 */
function jobRuns(jobName: string, ctx: GithubEventContext): boolean {
  const expr = JOB_IF_EXPRESSIONS.get(jobName);
  if (expr === undefined) throw new Error(`ジョブ "${jobName}" が ci.yml に見つからない`);
  if (expr === null) return true;
  return evaluateGithubExpression(expr, ctx);
}

/**
 * required contexts（`gh api repos/takecchi/alteroid/branches/main/protection` の
 * `required_status_checks.contexts` 実測値。観測 2026-09-10T08:11Z、`["ci","image"]`）。
 * **この配列はブランチ保護の実測を写した宣言であって、ci.yml から動的に読んでは
 * いない**——ジョブ名がずれてもこの歯が黙って自分を合わせないようにするため。
 */
const REQUIRED_CONTEXTS = ['ci', 'image'];

describe('前提: ci.yml から抽出できていること', () => {
  it('ci ジョブと image ジョブの両方を検出している', () => {
    expect(jobNames).toContain('ci');
    expect(jobNames).toContain('image');
  });

  it('ci ジョブと image ジョブは、どちらもジョブレベルの if: を持つ', () => {
    expect(JOB_IF_EXPRESSIONS.get('ci'), 'ci の if: を抽出できていない').not.toBeNull();
    expect(JOB_IF_EXPRESSIONS.get('image'), 'image の if: を抽出できていない').not.toBeNull();
  });

  it('on.pull_request.types を抽出できている', () => {
    expect(extractPullRequestTypes(ciYmlText)).not.toBeNull();
  });
});

describe('固定その1: push / workflow_dispatch / schedule での挙動（罠1が塞がっていること）', () => {
  it.each([
    ['push（main への push）', PUSH_CONTEXT, true, true],
    ['workflow_dispatch（手動起動）', DISPATCH_CONTEXT, true, true],
    ['schedule（定時実行）', SCHEDULE_CONTEXT, false, true],
  ] as const)('%s', (_label, ctx, expectCi, expectImage) => {
    expect(jobRuns('ci', ctx)).toBe(expectCi);
    expect(jobRuns('image', ctx)).toBe(expectImage);
  });
});

describe('固定その2: draft の pull_request では ci も image も走らない（節約が効いている）', () => {
  it('draft の pull_request: ci=false / image=false', () => {
    expect(jobRuns('ci', PR_DRAFT_CONTEXT)).toBe(false);
    expect(jobRuns('image', PR_DRAFT_CONTEXT)).toBe(false);
  });
});

describe('固定その3: on.pull_request.types に ready_for_review が在る（罠3）', () => {
  it('ready_for_review を含む', () => {
    const types = extractPullRequestTypes(ciYmlText);
    expect(
      types,
      'on.pull_request.types が見つからない（＝ GitHub の既定 [opened, synchronize, reopened] のまま。' +
        'ready_for_review が無いと draft → ready の遷移そのものが pull_request イベントを起こさない）',
    ).not.toBeNull();
    expect(types).toContain('ready_for_review');
  });
});

describe('固定その4: required contexts の実在対応 と「skip は draft のあいだだけ」の結び付け', () => {
  it('required contexts（ci / image）は ci.yml の実在するジョブ名にすべて対応している', () => {
    for (const name of REQUIRED_CONTEXTS) {
      expect(jobNames, `required context "${name}" に対応するジョブが ci.yml に無い`).toContain(
        name,
      );
    }
  });

  /**
   * **これが依頼の4番目「draft のまま required が全部緑になる経路が draft の
   * あいだだけであることの明示的な固定」そのものである。** 2つの主張を1本の
   * テストで結び付ける:
   *
   * 1. `ready_for_review` が `types` に在る（＝ draft → ready の遷移が本物の
   *    pull_request イベントを起こす）
   * 2. その遷移後（`draft == false`）の文脈で、required な全ジョブが実際に走る
   *
   * 片方だけでは足りない —— 1 だけなら「イベントは起きるが中身が空」も緑になり、
   * 2 だけなら「イベントがそもそも起きない」を見逃す。
   */
  it('ready_for_review が在り、かつ draft==false で required な全ジョブが走る（skip は draft のあいだだけ）', () => {
    const types = extractPullRequestTypes(ciYmlText);
    expect(types).not.toBeNull();
    expect(types).toContain('ready_for_review');

    for (const name of REQUIRED_CONTEXTS) {
      expect(
        jobRuns(name, PR_READY_CONTEXT),
        `required job "${name}" は ready（draft==false）で走る必要がある`,
      ).toBe(true);
    }
  });
});
