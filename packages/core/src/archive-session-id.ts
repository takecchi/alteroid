/**
 * アーカイブの `sessionId` として受け付けない値を、入口で3実装とも同じ例外で
 * 断る（issue #2233）。
 *
 * **NUL（`\u0000`）を含む `sessionId` は正しい値ではない。** pg の `text` 列は NUL を
 * 持てないので、以前は pg だけが `pg_advisory_xact_lock` の時点で PostgreSQL の
 * 例外（`invalid byte sequence for encoding "UTF8": 0x00`）で落ち、fs とインメモリは
 * そのまま積んでいた。pg だけ黙って NUL を除く形にすると、fs / インメモリと同じ
 * id が別の行を指すことになる。⟹ **入口で同じように断る側（閉じる側）に倒す**
 * （teto の判断、2026-09-29）。
 *
 * **例外の文に `sessionId` の値を載せない。** どこから来た値か分からないので、
 * 何が入っているかをログへ流さない（`describeUnreadableGrantRow` と同じ作法）。
 * 型で見分けること（文言で見分けない）。
 */
export class InvalidArchiveSessionIdError extends Error {
  constructor() {
    super('アーカイブの sessionId に NUL（\\u0000）が含まれているので、積まない');
    this.name = 'InvalidArchiveSessionIdError';
  }
}

/** `sessionId` が積めない値なら `InvalidArchiveSessionIdError` を投げる。 */
export function assertArchivableSessionId(sessionId: string): void {
  if (sessionId.includes('\u0000')) throw new InvalidArchiveSessionIdError();
}
