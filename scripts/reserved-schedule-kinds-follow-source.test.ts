import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  RESERVED_SCHEDULE_KINDS,
} from '../packages/core/src/schedule.js';
import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

// このファイルには予約 kind の名前を書かない: 書くと出所（`RESERVED_SCHEDULE_KINDS`）から導く歯ではなく手書きの写しになり、kind が増えたときここだけ取り残されるため。
// 部分一致ではなく語として数える（`containsWord`）: 予約 kind を接頭辞に持つ別の識別子が出現として数えられ、本物の言及が消えても緑のままになるため。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function listClaudeScannableFiles(root: string = ROOT): string[] {
  return listGitScannableFiles({ cwd: root, pathspec: ['.claude'] }) as string[];
}

describe('listClaudeScannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedClaudeFile(): Promise<string> {
    const dir = await makeTempDir('reserved-schedule-kinds-1817-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await mkdir(path.join(dir, '.claude', 'skills', 'example'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'skills', 'example', 'SKILL.md'), 'tracked\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(path.join(dir, '.claude', 'skills', 'example', 'NEW.md'), 'new\n');
    return dir;
  }

  it('🔴（直す前の形）: `git ls-files -z -- .claude` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedClaudeFile();
    const oldForm = execFileSync('git', ['ls-files', '-z', '--', '.claude'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('.claude/skills/example/NEW.md');
  });

  it('🟢（直した後）: listClaudeScannableFiles は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedClaudeFile();
    const files = listClaudeScannableFiles(dir);
    expect(files).toContain('.claude/skills/example/NEW.md');
    expect(files).toContain('.claude/skills/example/SKILL.md');
  });
});

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsWord(text: string, word: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`);
  return re.test(text);
}

// 字面だけで絞らず kind の語でも絞る: `RESERVED_SCHEDULE_KINDS` の字面を消すだけで、手書きの写しが対象から抜けられてしまうため。
export function isInScope(text: string, reservedKinds: readonly string[]): boolean {
  if (text.includes('RESERVED_SCHEDULE_KINDS')) return true;
  return reservedKinds.some((kind) => containsWord(text, kind));
}

export interface ReservedScheduleKindInSkillsExemption {
  readonly file: string;
  readonly kind: string;
  readonly why: string;
}

export const RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS: readonly ReservedScheduleKindInSkillsExemption[] =
  [];

const CLAUDE_SCANNABLE_FILES = listClaudeScannableFiles();
const TARGET_FILES = CLAUDE_SCANNABLE_FILES.filter((file) =>
  isInScope(readRepoFile(file), RESERVED_SCHEDULE_KINDS),
);

describe('.claude/** は予約スケジュール kind（RESERVED_SCHEDULE_KINDS）を手で数え直さない', () => {
  it('前提: 出所（RESERVED_SCHEDULE_KINDS）が空ではない（この歯が空振りしていないこと・空振り防止(a)）', () => {
    expect(
      RESERVED_SCHEDULE_KINDS.length,
      'RESERVED_SCHEDULE_KINDS が空である。この歯は何も測れていない。',
    ).toBeGreaterThan(0);
  });

  it('前提: 対象ファイルが1件以上見つかる（空振り防止(b)。範囲の決め方が壊れていないこと）', () => {
    expect(
      TARGET_FILES.length,
      '.claude/** の中に、RESERVED_SCHEDULE_KINDS を話題にしているファイルが1件も' +
        '見つからなかった。isInScope（対象範囲の決め方）が壊れている疑いがある —— ' +
        'これが0件のまま下の歯を走らせると、何も検査せずに緑を返す。',
    ).toBeGreaterThan(0);
  });

  it('免除表の理由（why）が全部、非空である', () => {
    const blank = RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS.filter(
      (e) => e.why.trim().length === 0,
    ).map((e) => `${e.file} ${e.kind}`);
    expect(
      blank,
      '免除の理由が空である。なぜこのファイルでその kind の言及を免除するのかを書くこと' +
        '（空欄を許すと、免除表は数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('免除表に載っている項目が、いまも実際に欠けている現物と一致する（幽霊免除が無い）', () => {
    const stillMissing = new Set<string>();
    for (const file of TARGET_FILES) {
      const text = readRepoFile(file);
      for (const kind of RESERVED_SCHEDULE_KINDS) {
        if (!containsWord(text, kind)) stillMissing.add(`${file} ${kind}`);
      }
    }
    const ghosts = RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS.filter(
      (e) => !stillMissing.has(`${e.file} ${e.kind}`),
    ).map((e) => `${e.file} ${e.kind}`);
    expect(
      ghosts,
      '免除表に載っている file/kind が、もう欠けていない（本文へ書き足された、または' +
        'ファイルが対象から外れた）。免除表からこの行を消すこと —— 直った後も免除に残すと、' +
        '次に本当に必要な免除が増えたときに見分けが付かなくなる。',
    ).toEqual([]);
  });

  it('対象ファイルはすべて、RESERVED_SCHEDULE_KINDS の全要素を語として含む', () => {
    const offenders: string[] = [];
    for (const file of TARGET_FILES) {
      const text = readRepoFile(file);
      for (const kind of RESERVED_SCHEDULE_KINDS) {
        if (containsWord(text, kind)) continue;
        const exempted = RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS.some(
          (e) => e.file === file && e.kind === kind,
        );
        if (exempted) continue;
        offenders.push(`${file}: ${kind} が見つからない`);
      }
    }
    expect(
      offenders,
      '【赤の意味】次のファイルは RESERVED_SCHEDULE_KINDS を話題にしているのに、' +
        `その全要素（packages/core/src/schedule.ts。いま ${RESERVED_SCHEDULE_KINDS.length} 件）を` +
        '語として含んでいない:\n' +
        offenders.join('\n') +
        '\n【直し方】(a) 欠けている kind の名前を本文へ書き足すか、' +
        '(b) 理由があって書かない場合は RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS へ ' +
        '{ file, kind, why } を理由つきで足すこと ' +
        '(scripts/reserved-schedule-kinds-in-skills.test.ts)。',
    ).toEqual([]);
  });
});

describe('この歯自身が「もう1つの写し」になっていないこと', () => {
  it('この歯のソースは、予約 kind をどれも語として含まない（出所から導いていることの確認）', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const copied = RESERVED_SCHEDULE_KINDS.filter((kind) => containsWord(self, kind));
    expect(
      copied,
      '【赤の意味】この歯のソースに予約 kind の名前が語として書かれている。' +
        'RESERVED_SCHEDULE_KINDS から導く形に直すこと —— 名前をここへ書き写すと、' +
        '出所に4つ目が増えたときにこの歯だけが古い一覧を持つことになる' +
        '（合成 fixture には実在しない語を使うこと）。',
    ).toEqual([]);
  });
});

describe('検出そのもの（歯が空振りしていないことの確認。合成 fixture。実在の kind 名は使わない）', () => {
  it('containsWord: 語の前後が識別子文字でなければ検出する', () => {
    expect(containsWord('この orange_grove は既定で回る', 'orange_grove')).toBe(true);
    expect(containsWord('(orange_grove)。', 'orange_grove')).toBe(true);
    expect(containsWord('`orange_grove`', 'orange_grove')).toBe(true);
  });

  it('containsWord: 予約語を接頭辞に持つ別の識別子には当たらない（daily_report_write 型の穴）', () => {
    expect(containsWord('orange_grove_write を呼び忘れたら', 'orange_grove')).toBe(false);
    expect(containsWord('pre_orange_grove という別の語', 'orange_grove')).toBe(false);
  });

  it('isInScope: RESERVED_SCHEDULE_KINDS という字面があれば対象に入る', () => {
    expect(isInScope('cf. RESERVED_SCHEDULE_KINDS', ['orange_grove'])).toBe(true);
  });

  it('isInScope: 字面が無くても、予約語のどれかを語として含めば対象に入る', () => {
    expect(isInScope('この orange_grove は既定で回る', ['orange_grove', 'lemon_field'])).toBe(true);
  });

  it('isInScope: どちらも含まなければ対象に入らない', () => {
    expect(isInScope('この文には何も無い', ['orange_grove', 'lemon_field'])).toBe(false);
  });
});

// kind の語ではなく `RESERVED_SCHEDULE_KIND_ENV_KEYS` の値を測る: `compose.yaml` は kind の名前を書かず環境変数名で喋っており、語を要求すると新しい写しを作らせてしまうため。
describe('compose.yaml は予約 kind の環境変数を取りこぼさない', () => {
  const COMPOSE_FILE = 'compose.yaml';

  it('前提: 対応表が空ではない（この歯が空振りしていないこと）', () => {
    expect(
      Object.keys(RESERVED_SCHEDULE_KIND_ENV_KEYS).length,
      'RESERVED_SCHEDULE_KIND_ENV_KEYS が空である。この歯は何も測れていない。',
    ).toBeGreaterThan(0);
  });

  it('対応表の環境変数名がすべて compose.yaml に現れる', () => {
    const text = readRepoFile(COMPOSE_FILE);
    const missing = Object.values(RESERVED_SCHEDULE_KIND_ENV_KEYS).filter(
      (envKey) => !containsWord(text, envKey),
    );
    expect(
      missing,
      '【赤の意味】次の環境変数が compose.yaml に無い:\n' +
        missing.join('\n') +
        '\nこれは `RESERVED_SCHEDULE_KIND_ENV_KEYS`（packages/core/src/schedule.ts）が' +
        '持っている行で、予約 kind を開け閉めする唯一の口である。無いと、compose 経由で' +
        '起こした器では**その刻みが在ることが読み取れない**（既定で回っているのに）。' +
        '\n【直し方】x-shared-env へ行を足すこと。**フォールバック値は書かなくてよい** —' +
        '空・空白のみは未設定としてコード側の既定へ落ちる（apps/daemon/src/schedule.ts の' +
        '`value()`）ので、既定をここへ書き写すと揃え続ける義務だけが増える。',
    ).toEqual([]);
  });
});
