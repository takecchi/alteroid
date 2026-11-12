import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { warnRetiredEnv } from './retired-env-warning.js';

const SECRET = 'sk-secret-value-12345';

function collect(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  warnRetiredEnv(env, (line) => out.push(line));
  return out;
}

describe('warnRetiredEnv（起動のときの、外した環境変数の警告）', () => {
  it('何も置かれていなければ何も出さない', () => {
    expect(collect({})).toEqual([]);
    expect(collect({ ALTEROID_CLONE_PERMISSION_MODE: 'auto' })).toEqual([]);
  });

  it('置かれていれば、alteroidd: の1行で名前だけが出て、値は出ない', () => {
    const out = collect({ ALTEROID_PEER_MAX_SESSIONS: SECRET });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^alteroidd: ALTEROID_PEER_MAX_SESSIONS が置かれていますが/);
    expect(out[0]).toMatch(/\n$/);
    expect(out.join('')).not.toContain(SECRET);
  });

  it('複数が置かれていれば、変数ごとに1行。値はどれも出ない', () => {
    const out = collect({
      ALTEROID_MERGED_BATCH_SIZE_LIMIT: `${SECRET}-1`,
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: `${SECRET}-2`,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('ALTEROID_MERGED_BATCH_SIZE_LIMIT');
    expect(out[1]).toContain('ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES');
    expect(out.join('')).not.toContain(SECRET);
  });

  it('index.ts は、起動時の環境の写しを stderr へ向けて1回だけ呼ぶ', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const calls = source.split('\n').filter((line) => line.includes('warnRetiredEnv('));
    expect(calls.map((line) => line.trim())).toEqual([
      'warnRetiredEnv(bootEnvSnapshot, writeStderrLine);',
    ]);
  });
});
