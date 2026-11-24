import { isSecretEnvName } from './denial-input-head.js';
import { SECRET_ENV_VALUE_MIN_LENGTH } from './secret-redaction.js';

/**
 * 生ログ（mirror＝pg の sessionStore・アーカイブ・transcript）へ写す前に、子が持っている秘密の値を `[redacted:env:<名前>]` へ置き換える。
 *
 * - **当てるのは値の完全一致だけ。** 形で当てる規則（`secret-redaction.ts` の `CREDENTIAL_RULES` など）は使わない: 生ログは resume の正本で、
 *   読んだコードの `password=…` のような普通の文字列まで書き換えると、起こし直した担当が読む文脈が元と違ってしまうため。
 *   値の完全一致は、偶然に一致する普通の文がほぼ無い（16 字以上の秘密の値に限る）。
 * - **対象は、名前が秘密に見える環境変数（`isSecretEnvName`）と、資格の正本の値（名前によらない。#4829 と同じ理由）。**
 * - **今持っている値しか知らない。** 鍵を回した後は、回す前の値が残った行を伏せない（その行は CLI の手元の生ログにも平文で在る）。塞いだことにしない。
 * - **触らない行は同じ参照で返す**（`transcript-image-redaction.ts` と同じ約束。アーカイブの連続性の判定がバイト比較のため）。
 */

export interface SecretValueSource {
  /** 子に渡している環境（`#childEnv()`）。名前が秘密に見えるものだけ使う */
  readonly env: NodeJS.ProcessEnv;
  /** 名前によらず伏せる値（資格の正本。名前 → 値） */
  readonly alwaysSecret?: Readonly<Record<string, string>>;
}

export interface SecretValueRedactor {
  /** 生の文字列（JSONL の本文を含む）を伏せる。値が JSON の文字列として逃がされた形（`"`・`\` を含む値）も当てる */
  redactText(text: string): string;
  /** 行（JSON の値）の文字列の葉を伏せる。何も変わらなければ同じ参照を返す */
  redactEntries(entries: readonly unknown[]): unknown[];
}

interface Needle {
  readonly value: string;
  readonly mark: string;
}

export function createSecretValueRedactor(source: SecretValueSource): SecretValueRedactor {
  const byValue = new Map<string, string>();
  const add = (name: string, value: unknown): void => {
    if (typeof value !== 'string' || value.length < SECRET_ENV_VALUE_MIN_LENGTH) return;
    if (!byValue.has(value)) byValue.set(value, name);
  };
  for (const [name, value] of Object.entries(source.alwaysSecret ?? {})) add(name, value);
  for (const [name, value] of Object.entries(source.env)) {
    if (isSecretEnvName(name)) add(name, value);
  }
  // 長い値から当てる: 値が別の値を含むとき、短いほうが先に当たると長いほうの断片が残るため
  const plain: Needle[] = [...byValue.entries()]
    .map(([value, name]) => ({ value, mark: `[redacted:env:${name}]` }))
    .sort((a, b) => b.value.length - a.value.length);
  const escaped: Needle[] = plain
    .map((n) => ({ value: JSON.stringify(n.value).slice(1, -1), mark: n.mark }))
    .filter((n, i) => n.value !== plain[i]?.value);

  const apply = (text: string, needles: readonly Needle[]): string => {
    let out = text;
    for (const { value, mark } of needles) {
      if (out.includes(value)) out = out.split(value).join(mark);
    }
    return out;
  };

  const redactString = (text: string): string => apply(text, plain);

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item: unknown) => {
        const r = redactValue(item);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : value;
    }
    if (typeof value === 'object' && value !== null) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const r = redactValue(item);
        if (r !== item) changed = true;
        // 普通の代入にしない: `__proto__` という名前のキーがプロトタイプの書き換えに化けるため
        Object.defineProperty(out, key, {
          value: r,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return changed ? out : value;
    }
    return value;
  }

  return {
    redactText: (text) => (plain.length === 0 ? text : apply(apply(text, plain), escaped)),
    redactEntries: (entries) => (plain.length === 0 ? [...entries] : entries.map(redactValue)),
  };
}
