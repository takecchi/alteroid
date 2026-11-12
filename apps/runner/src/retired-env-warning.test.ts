import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { warnRetiredEnv } from './retired-env-warning.js';

const SECRET = 'sk-secret-value-12345';

function collect(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  warnRetiredEnv(env, (line) => out.push(line));
  return out;
}

describe('warnRetiredEnv（runner 起動のときの、外した環境変数の警告）', () => {
  it('何も置かれていなければ何も出さない', () => {
    expect(collect({})).toEqual([]);
    expect(collect({ ALTEROID_MANAGER_PERMISSION_MODE: 'auto' })).toEqual([]);
  });

  it('置かれていれば、alteroid-runner: の1行で名前だけが出て、値は出ない', () => {
    const out = collect({ ALTEROID_PEER_IDLE_MINUTES: SECRET });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^alteroid-runner: ALTEROID_PEER_IDLE_MINUTES が置かれていますが/);
    expect(out[0]).toMatch(/\n$/);
    expect(out.join('')).not.toContain(SECRET);
  });

  it('複数が置かれていれば、変数ごとに1行。値はどれも出ない', () => {
    const out = collect({
      ALTEROID_PEER_MAX_SESSIONS: `${SECRET}-1`,
      ALTEROID_PEER_IDLE_MINUTES: `${SECRET}-2`,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('ALTEROID_PEER_MAX_SESSIONS');
    expect(out[1]).toContain('ALTEROID_PEER_IDLE_MINUTES');
    expect(out.join('')).not.toContain(SECRET);
  });

  it('index.ts は、環境を stderr へ向けて1回だけ呼ぶ', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const calls = source.split('\n').filter((line) => line.includes('warnRetiredEnv('));
    expect(calls.map((line) => line.trim())).toEqual([
      'warnRetiredEnv(process.env, writeStderrLine);',
    ]);
  });
});
