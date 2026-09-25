/**
 * 分類器・deny 規則の拒否より前に見た道具の入力から、**値そのものの先頭**を
 * 短く・伏せて残す（issue #1105）。
 *
 * ## `denial-shape.ts` との違い
 *
 * `denial-shape.ts` は値を一切出さず**形**（欄名・長さ・先頭の語）だけを残す。
 * こちらは逆で、値そのものの先頭を残す——それができるのは、SDK の走行中の
 * 拒否の合図（`system/permission_denied`）自体には `tool_input` が原理的に
 * 付かない（`runner-protocol.ts` の `input` の doc）一方で、`runner.ts` の
 * `#onPreToolUse` は**拒否より前**に同じ `tool_use_id` の入力を見ているから
 * である。値を運ぶ以上、`denial-shape.ts` より強い伏せ字が要る——同じ
 * ファイルへ足すと、読み手が「あれは形だけの関数だ」という前提のまま
 * こちらを読み、伏せ字の強さを見誤る。だから別ファイルに置く。
 *
 * ## 出すもの・出さないもの
 *
 * - **出す**: 伏せ字を通した後の入力の先頭、最大 {@link DENIAL_INPUT_HEAD_LIMIT} 文字
 * - **出さない**（伏せる）:
 *   - 秘密らしい名前（`TOKEN` / `KEY` / `SECRET` / `PASSWORD` / `CREDENTIAL` /
 *     `AUTH` を含む）の環境変数の値。ただし{@link SECRET_ENV_VALUE_MIN_LENGTH}
 *     未満の値は対象にしない（`redactEnvSecrets` 自体に長さの下限が無いため。
 *     `usage-probe.ts` の同関数の doc）
 *   - 既知のトークンの接頭辞（`ghp_` / `gho_` / `ghs_` / `github_pat_` /
 *     `sk-ant-` / `AKIA`）・`Bearer <token>`・秘密らしい名前への代入
 *     （`NAME=value` / `"NAME":"value"`）・40桁 hex（git の SHA）・
 *     英数字混在24文字以上の塊
 *
 * ## 伏せてから切る
 *
 * **先に160字で切ってから伏せると、境界で割れたトークンの断片が上のどの
 * パターンにも合わなくなり、そのまま残る。** だから必ず「伏せ字→切る」の
 * 順で行う（{@link buildDenialInputHead} の実装そのものがこの順）。
 *
 * ## 塞げていないもの（正直に書く。`denial-shape.ts` の doc と同じ姿勢）
 *
 * - **英字だけ・数字だけでできた短い秘密**（`hunter2` のようなパスワード）は
 *   どの伏せ字にも掛からず残る
 * - **このファイルが知らない命名の環境変数**（例えば独自の慣習で `MY_X` の
 *   ような名前に置いた鍵）は {@link SECRET_ENV_NAME_PATTERN} に一致しないので
 *   残る——一致するかどうかは「値がどこかの env に実在するか」ではなく
 *   「変数の**名前**がこのパターンに合うか」で決まる
 * - **既知の接頭辞を持たないトークン**（このリポジトリが知らない外部サービスの
 *   独自形式で、かつ英数字混在24文字未満のもの）は一般則にも掛からず残る
 * - **`redactEnvSecrets` と同じ、単純な文字列置換である。** 値が変形されて
 *   （base64 で包む・改行を挟む・大文字小文字を変える等）現れた場合までは
 *   塞げない
 * - **`command` 以外の欄からトークンや代入の形が来ても、代入・トークン系の
 *   正規表現自体は欄をまたいで文字列全体に掛かる**——`JSON.stringify` した
 *   1行の中に埋まっていても伏せる対象にはなるが、位置に依存するパターン
 *   （`denial-shape.ts` の「先頭の語」のような）はここには無い
 */

import { redactEnvSecrets } from './usage-probe.js';

/** 伏せてから切る、最終的な文字数の上限（issue #1105 本文の「先頭最大160字」）。 */
export const DENIAL_INPUT_HEAD_LIMIT = 160;

/** 切ったことを示す印。**空にしない**——「切った」と「切っていない」を分ける。 */
const TRUNCATION_MARK = '…';

/** 伏せた値の置き換え先。**空にしない**——「伏せた」という事実自体を残す。 */
const REDACTED = '[REDACTED]';

/**
 * 名前がこれに一致する環境変数だけを、値の伏せ字の対象にする
 * （`TOKEN` / `KEY` / `SECRET` / `PASSWORD` / `CREDENTIAL` / `AUTH` を含む名前。
 * `PASSWORD` を含む名前は自動的に `PASS` も含むので、`PASS` は別に足していない）。
 *
 * **この一覧は器の環境に何が置かれているか分からない前提の、名前だけの
 * パターンである。** alteroid 自身が使う具体の環境変数名の一覧
 * （`credentials.ts` の `ENV_FILE_OWNED_CREDENTIAL_NAMES` 等）とは別物で、
 * 流用もしていない——流用すると「その一覧に載っていない秘密」が伏せ字の
 * 対象から漏れる。ここは伏せ字（広く構える側）なので、狭い具体名の一覧より
 * 広いパターンを使う。
 */
const SECRET_ENV_NAME_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * これ未満の長さの値は置換の対象にしない。
 *
 * {@link redactEnvSecrets}（`usage-probe.ts`）自体は値の長さに下限を持たない
 * ——`LANG=C` のような短い値まで置換すると、出力の大半が `[REDACTED]` に
 * 化ける（あの関数の doc）。ここで長さの下限を先に掛けてから渡すことで、
 * その事故を避ける。
 */
const SECRET_ENV_VALUE_MIN_LENGTH = 8;

/**
 * `env` から、名前が {@link SECRET_ENV_NAME_PATTERN} に合い・値が
 * {@link SECRET_ENV_VALUE_MIN_LENGTH} 以上のものだけを抜き出し、
 * {@link redactEnvSecrets}（`usage-probe.ts`）へ渡す。
 *
 * **`process.env` を丸ごと渡さない。** 上の2条件で候補を絞ってから渡す
 * ——`denial-shape.ts` の「環境変数による最後の網を掛けていない理由」が
 * 指摘する事故（短い値まで置換されて出力が壊れる）を、この2条件で防ぐ。
 */
function redactSecretEnvValues(text: string, env: NodeJS.ProcessEnv | undefined): string {
  if (env === undefined) return text;
  const candidates: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_NAME_PATTERN.test(name)) continue;
    if (typeof value !== 'string' || value.length < SECRET_ENV_VALUE_MIN_LENGTH) continue;
    candidates[name] = value;
  }
  return redactEnvSecrets(text, candidates);
}

/** 英数字が混ざっていて、この長さ以上の塊は既知の接頭辞に関わらず伏せる。 */
const SECRET_ISH_MIN_LENGTH = 24;

/** `NAME=value` / `"NAME":"value"` の左辺に使う、秘密らしい名前の文字クラス。 */
const SECRET_ASSIGNMENT_NAME = `[A-Za-z_][A-Za-z0-9_]*(?:${SECRET_ENV_NAME_PATTERN.source})[A-Za-z0-9_]*`;

/**
 * 既知のトークンの形・代入・SHA を伏せる（`env` を経由しない、字面だけの判定）。
 *
 * **順序に意味がある。** 先に既知の接頭辞（GitHub のトークン・Anthropic の
 * API 鍵・AWS のアクセスキー id）を伏せ、次に代入の形、最後に「英数字混在
 * 24文字以上」という一般則を当てる。一般則を先に当てても既知の接頭辞は
 * （長さの条件を満たす限り）どのみち伏せられるので結果は変わらないが、
 * この順のほうが「何を狙って書いたか」が読める。
 */
function redactKnownSecretPatterns(text: string): string {
  let result = text;

  // GitHub のトークン（`ghp_` 等の旧形式・`github_pat_` の新形式）。
  result = result.replace(/\bgh[oprsu]_[A-Za-z0-9]{20,255}\b/g, REDACTED);
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,300}\b/g, REDACTED);
  // Anthropic の API 鍵。
  result = result.replace(/\bsk-ant-[A-Za-z0-9_-]{10,300}\b/g, REDACTED);
  // AWS のアクセスキー id（`AKIA` + 英大文字・数字16桁）。
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  // `Authorization: Bearer <token>` / 生の `Bearer <token>`。
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`);
  // シェルの代入 / `.env` の1行（`FOO_TOKEN=abc123`）。
  result = result.replace(
    new RegExp(`\\b(${SECRET_ASSIGNMENT_NAME})=(\\S+)`, 'gi'),
    (_match, name: string) => `${name}=${REDACTED}`,
  );
  // JSON の1行に埋まった同じ形（`"FOO_TOKEN":"abc123"`）。`command` 以外の
  // 欄は `JSON.stringify` を経由するので、こちらも当てておく。
  result = result.replace(
    new RegExp(`"(${SECRET_ASSIGNMENT_NAME})"\\s*:\\s*"([^"]*)"`, 'gi'),
    (_match, name: string) => `"${name}":"${REDACTED}"`,
  );
  // git の SHA（40桁 hex）。**取りこぼしより誤伏せを選ぶ**——本文に40桁 hex が
  // 現れること自体まれで、秘密ではない大半を伏せても実害は小さい。
  result = result.replace(/\b[0-9a-f]{40}\b/gi, REDACTED);
  // 英数字が混ざった長い塊は、既知の接頭辞を持たなくても伏せる
  // （{@link SECRET_ISH_MIN_LENGTH}。`denial-shape.ts` の同名の定数と同じ考え方
  // だが、こちらは値そのものを運ぶ関数なので独立して定義している）。
  result = result.replace(
    new RegExp(`\\b[A-Za-z0-9_-]{${SECRET_ISH_MIN_LENGTH},}\\b`, 'g'),
    (match) => (/[0-9]/.test(match) && /[A-Za-z]/.test(match) ? REDACTED : match),
  );

  return result;
}

/**
 * `toolInput` を1行の文字列にする。**`command` 欄が文字列ならそれを、
 * そうでなければ `JSON.stringify`。** `Bash` 以外の道具（`Edit` の
 * `old_string`/`new_string` 等）はこちらへ落ちる。
 *
 * `undefined` を返すのは「入力そのものが無かった・1行にできなかった」ときだけ
 * ——循環参照など `JSON.stringify` が例外を投げる形も含む
 * （`denial-shape.ts` の `charsOf` と同じ判断）。
 */
function rawLineOf(toolInput: unknown): string | undefined {
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

/**
 * `PreToolUse` が見た入力から、拒否の合図へ載せてよい「入力の先頭」を作る
 * （issue #1105）。`runner.ts` の `#capturePreToolInputHead` がこれを呼ぶ。
 *
 * **`undefined` を返すのは入力そのものが無かった・1行にできなかったときだけ**
 * （`rawLineOf` の doc）。**空文字はありうる値として返す**——空のコマンドは
 * 「無い」ではなく「そういう入力だった」。
 *
 * **必ず伏せてから切る。** 先に切ると、160字の境界で割れたトークンの断片が
 * どのパターンにも合わなくなり、そのまま残ってしまう（ファイル冒頭の doc）。
 */
export function buildDenialInputHead(
  toolInput: unknown,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  const raw = rawLineOf(toolInput);
  if (raw === undefined) return undefined;
  const redacted = redactKnownSecretPatterns(redactSecretEnvValues(raw, env));
  return redacted.length > DENIAL_INPUT_HEAD_LIMIT
    ? `${redacted.slice(0, DENIAL_INPUT_HEAD_LIMIT)}${TRUNCATION_MARK}`
    : redacted;
}
