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
 * **切り口はコードポイントの境界へ寄せる**（`excerpt.ts` の `codePointBoundary`。
 * #1549 で塞いだ穴と同じもの。#1606）。160コード単位目を絵文字がまたぐと、
 * そのまま切れば高サロゲートだけが残り、UTF-8 へ変える経路（受信箱の本文・
 * `manager_list` の応答）で黙って U+FFFD に化ける。寄せた回は159字になる。
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

import { codePointBoundary } from './excerpt.js';
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
 *
 * **`export` する。** `buildDenialInputHead`（表示用。伏せ字つき・160字に切る）
 * がこの関数を土台にする。
 *
 * ## ⚠️ 一致鍵には使わない（issue #1768）
 *
 * `runner.ts` の1回限りの許可の一致鍵（`#consumeOneShotAllow` /
 * `#onPermissionDenied`）は、**この関数の返り値を使わない。**
 * 以前はここが「伏せ字にする前・切る前の完全な文字列」を返すという説明の
 * もとで一致鍵の材料にも使われていたが、その説明は `command` という文字列欄を
 * 持たない入力（`JSON.stringify` へ落ちる形）にしか当てはまっていなかった。
 * `Bash` のように `command` を持つオブジェクトでは、**この関数は `command` の
 * 値だけを返し、`run_in_background` / `timeout` / `dangerouslyDisableSandbox`
 * のようなほかの欄を丸ごと捨てる**（すぐ下の実装のとおり）。一致鍵にこれを
 * 使うと、`command` が同じでほかの欄だけが違う撃ち直し（前景/背景・
 * サンドボックスの有無など、実行の意味論を変える差分）にまで、クローンが
 * 出した1回だけの許可が及んでしまう——「入力が1文字違えば返さない」という
 * 要求を満たさない、**許しすぎる側の穴**だった（issue #1768。横断レビュー
 * 14回目、PR #1750 の歯が `command` の文字列しか変えない対照しか持たな
 * かったため、この穴には気づかれていなかった）。
 *
 * **一致鍵には {@link matchInputOf} を使う**——入力全体（`command` を含む
 * 全欄）をキー順に依らない形で畳んだもの。表示（`buildDenialInputHead`）は
 * 「読みやすい短い1行」を目的にしているので `rawLineOf` のままでよく、
 * 今回変えたのは**鍵の側だけ**である。
 */
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

/**
 * `toolInput` **全体**を、1回だけの許可（issue #1105 P1）の一致鍵に使うための
 * 文字列へ正規化する（issue #1768）。
 *
 * ## `rawLineOf` との違い（なぜ別の関数が要ったか）
 *
 * `rawLineOf` は表示用に作った関数で、`command` という文字列欄を持つ入力からは
 * **その欄だけ**を取り出し、ほかの欄を捨てる。一致鍵にそれを使うと、`command`
 * が同じでほかの欄（`run_in_background` / `timeout` /
 * `dangerouslyDisableSandbox` 等）だけが違う撃ち直しにまで許可が及ぶ——
 * issue #1768 が見つけた「許しすぎる側」の穴そのもの。この関数は**入力の
 * 全欄**をダイジェストの材料にすることでそれを塞ぐ。
 *
 * ## 正規化の中身——キー順に依らない
 *
 * オブジェクトはすべての階層でキーを辞書順に並べ替えてから `JSON.stringify`
 * する。SDK がオブジェクトのキー順を安定して返す保証は無いので、**同じ入力が
 * キー順の違いだけで別の鍵にならない**ようにするためである（配列の要素順序は
 * 変えない——配列は「順序を持つ値」として入力の一部だから）。
 *
 * ## `description` のような欄も除外していない
 *
 * Bash の `description` は実行の意味論を変えない欄だが、あえて鍵から外して
 * いない。「どの欄が意味を持つか」を道具ごとに知る前提を鍵に持ち込むと、
 * 新しい道具・新しい欄が増えるたびに見直しが要る——**迷ったら入力全体を鍵に
 * する**（厳しい側。同じ内容の撃ち直しだけが通る。1個でも欄が増減・変化した
 * 撃ち直しは、たとえ意味を変えない欄の変化でも、あらためて分類器の判定を
 * 受ける）。この判断で通らなくなる撃ち直しは、クローンにもう一度「1回だけ
 * 許可する」を求めるだけで、安全側にしか倒れない。
 *
 * ## `undefined` を返すのは入力が無い・畳めないときだけ
 *
 * `toolInput === undefined` か、循環参照などで `JSON.stringify` が例外を
 * 投げる形（`rawLineOf` と同じ判断）。一致鍵が作れない入力は、呼び出し側
 * （`#onPermissionDenied` / `#consumeOneShotAllow`）が「1回だけの許可を
 * 出さない・使わない」という安全側の扱いにする。
 */
export function matchInputOf(toolInput: unknown): string | undefined {
  if (toolInput === undefined) return undefined;
  try {
    return JSON.stringify(sortKeysDeep(toolInput));
  } catch {
    return undefined;
  }
}

/**
 * オブジェクトのキーをすべての階層で辞書順に並べ替える（配列の要素順序は変えない）。
 *
 * **欄は `Object.defineProperty` で詰める。普通の代入（`sorted[key] = …`）は
 * 使わない**（issue #1787）。`tool_input` は JSON から作られるので、
 * `JSON.parse` が `__proto__` という名前の**自前の欄**を持たせうる。普通の
 * 代入だと、その欄は器のプロトタイプの書き換えに化けて自前の欄にならず、
 * `JSON.stringify` から欄の有無も中身も消える——`__proto__` の有無や中身だけが
 * 違う撃ち直しが同じ鍵になる（許しすぎる側）。`defineProperty` は
 * `JSON.parse` と同じく自前の欄を作るので、この欄も鍵に入る。
 */
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
    ? `${redacted.slice(0, codePointBoundary(redacted, DENIAL_INPUT_HEAD_LIMIT))}${TRUNCATION_MARK}`
    : redacted;
}
