import { codePointBoundary } from './excerpt.js';
import { redactEnvSecrets } from './redact-env-secrets.js';

export const DENIAL_INPUT_HEAD_LIMIT = 160;

// 空にしない: 「切った」と「切っていない」を分けるため
const TRUNCATION_MARK = '…';

// 空にしない: 「伏せた」という事実自体を残すため
const REDACTED = '[REDACTED]';

// `credentials.ts` の具体名の一覧を流用しない: 載っていない秘密が伏せ字の対象から漏れるため
const SECRET_ENV_NAME_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

// パターンを語単位の一致にしない: `ACCESSKEY` のような区切りの無い名前が伏せ漏れになるため
function isSecretEnvName(name: string): boolean {
  const withoutAuthorWords = name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => !/^authors?$/i.test(word))
    .join('_');
  return SECRET_ENV_NAME_PATTERN.test(withoutAuthorWords);
}

// 短い値を渡さない: redactEnvSecrets は長さの下限が無く、`LANG=C` のような値まで置換して出力が `[REDACTED]` だらけになるため
const SECRET_ENV_VALUE_MIN_LENGTH = 8;

function redactSecretEnvValues(text: string, env: NodeJS.ProcessEnv | undefined): string {
  if (env === undefined) return text;
  const candidates: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isSecretEnvName(name)) continue;
    if (typeof value !== 'string' || value.length < SECRET_ENV_VALUE_MIN_LENGTH) continue;
    candidates[name] = value;
  }
  return redactEnvSecrets(text, candidates);
}

const SECRET_ISH_MIN_LENGTH = 24;

const SECRET_ASSIGNMENT_NAME = `[A-Za-z_][A-Za-z0-9_]*(?:${SECRET_ENV_NAME_PATTERN.source})[A-Za-z0-9_]*`;

// パスワードは最後の `@` まで取る: 生の `@` を含むパスワードの後半を残さないため
// scheme を32文字までに絞る: 上限が無いと長い連なりの語の境目ごとに走り出し、入力の長さの2乗になりうるため
const URL_USERINFO_WITH_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@?#"'`]*:)[^\s/?#"'`]+@/gi;

const URL_USERINFO_TOKEN_ONLY = /\b([a-z][a-z0-9+.-]{0,31}):\/\/[^\s:/@?#"'`]+@/gi;

// 後ろ向き先読みと長さの上限を外さない: scheme が無くどこからでも走り出すため、外すと入力の長さの2乗になる
// scheme の無い `token@host` を伏せない: ssh の宛先・メールと見分けられず、巻き込みが大きすぎるため
const URL_SCHEMELESS_USERINFO_WITH_PASSWORD =
  /(?<![A-Za-z0-9._~%+:@-])([A-Za-z0-9._~%+-]{1,64}:)([^\s/?#"'`@]{1,128})@(?=[A-Za-z0-9][A-Za-z0-9.-])/g;

const SCHEMELESS_NON_CREDENTIAL_USERS: ReadonlySet<string> = new Set([
  'mailto',
  'xmpp',
  'sip',
  'sips',
  'tel',
  'callto',
  'im',
  'acct',
]);

const USERNAME_ONLY_SCHEMES: ReadonlySet<string> = new Set([
  'ssh',
  'git+ssh',
  'ssh+git',
  'sftp',
  'git',
  'rsync',
]);

function redactCredentialPatterns(text: string): string {
  return CREDENTIAL_RULES.reduce((result, rule) => rule.apply(result), text);
}

export type SecretPatternName =
  | 'env-secret-value'
  | 'url-userinfo-password'
  | 'url-userinfo-token'
  | 'schemeless-userinfo'
  | 'github-token'
  | 'github-pat'
  | 'anthropic-key'
  | 'aws-access-key'
  | 'bearer'
  | 'secret-assignment'
  | 'secret-json-field';

interface CredentialRule {
  readonly name: SecretPatternName;
  // 固有の接頭辞を持つ形か: 形だけの規則（`a:b@c` や `…KEY=…`）はバイナリのでたらめなバイト列にも当たるため
  readonly prefixed: boolean;
  readonly apply: (text: string) => string;
}

// userinfo の3つを先に当てる: ほかの規則が userinfo の一部だけを先に伏せると、形が崩れてこの規則に合わなくなるため
const CREDENTIAL_RULES: readonly CredentialRule[] = [
  {
    name: 'url-userinfo-password',
    prefixed: false,
    apply: (text) =>
      text.replace(URL_USERINFO_WITH_PASSWORD, (_m, head: string) => `${head}${REDACTED}@`),
  },
  {
    name: 'url-userinfo-token',
    prefixed: false,
    apply: (text) =>
      text.replace(URL_USERINFO_TOKEN_ONLY, (match, scheme: string) =>
        USERNAME_ONLY_SCHEMES.has(scheme.toLowerCase()) ? match : `${scheme}://${REDACTED}@`,
      ),
  },
  {
    name: 'schemeless-userinfo',
    prefixed: false,
    apply: (text) =>
      text.replace(URL_SCHEMELESS_USERINFO_WITH_PASSWORD, (match, head: string) => {
        const user = head.slice(0, -1);
        if (/^[0-9]+$/.test(user) || SCHEMELESS_NON_CREDENTIAL_USERS.has(user.toLowerCase())) {
          return match;
        }
        return `${head}${REDACTED}@`;
      }),
  },
  {
    name: 'github-token',
    prefixed: true,
    apply: (text) => text.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,255}\b/g, REDACTED),
  },
  {
    name: 'github-pat',
    prefixed: true,
    apply: (text) => text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,300}\b/g, REDACTED),
  },
  {
    name: 'anthropic-key',
    prefixed: true,
    apply: (text) => text.replace(/\bsk-ant-[A-Za-z0-9_-]{10,300}\b/g, REDACTED),
  },
  {
    name: 'aws-access-key',
    prefixed: true,
    apply: (text) => text.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED),
  },
  {
    name: 'bearer',
    prefixed: true,
    apply: (text) => text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`),
  },
  {
    name: 'secret-assignment',
    prefixed: false,
    apply: (text) =>
      text.replace(
        new RegExp(`\\b(${SECRET_ASSIGNMENT_NAME})=(\\S+)`, 'gi'),
        (_match, name: string) => `${name}=${REDACTED}`,
      ),
  },
  {
    name: 'secret-json-field',
    prefixed: false,
    apply: (text) =>
      text.replace(
        new RegExp(`"(${SECRET_ASSIGNMENT_NAME})"\\s*:\\s*"([^"]*)"`, 'gi'),
        (_match, name: string) => `"${name}":"${REDACTED}"`,
      ),
  },
];

/**
 * 規則を1つずつ元の `text` に当てる: 伏せる順に当てたときと「どれかが当たる」の真偽は変わらない。
 * `binary` では環境変数の鍵の値と固有の接頭辞を持つ形だけを見る: PNG のようなバイト列が、形だけの規則（`a:b@c`）に当たるため。
 */
export function secretPatternsInBody(
  text: string,
  env: NodeJS.ProcessEnv | undefined,
  options: { readonly binary?: boolean } = {},
): SecretPatternName[] {
  const hits: SecretPatternName[] = [];
  if (redactSecretEnvValues(text, env) !== text) hits.push('env-secret-value');
  for (const rule of CREDENTIAL_RULES) {
    if (options.binary === true && !rule.prefixed) continue;
    if (rule.apply(text) !== text) hits.push(rule.name);
  }
  return hits;
}

function redactKnownSecretPatterns(text: string): string {
  let result = redactCredentialPatterns(text);
  // 40桁 hex は取りこぼしより誤伏せを選ぶ: 秘密ではない大半を伏せても実害は小さいため
  result = result.replace(/\b[0-9a-f]{40}\b/gi, REDACTED);
  result = result.replace(
    new RegExp(`\\b[A-Za-z0-9_-]{${SECRET_ISH_MIN_LENGTH},}\\b`, 'g'),
    (match) => (/[0-9]/.test(match) && /[A-Za-z]/.test(match) ? REDACTED : match),
  );

  return result;
}

export function redactSecretsInText(text: string, env: NodeJS.ProcessEnv | undefined): string {
  return redactKnownSecretPatterns(redactSecretEnvValues(text, env));
}

// 40桁の SHA と英数字混在の長い塊を伏せない: コミットの sha・UUID・枝名が化けると報告や日誌が観測として使えなくなるため
export function redactSecretsInBody(text: string, env: NodeJS.ProcessEnv | undefined): string {
  return redactCredentialPatterns(redactSecretEnvValues(text, env));
}

const QUERY_PARAMS_TAIL = /\bparams:[\s\S]*$/i;

// `buildDenialInputHead` では `params:` を落とさない: 道具の入力に `params:` は普通に現れ、その先頭を残す契約を変えないため
// `params:` の落としを先に行う: 落とす部分を伏せ字の取りこぼしに頼らないため
export function redactErrorText(text: string, env: NodeJS.ProcessEnv | undefined): string {
  return redactSecretsInText(text.replace(QUERY_PARAMS_TAIL, `params: ${REDACTED}`), env);
}

// 一致鍵に使わない（`matchInputOf` を使う）: `command` 以外の欄を捨てるため、使うと撃ち直しにまで1回限りの許可が及ぶ
export function rawLineOf(toolInput: unknown): string | undefined {
  if (toolInput === undefined) return undefined;
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput)) {
    const command = (toolInput as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return undefined;
  }
}

// `description` のような欄も鍵から外さない: 欄ごとの意味を知る前提を持ち込むと、新しい欄のたびに見直しが要るため
export function matchInputOf(toolInput: unknown): string | undefined {
  if (toolInput === undefined) return undefined;
  try {
    return JSON.stringify(sortKeysDeep(toolInput));
  } catch {
    return undefined;
  }
}

// 普通の代入（`sorted[key] = …`）にしない: `__proto__` という自前の欄がプロトタイプの書き換えに化け、鍵から消えるため
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      Object.defineProperty(sorted, key, {
        value: sortKeysDeep(source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return sorted;
  }
  return value;
}

// 伏せてから切る: 先に切ると、境界で割れたトークンの断片がどのパターンにも合わず残るため
export function buildDenialInputHead(
  toolInput: unknown,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  const raw = rawLineOf(toolInput);
  if (raw === undefined) return undefined;
  const redacted = redactSecretsInText(raw, env);
  return redacted.length > DENIAL_INPUT_HEAD_LIMIT
    ? `${redacted.slice(0, codePointBoundary(redacted, DENIAL_INPUT_HEAD_LIMIT))}${TRUNCATION_MARK}`
    : redacted;
}
