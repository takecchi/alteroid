import type { InboxEvent, JournalEntryInput } from './schema.js';

/**
 * 記録の書き込みに失敗したことを stderr へ1行だけ残す。
 *
 * **握り潰しをやめるのではない。跡だけを残す。** 記録できないことでセッションを
 * 殺すべきではない（文脈を失う方が高くつく）。だが跡がどこにも無いと、
 * **日誌が判別器として静かに嘘をつく** — 「日誌にマーカーが無い」が
 * 「その処理を通らなかった」と読めてしまい、実際には「通ったが書けなかった」
 * だった、という取り違えが起きる。しかも一番書けなくなりやすいのは片付けの
 * 途中（ストアを閉じた後）＝一番調べたい時間帯である。
 *
 * **本文は出さない。** ここへ渡ってくる記録には、マネージャーの報告
 * （＝外の世界から拾ってきた任意の文字列）がそのまま入る。過去に `GH_TOKEN` が
 * 報告経路へ全文で出た事故があり（#52）、書けなかった本文を丸ごとログへ吐くと
 * **日誌にすら入らなかった秘密がホスティング先のログには残る**という逆転が起きる。
 * 日誌はまだ持ち主しか読まないが、stderr は器の外へ出ていく。
 *
 * **足りないと思っても本文を足さないこと。** ここは「何が起きたか」を掘るための
 * 跡であって、落ちた記録の代わりではない。中身が要るなら、ストアが書ける状態に
 * 戻してから読む。
 *
 * @param what 何を記録し損ねたか（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け（`journalEntryShape` などで作る）
 */
export function noteDroppedRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を記録できませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 記録の**読み出し**に失敗したことを stderr へ1行だけ残す。
 *
 * **書けなかった側（`noteDroppedRecord`）と対になる。** あちらの理由がそのまま
 * こちらにも効く —「跡がどこにも無いと、**『無い』が『通らなかった』と読める**」。
 * 読み出しではその取り違えがもう一段悪くなる: 読めなかったことが跡に残らないと、
 * 呼び出し側は**預かっていない**と読み、下流はそれを**恒久の結論**（終端状態・
 * 自動再試行の打ち切り・存在の否定を含む文言）に変える。
 *
 * **`noteDroppedRecord` を流用しないのは、あれが「記録できませんでした」と
 * 書くからである。** 読み出しの失敗にその文を当てると、跡そのものが何が起きたかを
 * 取り違えさせる（この関数が防ごうとしているものと同じ形になる）。
 *
 * **本文は出さない。** 理由は `noteDroppedRecord` と同じで、ここへ渡ってくる
 * 記録には外の世界から拾ってきた任意の文字列が入る（#52）。
 *
 * @param what 何を読み出し損ねたか（固定文言。呼び出し側が書く）
 * @param detail 本文を含まない見分け
 */
export function noteUnreadableRecord(what: string, detail: string, error: unknown): void {
  const tail = detail === '' ? '' : `（${detail}）`;
  note(`${what}を読み出せませんでした${tail}: ${reasonOf(error)}`);
}

/**
 * 受信箱が閉じた後に届いた合図を、このプロセスでは処理しなかったことを
 * stderr へ1行だけ残す。
 *
 * **「捨てた」とは書かない。** かつてはここで本当に捨てていて、その根拠は
 * 「処理しようとすると『未読の永続化』という別の設計になる」だった。その設計は
 * いま在るので、呼び出し側（`Clone#post`）は器へ残してから来る。
 *
 * **それでも「残した」とも書かない。** この窓の後半ではストアが既に閉じており、
 * 書き込みは落ちうる。落ちたことは `noteDroppedRecord` が別の行で言うので、
 * ここが断言すると**書けなかった回だけ跡が静かに嘘をつく**（1行目は「次の起動へ
 * 回した」、2行目は「書けなかった」で、後から読む者は前者を信じる）。この行が
 * 主張するのは**このプロセスでは処理しなかった**という、観測できたことだけである。
 *
 * **なぜ日誌ではなく stderr か。** `post` は同期で、返り値を持たない。日誌へ
 * 書くなら fire-and-forget にならざるを得ないが、**捨てが起きる窓（`stop()` →
 * `storage.close()` → `process.exit(0)`）はその約束が果たされる前にプロセスが
 * 消える窓そのもの**である。しかもその窓の後半ではストアが既に閉じており、
 * 日誌への追記は失敗して結局 `noteDroppedRecord` の stderr へ落ちる。**跡を
 * 残すために、跡が残らないことのある経路を選ばない。** 同期で1行書けば、窓の
 * どこで捨てても同じ跡になる。
 *
 * **日誌の型を足して解かないこと。** 「捨てた」は既存のどの型でもなく、
 * `journalEntrySchema` を広げると `JOURNAL_ENTRY_TYPES` 経由で `openapi.json`
 * ＝外向きの API 面が動く。跡を残すためだけに外へ出す面を広げない。
 *
 * **見分けは呼び出し側に選ばせない。** ここへ来る合図には人間の発言・webhook の
 * 本文・マネージャーの報告が入る（報告本文に `GH_TOKEN` が全文で出た前例が
 * ある。#52）。何を載せてよいかの判断は `inboxEventShape` の1か所に閉じる。
 */
export function noteDroppedInboxEvent(event: InboxEvent): void {
  note(
    `受信箱を閉じた後に届いた合図はこのプロセスでは処理しませんでした` +
      `（器へ残せていれば次の起動で配り直されます）: ${inboxEventShape(event)}`,
  );
}

/**
 * 受信箱の合図から、本文を含まない見分けだけを取り出す。
 *
 * **判定の基準は `journalEntryShape` と同じ**（「自由文かどうか」ではなく
 * 「値を誰が決めるか」）。したがって `external` の `source` は
 * `POST /events/:source` の URL パスセグメント＝外の送り元が決める値なので、
 * 名前に見えても長さだけにする。逆に `managerId` / `approvalId` はこちらが
 * 発行した id、`kind` / `reason`（`distill`）は列挙値なので載せてよい。
 *
 * `human_message` の `conversationId` は呼び出し側が指定できる値であり、
 * `journalEntryShape` の `exchange` も載せていない。**同じ値の扱いを2か所で
 * 変えないこと。**
 */
export function inboxEventShape(event: InboxEvent): string {
  switch (event.type) {
    case 'human_message':
      return `human_message ${size(event.text)}`;
    case 'human_answer':
      return `human_answer approvalId=${tag(event.approvalId)} ${size(event.answer, 'answer')}`;
    case 'distill':
      return `distill reason=${tag(event.reason)}`;
    // `kind` は `scheduleKindSchema`（英小文字・数字・. _ - の64字以内）で、
    // 仕込んだのは持ち主かクローンである。`memory_update` の `slug` と同じ扱い。
    case 'timer':
      return (
        `timer kind=${tag(event.kind)}` +
        (event.cause === undefined ? '' : ` cause=${tag(event.cause)}`) +
        (event.target === undefined ? '' : ` target=${tag(event.target)}`)
      );
    // `payload` は webhook の本文そのもの。**長さも出さない** — 長さを得るには
    // 一度 JSON へ畳む必要があり、畳んだ文字列が跡へ載る事故が入りやすい。
    case 'external':
      return `external ${size(event.source, 'source')} payload=${event.payload === undefined ? 'none' : 'yes'}`;
    case 'self_initiative':
      return `self_initiative ${size(event.reason)}`;
    case 'manager_message':
      return (
        `manager_message managerId=${tag(event.managerId)} kind=${tag(event.kind)}` +
        (event.requestId === undefined ? '' : ` requestId=${tag(event.requestId)}`) +
        ` ${size(event.text)}`
      );
  }
}

/**
 * stderr へ1行書く。
 *
 * **時刻は自分で付ける**（ホスティング先が付ける時刻に頼らない。付かない先が
 * ある）。跡を出す口をここ1本にしてあるのは、本文を出さないという判断が
 * このファイルの外へ散らないようにするためである。
 */
function note(text: string): void {
  process.stderr.write(`alteroid: ${new Date().toISOString()} ${text}\n`);
}

/**
 * 日誌エントリから、本文を含まない見分けだけを取り出す。
 *
 * 出すのは**書き手（＝この実装）が選んだ列挙値と id** だけである。自由文
 * （`text` / `decision` / `grounds` / `question` / `answer` / `summary` / `body` /
 * `input`）は入れない — 秘密が載りうるのはそこだからである。**長さはどの自由文に
 * ついても出す**（「空だった」と「書けなかった」の区別が付く。型によって出したり
 * 出さなかったりすると、跡の読み方が型ごとに変わる）。
 *
 * **判定は「自由文かどうか」ではなく「値を誰が決めるか」で行うこと。**
 * `tool_use` の `actor` / `tool` は SDK と runner が確定する値なので載せてよい。
 * 対して `external_event` の `source` は、**`POST /events/:source` の URL
 * パスセグメント**である＝外部の送り元が決める値なので、名前に見えても載せない。
 * ここを「本文（`summary`）ではないから」で通すと、#52 と同じ形が縮小して残る。
 *
 * **本文から id 相当を拾い出さないこと。** `[mgr-xxx]` のような目印は本文の先頭に
 * 入っているが、そこを切り出す規則を1つ認めると「本文は出さない」が
 * 「本文は原則出さない」に変わる。どのマネージャーだったかは時刻で突き合わせる。
 */
export function journalEntryShape(entry: JournalEntryInput): string {
  switch (entry.type) {
    case 'exchange':
      return `exchange with=${tag(entry.with)} role=${tag(entry.role)} ${size(entry.text)}`;
    case 'decision':
      return `decision ${size(entry.decision, 'decision')} ${size(entry.grounds, 'grounds')}`;
    case 'escalation':
      return (
        `escalation approvalId=${tag(entry.approvalId)}` +
        (entry.managerId === undefined ? '' : ` managerId=${tag(entry.managerId)}`) +
        ` ${size(entry.question, 'question')}` +
        (entry.answer === undefined ? '' : ` ${size(entry.answer, 'answer')}`)
      );
    case 'tool_use':
      return `tool_use actor=${tag(entry.actor)} tool=${tag(entry.tool)}`;
    case 'memory_update':
      return (
        `memory_update slug=${tag(entry.slug)} cause=${tag(entry.cause)}` +
        (entry.action === undefined ? '' : ` action=${tag(entry.action)}`) +
        ` ${size(entry.summary)}`
      );
    case 'daily_report':
      return `daily_report date=${tag(entry.date)} ${size(entry.body)}`;
    // `source` は外から来る値なので、名前であっても長さだけにする（上の doc 参照）。
    case 'external_event':
      return `external_event ${size(entry.source, 'source')} ${size(entry.summary)}`;
    // **全フィールドが runner 自身の数え上げ（整数・列挙値）で、自由文が1つも
    // 無い。** 値を決めるのは runner であって外の世界ではないので、`size()` へ
    // 逃がさず数値をそのまま載せてよい（`tool_use` の `actor`/`tool` と同じ判定
    // 基準 — 「自由文かどうか」ではなく「値を誰が決めるか」）。
    case 'worker_wait':
      return (
        `worker_wait tasks=${entry.tasks} turns=${entry.turns} ` +
        `toolless=${entry.toolless} settled=${entry.settled}`
      );
    // `layer` / `site` は列挙値、`managerId` はこちらが発行した id、`sessionId`
    // は SDK が決める値だが id である（`worker_wait` と同じ判定基準）。
    // **`models` の内訳（トークン数・costUsd）は SDK が数え上げた数値であって
    // 自由文ではないので、モデル id ごとの件数だけ載せる** — キーであるモデル
    // id は列挙に近い固定の語彙（`claude-opus-5` 等）であり、値は数値なので
    // 自由文を経由して秘密が混ざる経路が無い。それでも中身の数値までは
    // 載せない（跡はここまでで十分 — どのモデルで何件かが分かれば、ストアが
    // 書ける状態に戻してから読める）。
    case 'turn_usage':
      return (
        `turn_usage layer=${tag(entry.layer)} site=${tag(entry.site)} ` +
        `managerId=${tag(entry.managerId)} models=${Object.keys(entry.models).length}` +
        (entry.reset === undefined ? '' : ' reset=yes')
      );
  }
}

/** 1行に収まる長さの上限（理由の側）。 */
const REASON_LIMIT = 200;

/** id や列挙値として載せてよい長さの上限。 */
const TAG_LIMIT = 64;

/**
 * 失敗の理由を1行に畳む。
 *
 * **理由だけは出す。** 「書けなかった」しか残らない行を読んだ者にできることは、
 * ストアを一から疑うことしかない。ただしドライバの例外は失敗したクエリの
 * パラメータを添えてくることがある（＝本文が裏口から戻ってくる）ので、
 * **1行目だけ・長さも切る**。
 *
 * **記録の失敗をログへ出すところは、すべてここを通すこと。** いま漏れる例外を
 * 投げるストアが無くても、素の `String(error)` を1か所でも残すと、その1か所だけ
 * 将来のストア実装に無防備なまま置き去りになる（そして誰も気づかない）。
 */
export function reasonOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return clip(text.split('\n', 1)[0] ?? '', REASON_LIMIT);
}

/** 列挙値・id を1行に収める（改行を持ち込ませない）。 */
function tag(value: string): string {
  return clip(value.replaceAll(/\s+/gu, ' '), TAG_LIMIT);
}

/**
 * 自由文の長さだけを出す。
 *
 * 名前を付けられるようにしてあるのは、1つの型に自由文が2つ以上あるときに
 * `chars=0 chars=0` が何と何なのか分からなくなるからである。
 */
function size(text: string, name?: string): string {
  return `${name === undefined ? '' : `${name}.`}chars=${text.length}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
