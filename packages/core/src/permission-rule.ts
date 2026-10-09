/**
 * シェルの区切り・展開文字。判定に使う唯一の定義（呼び出し側で書き写さない）。
 * 規則側とコマンド側の両方に使う: コマンド側は、前方一致の後ろへ
 * `gh release edit; rm -rf /` のように継ぎ足されても規則が通ってしまうのを塞ぐため。
 * 規則側は、`Bash(gh pr view$(whoami))` のような規則を許すと `allows` / `denies` の検算が
 * 信頼できなくなるため。不一致は `deny` ではなく既存の確認フローへ委ねる。
 * `\` はエスケープ・行継続に使えるので独自に足した。
 */
const SHELL_METACHARACTERS = /[;&|$`()<>\\\n\r]/;

export function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}

export type PermissionRuleKind = 'exact' | 'prefix';

export interface ParsedPermissionRule {
  kind: PermissionRuleKind;
  command: string;
}

export type PermissionRuleParseResult =
  ({ ok: true } & ParsedPermissionRule) | { ok: false; reason: string };

const RULE_WRAPPER = /^Bash\((.+)\)$/s;
const PREFIX_SUFFIX = ':*';

/** 失敗は例外にしない: `request_permission` が `reason` をそのまま断り文に使うため。 */
export function parsePermissionRule(rule: string): PermissionRuleParseResult {
  const wrapped = RULE_WRAPPER.exec(rule);
  if (wrapped === null) {
    return {
      ok: false,
      reason: '規則は Bash(<コマンド>) または Bash(<コマンド>:*) の形である必要がある',
    };
  }
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

/** 不一致は `deny` を意味しない（呼び出し側が「何も決めない」か「要求の拒否」かを選ぶ）。 */
export function matchPermissionRule(rule: string, command: string): boolean {
  if (containsShellMetacharacters(command)) return false;
  const parsed = parsePermissionRule(rule);
  if (!parsed.ok) return false;
  if (parsed.kind === 'exact') return command === parsed.command;
  // startsWith だけにしない: `gh release editfoo` が `gh release edit` に一致してしまう。
  return command === parsed.command || command.startsWith(`${parsed.command} `);
}

/**
 * `'narrow'` / `'medium'` / `'broad'` は前方一致で、固定された先頭の語数が少ないほど広い。
 * `'invalid'` を `'broad'` 等へ倒さない: 壊れた規則が「広いだけの規則」に見えてしまうため。
 */
export type PermissionRuleBreadthLevel = 'exact' | 'narrow' | 'medium' | 'broad' | 'invalid';

export interface PermissionRuleBreadth {
  level: PermissionRuleBreadthLevel;
  prefixWordCount?: number;
}

const NARROW_PREFIX_WORD_COUNT = 3;

/** 表示専用。独自にパースし直さない: 書式が増えたときに一覧の表示と実際の挙動がずれるため。 */
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

/** `allows` も空を許さない: 空集合は `every` が常に真になり、検査が素通りするため。 */
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
