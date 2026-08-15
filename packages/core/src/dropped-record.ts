import type { JournalEntryInput } from './schema.js';

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
  const at = new Date().toISOString();
  const tail = detail === '' ? '' : `（${detail}）`;
  process.stderr.write(
    `alteroid: ${at} ${what}を記録できませんでした${tail}: ${reasonOf(error)}\n`,
  );
}

/**
 * 日誌エントリから、本文を含まない見分けだけを取り出す。
 *
 * 出すのは**書き手（＝この実装）が選んだ列挙値と id** だけである。自由文
 * （`text` / `decision` / `grounds` / `question` / `summary` / `body`）は入れない —
 * 秘密が載りうるのはそこだからである。長さだけは出す（「空だった」と
 * 「書けなかった」の区別が付く）。
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
      return `decision ${size(entry.decision)}`;
    case 'escalation':
      return (
        `escalation approvalId=${tag(entry.approvalId)}` +
        (entry.managerId === undefined ? '' : ` managerId=${tag(entry.managerId)}`)
      );
    case 'tool_use':
      return `tool_use actor=${tag(entry.actor)} tool=${tag(entry.tool)}`;
    case 'memory_update':
      return `memory_update slug=${tag(entry.slug)} cause=${tag(entry.cause)}`;
    case 'daily_report':
      return `daily_report date=${tag(entry.date)} ${size(entry.body)}`;
    case 'external_event':
      return `external_event source=${tag(entry.source)} ${size(entry.summary)}`;
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
 */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return clip(text.split('\n', 1)[0] ?? '', REASON_LIMIT);
}

/** 列挙値・id を1行に収める（改行を持ち込ませない）。 */
function tag(value: string): string {
  return clip(value.replaceAll(/\s+/gu, ' '), TAG_LIMIT);
}

function size(text: string): string {
  return `chars=${text.length}`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
