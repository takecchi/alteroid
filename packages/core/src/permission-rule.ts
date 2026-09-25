/**
 * `request_permission` / 以降許可の PreToolUse フックが共有する、純粋な照合器
 * （Issue #863「許可をコードではなくデータにする」）。
 *
 * **ここに副作用は無い。** ストア・時刻・乱数のどれにも触れない — 呼び出し側
 * （`tools.ts` の `request_permission`、`clone.ts` の `#onPreToolUse`）が、
 * この結果を使ってストアを読み書きする。
 *
 * ## 書式は2つだけ
 *
 * - `Bash(<完全な文字列>)` — 完全一致
 * - `Bash(<前方一致>:*)` — 前方一致。**語境界で切る** — `Bash(gh release edit:*)`
 *   は `gh release edit --draft` と `gh release edit` には一致するが、
 *   `gh release editfoo` には一致しない（`editfoo` は `edit` の続きの語であって
 *   別の語の始まりではない、を区別するため）。
 *
 * ## シェルの区切り・展開文字は一律不一致
 *
 * 規則の中身（`Bash(...)` の括弧の中）と、照合対象のコマンド文字列の**両方**
 * について、シェルの区切り・展開文字（`;` `&` `|` `$` バッククォート `(` `)`
 * `<` `>` `\` 改行 `CR`）を含んでいれば、機械的に不一致（または規則として不正）
 * として扱う。
 *
 * **なぜコマンド側も見るか。** 規則が `Bash(gh release edit:*)` を許しても、
 * 実際に流れてきたコマンドが `gh release edit; rm -rf /` のように前方一致の
 * 後ろへ危険な文字列を継ぎ足していたら、前方一致だけでは同じ規則が通ってしまう
 * ——だから「規則が何であれ、区切り・展開文字を持つコマンドはそもそも一致しない」
 * という別の網で塞ぐ。一致しなければ `deny` にはならず、既存の確認フローへ
 * 委ねられるだけである（`clone.ts` の `#onPreToolUse` の doc）。
 *
 * **なぜ規則側も見るか。** 規則の文字列自体に区切り文字が混じっていたら、
 * その規則がそもそも何を許しているのか人間にもクローンにも読み取れない
 * （`Bash(gh pr view$(whoami))` のような規則を許可してしまうと、`allows` /
 * `denies` による検算そのものが信頼できなくなる）。
 */

/**
 * シェルの区切り・展開文字。**判定に使う唯一の定義** — 呼び出し側でこの集合を
 * 書き写さないこと（腐ると2箇所がずれる）。
 *
 * `\`（バックスラッシュ）は設計メモの逐語（`;` `&` `|` `$` バッククォート `(`
 * `)` `<` `>` 改行・CR）には無いが、エスケープ・行継続に使えるため独自に足した
 * ——「その他必要と判断したもの」の枠として明示しておく。
 */
const SHELL_METACHARACTERS = /[;&|$`()<>\\\n\r]/;

/** 文字列がシェルの区切り・展開文字を1つでも含むか。 */
export function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}

export type PermissionRuleKind = 'exact' | 'prefix';

export interface ParsedPermissionRule {
  kind: PermissionRuleKind;
  /**
   * `Bash(...)` の中身。前方一致（`kind: 'prefix'`）なら末尾の `:*` を
   * 取り除いた後の文字列——`matchPermissionRule` はこの値と語境界で比較する。
   */
  command: string;
}

export type PermissionRuleParseResult =
  ({ ok: true } & ParsedPermissionRule) | { ok: false; reason: string };

const RULE_WRAPPER = /^Bash\((.+)\)$/s;
const PREFIX_SUFFIX = ':*';

/**
 * 規則の文字列を解く。**失敗は例外ではなく `{ ok: false, reason }` で返す**
 * ——`request_permission` がそのまま人間可読な断り文として使うため。
 */
export function parsePermissionRule(rule: string): PermissionRuleParseResult {
  const wrapped = RULE_WRAPPER.exec(rule);
  if (wrapped === null) {
    return {
      ok: false,
      reason: '規則は Bash(<コマンド>) または Bash(<コマンド>:*) の形である必要がある',
    };
  }
  // `RULE_WRAPPER` には捕捉グループが1つしか無いので、`wrapped !== null` の
  // 時点でこのグループは必ず埋まっている（正規表現の性質上 `undefined` には
  // ならない）。`noUncheckedIndexedAccess` が付ける `string | undefined` を
  // ここで剥がす。
  const inner = wrapped[1] ?? '';
  const isPrefix = inner.endsWith(PREFIX_SUFFIX);
  const command = isPrefix ? inner.slice(0, -PREFIX_SUFFIX.length) : inner;
  if (command.length === 0) {
    return { ok: false, reason: '規則の中身が空である（Bash() / Bash(:*) は不正）' };
  }
  if (containsShellMetacharacters(command)) {
    return {
      ok: false,
      reason: '規則の中身にシェルの区切り・展開文字が含まれている（規則として不正）',
    };
  }
  return { ok: true, kind: isPrefix ? 'prefix' : 'exact', command };
}

/**
 * その規則が、そのコマンド文字列に一致するか。
 *
 * **規則が不正なら常に不一致。コマンドが区切り・展開文字を持つ場合も常に不一致**
 * （このファイル冒頭の doc）。いずれの不一致も `deny` を意味しない——呼び出し側
 * が「何も決めない」へ倒すか「要求そのものを拒否する」かを選ぶ。
 */
export function matchPermissionRule(rule: string, command: string): boolean {
  if (containsShellMetacharacters(command)) return false;
  const parsed = parsePermissionRule(rule);
  if (!parsed.ok) return false;
  if (parsed.kind === 'exact') return command === parsed.command;
  // 前方一致は語境界で切る——ちょうど一致するか、規則の後ろに空白が続くときだけ。
  // `startsWith` だけだと `gh release editfoo` が `gh release edit` に誤って
  // 一致してしまう。
  return command === parsed.command || command.startsWith(`${parsed.command} `);
}

/**
 * 規則の広さの段階（#193 から #863 へ畳んだ残項目「規則の広さの段階表示」——
 * `Bash(gh pr merge:*)` と `Bash(gh:*)` と `Bash(*)` のような、書き方1つで通る
 * 範囲が大きく変わる規則を、棚卸しの一覧で見分けられるようにする）。
 *
 * - `'exact'` —— 完全一致。常に最も狭い（このコマンド文字列にしか一致しない）。
 * - `'narrow'` / `'medium'` / `'broad'` —— 前方一致。**固定された先頭の語数**が
 *   少ないほど広い。`Bash(gh release edit:*)`（3語）は `gh release edit` で
 *   始まるものにしか一致しないが、`Bash(gh:*)`（1語）は `gh` で始まる**あらゆる**
 *   サブコマンドに一致する——同じ「前方一致」という書式でも、実際に通す範囲は
 *   桁違いに違う。
 * - `'invalid'` —— {@link parsePermissionRule} が解けない規則。`PermissionGrant`
 *   は生成時に {@link validatePermissionRequest} を通っているはずなので通常は
 *   起きないが、棚卸しの一覧はストアの中身をそのまま描くので、念のため区別する
 *   （黙って `'broad'` 等へ倒すと、壊れた規則が「広いだけの規則」に見えてしまう）。
 */
export type PermissionRuleBreadthLevel = 'exact' | 'narrow' | 'medium' | 'broad' | 'invalid';

export interface PermissionRuleBreadth {
  level: PermissionRuleBreadthLevel;
  /**
   * 前方一致の、固定された先頭の語数。`level` が `'exact'` / `'invalid'` の
   * ときは無い——完全一致には「先頭何語」という概念が無く、不正な規則は
   * 語数を数えるところまで到達していない。
   */
  prefixWordCount?: number;
}

/** `'narrow'` と `'medium'` を分ける境界（この語数以上なら `'narrow'`）。 */
const NARROW_PREFIX_WORD_COUNT = 3;

/**
 * 規則の広さを段階へ変換する（棚卸しの一覧の表示専用。**判定は
 * {@link matchPermissionRule} と同じ意味論に寄せてある**——独自にパースし直すと
 * `parsePermissionRule` の書式が増えたときに2か所を揃え忘れ、一覧の表示と実際の
 * 挙動がずれる）。
 *
 * 語数は空白区切り（`command.split(/\s+/)`）で数える——`matchPermissionRule` の
 * 語境界一致（末尾に空白が続くかちょうど一致するか）と同じ区切り方である。
 */
export function describePermissionRuleBreadth(rule: string): PermissionRuleBreadth {
  const parsed = parsePermissionRule(rule);
  if (!parsed.ok) return { level: 'invalid' };
  if (parsed.kind === 'exact') return { level: 'exact' };
  const prefixWordCount = parsed.command.split(/\s+/).filter((word) => word.length > 0).length;
  const level: PermissionRuleBreadthLevel =
    prefixWordCount >= NARROW_PREFIX_WORD_COUNT
      ? 'narrow'
      : prefixWordCount === 2
        ? 'medium'
        : 'broad';
  return { level, prefixWordCount };
}

export interface PermissionRequestCandidate {
  rule: string;
  allows: readonly string[];
  denies: readonly string[];
}

export type PermissionRequestValidation = { ok: true } | { ok: false; reason: string };

/**
 * `request_permission` の入力を検査する——**要求そのものを拒否する**ための
 * 唯一の入口。
 *
 * 満たすべき条件（すべて。1つでも欠けたら拒否）:
 *
 * 1. `rule` が {@link parsePermissionRule} を通る
 * 2. `allows` が空でない
 * 3. `denies` が空でない（1件以上必須——設計メモの明示）
 * 4. `allows` の全件が規則に一致する
 * 5. `denies` の全件が規則に一致しない
 *
 * **`allows` を空で許さない判断はここでの解釈である。** 設計メモが明示して
 * いるのは `denies` の「1件以上必須」だけだが、「allows は全部通ることを
 * 検査する」は `allows` が1件も無ければ検査のしようがない（空集合に対する
 * `every` は常に真になり、検査が素通りする）——同じ理由で `allows` にも
 * 1件以上を要求する。
 */
export function validatePermissionRequest(
  request: PermissionRequestCandidate,
): PermissionRequestValidation {
  const parsed = parsePermissionRule(request.rule);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (request.allows.length === 0) {
    return {
      ok: false,
      reason: 'allows が空である（この規則が通すべき具体例を少なくとも1つ渡すこと）',
    };
  }
  if (request.denies.length === 0) {
    return {
      ok: false,
      reason: 'denies が空である（この規則が拒むべき具体例を少なくとも1つ渡すこと）',
    };
  }
  const failingAllow = request.allows.find(
    (command) => !matchPermissionRule(request.rule, command),
  );
  if (failingAllow !== undefined) {
    return {
      ok: false,
      reason: `allows のうち規則に一致しない例がある: ${failingAllow}`,
    };
  }
  const passingDeny = request.denies.find((command) => matchPermissionRule(request.rule, command));
  if (passingDeny !== undefined) {
    return {
      ok: false,
      reason: `denies のうち規則に一致してしまう例がある: ${passingDeny}`,
    };
  }
  return { ok: true };
}
