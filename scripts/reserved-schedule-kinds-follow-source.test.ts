import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  RESERVED_SCHEDULE_KINDS,
} from '../packages/core/src/schedule.js';

/**
 * **`.claude/**` が予約スケジュール kind を手で数え直さないことを測る歯。**
 *
 * ## 何のためにここが在るか
 *
 * `packages/core/src/schedule.ts` の `RESERVED_SCHEDULE_KIND_TUPLE`（実体は
 * `RESERVED_SCHEDULE_KINDS`）が、この repo で唯一の数え上げである（同ファイルの doc「この配列リテラルが、
 * この repo で唯一の数え上げである」）。`.claude/skills/autonomy-triggers/SKILL.md`
 * は**クローン（AI）が読んで判断に使う指示文書**で、2026-09-08 の PR #701 が
 * 3つ目の予約 kind（記憶の整理の刻み）を足した後も、しばらく2つのまま
 * 書き写されていた（人間が現物で見つけて直した個体）。**ここに欠けていた kind の
 * 名前を書かない** —— 下の「⛔」と同じ理由で、経緯の説明であっても写しは写しである。
 *
 * `apps/web/app/reserved-schedule-kind-prose.test.ts`（同じ主題を `apps/web` 側で
 * 測る）や `packages/core/src/tool-description-enumeration.test.ts`（クローンへ渡る
 * `description` を測る）と**きょうだいの歯**だが、対象も検出の形も違う——
 * こちらが見るのは `.claude/**`（クローンが読む指示文書）で、判定は「その
 * ファイルが RESERVED_SCHEDULE_KINDS を話題にしているなら、全要素を語として
 * 含んでいること」である。
 *
 * ## 測っているもの
 *
 * 1. `git ls-files` が挙げる `.claude/**` の追跡済みファイルのうち、
 *    `RESERVED_SCHEDULE_KINDS` という字面を含むか、予約 kind のどれかを
 *    **語として**含むものを対象に取る（`isInScope`）。
 * 2. 対象の各ファイルが、`RESERVED_SCHEDULE_KINDS` の**全要素**を語として
 *    含んでいること。1つでも欠けていれば、理由つきで
 *    `RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS` へ足すまで赤い。
 *
 * **「語として」が要る理由。** 素朴な部分一致だと、**予約 kind を接頭辞に持つ
 * 別の識別子**（`<kind>_write` の形の道具名が実在する）がその kind の出現として
 * 数えられてしまい、本物の言及が消えても緑のままになる。前後が識別子の文字
 * （`[A-Za-z0-9_]`）でなければ「語として現れた」とみなす（`containsWord`）。
 * **具体名はここに書かない**（下の「⛔」。合成 fixture の側で同じ形を測っている）。
 *
 * **⛔ このファイルには予約 kind の名前を1つも書かない。** 書いた瞬間、この歯は
 * 「出所（`RESERVED_SCHEDULE_KINDS`）から導く歯」ではなく「もう1つの手書きの
 * 写し」になり、`RESERVED_SCHEDULE_KIND_TUPLE` に4つ目が増えたときにここだけ
 * 取り残される——直そうとしている問題をこの歯自身が再現することになる。
 *
 * ## ⚠️ この歯が測っていないこと（正直に書く）
 *
 * - **意味が合っているかは見ていない。** 3要素が字面として並んでいれば、
 *   隣の文が嘘でもここは緑になる（`tool-description-enumeration.test.ts` と
 *   同じ限界）。
 * - **`.claude/**` 以外は見ない。** `apps/web` 側は別の歯
 *   （`apps/web/app/reserved-schedule-kind-prose.test.ts`）が持つ。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `git ls-files -z` で `.claude/**` 配下の追跡済みファイルを列挙する。 */
function listClaudeTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', '.claude'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `word` が識別子境界（前後が `[A-Za-z0-9_]` でない）で `text` に現れるかを判定する。
 *
 * **これが無いと `daily_report_write` のような接頭辞一致を「本物の言及」と
 * 誤って数える**（SKILL.md に実在する語。歯の doc を見ること）。
 */
export function containsWord(text: string, word: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(word)}(?![A-Za-z0-9_])`);
  return re.test(text);
}

/**
 * 対象ファイルかどうか: `RESERVED_SCHEDULE_KINDS` という字面を含むか、
 * 予約 kind のどれかを語として含むか。
 *
 * **後者を持たない（字面だけで絞る）と穴が開く** — `RESERVED_SCHEDULE_KINDS`
 * という字面さえ消してしまえば、その周りで予約 kind を手で書き写していても
 * この歯の対象から抜けられてしまう。
 */
export function isInScope(text: string, reservedKinds: readonly string[]): boolean {
  if (text.includes('RESERVED_SCHEDULE_KINDS')) return true;
  return reservedKinds.some((kind) => containsWord(text, kind));
}

export interface ReservedScheduleKindInSkillsExemption {
  /** `.claude/**` の中の、リポジトリ相対パス。 */
  readonly file: string;
  /** 欠けている予約 kind（`RESERVED_SCHEDULE_KINDS` の要素の1つ）。 */
  readonly kind: string;
  /** **非空であること**（下の歯が測る）。「あとで書く」を空文字で表せない。 */
  readonly why: string;
}

/**
 * 免除は「理由付き」であること（`scripts/agents-md-references.test.ts` の
 * `WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS` と同じ形）。**いまは0件が正しい** —
 * `.claude/**` の中で `RESERVED_SCHEDULE_KINDS` を話題にしているのは
 * `.claude/skills/autonomy-triggers/SKILL.md` だけで、3要素とも既に揃っている
 * （このファイルを足した PR が直した）。1件でも新しく免除するなら、
 * ここへ理由つきで足すこと。
 */
export const RESERVED_SCHEDULE_KIND_IN_SKILLS_EXEMPTIONS: readonly ReservedScheduleKindInSkillsExemption[] =
  [];

const CLAUDE_TRACKED_FILES = listClaudeTrackedFiles();
const TARGET_FILES = CLAUDE_TRACKED_FILES.filter((file) =>
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
  /**
   * **doc に書いた「⛔ このファイルには予約 kind の名前を1つも書かない」を、
   * 注意書きで終わらせずに測る。** 書いた瞬間、この歯は出所から導く歯ではなく
   * 手書きの写しになり、4つ目が増えたときにここだけ取り残される —— 直そうと
   * している問題を、この歯自身が再現することになる。
   *
   * **`containsWord` で測るので、`daily_report_write` のような「予約 kind を
   * 接頭辞に持つ別の識別子」には当たらない**（この doc がその例を挙げる必要が
   * あるため。語として現れたときだけ赤くする）。
   */
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

/**
 * **`compose.yaml` が予約 kind の環境変数を取りこぼさないことを測る。**
 *
 * ## なぜ上の歯と形が違うのか
 *
 * `compose.yaml` は **kind の名前を1つも書いていない。環境変数名で喋っている。**
 * ⟹ 上の歯（「全要素を語として含む」）をそのまま当てると、**いま1つも無い写しを
 * この歯が作らせることになる。**書かなければ腐らないので、書かせないほうがよい。
 *
 * 代わりに `RESERVED_SCHEDULE_KIND_ENV_KEYS`（kind → 環境変数名の対応。出所と
 * 同じファイルに在り、`Record<ReservedScheduleKind, string>` なので **kind を
 * 足すと行を足すまで `typecheck` が落ちる**）の**値**が全部 `compose.yaml` に
 * 現れることを測る。⟹ 予約 kind が増えたとき、型が対応表を要求し、この歯が
 * `compose.yaml` を要求する。
 *
 * ## ⚠️ この歯が測っていないこと（正直に書く）
 *
 * - **値が正しいかは見ていない。** 環境変数名が在れば緑になる。フォールバック値を
 *   コード側の既定と揃える義務（同ファイルのコメント）は、ここでは測っていない
 * - **`compose.yaml` 以外のデプロイ記述（`railway/`）は見ていない**
 */
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
