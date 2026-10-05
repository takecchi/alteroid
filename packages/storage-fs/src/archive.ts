import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  MAX_UTF8_BYTES_PER_CODE_POINT,
  archiveIdBranch,
  assertArchivableSessionId,
  hasNul,
  stripNul,
  classifyArchiveContinuity,
  compareArchiveEntriesNewestFirst,
  createUnreadableRowOnce,
  fingerprintArchiveBody,
  matchArchiveIdStamp,
  tailByCodePoints,
  tallyArchiveContinuity,
  type ArchiveContinuity,
  type ArchiveEntry,
  type ArchiveRead,
  type ArchiveRemoval,
  type ArchiveSessionSummary,
  type ArchiveWrite,
  type TranscriptArchive,
  type UnreadableRowOnce,
} from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * 同じミリ秒に同じセッションへ積まれたときに、枝番を試す上限（#905）。
 *
 * **超えたら例外を投げる。⛔ 黙って上書きへ落ちない。** 「捨てた」ことが
 * 観測できない形がこの Issue の欠陥そのものなので、塞ぎ方の側で同じ形を
 * 作らない。pg 側（`packages/storage-pg/src/archive.ts` の
 * `MAX_ARCHIVE_ID_ATTEMPTS`）と同じ値・同じ倒れ方である。
 */
const MAX_ARCHIVE_ID_ATTEMPTS = 1000;

/** `n` 回目の候補 id（1回目は枝番無し＝従来と同じ形）。 */
function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * PreCompact フックで要約に潰される直前の全文をここへ落とす。人間が後から追う
 * ための用途にセッション本体を太らせ続けない(architecture.md「寿命モデル」)。
 *
 * **`remove()`（#698）は本体の `.jsonl` を消さない。** 空へ切り詰め、脇に
 * `<id>.removed` という印ファイルを置く——`list()` が `.jsonl` で絞っている
 * ので、印は別の拡張子にして一覧へ混ざらないようにしてある。**判定は印の
 * 有無だけで行う**（`read()` は印を先に見る）——本体が空文字であることを
 * 「消された」の根拠にしない（空の生ログは正当にありえる）。
 *
 * **`list()` / `sessions()`（#698 の拡張）は、脇の `<id>.meta.json` から
 * `sessionId` / `at` を読む。** ファイル名にも同じ情報が入っている
 * (`${sanitize(sessionId)}-${stamp}.jsonl`) が、`sanitize()` は非可逆
 * （`[^A-Za-z0-9._-]` を `_` へ潰す）なので、ファイル名からは pg 版の
 * `session_id` 列と同じ生の値を復元できない。脇へ生の値を持つことで、
 * `sessionId` が3実装（インメモリ / fs / pg）のあいだで一致する
 * (`archive-contract.ts` が測る)。**この meta ファイルより前に作られた
 * アーカイブ（sidecar が無い）は、ファイル名から best-effort で復元する**
 * (`#fallbackMeta`)——`sanitize` 済みの近似値になるが、無いよりはよい。
 */
export class FsTranscriptArchive implements TranscriptArchive {
  readonly #dir: string;
  /**
   * **壊れた sidecar の知らせを、1本につき1回に絞る**（issue #2231。許可の記録の
   * #2191 と同じ形）。`list()` / `sessions()` は呼ぶたびに全行の sidecar を読み直す
   * ので、絞らないと、同じ壊れた1本が直るまで呼び出しの回数だけ同じ行が stderr に
   * 積もり、他の合図を埋める。鍵は `<sidecar の種類>:<id>`。読めた（無いも含む）
   * ときは鍵から外すので、直した後にまた壊れたら1回知らせ直す。
   * `read(id)` / `remove(id)` がその id について投げるのは、今までどおりである
   * （名指しで触った操作の結果を黙らせない）。
   */
  readonly #unreadableOnce: UnreadableRowOnce = createUnreadableRowOnce();

  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * **判定のために本体の `.jsonl` を読まない（#698）。** 直前の退避は
   * `#findPreviousArchiveForSession` が `.meta.json` サイドカーだけを見て
   * 探し、その `bodyChars` / `bodyMd5` と新しい本文の指紋を突き合わせる
   * だけで `classifyArchiveContinuity` が判定を終える。
   *
   * **id が衝突したら枝番を上げる（#905）。** `stamp` はミリ秒精度なので、
   * 同じセッションへ同じミリ秒に2回積むと id が衝突する。**排他フラグ無しの
   * `writeFile` はそれを黙って上書きしていた**——退避の回数が過少に数えられ、
   * 生ログが1本消えた。いまは `flag: 'wx'`（排他作成）で書き、`EEXIST` なら
   * `${base}-2.jsonl` → `${base}-3.jsonl` … と枝番を上げる。
   *
   * ⭐ **`remove()` は本体を消さず空へ切り詰めるだけ**なので、tombstone
   * 済みの id でも `wx` は正しく `EEXIST` になる（＝ 一度使った id は埋まった
   * まま）。この性質に依存している。
   *
   * **衝突していない id の形は1文字も変わらない**ので、既存の退避に移行は
   * 要らない。**先頭が `sanitize(sessionId)` である性質も保たれる**（id の
   * 前方一致が効く。#698 §6-5）。
   *
   * **「直前を引く → 判定する → 書く」を `sessionId` ごとの `withPathLock`
   * で直列化する（#1732）。** 以前はここにロックが無く、同じ `sessionId` への
   * 並行 `archive()`（同一プロセス内の `Promise.all` だけで踏める——実測:
   * 真に前方一致する8本を並行に積むと8本とも `'first'` になった）が
   * `#findPreviousArchiveForSession` を同じ状態で読み、同じ「直前」を見て
   * 同じ判定を出す競合を起こしていた。pg 側（`packages/storage-pg/src/archive.ts`
   * の `archive()`）と同じ形の欠陥で、直し方も同じ形——`sessionId` 単位で
   * 直列化する。**`withPathLock` はプロセス内・プロセス間の両方を排他する**
   * （advisory な強さは `file-lock.ts` の doc）ので、fs ストアを共有する複数
   * プロセス（#1113 が想定する形）にもこれで効く。
   *
   * ⚠️ **`at`（と `stamp` / `base`）はロックを取った**後**で決める。** pg 側の
   * `archive()` と同じ理由——ロックの外で `new Date()` を取ると、「`at` が
   * 早いのに、ロックは後から取った側」が起こりうる。`list()` の並び
   * （`at` 昇順）と、実際にロックを取れた順（＝読み書きが起きた順）がずれ、
   * `comparedTo` の鎖が並びと一致しなくなる——`selectArchiveRemovalTargets`
   * （`packages/core/src/archive-prune.ts`）は配列上の隣接関係と `continuity`
   * だけで含有を推定するので、鎖と並びがずれれば同じように欺かれる。
   *
   * **`mkdir` はロックの内側に置く。** `file-lock.ts` の `withPathLock` の doc
   * 「⚠️ ここで `mkdir` を先に呼んではいけない」と同じ理由——呼ぶ前に
   * `await mkdir(...)` を挟むと、複数の同時呼び出しが `withPathLock` へ実際に
   * 到達する順序が mkdir の完了順にずれ、プロセス内の直列化（FIFO）が乱れる。
   * `withPathLock` 自身は呼んだ時点で同期的にキューへ並ぶことに依存している
   * ので、呼ぶ前には何も `await` しない。
   */
  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    // 積めない sessionId は、ロックを取る前に3実装と同じ例外で断る（issue #2233）。
    assertArchivableSessionId(sessionId);
    return withPathLock(this.#sessionLockPath(sessionId), async () => {
      await mkdir(this.#dir, { recursive: true });
      // **`at` はロックを取った後で決める（#1732）。** 上の doc「⚠️」参照。
      const at = new Date();
      const previous = await this.#findPreviousArchiveForSession(sessionId);
      const fingerprint = fingerprintArchiveBody(transcript);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      const base = `${sanitize(sessionId)}-${stamp}`;
      // 本文の NUL は落として残す（issue #3011。pg と同じ）。指紋と連続性は生の本文で取る（pg と同じ）。
      const name = await this.#writeBodyExclusively(base, stripNul(transcript));
      // **本体より先に meta を書かない理由は無い**（`remove()` の
      // 「印を書いてから本体を切り詰める」とは違い、こちらは新規作成で
      // 競合が無い）。実測上の心配は要らないが、本体が読めればこの id は
      // 実在するので、meta を本体の後に書いても `list()` が拾えない窓は
      // `#fallbackMeta` が埋める。
      await this.#writeMeta(name, {
        sessionId,
        at: at.toISOString(),
        bodyChars: fingerprint.bodyChars,
        bodyMd5: fingerprint.bodyMd5,
        continuity,
      });
      return { id: name, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
    });
  }

  /**
   * `archive()` の並行呼び出しを直列化するロックの対象パス（#1732）。
   *
   * **`.jsonl` / `.meta.json` / `.removed` のどれとも拡張子が被らない**
   * （`sanitize(sessionId)` の後ろに `.session-lock` を付け、`withPathLock` が
   * さらに `.lock` を足す＝実体は `<sanitize(sessionId)>.session-lock.lock`）
   * ので、`#listIds()`（`.jsonl` だけを見る）にも `#readMeta` 系にも紛れ込まない。
   * `sessionId` 単位——他のセッションの `archive()` を待たせない。
   */
  #sessionLockPath(sessionId: string): string {
    return join(this.#dir, `${sanitize(sessionId)}.session-lock`);
  }

  /**
   * 本体の `.jsonl` を**排他作成**で書き、実際に使えた名前を返す（#905）。
   *
   * `EEXIST` 以外の失敗はそのまま投げる（握り潰さない）。上限に達したら
   * 例外——**黙って上書きへ落ちない。**
   */
  async #writeBodyExclusively(base: string, transcript: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ARCHIVE_ID_ATTEMPTS; attempt += 1) {
      const name = archiveIdCandidate(base, attempt);
      try {
        await writeFile(join(this.#dir, name), transcript, { encoding: 'utf8', flag: 'wx' });
        return name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error(
      `archive(): id の衝突が ${MAX_ARCHIVE_ID_ATTEMPTS} 回続いたので退避を中止した（base=${base}）`,
    );
  }

  /**
   * 「直前の退避」＝同じ `sessionId` の行のうち `at` が最大（同値なら `id`
   * が最大）のもの（#698）。**`removedAt`（印ファイルの有無）で絞らない**
   * ——tombstone された行の指紋も、`remove()` が起きた時点までは当時の本文を
   * 正しく表していた有効な情報である。`remove()` は本文を空へ切り詰める
   * だけで、サイドカーの `bodyChars` / `bodyMd5` は書き換えない（`remove()`
   * の実装を見よ）ので、消された行を除外する理由が無い。
   *
   * **`.jsonl` 本体には一切触れない**——`.meta.json` サイドカー（無ければ
   * `fallbackMeta` の best-effort 復元）だけを読む。サイドカーが無い、
   * または `bodyChars` / `bodyMd5` を持たない行は `bodyChars` / `bodyMd5`
   * が `undefined` のまま返り、`classifyArchiveContinuity` がそれを
   * `'unknown'` へ落とす。
   *
   * **同着（`at` が同値）のときの tie-break は `id` の字面順ではなく、
   * `archiveIdBranch` が返す枝番（＝積んだ順）の大小で行う（#908）。**
   * `id` は `-`(0x2D) と `.`(0x2E) の文字コードの関係で
   * `base-2.jsonl < base-3.jsonl < base.jsonl` という順になり、枝番の無い
   * 1本目が字面上は最大になる——3本以上を同じミリ秒に積んだとき、
   * 「`id` が最大」で選ぶと3本目以降が1本目を「直前」だと誤認する
   * （`archive-id.ts` の doc に、枝番が積んだ順と一致する根拠がある）。
   */
  async #findPreviousArchiveForSession(
    sessionId: string,
  ): Promise<{ id: string; bodyChars?: number; bodyMd5?: string } | null> {
    const ids = await this.#listIds();
    let best: { id: string; at: string; bodyChars?: number; bodyMd5?: string } | null = null;
    for (const id of ids) {
      const meta = (await this.#readMeta(id)) ?? fallbackMeta(id);
      if (meta.sessionId !== sessionId) continue;
      if (
        best === null ||
        meta.at > best.at ||
        (meta.at === best.at && archiveIdBranch(id) > archiveIdBranch(best.id))
      ) {
        best = { id, at: meta.at, bodyChars: meta.bodyChars, bodyMd5: meta.bodyMd5 };
      }
    }
    return best === null ? null : { id: best.id, bodyChars: best.bodyChars, bodyMd5: best.bodyMd5 };
  }

  /**
   * 新しい順（#698）。**同着（同じ `at`）の並びは積んだ逆順（新しいものが
   * 先）——`compareArchiveEntriesNewestFirst`（`archive-id.ts`）に委ねる
   * （#908。`id` の字面順の tie-break は使わない。`#findPreviousArchiveForSession`
   * と同じ理由）。**
   *
   * `storedBytes` は `stat().size`——**その置き場が実際に使っているバイト数**
   * であって、生ログの文字数ではない（`ArchiveEntry` interface の doc）。
   * 消された行は本体が `''` へ切り詰められているので、`storedBytes` は
   * 実質 `0` になる（pg の `pg_column_size('')` とは値が揃わない——
   * 「置き場をまたいで比較しない」が、ここでも成り立つ）。
   */
  async list(): Promise<ArchiveEntry[]> {
    const ids = await this.#listIds();
    // **1本の壊れた削除の印で、無関係な全行を落とさない**（issue #1969）。
    // 印が JSON として読めない行だけを一覧から外し、stderr に跡を残す。
    // 壊れた `.meta.json` は `#readMeta` の側で `fallbackMeta` に倒れるので、
    // その行は一覧に残る。
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.#readEntry(id);
        } catch (error) {
          if (error instanceof UnreadableArchiveSidecarError) {
            // 1本につき1回（`#unreadableOnce` の doc。issue #2231）。
            if (this.#unreadableOnce.sawUnreadable(`${error.sidecar}:${error.id}`)) {
              process.stderr.write(`${describeUnreadableSidecar(error)}（一覧から外した）\n`);
            }
            return undefined;
          }
          throw error;
        }
      }),
    );
    return entries
      .filter((entry): entry is ArchiveEntry => entry !== undefined)
      .sort(compareArchiveEntriesNewestFirst);
  }

  /**
   * `sessionId` ごとの集計(#698)。`list()` を1回読んで自分で畳む——fs は
   * 集計用の索引を持たない。
   *
   * `continuity`（#698 続き）は `list()` の各行が持つ `ArchiveEntry.continuity`
   * （`.meta.json` サイドカーから読んだ値。無ければ `undefined`）を
   * `tallyArchiveContinuity` へ渡すだけ——`undefined` は `absent` に数えられる
   * （サイドカー自体が無い、またはサイドカーはあるが `continuity` フィールドを
   * 持たない＝どちらも「この機能より前に積まれた行」であって、判定はできて
   * いない。`ArchiveContinuityTally` の doc）。
   */
  async sessions(): Promise<ArchiveSessionSummary[]> {
    // **2パス**: まず sessionId ごとに行をまとめ、それぞれをまとめて畳む。
    const bySessionId = new Map<string, ArchiveEntry[]>();
    for (const entry of await this.list()) {
      const group = bySessionId.get(entry.sessionId);
      if (group === undefined) bySessionId.set(entry.sessionId, [entry]);
      else group.push(entry);
    }
    const summaries = [...bySessionId.entries()].map(([sessionId, entries]) => {
      const storedBytesList = entries.map((e) => e.storedBytes);
      const atList = entries.map((e) => e.at);
      return {
        sessionId,
        rows: entries.length,
        storedBytes: storedBytesList.reduce((sum, n) => sum + n, 0),
        maxStoredBytes: Math.max(...storedBytesList),
        firstAt: atList.reduce((min, at) => (at < min ? at : min)),
        lastAt: atList.reduce((max, at) => (at > max ? at : max)),
        continuity: tallyArchiveContinuity(entries.map((e) => e.continuity)),
      };
    });
    return summaries.sort(
      (a, b) =>
        b.storedBytes - a.storedBytes ||
        (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
    );
  }

  /**
   * `id` はディレクトリ外を指してはいけない（issue #1635）。**判定は
   * `isWithinArchiveDir`（resolve した実パスが archive ディレクトリの直下に
   * 収まっているか）で行う**——`'/'` を含む id を弾く旧来の `sanitize(id)
   * !== id` は `'.'`/`'..'` を素通りさせていた（`sanitize()` の文字クラスが
   * `.` と `-` を許すため、`'..'` は sanitize しても変わらない）。
   */
  async read(id: string): Promise<ArchiveRead> {
    // NUL を含む id の行は存在しえない（issue #3011）。fs の呼び出しに渡すと投げるので、「無い」と答える。
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const marker = await this.#readMarker(id);
    if (marker !== null)
      return { kind: 'removed', removedAt: marker.removedAt, bytes: marker.bytes };
    try {
      const body = await readFile(join(this.#dir, id), 'utf8');
      return { kind: 'body', body };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }

  /**
   * 末尾だけを読む（#1283 の OOM、読み出し側。`TranscriptArchive.readTail`）。
   *
   * **`maxChars` はコードポイント数で数える（issue #1829）。** 以前はここが
   * 読んだバイト列を UTF-8 デコードしただけの文字列をそのまま返していた
   * ——それは「窓のバイト数の都合で `maxChars` より多く返る」ぶんを一切
   * 削っておらず、しかも量の見積もりが UTF-16 コード単位（1コードユニット
   * あたり最大3バイト）を基準にしていた。pg（PostgreSQL の `right()`。
   * コードポイント数で数える）と揃えるため、いまは (1) 窓のバイト数を
   * コードポイントあたりの最大バイト数（`MAX_UTF8_BYTES_PER_CODE_POINT`）で
   * 見積もり、(2) デコード後の文字列を `tailByCodePoints`
   * （`@alteroid/core`。3実装が共有する唯一の変換）でコードポイント単位に
   * 正確に切り直す。
   *
   * **`clone.ts` の `readTranscriptTail` と同じ形**——file handle でファイルの
   * 末尾から `(maxChars + 1) * {@link MAX_UTF8_BYTES_PER_CODE_POINT}` バイト
   * だけを読む。`readFile()`（`read()` が使うもの）のように全文を1本の文字列
   * へ起こしてから切ると、切る前に本文の全体がプロセスのメモリへ載ってしまい、
   * この関数自身が避けたい OOM を起こす。
   *
   * **`maxChars` ではなく `maxChars + 1` を掛ける。** `MAX_UTF8_BYTES_PER_CODE_POINT`
   * 倍だけでは「窓が実際にファイルを切り詰めたとき、デコード後のコードポイント数が
   * ちょうど `maxChars` になる」場合を防げない（全部が4バイト/コードポイント
   * の内容——補助面の文字——だと、最悪ケースでちょうど `maxChars` に達する）。
   * ちょうどだと、呼び出し側の `tailOf`（`clone.ts`）が「切り詰め済みの窓」を
   * 「本文がもとから短かった」と誤読し、行の途中の窓がそのまま蒸留へ渡る
   * （`readTail` interface doc、clone.test.ts「歯2」で実測——ただし実測したのは
   * in-memory 実装で、こちらは理論上の最悪ケースであり実測はしていない）。
   * `+ 1` を先に掛けておけば、切り詰めが起きるときのデコード後コードポイント数は
   * 常に `maxChars` を厳密に上回る——そのうえで下の `tailByCodePoints` が
   * 「厳密に `maxChars` を上回る量」へ正確に揃える（窓のバイト数の見積もりが
   * 生む超過ぶんは、ここで削られる）。
   *
   * **`bytesRead` で切る。** `handle.read()` は要求より短く返しうるので、
   * `buffer` をそのまま文字列にすると末尾に NUL が並ぶ（`readTranscriptTail`
   * の doc と同じ注意）。
   *
   * tombstone の判定は `read()` と1文字も変えない——印ファイルの有無だけで
   * 見る。`removed` のときは本体を読みに行かない（`body` は既に `''` へ
   * 切り詰められている行なので、読んでも意味が無い）。
   */
  async readTail(id: string, maxChars: number): Promise<ArchiveRead> {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error(
        `archive.readTail(): maxChars は正の整数でなければならない（渡された値: ${String(maxChars)}）`,
      );
    }
    // NUL を含む id の行は存在しえない（issue #3011）。fs の呼び出しに渡すと投げるので、「無い」と答える。
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const marker = await this.#readMarker(id);
    if (marker !== null)
      return { kind: 'removed', removedAt: marker.removedAt, bytes: marker.bytes };

    let handle;
    try {
      handle = await open(join(this.#dir, id), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const window = (maxChars + 1) * MAX_UTF8_BYTES_PER_CODE_POINT;
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      const decoded = buffer.subarray(0, bytesRead).toString('utf8');
      // **窓のバイト数の超過ぶんをコードポイント単位で削る。** 上の doc
      // 「+1 を先に掛ける」理由により、`decoded` はファイル全体を読んだ
      // のでない限り `maxChars + 1` コードポイントより多く持ちうる——
      // `tailByCodePoints` に通せば、pg・インメモリと同じ「厳密に `maxChars`
      // を上回る、サロゲートペアを割らない」量へ揃う。窓がファイル全体に
      // 届いていた（`length === size`）ときは、この呼びは全文をそのまま
      // 返す（`tailByCodePoints` 自身がそう判定する）。
      return { kind: 'body', body: tailByCodePoints(decoded, maxChars + 1) };
    } finally {
      await handle.close();
    }
  }

  /**
   * 本文だけを落とす(tombstone)。**本体の `.jsonl` は消さず、空へ切り詰める。**
   *
   * **印ファイルを `wx`（既に在れば失敗）で作ることで、二重の `remove()` の
   * 競合を防ぐ。** 先に印が書けた側だけが「消した」（`removed`）を名乗り、
   * 遅れた側は `EEXIST` を見て印を読み直し `already` を返す——read-then-write
   * に割ると、2つの `remove()` が両方「消した」と名乗る窓ができる(pg 版の
   * `UPDATE ... WHERE removed_at IS NULL` と同じ理由)。
   */
  async remove(id: string): Promise<ArchiveRemoval> {
    // NUL を含む id の行は存在しえない（issue #3011）。fs の呼び出しに渡すと投げるので、「無い」と答える。
    if (hasNul(id) || !isWithinArchiveDir(this.#dir, id)) return { kind: 'missing' };
    const existingMarker = await this.#readMarker(id);
    if (existingMarker !== null) {
      return { kind: 'already', removedAt: existingMarker.removedAt, bytes: existingMarker.bytes };
    }

    const filePath = join(this.#dir, id);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }

    const removedAt = new Date().toISOString();
    try {
      await writeFile(this.#markerPath(id), JSON.stringify({ removedAt, bytes: size }), {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // 競合: 別の呼び出しが先に印を置いた。その印を読み直して結果を合わせる。
        const marker = await this.#readMarker(id);
        if (marker !== null)
          return { kind: 'already', removedAt: marker.removedAt, bytes: marker.bytes };
      }
      throw error;
    }
    // **印を書いてから本体を切り詰める。** 逆順だと、本体が空になった直後・
    // 印を書く前に落ちた窓で「空の生ログなのに消された印が無い」という、
    // 判定してはいけない状態を自分で作る。
    await writeFile(filePath, '', 'utf8');
    return { kind: 'removed', bytes: size };
  }

  /**
   * 全件を消す（`TranscriptArchive.clear` の doc）。**`.jsonl` 本体・
   * `.meta.json` サイドカー・`.removed` tombstone 印の3つとも消す** —
   * `remove()`（本体を空へ切り詰めるだけ）とは違い、行そのものを無かった
   * ことにする。
   *
   * 返すのは消した `.jsonl`（＝行）の数。サイドカー・印ファイルの有無は
   * 行ごとにまちまちなので数えない（pg 版が返す `archive` テーブルの行数と
   * 単位を揃える）。
   */
  async clear(): Promise<number> {
    const ids = await this.#listIds();
    for (const id of ids) {
      await rm(join(this.#dir, id), { force: true });
      await rm(this.#metaPath(id), { force: true });
      await rm(this.#markerPath(id), { force: true });
    }
    return ids.length;
  }

  async #listIds(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((n) => n.endsWith('.jsonl'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async #readEntry(id: string): Promise<ArchiveEntry> {
    const [marker, meta, storedBytes] = await Promise.all([
      this.#readMarker(id),
      this.#readMeta(id),
      this.#statSize(id),
    ]);
    const resolvedMeta = meta ?? fallbackMeta(id);
    return {
      id,
      sessionId: resolvedMeta.sessionId,
      at: resolvedMeta.at,
      storedBytes,
      ...(marker === null ? {} : { removedAt: marker.removedAt, removedBytes: marker.bytes }),
      ...(resolvedMeta.continuity === undefined ? {} : { continuity: resolvedMeta.continuity }),
    };
  }

  async #statSize(id: string): Promise<number> {
    try {
      return (await stat(join(this.#dir, id))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  #markerPath(id: string): string {
    return join(this.#dir, `${id}.removed`);
  }

  /**
   * 削除の印を読む。**JSON として読めない印は `UnreadableArchiveSidecarError` を
   * 投げる**（issue #1969）。`list()` はそれを捕まえてその1本だけを外す。
   * `read(id)` / `remove(id)` は今までどおりその id について投げる——印が在る
   * （＝消されたかもしれない）行の本体を、読めないまま「在る」と返さないため。
   * 例外のメッセージに中身を載せない（`SyntaxError` の文言は壊れた中身を含む）。
   */
  async #readMarker(id: string): Promise<{ removedAt: string; bytes: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.#markerPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#unreadableOnce.sawReadable(`.removed:${id}`);
        return null;
      }
      throw error;
    }
    try {
      const marker = JSON.parse(raw) as { removedAt: string; bytes: number };
      this.#unreadableOnce.sawReadable(`.removed:${id}`);
      return marker;
    } catch {
      throw new UnreadableArchiveSidecarError(id, '.removed');
    }
  }

  #metaPath(id: string): string {
    return join(this.#dir, `${id}.meta.json`);
  }

  /**
   * **一時ファイル＋rename で書く**（issue #1969）。素の `writeFile` だと、書いて
   * いる途中で落ちたときに半端な JSON が残り、`#readMeta` が読めない sidecar を
   * 作る。`#listIds` は `.jsonl` だけを拾うので、一時ファイル（`….meta.json.tmp.…`）
   * が行として数えられることは無い。
   */
  async #writeMeta(id: string, meta: ArchiveMeta): Promise<void> {
    await writeFileAtomic(this.#metaPath(id), JSON.stringify(meta));
  }

  /**
   * `bodyChars` / `bodyMd5` / `continuity` を持たないサイドカー（この機能
   * より前に積まれた行）でも例外を投げない——欠けたフィールドは `undefined`
   * のまま返り、`classifyArchiveContinuity` が `'unknown'` へ落とす（#698）。
   */
  async #readMeta(id: string): Promise<ArchiveMeta | null> {
    let raw: string;
    try {
      raw = await readFile(this.#metaPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#unreadableOnce.sawReadable(`.meta.json:${id}`);
        return null;
      }
      throw error;
    }
    try {
      const meta = JSON.parse(raw) as ArchiveMeta;
      this.#unreadableOnce.sawReadable(`.meta.json:${id}`);
      return meta;
    } catch {
      // **JSON として読めない sidecar は「無い」と同じに扱う**（issue #1969）。呼び手は
      // `fallbackMeta(id)`（id から sessionId と時刻を取る）へ倒すので、その行は
      // 一覧に残る。跡には中身を出さない。**跡は1本につき1回**（`#unreadableOnce`
      // の doc。issue #2231）——ここは `list()` からも `read(id)` からも通るが、
      // どちらでも行は fallback で返るので、名指しの操作が失敗を隠すことにはならない。
      if (this.#unreadableOnce.sawUnreadable(`.meta.json:${id}`)) {
        process.stderr.write(
          `${describeUnreadableSidecar(new UnreadableArchiveSidecarError(id, '.meta.json'))}（id から sessionId と時刻を取った）\n`,
        );
      }
      return null;
    }
  }
}

/**
 * sidecar（`.meta.json` / `.removed`）が JSON として読めなかった（issue #1969）。
 * **メッセージに中身を載せない**——`JSON.parse` の `SyntaxError` の文言は、壊れた
 * 中身の一部をそのまま含む。
 */
class UnreadableArchiveSidecarError extends Error {
  constructor(
    readonly id: string,
    readonly sidecar: '.meta.json' | '.removed',
  ) {
    super(`アーカイブの ${sidecar} が JSON として読めない（id=${JSON.stringify(id)}）`);
    this.name = 'UnreadableArchiveSidecarError';
  }
}

function describeUnreadableSidecar(error: UnreadableArchiveSidecarError): string {
  return `alteroid: ${error.message}`;
}

/** `.meta.json` サイドカーの中身（#698。`bodyChars`/`bodyMd5`/`continuity` は optional）。 */
interface ArchiveMeta {
  readonly sessionId: string;
  readonly at: string;
  readonly bodyChars?: number;
  readonly bodyMd5?: string;
  readonly continuity?: ArchiveContinuity;
}

/**
 * `.meta.json` が無い(この拡張より前に作られた)アーカイブ向けの best-effort 復元。
 *
 * ファイル名の `stamp` 部分(`-YYYY-MM-DDTHH-MM-SS-mmmZ.jsonl`。**衝突したときは
 * 枝番が付いて `-YYYY-MM-DDTHH-MM-SS-mmmZ-2.jsonl` になる**。#905)を ISO 8601 へ
 * 戻し、残りを `sessionId` とする——**ただし `sanitize()` 済みの近似値**
 * （元の `sessionId` に `sanitize` が潰した文字が在れば、その情報は failsafe
 * では戻らない）。パターンに一致しない(壊れた・想定外の名前の)場合は、
 * ファイル名全体を `sessionId`、`epoch` を `at` として返す——`list()` /
 * `sessions()` を例外で落とさないことを優先する。
 *
 * **解析そのものは `matchArchiveIdStamp`（`@alteroid/core`）に委ねる**（#908）
 * ——枝番の tie-break（`archiveIdBranch`）と同じ正規表現を2箇所に書かない。
 */
function fallbackMeta(id: string): ArchiveMeta {
  const match = matchArchiveIdStamp(id);
  if (match === undefined) {
    return { sessionId: id, at: new Date(0).toISOString() };
  }
  // **`suffix`（マッチ全体）で切る。** 枝番（#905）が付いた id では
  // `suffix` にその枝番も入るので、`sessionId` 側へ枝番が漏れない。
  const sessionId = id.slice(0, id.length - match.suffix.length);
  const at = match.stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  return { sessionId, at };
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * `id` が指す実際のパスが、archive ディレクトリの直下に収まっているか
 * （issue #1635）。
 *
 * **文字クラスでの制限（`sanitize()`）は境界の判定には使わない。** `sanitize()`
 * は `[^A-Za-z0-9._-]` を `_` へ潰すだけなので、`'/'` を含む id は弾けるが
 * `'.'` / `'..'` はそのまま素通りする（`.` と `-` を許しているため）。
 * `resolve()` した結果そのものを比べれば、`sanitize()` の文字クラスを
 * どう変えても——将来 `.` を許さなくする／許す文字を増やす、どちらの
 * 変更をしても——境界の判定はそれに引きずられない。
 *
 * **「配下」ではなく「直下」を比べる（issue #2454）。** 以前の
 * `resolvedPath.startsWith(resolvedDir + sep)` は配下の深い道筋も通していた
 * ——既存の `<sid>-<stamp>.jsonl` の下を指す `'<その名前>/x'` が境界を通り、
 * `#readMarker()` の `readFile()` が `ENOTDIR` を投げ（`ENOENT` しか missing に
 * 倒さない）、`GET /archive/:id` / `DELETE /archive/:id`（どちらも try/catch を
 * 持たない）で 404 のはずが 500 になっていた。archive の id はディレクトリ
 * 直下の1ファイルの名前なので、`dirname(resolve(dir, id)) === resolve(dir)`
 * で判定する。
 *
 * `resolve(dir, id)` が `resolve(dir)` 自身と一致する（`id === '.'` 等）場合も
 * 「ディレクトリそのもの」であって「ディレクトリ直下の1ファイル」では
 * ないので、`false` を返す（`dir` がファイルシステムの根のときは
 * `dirname(根) === 根` になるので、一致そのものを別に弾く）。
 *
 * `resolve()` が例外を投げる入力（null バイトを含む文字列等）も、境界の
 * 外にあるのと同じ扱い（`false`）にする——`sanitize(id) !== id` はこの種の
 * 入力も暗黙に弾いていたので、その性質を保つ。
 */
function isWithinArchiveDir(dir: string, id: string): boolean {
  let resolvedPath: string;
  try {
    resolvedPath = resolve(dir, id);
  } catch {
    return false;
  }
  const resolvedDir = resolve(dir);
  return resolvedPath !== resolvedDir && dirname(resolvedPath) === resolvedDir;
}
