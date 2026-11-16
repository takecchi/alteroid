import { describe, expect, it } from 'vitest';

import { BASH_SHAPE_SUMMARIES } from './bash-shape-guard.js';
import { WAIT_GUARD_SUMMARIES } from './bash-wait-guard.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';

const MANAGER_INPUT = { managerId: 'mgr-test', workerName: 'worker' } as const;
const SHAPE_HEADING = '# この器で断られる Bash の形';
const CLASSIFIER_HEADING = '# 分類器に止められやすい Bash の形';
const WAIT_HEADING = '# この器で断られる Bash の待ちの形';

describe('歯が断る Bash の形をプロンプトに載せる（#5017）', () => {
  const builders = [
    [
      '担当',
      (g?: { shape: boolean; wait: boolean; shapeOff?: boolean }) =>
        buildManagerSystemPrompt({
          ...MANAGER_INPUT,
          ...(g === undefined ? {} : { bashGuards: g }),
        }),
    ],
    ['作業者', (g?: { shape: boolean; wait: boolean; shapeOff?: boolean }) => buildWorkerPrompt(g)],
  ] as const;

  for (const [label, build] of builders) {
    describe(label, () => {
      it('渡さない・どちらも偽なら、1文字も変わらない', () => {
        const base = build();
        expect(build({ shape: false, wait: false })).toBe(base);
        expect(base).not.toContain('この器で断られる');
      });

      it('形の歯が on なら、全部の形の要約が載り、待ちの形の節は載らない', () => {
        const prompt = build({ shape: true, wait: false });
        expect(prompt.startsWith(build())).toBe(true);
        expect(prompt).toContain(SHAPE_HEADING);
        expect(prompt).not.toContain(WAIT_HEADING);
        for (const { shape, instead } of Object.values(BASH_SHAPE_SUMMARIES)) {
          expect(prompt).toContain(`- ${shape} → ${instead}`);
        }
        expect(prompt).toContain(
          'この器では、次の形の Bash は1回ごとに断られる（打つと、その呼び出しだけが拒否されて理由が返る）。最初から右の書き方で打つこと。',
        );
      });

      it('待ちの歯が ask / deny なら、待ちの形の要約が載り、形の節は載らない', () => {
        const prompt = build({ shape: false, wait: true });
        expect(prompt.startsWith(build())).toBe(true);
        expect(prompt).toContain(WAIT_HEADING);
        expect(prompt).not.toContain(SHAPE_HEADING);
        for (const { shape, instead } of Object.values(WAIT_GUARD_SUMMARIES)) {
          expect(prompt).toContain(`- ${shape} → ${instead}`);
        }
      });

      it('形の歯が off（shapeOff）なら、分類器の短い節が載り、歯の一覧は載らない', () => {
        const prompt = build({ shape: false, wait: false, shapeOff: true });
        expect(prompt.startsWith(build())).toBe(true);
        expect(prompt).toContain(CLASSIFIER_HEADING);
        expect(prompt).not.toContain(SHAPE_HEADING);
        expect(prompt).not.toContain(WAIT_HEADING);
        const section = prompt.slice(prompt.indexOf(CLASSIFIER_HEADING));
        expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(4);
        // 通る書き方は歯の要約と同じ文言を使う
        expect(section).toContain(BASH_SHAPE_SUMMARIES.chain.instead);
        expect(section).toContain(BASH_SHAPE_SUMMARIES['pipe-trim'].instead);
        expect(section).toContain(BASH_SHAPE_SUMMARIES['fd-dup'].instead);
        expect(section).toContain('git -C <絶対パス>');
      });

      it('形の歯が on なら、shapeOff が立っていても従来の一覧だけで、分類器の節は載らない', () => {
        const prompt = build({ shape: true, wait: false, shapeOff: true });
        expect(prompt).toBe(build({ shape: true, wait: false }));
        expect(prompt).not.toContain(CLASSIFIER_HEADING);
      });

      it('形の歯が off で待ちの歯が on なら、待ちの節と分類器の節の両方が載る', () => {
        const prompt = build({ shape: false, wait: true, shapeOff: true });
        expect(prompt).toContain(CLASSIFIER_HEADING);
        expect(prompt).toContain(WAIT_HEADING);
      });

      it('形の歯が on なら、既定の呼び出しに分類器の節は載らない', () => {
        expect(build({ shape: true, wait: true })).not.toContain(CLASSIFIER_HEADING);
      });

      it('両方 on なら、形の節の後ろに待ちの節が載る', () => {
        const prompt = build({ shape: true, wait: true });
        expect(prompt.indexOf(SHAPE_HEADING)).toBeGreaterThan(-1);
        expect(prompt.indexOf(WAIT_HEADING)).toBeGreaterThan(prompt.indexOf(SHAPE_HEADING));
      });
    });
  }
});
