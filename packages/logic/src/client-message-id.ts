// `crypto.randomUUID()` を使わない: 安全な文脈（https か localhost）でしか生えず、LAN の http では未定義で送信が落ちる。
export function newClientMessageId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
