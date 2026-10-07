export function unsentInput(current: string, sent: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}
