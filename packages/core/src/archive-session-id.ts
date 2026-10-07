// NUL を黙って除かない: fs / インメモリと同じ id が別の行を指すことになるため
export class InvalidArchiveSessionIdError extends Error {
  constructor() {
    // 例外の文に sessionId の値を載せない: どこから来た値か分からないため
    super('アーカイブの sessionId に NUL（\\u0000）が含まれているので、積まない');
    this.name = 'InvalidArchiveSessionIdError';
  }
}

export function assertArchivableSessionId(sessionId: string): void {
  if (sessionId.includes('\u0000')) throw new InvalidArchiveSessionIdError();
}
