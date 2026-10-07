import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  extractJobNames,
  extractJobsSection,
  listWorkflowFiles,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './workflow-scan-core.mjs';

// `if:` の文字列を期待値と突き合わせず、式を評価する評価器を持つ: 直書きすると、等価な書き換えで歯が赤くなるため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CI_YML_PATH = path.join(ROOT, '.github/workflows/ci.yml');

// 未対応の識別子・型の組み合わせは推測せず例外を投げる: fail-closed にするため。

type GHValue = string | boolean | null;

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

// `null == false` を偽と評価する: GitHub Actions の仕様で、`draft == false` だけを条件にすると push で `ci` が丸ごと skip されるため。
function ghEqual(a: GHValue, b: GHValue): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (typeof a !== typeof b) {
    throw new Error(
      `ghEqual: 型が揃っていない比較には対応していない（${typeof a} と ${typeof b}）`,
    );
  }
  if (typeof a === 'string' && typeof b === 'string') {
    // 文字列比較は大文字小文字を区別しない: GitHub Actions の仕様のため。
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

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
    const c = expr.charAt(i);
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
    // `always()` は真として扱う: この評価器は needs の結果を持たないため。
    if (expr.startsWith('always()', i)) {
      tokens.push({ t: 'BOOL', v: true });
      i += 'always()'.length;
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

function evaluateGithubExpression(expr: string, ctx: GithubEventContext): boolean {
  const tokens = tokenize(expr);
  const parser = new ExprParser(tokens, ctx, expr);
  return toBool(parser.parse());
}

// YAML パーサを使わず素の文字列走査で読む: `js-yaml` は root から import できず、新しい依存を足さないため。
// YAML コメント内の一致を除外し、フロースタイルの正規表現に改行を跨がせない: `ci.yml` のコメントが `types:` を含み、本物より先に一致して偽陰性になったため。
function isInsideYamlComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(lineStart, index).includes('#');
}

function extractPullRequestTypes(ciYml: string): string[] | null {
  const blockMatch = /\n {2}pull_request:\n([\s\S]*?)(?=\n {2}[A-Za-z_]+:)/.exec(ciYml);
  if (!blockMatch) return null;
  const block = blockMatch[1];
  if (block === undefined) return null;

  for (const m of block.matchAll(/types:\s*\[([^\]\n]*)\]/g)) {
    if (isInsideYamlComment(block, m.index ?? 0)) continue;
    const captured = m[1];
    if (captured === undefined) continue;
    return captured
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  for (const m of block.matchAll(/types:\s*\n((?:[ \t]*-\s*\S+\n?)+)/g)) {
    if (isInsideYamlComment(block, m.index ?? 0)) continue;
    const captured = m[1];
    if (captured === undefined) continue;
    return [...captured.matchAll(/-\s*(\S+)/g)]
      .map((x) => x[1])
      .filter((s): s is string => s !== undefined);
  }

  return null;
}

// `extractJobsSection` / `extractJobNames` は再定義せず import する: 二重に持つと、片方だけ直して他方を直し忘れるため。

function extractJobBlock(jobsSection: string, jobName: string): string | null {
  const padded = `\n${jobsSection}`;
  const re = new RegExp(`\\n {2}${jobName}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:|$)`);
  const m = re.exec(padded);
  return m ? (m[1] ?? null) : null;
}

function extractJobIf(jobBlock: string): string | null {
  const m = /^\s*if:\s*(.+)$/m.exec(jobBlock);
  return m ? (m[1] ?? '').trim() : null;
}

const PUSH_CONTEXT: GithubEventContext = { eventName: 'push', pullRequestDraft: null };
const SCHEDULE_CONTEXT: GithubEventContext = { eventName: 'schedule', pullRequestDraft: null };
const DISPATCH_CONTEXT: GithubEventContext = {
  eventName: 'workflow_dispatch',
  pullRequestDraft: null,
};
const PR_DRAFT_CONTEXT: GithubEventContext = { eventName: 'pull_request', pullRequestDraft: true };
const PR_READY_CONTEXT: GithubEventContext = { eventName: 'pull_request', pullRequestDraft: false };

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

  it('always() は真として扱う。単独なら draft の文脈でも真（だから後ろに条件を続ける必要がある）', () => {
    expect(evaluateGithubExpression('always()', PR_DRAFT_CONTEXT)).toBe(true);
    expect(
      evaluateGithubExpression(
        "always() && github.event_name != 'schedule' && (github.event_name != 'pull_request' || github.event.pull_request.draft == false)",
        PR_DRAFT_CONTEXT,
      ),
    ).toBe(false);
  });

  it('未対応の識別子には推測せず例外を投げる（fail-closed）', () => {
    expect(() => evaluateGithubExpression('github.event.something_new', PUSH_CONTEXT)).toThrow();
  });

  it('罠1: draft==false 単独の条件は push で偽になる（required チェックが丸ごと skip される事故の再現）', () => {
    expect(evaluateGithubExpression('github.event.pull_request.draft == false', PUSH_CONTEXT)).toBe(
      false,
    );
  });
});

const ciYmlText = readFileSync(CI_YML_PATH, 'utf8');
const jobsSection: string = extractJobsSection(ciYmlText);
const jobNames: string[] = extractJobNames(jobsSection);

const JOB_IF_EXPRESSIONS = new Map<string, string | null>(
  jobNames.map((name) => {
    const block = extractJobBlock(jobsSection, name);
    if (block === null) throw new Error(`ジョブ "${name}" の本文を抽出できなかった`);
    return [name, extractJobIf(block)];
  }),
);

// `ci.yml` 1本ではなく全 workflow から引く: required な門が `ci.yml` の外に実在しうり、1本だけだと宣言から外して黙らせる圧力が生まれるため。
// 同じジョブ名が2つの workflow に在ったら投げる: 片方を黙って採ると「測れていない」を「緑」として返すため。
interface JobSite {
  readonly workflow: string;
  readonly ifExpr: string | null;
  readonly pullRequestTypes: string[] | null;
}

const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');

const WORKFLOW_FILE_NAMES: string[] = listWorkflowFiles(WORKFLOWS_DIR);

const ALL_WORKFLOW_JOBS: Map<string, JobSite> = (() => {
  const map = new Map<string, JobSite>();
  for (const file of WORKFLOW_FILE_NAMES) {
    const text = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    const section = extractJobsSection(text);
    const types = extractPullRequestTypes(text);
    for (const name of extractJobNames(section)) {
      const existing = map.get(name);
      if (existing !== undefined) {
        throw new Error(
          `ジョブ名 "${name}" が ${existing.workflow} と ${file} の両方に在る —— ` +
            'required context がどちらを指すか決められない（ジョブ名は repo 全体で一意にすること）',
        );
      }
      const block = extractJobBlock(section, name);
      if (block === null) throw new Error(`ジョブ "${name}"（${file}）の本文を抽出できなかった`);
      map.set(name, { workflow: file, ifExpr: extractJobIf(block), pullRequestTypes: types });
    }
  }
  return map;
})();

function jobRuns(jobName: string, ctx: GithubEventContext): boolean {
  const site = ALL_WORKFLOW_JOBS.get(jobName);
  if (site === undefined) {
    throw new Error(`ジョブ "${jobName}" が .github/workflows/ のどの workflow にも見つからない`);
  }
  if (site.ifExpr === null) return true;
  return evaluateGithubExpression(site.ifExpr, ctx);
}

// `ci.yml` から動的に読まない: ジョブ名がずれても歯が黙って自分を合わせないようにするため。
const REQUIRED_CONTEXTS: string[] = (
  JSON.parse(readFileSync(path.join(ROOT, '.github/required-status-checks.json'), 'utf8')) as {
    contexts: string[];
  }
).contexts;

// 一覧は導出してベタ書きしない: 検査 job を足したのに `if:` を引き継ぎ忘れるのを見逃さないため。
const CI_FAMILY_JOBS: string[] = jobNames.filter((name) => name !== 'image');

describe('前提: ci.yml から抽出できていること', () => {
  it('ci 系の job は ci 門を含めて2本以上ある（分割後も ci が在り、検査 job を取りこぼさない）', () => {
    expect(CI_FAMILY_JOBS).toContain('ci');
    expect(CI_FAMILY_JOBS.length).toBeGreaterThanOrEqual(2);
  });

  it('ci 系の全 job がジョブレベルの if: を持つ', () => {
    for (const name of CI_FAMILY_JOBS) {
      expect(JOB_IF_EXPRESSIONS.get(name), `${name} の if: を抽出できていない`).not.toBeNull();
    }
  });

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

// 除外ロジックの入力は合成する: 実物の `ci.yml` に `types:` を含むコメントが在るかで測れたり測れなくなったりして、書き換わった時点で歯が黙って空振りするため。

function synthesizeCiYml(pullRequestBlockBody: string): string {
  return [
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    pullRequestBlockBody,
    '  schedule:',
    "    - cron: '41 15 * * *'",
    '',
  ].join('\n');
}

const REAL_TYPES_LINE = '    types: [opened, synchronize, reopened, ready_for_review]';
const REAL_TYPES = ['opened', 'synchronize', 'reopened', 'ready_for_review'];

describe('除外ロジックそのものを測る（合成入力。実物のコメントに依存しない）', () => {
  it('行頭コメントの中の types: [...] は、本物の types: より先に在っても採用されない', () => {
    const yml = synthesizeCiYml(
      ['    # 既定は types: [opened, synchronize, reopened] である', REAL_TYPES_LINE].join('\n'),
    );
    expect(extractPullRequestTypes(yml)).toEqual(REAL_TYPES);
  });

  it('行の途中から始まるコメント（コードの後ろの #）の中の types: [...] も採用されない', () => {
    const yml = synthesizeCiYml(
      ['    branches: [main] # 旧仕様では types: [opened] と書いていた', REAL_TYPES_LINE].join(
        '\n',
      ),
    );
    expect(extractPullRequestTypes(yml)).toEqual(REAL_TYPES);
  });

  it('コメントが改行を跨いで角括弧を閉じていても採用されない（フロー正規表現が改行を跨がない）', () => {
    const yml = synthesizeCiYml(
      [
        '    # 先例の並びは types: [opened, synchronize,',
        '    # reopened] の形だった',
        REAL_TYPES_LINE,
      ].join('\n'),
    );
    expect(extractPullRequestTypes(yml)).toEqual(REAL_TYPES);
  });

  it('コメントでない位置から始まる一致も、改行を跨いだら採用されない', () => {
    const yml = synthesizeCiYml(["    name: 'types: [opened,'", REAL_TYPES_LINE].join('\n'));
    expect(extractPullRequestTypes(yml)).toEqual(REAL_TYPES);
  });

  it('ブロックスタイルの本物も、直前のコメントに邪魔されずに読める', () => {
    const yml = synthesizeCiYml(
      [
        '    # 既定は types: [opened, synchronize, reopened] である',
        '    types:',
        '      - opened',
        '      - ready_for_review',
      ].join('\n'),
    );
    expect(extractPullRequestTypes(yml)).toEqual(['opened', 'ready_for_review']);
  });

  it('陰性対照: コメントが1つも無くても本物は読める（除外が効きすぎていない）', () => {
    const yml = synthesizeCiYml(REAL_TYPES_LINE);
    expect(extractPullRequestTypes(yml)).toEqual(REAL_TYPES);
  });

  it('陰性対照: 本物が無くコメントだけなら null（コメントを本物として拾わない）', () => {
    const yml = synthesizeCiYml('    # 既定は types: [opened, synchronize, reopened] である');
    expect(extractPullRequestTypes(yml)).toBeNull();
  });

  describe('isInsideYamlComment の単体', () => {
    it('# より後ろの位置は true', () => {
      const text = 'a: 1 # types: [x]';
      expect(isInsideYamlComment(text, text.indexOf('types:'))).toBe(true);
    });

    it('同じ行の # より前の位置は false', () => {
      const text = '    types: [x] # 注記';
      expect(isInsideYamlComment(text, text.indexOf('types:'))).toBe(false);
    });

    it('前の行の # は、次の行をコメント扱いにしない（行単位で見ている）', () => {
      const text = '    # 注記\n    types: [x]';
      expect(isInsideYamlComment(text, text.lastIndexOf('types:'))).toBe(false);
    });
  });
});

describe('固定その1: push / workflow_dispatch / schedule での挙動（罠1が塞がっていること）', () => {
  it.each([
    ['push（main への push）', PUSH_CONTEXT, true, true],
    ['workflow_dispatch（手動起動）', DISPATCH_CONTEXT, true, true],
    ['schedule（定時実行）', SCHEDULE_CONTEXT, false, true],
  ] as const)('%s', (_label, ctx, expectCi, expectImage) => {
    for (const name of CI_FAMILY_JOBS) {
      expect(jobRuns(name, ctx), `${name} の ${_label}`).toBe(expectCi);
    }
    expect(jobRuns('image', ctx)).toBe(expectImage);
  });
});

describe('固定その2: draft の pull_request では ci も image も走らない（節約が効いている）', () => {
  it('draft の pull_request: ci 系の全 job=false / image=false', () => {
    for (const name of CI_FAMILY_JOBS) {
      expect(jobRuns(name, PR_DRAFT_CONTEXT), name).toBe(false);
    }
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
  it('required contexts は .github/workflows/ の実在するジョブ名にすべて対応している', () => {
    for (const name of REQUIRED_CONTEXTS) {
      expect(
        [...ALL_WORKFLOW_JOBS.keys()],
        `required context "${name}" に対応するジョブが .github/workflows/ のどこにも無い`,
      ).toContain(name);
    }
  });

  it('走査対象の workflow が ci.yml 1本ではない（別 workflow の required な門を見落とさない）', () => {
    expect(WORKFLOW_FILE_NAMES).toContain('ci.yml');
    expect(WORKFLOW_FILE_NAMES).toContain('no-attribution-trailers.yml');
    expect(ALL_WORKFLOW_JOBS.get('no-attribution-trailers')?.workflow).toBe(
      'no-attribution-trailers.yml',
    );
  });

  it('ready_for_review が在り、かつ draft==false で required な全ジョブが走る（skip は draft のあいだだけ）', () => {
    for (const name of REQUIRED_CONTEXTS) {
      const site = ALL_WORKFLOW_JOBS.get(name);
      expect(site, `required context "${name}" に対応するジョブが無い`).toBeDefined();

      // required なジョブが載っている workflow それぞれの `types` を見る: `ci.yml` だけだと、別 workflow の門が `ready_for_review` を欠いていても緑になるため。
      expect(
        site?.pullRequestTypes,
        `required job "${name}" を載せている ${site?.workflow} に on.pull_request.types が無い` +
          '（＝ GitHub の既定 [opened, synchronize, reopened] のまま。' +
          'ready_for_review が無いと draft → ready の遷移そのものが pull_request イベントを起こさない）',
      ).not.toBeNull();
      expect(
        site?.pullRequestTypes,
        `required job "${name}" を載せている ${site?.workflow} の types に ready_for_review が無い`,
      ).toContain('ready_for_review');

      expect(
        jobRuns(name, PR_READY_CONTEXT),
        `required job "${name}" は ready（draft==false）で走る必要がある`,
      ).toBe(true);
    }
  });
});
