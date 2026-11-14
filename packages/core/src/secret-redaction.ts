import { isSecretEnvName, redactCredentialRulesNamed } from './denial-input-head.js';

/**
 * 応答へ載せる文字列の秘密走査（`GET /self/prompt`）。当たった箇所を `[redacted:<規則名>]` に置き換え、規則ごとの当たりの件数だけを控える。
 * - 値・値の一部・前後の文脈・位置は控えない（名前と件数だけ）。
 * - 規則は名前つきの固定の一覧。`redact.ts` / `denial-input-head.ts` の `CREDENTIAL_RULES`（github・anthropic・aws・pem・openai・slack・stripe・google・userinfo・secret-assignment など）を使い回し、
 *   連携の鍵（`altk_`）・JWT・`sk-` 系の長い鍵・環境変数の値の完全一致だけを足す。**診断の要約の秘密走査（削除済み）のように、当たったら断る形にはしない**:
 *   この口の目的は中身を見せることで、伏せて返す。
 * - 走査が例外で落ちたら、呼び手の側が応答を返さない（走査できていない文字列を返さない）。ここでは握り潰さない。
 */

/** 環境変数の値として走査する最小の長さ。これより短い値（`3000` や `on`）は、通常の文章に当たって壊すので走査しない */
export const SECRET_ENV_VALUE_MIN_LENGTH = 16;

const ENV_RULE_PREFIX = 'env:';

interface PatternRule {
  readonly name: string;
  readonly pattern: RegExp;
}

// 既存の規則に無いものだけをここに持つ。順序は既存の規則より先: 連携の鍵は `secret-assignment` などに部分的に伏せられる前に、名前つきで当てる
const OWN_RULES: readonly PatternRule[] = [
  // `altk_` + 乱数。接頭辞だけの語（「altk_ ＋ 英数」と書いた説明）には当てない長さ
  { name: 'integration-key', pattern: /\baltk_[A-Za-z0-9_-]{16,}/g },
  // ヘッダ部が `eyJ`（`{"` の base64url）で始まる3つの塊
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // 既存の `bearer` は `Bearer authentication` のような普通の文にも当たるので使わず、長さのある値だけに当てる
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
];

// 既存の規則（`sk-ant-`・`sk-proj-`・`sk-` + 英数40字以上）の後に当てる: 先に当てると、同じ鍵が既存の名前（`anthropic-key`・`openai-key`）でなく `sk-key` と数えられる。
// `sk-` の後ろが十分に長いものだけ: `task-`・`risk-` のような英単語と、短い説明文（`sk-ant-` の形の説明）を壊さない
const TRAILING_RULES: readonly PatternRule[] = [
  { name: 'sk-key', pattern: /\bsk-[A-Za-z0-9_-]{32,}/g },
];

export interface SecretHit {
  /** 規則の名前。環境変数の値の完全一致は `env:<変数名>`（変数名だけで、値は含まない） */
  readonly rule: string;
  readonly count: number;
}

export interface SecretRedactorOptions {
  /** 走査する環境（既定は呼び手が渡す。このモジュールは `process.env` を読まない） */
  readonly env: NodeJS.ProcessEnv;
  /**
   * 名前に `TOKEN`・`KEY` などが入っていなくても秘密として扱う変数名（`WITHHELD_ENV_KEYS`・`AUTH_WITHHELD_ENV_KEYS`・`ROTATABLE_CREDENTIAL_KEYS` など、既存の一覧を呼び手が渡す）。
   * 新しい一覧をここへ手書きしない。
   */
  readonly knownSecretEnvNames?: readonly string[];
}

export interface SecretRedactor {
  redact(text: string): string;
  /** 文字列（キーを含む）を再帰的に走査する。文字列以外はそのまま */
  redactDeep<T>(value: T): T;
  hits(): readonly SecretHit[];
}

export function createSecretRedactor(options: SecretRedactorOptions): SecretRedactor {
  const known = new Set(options.knownSecretEnvNames ?? []);
  // 同じ値を別の名前で持つ環境変数は、先に見つけた名前だけで数える。値の長い順に当てる: 値が別の値を含むとき、短いほうが先に当たって長いほうの断片が残るため
  const envEntries: { name: string; value: string }[] = [];
  const seenValues = new Set<string>();
  for (const [name, value] of Object.entries(options.env)) {
    if (typeof value !== 'string' || value.length < SECRET_ENV_VALUE_MIN_LENGTH) continue;
    if (!known.has(name) && !isSecretEnvName(name)) continue;
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    envEntries.push({ name, value });
  }
  envEntries.sort((a, b) => b.value.length - a.value.length);

  const counts = new Map<string, number>();
  const count = (rule: string, n: number): void => {
    if (n > 0) counts.set(rule, (counts.get(rule) ?? 0) + n);
  };

  function redact(text: string): string {
    let result = text;
    for (const { name, value } of envEntries) {
      const parts = result.split(value);
      if (parts.length === 1) continue;
      count(`${ENV_RULE_PREFIX}${name}`, parts.length - 1);
      result = parts.join(`[redacted:${ENV_RULE_PREFIX}${name}]`);
    }
    const applyOwn = (rules: readonly PatternRule[], text: string): string => {
      let out = text;
      for (const rule of rules) {
        let matched = 0;
        out = out.replace(rule.pattern, () => {
          matched += 1;
          return `[redacted:${rule.name}]`;
        });
        count(rule.name, matched);
      }
      return out;
    };
    result = applyOwn(OWN_RULES, result);
    const named = redactCredentialRulesNamed(result, new Set(['bearer']));
    for (const [rule, n] of named.hits) count(rule, n);
    return applyOwn(TRAILING_RULES, named.text);
  }

  function redactDeep<T>(value: T): T {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item)) as T;
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // 普通の代入にしない: `__proto__` という名前のキーがプロトタイプの書き換えに化けるため
        Object.defineProperty(out, redact(key), {
          value: redactDeep(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out as T;
    }
    return value;
  }

  return {
    redact,
    redactDeep,
    hits: () =>
      [...counts.entries()]
        .map(([rule, n]) => ({ rule, count: n }))
        .sort((a, b) => a.rule.localeCompare(b.rule)),
  };
}
