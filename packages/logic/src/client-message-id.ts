/**
 * 発言ごとに作る一意な id（`POST /chat` の `clientMessageId`）。
 *
 * 形はデーモンの `clientMessageIdSchema`（英数字・`_` `-` の1〜128字）に収まる。**`crypto.randomUUID()` を
 * 使わない**のは、それが「安全な文脈」（https か localhost）でしか生えないため——LAN の http で開いた画面では
 * 未定義で、送信が落ちる。`getRandomValues` は文脈を問わずに在る。128 ビットの乱数を16進で書く（32字）。
 */
export function newClientMessageId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
