import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { createClient, type DaemonClient } from './client.js';
import { formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';

/**
 * `alteroid memory` — 記憶（人格）を読む・書き換える・消す。
 *
 * **読めるのに直せない面を作らない。** `docs/PRD.md`「インターフェース」は3面
 * （CLI・HTTP API・Web UI）で同じことができると書いており、起こせることの列挙に
 * **「記憶の書き換え」**がある。それまで CLI は `chat` の `/memory` で**読むだけ**で、
 * `PUT` / `DELETE /memory/:slug` に到達できなかった（`apps/cli/src` に `$put` は
 * 1件も無かった）。
 *
 * **記憶を人間が直せることは M1 の受け入れ基準3そのものである**（「人間がその
 * Markdown を手で書き換える → 次の会話でクローンの判断に反映される」）。ローカルの
 * fs 構成ならファイルを直に開けるが、pg 構成やコンテナの向こうではそれができない —
 * つまり**器を替えると受け入れ基準が満たせなくなる**状態だった。
 *
 * 形は `alteroid profile`（実行環境プロファイル）に合わせてある。人間が同じ手つきで
 * 使えることのほうが、コマンド名の短さより効く。
 */

/**
 * 一覧に出す1件（`GET /memory` の要素）。
 *
 * **`export` してあるのは `chat.ts` の `/memory` から使うため。** あちらは
 * 同じ `GET /memory` を見ながら、この一覧が持つ4項目（概要・作成・更新・
 * 鮮度の印）を1つも出していなかった（#235 はトップレベルの
 * `alteroid memory list` だけを直し、`chat` の中の重複実装は残っていた）。
 * 型と整形ロジック（`formatCreatedAt` / `freshnessMarker`）をここから
 * 再利用し、`chat.ts` 側で新しい言い方を発明しないようにする。
 */
/**
 * 本文の変化量（#913 / #821 残課題）。`MemoryDescriptionFreshness` の
 * `stale` にだけ乗る（`fresh` は定義上 drift 0 なので持たない）。
 * `packages/core/src/schema.ts` の `memoryDescriptionDriftSchema` と同じ形
 * ——CLI は HTTP 経由の JSON を見ているだけで `@alteroid/core` の型その
 * ものを持ち込んでいないので、ここでも私物として持つ
 * （`formatMemoryStaleness` の doc と同じ理由）。
 */
export type MemoryDescriptionDrift =
  | { kind: 'measured'; describedBytes: number; currentBytes: number; deltaBytes: number }
  | {
      kind: 'at-least';
      baselineBytes: number;
      baselineAt: string;
      currentBytes: number;
      deltaBytes: number;
    }
  | { kind: 'unrecorded' };

export interface MemorySummary {
  slug: string;
  title: string;
  kind: 'premise' | 'fact' | 'indexed';
  description?: string;
  descriptionFreshness:
    | { kind: 'fresh' }
    | { kind: 'stale'; staleForMs: number; drift: MemoryDescriptionDrift }
    | { kind: 'unknown' }
    | { kind: 'absent' };
  /** 最後に本文が変わった時刻。 */
  updatedAt: string;
  /**
   * 作成時刻。**根拠が無ければ `unknown`。**
   *
   * `GET /memory` は #220 からこの2状態で返す（日誌に最初の書き込みが無ければ
   * `unknown`。ファイルの mtime は使わない）。**空欄にしないこと** — 空欄だと
   * 「取れていない」のか「読み忘れ」なのか区別できない。
   */
  createdAt: { kind: 'known'; at: string } | { kind: 'unknown' };
}

/**
 * 作成時刻を1行に出す形。**根拠が無ければ「不明」と明言する。**
 *
 * クローンの `memory_list`（`packages/core/src/memory.ts` の
 * `formatMemoryCreatedAt`）と同じ言葉にしてある。**片方だけ空欄にすると、
 * 人間とクローンが同じ記憶を見て違う判断をする。**
 *
 * `export` してあるのは `chat.ts` の `/memory` から使うため（同上）。
 */
export function formatCreatedAt(createdAt: MemorySummary['createdAt']): string {
  return createdAt.kind === 'known' ? createdAt.at : '不明';
}

/**
 * `formatCreatedAt` の横に経過を添える（issue #2141 段1、`alteroid memory
 * list` だけ）。
 *
 * **`unknown` の倒れ先はそのまま。** 「不明」に経過を添えると、読めないのに
 * 何かが分かったかのような値（例えば `0分前`）を作ることになる——`formatElapsedAgo`
 * が読めない ISO を「経過不明」に倒すのと同じ理由で、ここでも `known` のときだけ
 * 添える。
 */
function formatCreatedAtWithElapsed(createdAt: MemorySummary['createdAt'], now: number): string {
  if (createdAt.kind === 'known') {
    return `${createdAt.at}（${formatElapsedAgo(createdAt.at, now)}）`;
  }
  return formatCreatedAt(createdAt);
}

export async function memoryListCommand(now: number = Date.now()): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client } = conn;
  const response = await client.memory.$get();
  if (!response.ok) {
    stdout.write(
      `${await withErrorReason(`記憶の一覧を読めませんでした（HTTP ${String(response.status)}）`, response)}\n`,
    );
    return;
  }
  const { documents } = (await response.json()) as { documents: MemorySummary[] };
  if (documents.length === 0) {
    // **「0 件」で終わらせない。** 次の一手が無いと、空なのか読めていないのかが
    // 人間の側から区別できない。
    stdout.write('記憶はまだ空です。\n');
    stdout.write('置くには: alteroid memory edit <slug>\n');
    return;
  }
  for (const doc of documents) {
    const marker = freshnessMarker(doc.descriptionFreshness);
    const desc = doc.description === undefined ? '' : ` — ${marker}${doc.description}`;
    // 5項目: slug（id）/ title（名前）/ description（概要）/ 作成 / 更新。
    // 括弧の中の形は `memory_list` に揃えてある。
    stdout.write(
      `  [${doc.kind}] ${doc.slug}  — ${doc.title}` +
        ` (作成: ${formatCreatedAtWithElapsed(doc.createdAt, now)} / 更新: ${doc.updatedAt})${desc}\n`,
    );
  }
  // **一覧から次の一手へつなぐ。** 0 件の枝が「置くには」を出すのと同じ理由で、
  // 1 件以上のときは本文を読むコマンドを出す（`conversations.ts` の
  // `renderConversationsList` の「中身を読むには」と同じ位置・同じ形）。
  stdout.write('本文を読むには: alteroid memory show <slug>\n');
}

/**
 * 経過ミリ秒を「1時間」「30日」のような字面にする（`freshnessMarker` の
 * `stale` 専用）。
 *
 * **`packages/core/src/memory.ts` の `formatMemoryStaleness` と同じ考え方
 * だが、実体は分けて持つ。** `@alteroid/core` から値を1つでも import すると
 * バンドラが tree-shake できずに丸ごと混入する問題は Web 側の話で CLI には
 * 無いが、CLI はサーバから来た JSON（`MemorySummary`）を見ているだけで
 * `@alteroid/core` の型そのものを持ち込んでいないので、ここでも同じ理由
 * （二重管理より用途ごとの独立を取る、`packages/logic/src/format.ts` の
 * `formatRelative` と同じ判断）で私物として持つ。
 *
 * **`Math.max(seconds, 0)` は core 側とは違う理由で残す。** core の
 * `resolveMemoryDescriptionFreshness` は非負であることを保証してから返すが、
 * ここが受け取るのは HTTP 経由の JSON（信頼境界の外）——境界を越えた値を
 * 型が保証しているだけで信じない、という別の理由の防御である（同じ異常を
 * 同じプロセス内で2箇所が隠す、という core 側で避けた形とは異なる）。
 */
function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

/**
 * `MemoryDescriptionDrift` の網羅性を型で強制する（#913 / #821 残課題。
 * core 側の `assertNeverMemoryDescriptionDrift` と同じ形——`drift` の
 * 状態を1つ足したときに埋め忘れた分岐で `tsc` が落ちる側へ倒す）。
 */
function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

/**
 * 変化量（バイト）を人間可読な文字列にする（`describeMemoryDescriptionDrift`
 * の `measured` 専用。`packages/core/src/memory.ts` の
 * `formatMemoryDescriptionDrift` と同じ考え方だが実体は分けて持つ——同上の
 * 理由）。
 */
function formatMemoryDescriptionDrift(drift: {
  describedBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  if (drift.describedBytes === 0) return `本文は${sign}${magnitude}バイト変わった`;
  const percent = Math.round((Math.abs(drift.deltaBytes) / drift.describedBytes) * 100);
  return `本文は${sign}${magnitude}バイト（${sign}${percent.toLocaleString('en-US')}%）変わった`;
}

/**
 * 変化量（バイト）を人間可読な文字列にする（`at-least` 専用、#821 残課題。
 * `packages/core/src/memory.ts` の `formatMemoryDescriptionDriftAtLeast` と
 * 同じ考え方だが実体は分けて持つ）。**`%` を出さず、`baselineAt` も刷らず、
 * `本文は` も持たない**——理由は core 側の同名関数の doc と同じ。
 */
function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

/**
 * `MemoryDescriptionDrift`（3状態）を人間可読な文字列にする（#913 /
 * #821 残課題）。**`switch` で網羅し、`default` で
 * `assertNeverMemoryDescriptionDrift` へ落とす。**
 */
function describeMemoryDescriptionDrift(drift: MemoryDescriptionDrift): string {
  switch (drift.kind) {
    case 'measured':
      return formatMemoryDescriptionDrift(drift);
    case 'at-least':
      return formatMemoryDescriptionDriftAtLeast(drift);
    case 'unrecorded':
      return '本文の変化量は記録されていない';
    default:
      return assertNeverMemoryDescriptionDrift(drift);
  }
}

/**
 * 印は要旨の前に置く（`memory_list` ツール・プロンプトの目次と同じ約束。
 * `packages/core/src/memory.ts` の doc）。**代理指標である** — `fresh` は
 * 「要旨が最後の本文変更以降に書かれた」ことしか意味しない。
 *
 * **`absent` 以外の3状態は必ず何か言う（#821）。** 「⚠古い要旨」が
 * 12文書すべてで鳴っていた欠陥の直し——`stale` かどうかの1ビットではなく、
 * `stale` ならどれだけ古いか（`staleForMs`）を、`unknown` なら「取れな
 * かった」であって「0（＝最新）」ではないことを、`fresh` なら「本文は
 * 動いていない」という正直なゼロを、それぞれ別の言葉で言う。
 *
 * **`stale` は本文の変化量（`drift`、#913）も期間に並べて言う。** 時間差
 * だけでは「いちばん手が入っている文書がいちばん新しく見える」ので、
 * 期間フレーズは置き換えず追記する。
 *
 * `export` してあるのは `chat.ts` の `/memory` から使うため（同上）。
 */
export function freshnessMarker(freshness: MemorySummary['descriptionFreshness']): string {
  switch (freshness.kind) {
    case 'stale':
      return (
        `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い` +
        `（${describeMemoryDescriptionDrift(freshness.drift)}）: `
      );
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'absent':
      return '';
  }
}

export async function memoryShowCommand(slug: string): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const doc = await readDoc(conn.client, conn.target, slug);
  if (doc === null) {
    stdout.write(`そんな記憶はありません: ${slug}\n`);
    return;
  }
  const content = doc.content;
  stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

/**
 * `$EDITOR` で開いて、閉じたら反映する。
 *
 * **無い slug でも開ける。** 記憶を新しく作るのも「人間が直せる」に含まれる
 * （`PUT` は全文置換で、存在しない slug でも作られる）。空から始めるときだけ
 * 雛形を入れる。
 */
export async function memoryEditCommand(slug: string): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const doc = await readDoc(client, target, slug);
  const current = doc === null ? null : doc.content;
  // **読んだ時の版を持ち回る（Issue #2743）。** エディタを開いている間にクローンが
  // 同じ記憶へ書くと、版が変わっていて 409 になる（黙って上書きしない）。無い slug は
  // `null`（「読んだ時には無かった」）。古いデーモンが `version` を返さないときは
  // 前提なし（従来どおり後勝ち）で書く。
  const ifMatch = doc === null ? null : doc.version;

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-memory-'));
  const path = join(dir, `${slug}.md`);
  // **衝突したときだけ、人間が書いた内容を含む一時ディレクトリを消さない。**
  let keep = false;
  try {
    await writeFile(path, current ?? template(slug), 'utf8');
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    if (current !== null && edited === current) {
      // **書き換えていないなら書き込まない。** 同じ本文でも `PUT` は日誌へ
      // `memory_update` を積むので、押し戻すたびに「人間が書き換えた」が
      // 増えていく（後から経緯を読む側が、実際には無かった変更を数える）。
      stdout.write('変更はありません。\n');
      return;
    }
    try {
      await write(client, target, slug, edited, ifMatch);
    } catch (error) {
      if (!(error instanceof MemoryConflictCliError)) throw error;
      // **人間が書いた内容を失わない。** 消さずに残し、いまの版も隣へ置いて、
      // 見比べる道具（`diff`）と次の手を案内する。
      keep = true;
      const theirs = join(dir, `${slug}.current.md`);
      if (error.current !== null) await writeFile(theirs, error.current, 'utf8');
      stdout.write(
        [
          `書き換えていません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、消されました）。`,
          `  あなたの編集（残してあります）: ${path}`,
          error.current === null
            ? '  いまの記憶: 無い（消されています）'
            : `  いまの記憶: ${theirs}`,
          ...(error.current === null ? [] : [`  見比べる: diff -u ${theirs} ${path}`]),
          `  取り込んだら \`alteroid memory edit ${slug}\` で開き直して直してください。`,
          `  そのまま置き換えてよいなら \`alteroid memory set ${slug} --file ${path}\`（クローンの書き込みを消します）。`,
          '',
        ].join('\n'),
      );
      throw new Error(`記憶が読んだ後に変わっていたので書き換えませんでした: ${slug}`, {
        cause: error,
      });
    }
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true });
  }
}

/** ファイル（または標準入力）の内容で丸ごと置き換える。 */
export async function memorySetCommand(
  slug: string,
  options: { file?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  await write(conn.client, conn.target, slug, content);
}

/**
 * 記憶を1つ消す。
 *
 * **確認を求めない。** Web には確認の段が無く（ボタン1つで消える）、CLI にだけ
 * `--yes` を要求すると「CLI だけができないこと」を作る。消した事実は日誌に残るので、
 * 記憶から消えても記録からは消えない（`DELETE /memory/:slug` の description）。
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** 書き込み系（消す
 * 操作）なので、`reset.ts` / `access.ts` / `token.ts` / `alteroid interrupt`
 * （#1621）と同じく、HTTP の失敗を握り潰さない（#1641）。
 *
 * **「無い」と「名前として不正」は、サーバが 404 と 400 で分けているものを
 * そのまま伝える**（1つに潰すと打ち間違いなのか消えたのかが読めなくなる）。
 * **それ以外（401/403/5xx）を、この2つのどちらかだと取り違えない**——
 * 以前はここが「400 以外は全部『無い』」という形をしていたため、認証切れや
 * サーバの内部エラーでも「そんな記憶はありません」と誤案内していた。
 */
export async function memoryRemoveCommand(slug: string): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.memory[':slug'].$delete({ param: { slug } });
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`記憶の名前として成立しません: ${slug}`);
    }
    if (response.status === 404) {
      throw new Error(`そんな記憶はありません: ${slug}`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `記憶を消せませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`消しました: ${slug}\n`);
}

/**
 * 繋ぎ先を決めて型付きクライアントを作る。**繋げない理由はそのまま出す。**
 *
 * 読み取り系で例外にしないのは `usage.ts` と揃えるためである（`alteroid: Error: …` の
 * 形にすると、「ログインしていません」という人間向けの案内が例外の見た目で出る）。
 * 書き込み系は下の #2456 の判断で例外にする（見た目より、終了コードが 0 でないことを採る）。
 *
 * **`target` も一緒に返す。** 書き込み系（`write` / `memoryRemoveCommand`）が
 * HTTP の失敗を `describeAuthFailure` で判定するのに要る（#1641）。
 *
 * **`access: 'write'` のときは、未ログインの note を例外にする**（#2456、クローン
 * teto の判断 2026-09-30）。状態を変えるつもりで叩いたのに何もせず終了コード 0 で
 * 返ると、cron などが「済んだ」と誤読する。読み取り系（`'read'`）は今のまま、
 * note を stdout に出して `null` を返す（呼び出し側は 0 で return する）。
 */
async function connect(
  access: 'read' | 'write',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}

/**
 * 無ければ `null`。**空文字と区別する**（空の記憶は在りうる）。
 *
 * **`null` は「無い」（404）と「名前が成立しない」（400）だけである。** それ以外の失敗
 * （401/403/5xx）を `null` にすると、`show` は「そんな記憶はありません」と嘘を言い、
 * `edit` は**あるはずの記憶を読めていないのに空のひな形でエディタを開く**（保存すれば
 * 既存の中身を上書きする）。読めなかった理由は例外で上へ通す。
 */
/** 本文と、その版（`GET /memory/:slug` の `version`。古いデーモンでは `undefined`）。 */
async function readDoc(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<{ content: string; version: string | undefined } | null> {
  const response = await client.memory[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `記憶を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  if (!('document' in body)) return null;
  return {
    content: body.document.content,
    version: 'version' in body && typeof body.version === 'string' ? body.version : undefined,
  };
}

/** `PUT` が 409（読んだ後に変わっていた）を返した。`current` はいまの本文（消えていれば null）。 */
class MemoryConflictCliError extends Error {
  readonly current: string | null;
  constructor(slug: string, current: string | null) {
    super(`記憶が読んだ後に変わっています: ${slug}`);
    this.current = current;
  }
}

/**
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** `memoryRemoveCommand`
 * と同じ理由（#1641）。
 *
 * **400 は「記憶の名前が不正」の意味を保つ**（サーバの `memorySlugSchema` 検証。
 * `PUT /memory/:slug` が返す唯一の明示的な失敗コード）。**それ以外
 * （401/403/5xx）を「名前が不正」だと取り違えない**——以前はここが `!response.ok`
 * を1つに潰していたため、認証切れやサーバの内部エラーでも「名前が不正かも
 * しれません」と誤案内していた。
 */
async function write(
  client: DaemonClient,
  target: Target,
  slug: string,
  content: string,
  ifMatch?: string | null,
): Promise<void> {
  const response = await client.memory[':slug'].$put({
    param: { slug },
    json: ifMatch === undefined ? { content } : { content, ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { document?: { content?: string } } | null;
    };
    throw new MemoryConflictCliError(slug, body.current?.document?.content ?? null);
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`書き換えられませんでした: ${slug}（記憶の名前が不正かもしれません）`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `書き換えられませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`書き換えました: ${slug}\n`);
  // **どこに効くかを言う。** 記憶はクローンのシステムプロンプトに載るので、
  // 次のターンから判断の材料になる（M1 受け入れ基準3）。
  stdout.write('（次の会話からクローンの判断に入ります）\n');
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function openEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} が異常終了しました (${String(code)})`));
    });
  });
}

/**
 * 空から始めるときの雛形。
 *
 * **「何をしてよいかの表」を書かせない。** 記憶は判断の根拠を置く場所であって、
 * 許可する行為の一覧ではない（一覧を作ると AGENTS.md 地雷表3行目の
 * `permissions.yaml` と同じ形になる）。
 */
function template(slug: string): string {
  return `# ${slug}

（ここにクローンへ渡したい根拠を書きます。価値観・判断の基準・背景など）

- 記憶は次の会話からクローンの判断に入ります
- 鍵やトークンは書かないでください（記憶はシステムプロンプトに載ります。
  それは実行環境プロファイル: alteroid profile edit の仕事です）
`;
}
