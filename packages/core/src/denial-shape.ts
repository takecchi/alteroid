/**
 * 止められた道具呼び出しの**入力の形**だけを、値を出さずに1行へ畳む。
 *
 * **なぜ形なのか。** 拒否の記録に入力が1文字も残らないと、読む側は
 * 「良性のコマンドが誤検知された」と「拒否されるべきコマンドだった」を
 * 区別できない——次の一手が変わるのに、変える材料が無い。かといって本文を
 * そのまま日誌へ書くのは危険である。道具の入力には環境変数の値・トークン・
 * URL に埋まった鍵が入りうる。**だから値ではなく形を書く**——これは
 * `usage-probe.ts` の `redactEnvSecrets` と同じ向きの判断であり、
 * 「読めない値を trace に残すときは値ではなく長さを書く」という
 * `profile.ts` の `chars=` の先例（PR #636）をそのまま延ばしたものである。
 *
 * ## 出すもの・出さないもの（この線がこの関数の全部である）
 *
 * **出す:**
 *
 * - **欄の名前**（`command` / `file_path` / …）。これは道具のスキーマ由来で
 *   あって、モデルが書いた値ではない。**原理的に秘密になりえない**
 * - **長さ**（`chars=N`）。値そのものではなく、値の大きさ
 * - **`command` 欄の先頭の語**——ただし {@link SAFE_HEAD_WORD} に合う形のときだけ。
 *   **入力が素の文字列のときは出さない**（下の「先頭の語をどこまで出すか」）
 *
 * **出さない:** それ以外の値。引数も、パスも、URL も、`command` の2語目以降も。
 *
 * ## 先頭の語をどこまで出すか（危ないので明示する）
 *
 * 先頭の語は「良性か否か」の判断にいちばん効く（`git` なのか `rm` なのか
 * `curl` なのか）。だが**先頭の語も無条件には安全ではない**:
 *
 * - `TOKEN=abc123 curl …` のように、シェルは代入を先頭に置ける。この形の
 *   先頭の語は**値そのもの**である
 * - `https://example.com/?token=…` のような URL が先頭に来る形もある
 *
 * だから {@link SAFE_HEAD_WORD} は `=` も `:` も `/` も許さず、長さも 32 で
 * 切る。**代入・URL・長い塊は先頭の語として出さない。**
 *
 * **そして先頭の語を見るのは `command` 欄だけである。** 入力が素の文字列で
 * 来た回には当てない —— 道具の入力は普通オブジェクトなので、文字列がそのまま
 * 来る形はシェルのコマンド行ではなく、そこで先頭の語を取ると**入力が 1 語
 * だったとき（＝値そのものが鍵だったとき）に鍵をまるごと出す**。得るものが
 * 無い側なので当てない。
 *
 * **それでも塞げていないものを書いておく**（`redactEnvSecrets` の doc と同じ
 * 作法——塞げないと分かっていることを塞いだことにしない）: **`command` 欄の
 * 先頭に秘密が単独で置かれ、かつ 32 文字以内で `[A-Za-z0-9._+-]` だけから
 * できている**とき、この関数はそれを出す（`{ command: 'hunter2' }` の形）。
 * 実際にそう書かれる形——秘密をプログラム名の位置に置いて実行しようとする——は
 * 考えにくいが、**不可能ではない**。GitHub / Anthropic のトークンも AWS の
 * アクセスキー id も {@link SECRET_ISH_MIN_LENGTH} で落ちるが、**英字だけ・
 * 数字だけでできた短い秘密**（`hunter2` のようなパスワード）は落ちない。
 * ここを完全に塞ぐには先頭の語を一切出さないしかなく、そうすると Bash の
 * 拒否がすべて「欄=command / chars=N」だけになり、この関数を足した意味
 * （誤検知か正当な拒否かを読む側が判断できること）が消える。**その交換を
 * 選んでいる。**
 *
 * ## 環境変数による最後の網を掛けていない理由
 *
 * `redactEnvSecrets(text, env)` を `process.env` で通すことは**しない**。
 * あの関数は値の長さに下限を持たず、`LANG=C` のような短い値まで置換の対象に
 * するので、`process.env` を丸ごと渡すと出力の中の `C` が軒並み
 * `[REDACTED]` に化ける。あれは probe が**候補トークンだけ**を持つ env を
 * 渡すための道具であって（`UsageProbeOptions.env` の doc）、ここへは当てない。
 */

/**
 * 拒否の帳面（`tool_use_id` ごと）が覚える1件。**`runner.ts` と `clone.ts` で
 * 同じものを使う** —— 片方だけ直っている状態は、直っていない側の欠落を
 * 「そういう入力だった」と読ませる（`runner.ts` の `#flushUsage` の doc が
 * 層ごとに書き分けないと言っているのと同じ理由）。
 *
 * **持つのは1ビットだけである。** 入力そのものを覚えない —— 覚えれば、忘れる
 * までの間ずっとコマンド本文（＝鍵が入りうる文字列）を抱えることになり、
 * しかも `onForget` の日誌行へ滲み出る経路が増える。必要なのは「入力を持つ
 * 記録をもう降ろしたか」だけなので、それだけ持つ。
 */
export interface DeniedRecord {
  /** その id について、入力を持つ記録を既に降ろした（＝日誌へ形を残した）か。 */
  input: boolean;
}

/**
 * 入力が付いていない回に、なぜ無いのかを言う一文。
 *
 * **空文字を置かない。** `brief(undefined)` が `''` を返していたせいで、
 * 「空のコマンドだった」と「そもそも入力が届かない経路だった」が同じ字面に
 * 見えていた——それがこの修正の出発点である。**「無い」の種類を潰さない。**
 *
 * **Markdown の記号を書かないこと。** この一文はそのまま報告本文
 * （`react-markdown` で描かれる面）へ埋まる。`_` や `*` を書くと `<em>` に
 * 化ける（`manager.ts` の `#emit` 側の doc）。
 */
export function denialInputAbsence(via: 'live' | 'result'): string {
  return via === 'live'
    ? '入力は付いていない（走行中の合図には入力の欄が無い。' +
        'ターン終わりの記録が届けば、続く note に形だけ残る）'
    : '入力は付いていない（result の記録に入力の欄が無かった）';
}

/**
 * 先頭の語をそのまま出してよい形。
 *
 * `=`（代入）・`:` `/`（URL・パス）・空白を許さず、長さは 32 まで。
 * 素のプログラム名（`git` / `rm` / `curl` / `pnpm` / `node` / `gh` …）は
 * 通り、`TOKEN=abc` や `https://…` は通らない。
 */
const SAFE_HEAD_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

/**
 * 「英数字が混ざっていて、この長さ以上」なら先頭の語を出さない。
 *
 * **この条件が単独で守っている範囲は「英数字が混ざった 12〜32 文字」である。**
 * それより長い鍵——GitHub の PAT（`ghp_` + 36 文字＝40 文字）や Anthropic の
 * API 鍵——は、{@link SAFE_HEAD_WORD} の 32 文字上限が先に落とすので、**ここまで
 * 届かない**。この条件が要るのは、上限より短くて `=` も `:` も `/` も含まない
 * 鍵である——**AWS のアクセスキー id（`AKIA` で始まる 20 文字の英大文字＋数字）が
 * まさにそれで、{@link SAFE_HEAD_WORD} だけなら素通しする。**
 *
 * **この分担は変異試験で測って書き直した。** 当初この doc は「PAT はここで落ちる」と
 * 書いていたが、`SECRET_ISH_MIN_LENGTH` を無効化する変異を当てても PAT の歯は
 * 落ちなかった——長さ上限のほうが先に効いていたからである。**守っていない
 * ものを守っていると書かない。**
 *
 * **実在するプログラム名はほとんど落ちない。** 数字を含む名前は短い
 * （`python3` / `gpg2` / `sha256sum` / `base64`）か、数字を含まないまま長い
 * （`docker-compose` / `update-alternatives`）かのどちらかである。落ちる側に
 * 回るのは `x86_64-linux-gnu-gcc-13` のような長いツールチェーンの名前で、
 * **そのときは `(伏せた)` になる**——読める語が1つ減るだけで、道具の名前
 * （`Bash`）と欄と長さは残る。**この交換は「出さない側へ倒す」で選んでいる。**
 */
const SECRET_ISH_MIN_LENGTH = 12;

/** 先頭の語を出さないときに置く字面。**空にしない**——「見なかった」と「隠した」を分ける。 */
const WITHHELD_HEAD_WORD = '(伏せた)';

/** 欄の名前を並べる上限。長い入力で1行が壊れないようにするだけで、安全の線ではない。 */
const MAX_KEYS = 8;

/**
 * `command` らしき欄の名前。ここに載っている欄だけ、先頭の語を見る。
 *
 * **道具ごとに増やすときは「その欄の先頭の語がプログラム名か」を確かめること。**
 * 例えば `file_path` はここに入れない——先頭の語がパスの断片になり、
 * 「値を出さない」という線を越える。
 */
const COMMAND_KEYS = new Set(['command']);

/**
 * `input` から先頭の語を取る。取れない・出してよい形でないなら `undefined`。
 *
 * **`undefined` は「取れなかった」であって「危なかった」ではない。** 呼び出し側は
 * 区別せず {@link WITHHELD_HEAD_WORD} に落とす——読む側にとってはどちらも
 * 「この行からは読めない」で同じだからである。
 */
function headWordOf(value: string): string | undefined {
  const head = value.trimStart().split(/\s/, 1)[0];
  if (head === undefined || head === '') return undefined;
  if (!SAFE_HEAD_WORD.test(head)) return undefined;
  // **英数字が混ざった長い語は出さない**（{@link SECRET_ISH_MIN_LENGTH}）。
  if (head.length >= SECRET_ISH_MIN_LENGTH && /[0-9]/.test(head) && /[A-Za-z]/.test(head)) {
    return undefined;
  }
  return head;
}

/** `JSON.stringify` が落ちない形で長さを測る。測れなければ `undefined`。 */
function charsOf(value: unknown): number | undefined {
  if (typeof value === 'string') return value.length;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.length;
  } catch {
    // 循環参照など。**長さすら測れなかった**ことを、0 と偽らずに返す。
    return undefined;
  }
}

/**
 * 止められた道具呼び出しの入力を、秘密を含まない1行へ畳む。
 *
 * **`undefined` を返すのは「入力そのものが無かった」ときだけである。**
 * 呼び出し側はこれを「入力は空だった」と書き換えないこと——
 * `via: 'live'` の合図には `tool_input` が原理的に付かない
 * （`runner-protocol.ts` の `input` の doc）ので、**「無い」には
 * 「取れない経路だった」という意味があり、それは潰してはいけない。**
 */
export function denialInputShape(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (input === null) return 'null';

  const chars = charsOf(input);
  const size = chars === undefined ? '長さ不明' : `chars=${chars}`;

  // **素の文字列には先頭の語を出さない。** 道具の入力は普通オブジェクトで、
  // 文字列がそのまま来る形はシェルのコマンド行ではない。そこへ先頭の語の規則を
  // 当てると、**値そのものが 1 語だったとき（＝入力全体が鍵だったとき）に、
  // その鍵をまるごと出す**。先頭の語で得られるもの（プログラム名が読める）が
  // 無い側なので、出さない側へ倒す。
  if (typeof input === 'string') return `文字列 / ${size}`;
  if (typeof input !== 'object') return `${typeof input} / ${size}`;
  if (Array.isArray(input)) return `配列 / 要素=${input.length} / ${size}`;

  const keys = Object.keys(input as Record<string, unknown>);
  const shown = keys.slice(0, MAX_KEYS).join(',');
  const keyList = keys.length === 0 ? '(欄なし)' : keys.length > MAX_KEYS ? `${shown},…` : shown;

  // **先頭の語は `command` らしき欄のときだけ見る。** 欄が無ければその節ごと
  // 落とす——「先頭の語=(伏せた)」と書くと、見に行って隠したように読める。
  const commandKey = keys.find((key) => COMMAND_KEYS.has(key));
  const commandValue =
    commandKey === undefined ? undefined : (input as Record<string, unknown>)[commandKey];
  const headPart =
    typeof commandValue !== 'string'
      ? ''
      : ` / 先頭の語=${headWordOf(commandValue) ?? WITHHELD_HEAD_WORD}`;

  return `欄=${keyList}${headPart} / ${size}`;
}
