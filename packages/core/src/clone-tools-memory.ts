// 記憶（memory_*）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { reasonOf } from './dropped-record.js';
import { resolveEnumEnv } from './placed-env.js';
import { describePage, page, renderListing } from './excerpt.js';
import { describeTokenDiff } from './token-diff.js';
import { resolveMemoryCursor } from './memory-cursor.js';
import {
  applyMemoryFrontmatterPatch,
  assertNeverMemoryDocKind,
  assertNeverMemoryProtectionStatus,
  cutMemorySections,
  describeMemoryFloor,
  describeMemoryPremiseRanking,
  describeMemoryReinjectionEstimate,
  describeMemorySectionMoveHierarchyJumpWarning,
  describeMemorySessionDelta,
  describeMemoryWriteDiff,
  findMemoryFrontmatterLineBreak,
  findOverlappingMemorySections,
  isKnownMemoryDocKind,
  lookupMemorySection,
  measureMemoryFloor,
  MEMORY_OUTLINE_SIDES,
  MEMORY_SECTION_MOVE_LIST_BUDGET,
  parseMemoryFrontmatter,
  renderMemoryListing,
  renderMemoryOutline,
  resolveMemoryDocKind,
  scanMemorySections,
  type MemoryFold,
  type MemoryPart,
  type MemorySection,
  type MemorySectionLookup,
} from './memory.js';
import { collapseErrorCause } from './error-cause.js';
import { stripNul } from './nul-guard.js';
import { memorySlugSchema, type MemoryDocKind, type MemoryProtectionStatus } from './schema.js';
import type { CloneRuntimeFacts } from './self.js';
import { MemoryConflictError, memoryVersion, type Stores } from './store.js';
import {
  describeArrayLengthViolation,
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatArrayLengthJa,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import { tool, text, appendJournalOrThrow, foldFixedFor } from './clone-tools-common.js';

const MEMORY_PAGE = 8_000;

export const MEMORY_GUARD_ENV = 'ALTEROID_MEMORY_GUARD';

export const MEMORY_GUARD_VALUES = ['on', 'off'] as const;

export type MemoryGuardValue = (typeof MEMORY_GUARD_VALUES)[number];

export const DEFAULT_MEMORY_GUARD: MemoryGuardValue = 'on';

// 綴りを間違えた値は黙って既定へ倒さず落とす: 守っているつもりの持ち主が気づけなくなるため
export function resolveMemoryGuard(env: NodeJS.ProcessEnv = process.env): MemoryGuardValue {
  return resolveEnumEnv(env, MEMORY_GUARD_ENV, MEMORY_GUARD_VALUES, DEFAULT_MEMORY_GUARD);
}

type MemoryGuardAction = '全文置換' | '削除' | 'frontmatter の更新' | '節の移動';

function assertNeverMemoryGuardAction(action: never): never {
  throw new Error(`未知の歯の対象: ${JSON.stringify(action)}`);
}

// 量（文字数の減少率）では判定しない: 蒸留は正当な運用として大きく畳むことがあり、量では意図を分離できないため
// `canUseTool` で止めて待たない: クローンは受信箱を直列に処理する単一セッションで、待つと全部が止まるため断って返す
async function guardFullReplace(
  stores: Stores,
  slug: string,
  cause: 'distill' | 'clone',
  action: MemoryGuardAction,
): Promise<string | null> {
  if (cause !== 'distill') return null;
  if (resolveMemoryGuard() === 'off') return null;
  // 節の移動は統合の走行からも通す: 先に足してから元を切るので本文が失われず、断ると整理が追いつかず肥大する一方になるため
  if (action === '節の移動') return null;
  const status = await stores.persona.protectionStatus(slug);
  // 三項演算子ではなく switch で網羅する: 状態が増えたとき黙って別の文言へ倒れず `tsc` が落ちるようにするため
  switch (status.kind) {
    case 'clone-only':
      return null;
    case 'human':
    case 'unknown':
      return denialMessage(slug, status, action);
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

function seenBefore(
  slug: string,
  before: { readonly content: string } | null,
): ReadonlyMap<string, string> {
  return before === null ? new Map() : new Map([[slug, before.content]]);
}

function versionLine(content: string): string {
  return `（版 base_version=${memoryVersion(content)} ——この文書を全文で書き直す memory_write には、これを base_version に渡すこと）`;
}

function describeMemoryConflict(
  slug: string,
  action: string,
  current: { readonly content: string } | null,
  kind: 'write' | 'remove' = 'write',
): string {
  const now =
    current === null
      ? 'いまその文書は無い（読んだ後に消された）。'
      : `いまの版は base_version=${memoryVersion(current.content)}（${current.content.length} 文字）。`;
  if (kind === 'remove') {
    return (
      `記憶 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**しなかった**。` +
      `${now}**何も消していない**（読んでいない内容を消さないため。いまの内容は1文字も変わっていない）。` +
      `memory_read slug=${slug} で読み直し、いまの内容でも消してよいか判断し直してから、` +
      '読み直した版の base_version を付けて memory_delete し直すこと。'
    );
  }
  return (
    `記憶 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**書かなかった**。` +
    `${now}**何も書いていない**（あなたの内容は書かれておらず、いまの内容は1文字も変わっていない）。` +
    `memory_read slug=${slug} で読み直し、いまの内容に対してやりたいことが変わらないか判断し直してから、` +
    '読み直した版の base_version を付けて書き直すこと。'
  );
}

function memoryFloorNote(
  memoryBefore: readonly MemoryPart[],
  memoryAfter: readonly MemoryPart[],
  slug: string,
  writtenContent: string,
  created: boolean,
  fold?: MemoryFold,
): string {
  return describeMemoryFloor({
    before: measureMemoryFloor(memoryBefore),
    after: measureMemoryFloor(memoryAfter),
    slug,
    kind: resolveMemoryDocKind(parseMemoryFrontmatter(writtenContent)),
    created,
    ...(fold === undefined ? {} : { fold }),
  });
}

// `memoryFloorNote` と混ぜない: 引数の形が違い、既存の糊を条件分岐だらけにしないため
// 順位は premise が動いたときだけ出す: fact は焼き込みの対象外で、順位は fact を書いた回の読み手に関係しないため
// 書いた文書が fact でも順位の文字列が前後で変わっていれば出す（premise → fact への変更で順位から落ちた回を黙らせない）
function memorySessionGrowthNote(
  memoryBefore: readonly MemoryPart[],
  memoryAfter: readonly MemoryPart[],
  runtime: CloneRuntimeFacts | undefined,
  writtenContents: readonly string[],
  fold?: MemoryFold,
): string {
  const afterChars = measureMemoryFloor(memoryAfter).totalChars;
  const sessionDelta = describeMemorySessionDelta({
    afterChars,
    injectedMemoryChars: runtime?.injectedMemoryChars ?? null,
    ...(fold === undefined ? {} : { fold }),
  });
  const ranking = describeMemoryPremiseRanking(memoryAfter);
  const touchesPremise = writtenContents.some(
    (content) => resolveMemoryDocKind(parseMemoryFrontmatter(content)) === 'premise',
  );
  if (!touchesPremise && ranking === describeMemoryPremiseRanking(memoryBefore)) {
    return sessionDelta;
  }
  return [sessionDelta, ranking].join('\n\n');
}

// `human` と `unknown` を畳まない: 履歴が在る積極的な事実と、確認できず守る側へ倒した消極的な既定は理由が違うため
// 三項演算子に戻さない: `action` の union に値を足したとき、落ちるのは `switch` だけで三項は黙って `else` 側へ倒れるため
function denialMessage(
  slug: string,
  status: Extract<MemoryProtectionStatus, { kind: 'human' | 'unknown' }>,
  action: MemoryGuardAction,
): string {
  const reason =
    status.kind === 'human'
      ? `この文書には人間の書き込みの履歴が在る（保護状態: human）`
      : `この文書の書き込みの履歴が確認できない（保護状態: unknown。索引が無い・外から書き換えられた` +
        `可能性がある、などのときにここへ倒す——不明を「人間は書いていない」とは読まず、守る側へ倒す）`;

  const alternative = ((): string => {
    switch (action) {
      case '全文置換':
      case '削除':
        return 'memory_append（追記）はこの歯の対象ではなく、断られない。失いたくないだけならそちらを使うこと。';
      case 'frontmatter の更新':
        return (
          'memory_append（追記）はここでは代わりにならない——追記は本文の末尾に文字列を足すだけで、' +
          'frontmatter のキー（description / type / parent）は直せない。'
        );
      case '節の移動':
        return (
          'memory_append（追記）はこの歯の対象ではないので、移し先の文書へ本文を写すことだけは断られない' +
          '——ただし出どころの文書から節を消すことはできないので、写した後は同じ本文が2箇所に残る。' +
          '失いたくないだけならそれで足りる。'
        );
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  const askHumanHint = ((): string => {
    const tail =
      '」のように積むこと。人間の回答が届いた後の次のターンで、同じ操作をやり直せば実行できる' +
      '（この場・このターンではやり直せない）。';
    switch (action) {
      case '全文置換':
      case '削除':
        return `本当に${action}が必要だと判断したら、ask_human に「記憶 ${slug} を${action}したい。理由: 〈ここに理由〉${tail}`;
      case 'frontmatter の更新':
        return `本当に frontmatter の更新が必要だと判断したら、ask_human に「記憶 ${slug} の frontmatter を更新したい。理由: 〈ここに理由〉${tail}`;
      case '節の移動':
        return `本当に節の移動が必要だと判断したら、ask_human に「記憶 ${slug} から節を1つ別の文書へ移したい。理由: 〈ここに理由〉${tail}`;
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  return [
    `記憶 ${slug} への${/^[A-Za-z]/.test(action) ? ' ' : ''}${action}を、統合の走行（distill）から断った。`,
    `理由: ${reason}。`,
    'いま何も変わっていない（記憶は断る前のまま残っている）。',
    alternative,
    askHumanHint,
  ].join(' ');
}

function assertNeverMemorySectionLookup(lookup: never): never {
  throw new Error(`未知の節の照合結果: ${JSON.stringify(lookup)}`);
}

// 3つを同じ「見つかりません」に畳まない: 疑う先が違い、畳むと「誰かが書き換えた」が「打ち間違い」に見えるため
// 曖昧なときに「どちらか」を選ばない: 片方を黙って選ぶと消える側が観測できないため
function describeMemorySectionLookupFailure(
  slug: string,
  id: string,
  lookup: Exclude<MemorySectionLookup, { kind: 'found' }>,
): string {
  switch (lookup.kind) {
    case 'absent':
      return (
        `記憶 ${slug} に節id ${id} の節は無い。打ち間違いか、別の文書の節id か、` +
        '見出しごと書き換えられたかのどれかである。memory_outline で目次を取り直すこと' +
        '（何も変わっていない）。'
      );
    case 'stale':
      return (
        `節id ${id} は古い。記憶 ${slug} に同じ見出しの節は在るが、中身のハッシュが違う——` +
        `**この目次を読んだ後で、誰かがこの節を書き換えている。** 節id は指し先であると同時に版の照合` +
        `なので、ここで断って上書きを防いでいる。memory_outline で ${slug} の目次を取り直し、` +
        '中身を確かめてから新しい節id でやり直すこと（何も変わっていない）。'
      );
    case 'ambiguous':
      return (
        `節id ${id} は記憶 ${slug} の中で ${lookup.sections.length} 箇所に当たる` +
        '（見出しも中身も完全に同一の節が複数ある）。**どちらかを選ばずに断る**——' +
        '黙って一方を選ぶと、消えた側を後から観測する手段が無い。' +
        'どちらか一方の中身を先に書き分けてから（memory_write で1行足すなど）やり直すこと' +
        '（何も変わっていない）。'
      );
    default:
      return assertNeverMemorySectionLookup(lookup);
  }
}

type MemoryMoveRefusal = { kind: 'refused'; body: string };

type MemoryMoveScan = ReturnType<typeof scanMemorySections>;

type MemoryMoveFrontmatter = ReturnType<typeof parseMemoryFrontmatter>;

type MemoryMoveLookupFailure = {
  id: string;
  lookup: Exclude<MemorySectionLookup, { kind: 'found' }>;
};

type MemoryMoveDocument = { readonly content: string };

type MemoryMoveWritten = Awaited<ReturnType<Stores['persona']['append']>>;

// 移し先に同じ節id が既に在るかで分けた、移す節の内訳
type MemoryMovePlan = {
  toAppend: MemorySection[];
  alreadyAtDestination: MemorySection[];
};

// `memory_section_move` の引数の検査: from のスラッグ → to のスラッグ → sections の個数 → from と to が同じ、の順
function checkMemorySectionMoveArgs(
  fromSlug: string,
  toSlug: string,
  ids: readonly string[],
): { kind: 'ok' } | MemoryMoveRefusal {
  if (!memorySlugSchema.safeParse(fromSlug).success) {
    return {
      kind: 'refused',
      body: `記憶のスラッグが不正: ${fromSlug}（英小文字・数字・. _ - のみ）。`,
    };
  }
  if (!memorySlugSchema.safeParse(toSlug).success) {
    return {
      kind: 'refused',
      body: `記憶のスラッグが不正: ${toSlug}（英小文字・数字・. _ - のみ）。`,
    };
  }
  const sectionsError = describeArrayLengthViolation('sections', ids, { min: 1 });
  if (sectionsError !== null) return { kind: 'refused', body: sectionsError };
  if (fromSlug === toSlug) {
    return {
      kind: 'refused',
      body:
        `from と to が同じ文書（${fromSlug}）である。節の移動先は別の文書でなければならない` +
        '（同じ文書の中で節を動かす口はここには無い）。何も変わっていない。',
    };
  }
  return { kind: 'ok' };
}

// 出どころの frontmatter の検査（malformed なら断る）
function checkMemoryMoveSourceFrontmatter(
  fromSlug: string,
  content: string,
): { kind: 'ok'; priorFrontmatter: MemoryMoveFrontmatter } | MemoryMoveRefusal {
  const priorFrontmatter = parseMemoryFrontmatter(content);
  if (priorFrontmatter.kind === 'malformed') {
    return {
      kind: 'refused',
      body:
        `記憶 ${fromSlug} の frontmatter が壊れている（malformed）。ここでは節を移さない——` +
        '本文の始まる位置が決まらないので、frontmatter を本文として運ぶ経路ができる。' +
        'memory_write で全文を書き直すか、人間に確認を通すこと（何も変わっていない）。',
    };
  }
  return { kind: 'ok', priorFrontmatter };
}

// 解決できなかった節id の断り文: 先頭1件の理由 + 残りの件数の内訳 + 「1節も移していない」
function describeMemoryMoveLookupFailures(
  fromSlug: string,
  ids: readonly string[],
  failures: readonly MemoryMoveLookupFailure[],
): string {
  const first = failures[0] as MemoryMoveLookupFailure;
  const base = describeMemorySectionLookupFailure(fromSlug, first.id, first.lookup);
  if (ids.length === 1) return base;

  const rest = failures.slice(1);
  const restCounts = { absent: 0, stale: 0, ambiguous: 0 } as Record<
    Exclude<MemorySectionLookup, { kind: 'found' }>['kind'],
    number
  >;
  for (const entry of rest) restCounts[entry.lookup.kind] += 1;
  // id を全部並べない: 90個渡されたとき応答がその数だけ膨らむため
  const restLine =
    rest.length > 0
      ? `\nほかにも解決できなかった節id が ${rest.length} 件ある` +
        `（無い ${restCounts.absent} 件・古い ${restCounts.stale} 件・曖昧 ${restCounts.ambiguous} 件）。`
      : '';
  const allOrNothingLine =
    '\nこの口は全件が見つかったときしか動かさない——1つでも解決できなければ、' +
    `今回指定した他の ${ids.length - 1} 節も含めて1節も移していない。`;
  return `${base}${restLine}${allOrNothingLine}`;
}

// 範囲が重なる節の断り文
function describeMemoryMoveOverlap(overlap: {
  first: MemorySection;
  second: MemorySection;
}): string {
  return (
    `節id ${overlap.first.id}（「${overlap.first.heading}」）と ${overlap.second.id}` +
    `（「${overlap.second.heading}」）の範囲が重なっている。片方がもう片方の中に` +
    '入れ子になっている節を親子まとめて指した（`end` は子込みなので、親を切ると' +
    '渡していないつもりの子も一緒に動く）か、同じ節id を2回渡したか（範囲が完全に' +
    '一致する）のどちらかである——**どちらの形でも断る**。memory_outline で目次を' +
    '取り直し、重ならない組で渡し直すこと。何も変わっていない' +
    '（出どころも移し先も、1文字も動いていない）。'
  );
}

// 節の解決: 全件を照合してから、解決できなかったもの → 範囲の重なり、の順に断る
function resolveMemoryMoveTargets(
  fromSlug: string,
  ids: readonly string[],
  sections: readonly MemorySection[],
): { kind: 'ok'; targets: MemorySection[] } | MemoryMoveRefusal {
  const lookups = ids.map((id) => ({ id, lookup: lookupMemorySection(sections, id) }));
  const failures = lookups.filter(
    (entry): entry is MemoryMoveLookupFailure => entry.lookup.kind !== 'found',
  );
  if (failures.length > 0) {
    return { kind: 'refused', body: describeMemoryMoveLookupFailures(fromSlug, ids, failures) };
  }

  const targets = lookups.flatMap((entry) =>
    entry.lookup.kind === 'found' ? [entry.lookup.section] : [],
  );

  const overlap = findOverlappingMemorySections(targets);
  if (overlap !== null) {
    return { kind: 'refused', body: describeMemoryMoveOverlap(overlap) };
  }
  return { kind: 'ok', targets };
}

// 出どころから節を切り取った結果を作る（記憶は書かない）。frontmatter の解釈が変わるなら断る
function cutMemoryMoveSource(args: {
  fromSlug: string;
  existingContent: string;
  scan: MemoryMoveScan;
  priorFrontmatter: MemoryMoveFrontmatter;
  targets: readonly MemorySection[];
}):
  | { kind: 'ok'; nextContent: string; cut: string; ordered: readonly MemorySection[] }
  | MemoryMoveRefusal {
  const { fromSlug, existingContent, scan, priorFrontmatter, targets } = args;
  // `ordered` を自分で並べ替え直さない: 並び順の規則は `cutMemorySections` が1箇所で持つため
  const { nextContent, cut, ordered } = cutMemorySections(existingContent, targets);

  const priorHeader = existingContent.slice(0, scan.bodyStart);
  const nextHeader = nextContent.slice(0, scan.bodyStart);
  const nextFrontmatter = parseMemoryFrontmatter(nextContent);
  if (nextHeader !== priorHeader || nextFrontmatter.kind !== priorFrontmatter.kind) {
    return {
      kind: 'refused',
      body:
        `記憶 ${fromSlug} から指定した節を切り取ると、frontmatter の解釈が変わってしまう` +
        `（${priorFrontmatter.kind} → ${nextFrontmatter.kind}）。断った——この道具は` +
        'frontmatter を1バイトも動かさないと約束しているので、約束が破れる切り取りは行わない。' +
        '何も変わっていない（出どころも移し先も、1文字も動いていない）。',
    };
  }
  return { kind: 'ok', nextContent, cut, ordered };
}

// 移し先に同じ節id が既に在るものは追記から外す: 半完了からの再実行で同じ節が増えると `ambiguous` になり、その id が二度と指せなくなるため
function planMemoryMoveDestination(
  ordered: readonly MemorySection[],
  toBefore: MemoryMoveDocument | null,
): MemoryMovePlan {
  const destIds = new Set(
    toBefore === null ? [] : scanMemorySections(toBefore.content).sections.map((s) => s.id),
  );
  const toAppend = ordered.filter((section) => !destIds.has(section.id));
  const alreadyAtDestination = ordered.filter((section) => destIds.has(section.id));
  return { toAppend, alreadyAtDestination };
}

// 移し先へ足す（追記 → move_in の日誌）。足す節が無ければ何も書かない
async function appendMemoryMoveDestination(args: {
  stores: Stores;
  cause: 'distill' | 'clone';
  toSlug: string;
  toBefore: Awaited<ReturnType<Stores['persona']['read']>>;
  existingContent: string;
  plan: MemoryMovePlan;
  summary: string;
}): Promise<{ toWritten: MemoryMoveWritten; appendedChars: number }> {
  const { stores, cause, toSlug, toBefore, existingContent, plan, summary } = args;
  const { toAppend, alreadyAtDestination } = plan;
  let toWritten: MemoryMoveWritten;
  let appendedChars = 0;
  if (toAppend.length > 0) {
    const appendText = toAppend
      .map((section) => existingContent.slice(section.start, section.end))
      .join('');
    appendedChars = appendText.length;
    toWritten = await stores.persona.append(toSlug, appendText);
    await appendJournalOrThrow(
      'memory_section_move',
      stores.journal,
      {
        type: 'memory_update',
        slug: toSlug,
        cause,
        action: 'move_in',
        bytesBefore: toBefore === null ? 0 : Buffer.byteLength(toBefore.content, 'utf8'),
        bytesAfter: Buffer.byteLength(toWritten.content, 'utf8'),
        summary:
          alreadyAtDestination.length > 0
            ? `${summary}（${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため追記しなかった）`
            : summary,
      },
      'act-partially-completed',
    );
  } else {
    if (toBefore === null) {
      throw new Error(
        '到達しないはずの分岐: toBefore が無いのに toAppend が0件になった' +
          '（やり直しても重複させない冪等化の前提が崩れている）。',
      );
    }
    // 追記そのものを行わない: 空文字列を `persona.append` に渡すと fs/pg どちらも書き込みが起き、末尾に空行が増え `updatedAt` が進むため
    toWritten = toBefore;
  }
  return { toWritten, appendedChars };
}

// 追記は済んだが切り取りに失敗したときの文（足した節があるとき）
function describeMemoryMoveDuplicated(args: {
  fromSlug: string;
  toSlug: string;
  reason: string;
  plan: MemoryMovePlan;
  appendedChars: number;
}): string {
  const { fromSlug, toSlug, reason, plan, appendedChars } = args;
  const { toAppend, alreadyAtDestination } = plan;
  // 「移した」と返さない: 呼び手が重複に気づけなくなるため
  const dedupNote =
    alreadyAtDestination.length > 0
      ? ` このうち ${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため、今回は追記していない（重複は増えていない）。`
      : '';
  return (
    `⚠ ${toAppend.length} 節（合計 ${appendedChars.toLocaleString('en-US')} 文字）を ${toSlug} の末尾へ足すところまでは済んだが、` +
    `${fromSlug} からの切り取りに失敗した（${reason}）。` +
    `いま同じ ${toAppend.length} 節が ${fromSlug} と ${toSlug} の両方に在る——**重複しているが、失われてはいない。**` +
    `${dedupNote}` +
    `${fromSlug} 側は1文字も変わっていない。memory_outline で ${fromSlug} を読み直し、` +
    '同じ操作をやり直すか、重複したままにするかを決めること。'
  );
}

// 何も足さなかったうえで切り取りに失敗したときの文（足す節が0件のとき）
function describeMemoryMoveCutFailedWithoutAppend(args: {
  fromSlug: string;
  toSlug: string;
  reason: string;
  orderedCount: number;
}): string {
  const { fromSlug, toSlug, reason, orderedCount } = args;
  return (
    `${orderedCount} 節は ${toSlug} に既に同じ節id の節が在ったため、今回は何も追記していない。` +
    `そのうえで ${fromSlug} からの切り取りを試みたが失敗した（${reason}）。` +
    `${fromSlug} 側は1文字も変わっていない。重複は増えていない——前回までの重複があるなら、それがそのまま残っている状態である。` +
    `memory_outline で ${fromSlug} と ${toSlug} を読み直してから、同じ操作をやり直すこと。`
  );
}

// 出どころから切り取って書く（版つき）。失敗は半完了の文にして返す（ここで捕まえる）
async function writeMemoryMoveSource(args: {
  stores: Stores;
  fromSlug: string;
  toSlug: string;
  existingContent: string;
  nextContent: string;
  ordered: readonly MemorySection[];
  plan: MemoryMovePlan;
  appendedChars: number;
}): Promise<{ kind: 'written'; fromWritten: MemoryMoveWritten } | MemoryMoveRefusal> {
  const { stores, fromSlug, toSlug, existingContent, nextContent, ordered, plan, appendedChars } =
    args;
  let fromWritten;
  try {
    fromWritten = await stores.persona.write(fromSlug, nextContent, {
      ifMatch: memoryVersion(existingContent),
    });
  } catch (error) {
    const reason =
      error instanceof MemoryConflictError
        ? `${fromSlug} が読んだ後にその間に変わった（人間または別のターンが書いた）ので、書かなかった`
        : reasonOf(error);
    if (plan.toAppend.length > 0) {
      return {
        kind: 'refused',
        body: describeMemoryMoveDuplicated({ fromSlug, toSlug, reason, plan, appendedChars }),
      };
    }
    return {
      kind: 'refused',
      body: describeMemoryMoveCutFailedWithoutAppend({
        fromSlug,
        toSlug,
        reason,
        orderedCount: ordered.length,
      }),
    };
  }
  return { kind: 'written', fromWritten };
}

// 出どころの move_out の日誌
async function journalMemoryMoveOut(args: {
  stores: Stores;
  cause: 'distill' | 'clone';
  fromSlug: string;
  toSlug: string;
  existingContent: string;
  fromWrittenContent: string;
  plan: MemoryMovePlan;
  summary: string;
}): Promise<void> {
  const { stores, cause, fromSlug, toSlug, existingContent, fromWrittenContent, plan, summary } =
    args;
  const { toAppend, alreadyAtDestination } = plan;
  await appendJournalOrThrow(
    'memory_section_move',
    stores.journal,
    {
      type: 'memory_update',
      slug: fromSlug,
      cause,
      action: 'move_out',
      bytesBefore: Buffer.byteLength(existingContent, 'utf8'),
      bytesAfter: Buffer.byteLength(fromWrittenContent, 'utf8'),
      summary:
        toAppend.length === 0 && alreadyAtDestination.length > 0
          ? `${summary}（${alreadyAtDestination.length} 節は ${toSlug} に既に在ったため追記しなかった。切り取りのみ行った）`
          : summary,
    },
    'act-completed',
  );
}

// 書いたあとの記憶を読み直して、床・再注入の見込み・成長の注記を作る（documents の読み → floor → reinjection → growth の順）
async function describeMemoryMoveAftermath(args: {
  stores: Stores;
  context: ToolContext;
  memoryBefore: readonly MemoryPart[];
  fromSlug: string;
  toSlug: string;
  existing: MemoryMoveDocument;
  toBefore: MemoryMoveDocument | null;
  toWritten: MemoryMoveWritten;
  fromWritten: MemoryMoveWritten;
}): Promise<{ floor: string; reinjection: string; growth: string }> {
  const {
    stores,
    context,
    memoryBefore,
    fromSlug,
    toSlug,
    existing,
    toBefore,
    toWritten,
    fromWritten,
  } = args;
  const memoryAfter = await stores.persona.documents();
  const floor = memoryFloorNote(
    memoryBefore,
    memoryAfter,
    toSlug,
    toWritten.content,
    toBefore === null,
  );
  const reinjection = describeMemoryReinjectionEstimate(
    [toWritten, fromWritten],
    memoryAfter,
    new Map([...seenBefore(toSlug, toBefore), ...seenBefore(fromSlug, existing)]),
  );
  const growth = memorySessionGrowthNote(memoryBefore, memoryAfter, context.runtime?.(), [
    toWritten.content,
    fromWritten.content,
  ]);
  return { floor, reinjection, growth };
}

// 移した節の一覧（見出し・節id・文字数だけ。本文は出さない）
function renderMemoryMoveListing(ordered: readonly MemorySection[], toSlug: string): string {
  // 古い本文を1文字も出さない: 出せば文脈に入り、この道具の存在理由が消えるため
  return renderListing(
    ordered.map(
      (section) =>
        `- 「${section.heading}」（節id ${section.id}、${section.chars.toLocaleString('en-US')} 文字）`,
    ),
    {
      budget: MEMORY_SECTION_MOVE_LIST_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `…ほか ${rest} 節は一覧から省略（移した ${total} 節のうち ${shown} 節だけ出した。` +
        `移動は済んでいる——省いた節も含めて、移った先の見出しは memory_outline slug=${toSlug} で見える）。`,
    },
  );
}

// 追記しなかった分も応答の本文で名乗る行（無ければ空）
function describeMemoryMoveIdempotentNote(toSlug: string, plan: MemoryMovePlan): string[] {
  const { toAppend, alreadyAtDestination } = plan;
  // 追記しなかった分も応答の本文で名乗る: 冪等にした結果が何も起きなかったように見える応答になるため
  return alreadyAtDestination.length > 0
    ? [
        '',
        `⭐ このうち ${alreadyAtDestination.length} 節は ${toSlug} に同じ節id の節が既に在ったため、追記していない` +
          `（今回 ${toSlug} へ新しく足したのは ${toAppend.length} 節）。重複は増えていない——` +
          '半完了から同じ呼び出しをやり直しても、移し先の節は増えない。' +
          `どの節が既に在ったかは memory_outline slug=${toSlug} で確かめられる。`,
      ]
    : [];
}

// 階層飛びの警告の行（無ければ空）
function describeMemoryMoveHierarchyJumpNote(
  scanSections: readonly MemorySection[],
  targets: readonly MemorySection[],
): readonly string[] {
  const warning = describeMemorySectionMoveHierarchyJumpWarning(scanSections, targets);
  return warning === null ? [] : ['', warning];
}

// 移せたときの応答の全体
function describeMemoryMoveResult(args: {
  fromSlug: string;
  toSlug: string;
  ordered: readonly MemorySection[];
  cutChars: number;
  plan: MemoryMovePlan;
  scanSections: readonly MemorySection[];
  targets: readonly MemorySection[];
  toBefore: MemoryMoveDocument | null;
  toWritten: MemoryMoveWritten;
  existingContent: string;
  fromWritten: MemoryMoveWritten;
  aftermath: { floor: string; reinjection: string; growth: string };
}): string {
  const {
    fromSlug,
    toSlug,
    ordered,
    cutChars,
    plan,
    scanSections,
    targets,
    toBefore,
    toWritten,
    existingContent,
    fromWritten,
    aftermath,
  } = args;
  const listing = renderMemoryMoveListing(ordered, toSlug);
  const idempotentNote = describeMemoryMoveIdempotentNote(toSlug, plan);
  const hierarchyJumpNote = describeMemoryMoveHierarchyJumpNote(scanSections, targets);
  return [
    `記憶 ${fromSlug} から ${ordered.length} 節（合計 ${cutChars.toLocaleString('en-US')} 文字）を ${toSlug} の末尾へ移した。`,
    '',
    listing,
    ...idempotentNote,
    ...hierarchyJumpNote,
    '',
    `移した先 ${toSlug}:`,
    describeMemoryWriteDiff(toBefore === null ? null : toBefore.content, toWritten.content),
    '',
    `出どころ ${fromSlug}:`,
    describeMemoryWriteDiff(existingContent, fromWritten.content),
    '',
    aftermath.floor,
    '',
    aftermath.reinjection,
    '',
    aftermath.growth,
  ].join('\n');
}

type MemoryFrontmatterSetWritten = Awaited<ReturnType<Stores['persona']['write']>>;

// `memory_frontmatter_set` の slug と「渡したキーが1つも無い」の断り（無ければ null）
function describeMemoryFrontmatterSetBasicViolation(
  slug: string,
  description: string | undefined,
  type: string | undefined,
  parent: string | undefined,
): string | null {
  if (!memorySlugSchema.safeParse(slug).success) {
    return `記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`;
  }
  if (description === undefined && type === undefined && parent === undefined) {
    return (
      `記憶 ${slug} の frontmatter を直すには description・type・parent のうち少なくとも1つを渡すこと` +
      '（何も変わっていない）。'
    );
  }
  return null;
}

// 改行を含む値は入口（ストアを読む前）で断る: 値の続きが別のキー・閉じの `---`・本文の1行目として紛れ込むため
// 断りには文字数・改行の位置・抜粋を名乗らせる: 呼び手が改行を探し続けて直し方を誤らないため
function describeMemoryFrontmatterLineBreakViolation(
  slug: string,
  description: string | undefined,
  type: string | undefined,
  parent: string | undefined,
): string | null {
  const lineBreakInputs: readonly ['description' | 'type' | 'parent', string | undefined][] = [
    ['description', description],
    ['type', type],
    ['parent', parent],
  ];
  for (const [lineBreakKey, value] of lineBreakInputs) {
    if (value === undefined) continue;
    const lineBreak = findMemoryFrontmatterLineBreak(value);
    if (lineBreak === null) continue;
    const charLabel = lineBreak.char === '\r' ? '\\r' : '\\n';
    return (
      `記憶 ${slug} の frontmatter を更新できない——${lineBreakKey} に改行（\\n / \\r）を含む値は渡せない` +
      '（frontmatter は1キー1行で書く約束なので、改行が入ると値の続きが本文や他のキーと混ざる）。' +
      `渡された ${lineBreakKey} は全 ${value.length} 文字、${lineBreak.position} 文字目に ${charLabel} が在る` +
      `（前後の抜粋: "${lineBreak.excerpt}"）。何も変わっていない。`
    );
  }
  return null;
}

// `type` は自由文字列で受けない: 綴り違いが書かれると区分は変わらないのに `kindChangeNote` が空になり、書き手に「変えた」つもりだけが残るため
function describeMemoryFrontmatterTypeViolation(
  slug: string,
  type: string | undefined,
): string | null {
  if (type !== undefined && !isKnownMemoryDocKind(type)) {
    return (
      `記憶 ${slug} の frontmatter を更新できない——type に渡せるのは premise か fact か indexed のいずれかだけである` +
      `（渡された値: ${JSON.stringify(type)}）。何も変わっていない。`
    );
  }
  return null;
}

// 引数の検査: slug・渡したキーが無い → 改行 → type の綴り、の順（ストアは読まない）
function describeMemoryFrontmatterSetArgsViolation(
  slug: string,
  description: string | undefined,
  type: string | undefined,
  parent: string | undefined,
): string | null {
  const basic = describeMemoryFrontmatterSetBasicViolation(slug, description, type, parent);
  if (basic !== null) return basic;
  const lineBreak = describeMemoryFrontmatterLineBreakViolation(slug, description, type, parent);
  if (lineBreak !== null) return lineBreak;
  return describeMemoryFrontmatterTypeViolation(slug, type);
}

// 文書が無いときの断り文
function describeMemoryFrontmatterNotFound(slug: string): string {
  return (
    `記憶 ${slug} は存在しない（frontmatter を直せない。新規作成は memory_write を使うこと。` +
    '何も変わっていない）。'
  );
}

// base_version の検査（渡されていなければ断る）
function checkMemoryFrontmatterBaseVersion(
  slug: string,
  baseVersion: string | undefined,
): { kind: 'ok'; baseVersion: string } | MemoryMoveRefusal {
  if (baseVersion === undefined || baseVersion.trim() === '') {
    return {
      kind: 'refused',
      body:
        `記憶 ${slug} の frontmatter を直すには、先に memory_read slug=${slug} で読み、` +
        '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
        '（読んだ後に人間が要旨などを直していても、渡したキーで上書きしないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
    };
  }
  return { kind: 'ok', baseVersion };
}

// 直す前の frontmatter の検査（malformed なら断る）
function checkMemoryFrontmatterPrior(
  slug: string,
  content: string,
): { kind: 'ok'; priorFrontmatter: MemoryMoveFrontmatter } | MemoryMoveRefusal {
  const priorFrontmatter = parseMemoryFrontmatter(content);
  if (priorFrontmatter.kind === 'malformed') {
    return {
      kind: 'refused',
      body:
        `記憶 ${slug} の frontmatter が壊れている（malformed）。ここでは直さない——` +
        '機械が推測して組み直すと本文を食う経路ができるため。memory_write で全文を書き直すか、' +
        '人間に確認を通すこと（何も変わっていない）。',
    };
  }
  return { kind: 'ok', priorFrontmatter };
}

// 版つきで書く。競合（MemoryConflictError）だけを断りにして返し、ほかの失敗はそのまま投げる
async function writeMemoryFrontmatter(args: {
  stores: Stores;
  slug: string;
  nextContent: string;
  baseVersion: string;
}): Promise<{ kind: 'written'; written: MemoryFrontmatterSetWritten } | MemoryMoveRefusal> {
  const { stores, slug, nextContent, baseVersion } = args;
  let written;
  try {
    written = await stores.persona.write(slug, nextContent, { ifMatch: baseVersion });
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      return {
        kind: 'refused',
        body: describeMemoryConflict(slug, 'frontmatter の更新', error.current),
      };
    }
    throw error;
  }
  return { kind: 'written', written };
}

// 書いた後の日誌（frontmatter の更新）
async function journalMemoryFrontmatterSet(args: {
  stores: Stores;
  slug: string;
  cause: 'distill' | 'clone';
  existingContent: string;
  writtenContent: string;
  summary: string;
}): Promise<void> {
  const { stores, slug, cause, existingContent, writtenContent, summary } = args;
  await appendJournalOrThrow(
    'memory_frontmatter_set',
    stores.journal,
    {
      type: 'memory_update',
      slug,
      cause,
      action: 'describe',
      bytesBefore: Buffer.byteLength(existingContent, 'utf8'),
      bytesAfter: Buffer.byteLength(writtenContent, 'utf8'),
      summary,
    },
    'act-completed',
  );
}

// 区分の名前（応答の「区分が変わった」に出す）
function describeMemoryDocKindLabel(kind: MemoryDocKind): string {
  switch (kind) {
    case 'premise':
      return 'premise（要旨＋節の目次が載る）';
    case 'indexed':
      return 'indexed（要旨だけが載る。節の目次は載らない）';
    case 'fact':
      return 'fact（目次の1行だけ載る）';
    default:
      return assertNeverMemoryDocKind(kind);
  }
}

// 区分ごとの、次のターンからの載り方
function describeMemoryNextKindLoad(kind: MemoryDocKind): string {
  switch (kind) {
    case 'fact':
      return '次のターンから、この文書は目次の1行だけになる（節の目次も載らなくなる）。';
    case 'indexed':
      return (
        '次のターンから、この文書は要旨だけがプロンプトへ載る（節の目次は載らない。' +
        '節を確かめるには memory_outline を呼び、memory_section_read で開くこと）。'
      );
    case 'premise':
      return '次のターンから、この文書は要旨と節の目次がプロンプトへ載る（本文は載らない。memory_section_read で開く）。';
    default:
      return assertNeverMemoryDocKind(kind);
  }
}

// 区分が変わったときの注記（変わらなければ空文字列）
function describeMemoryFrontmatterKindChange(
  priorKind: MemoryDocKind,
  nextKind: MemoryDocKind,
): string {
  return priorKind === nextKind
    ? ''
    : `\n\n区分が変わった: ${describeMemoryDocKindLabel(priorKind)} → ${describeMemoryDocKindLabel(nextKind)}。` +
        describeMemoryNextKindLoad(nextKind);
}

// 書いた後の記憶（読み直し済み）から、床・再注入の見込み・成長の注記を作る
function describeMemoryFrontmatterAftermath(args: {
  context: ToolContext;
  slug: string;
  memoryBefore: readonly MemoryPart[];
  memoryAfter: readonly MemoryPart[];
  existing: MemoryMoveDocument;
  written: MemoryFrontmatterSetWritten;
}): { floor: string; reinjection: string; growth: string } {
  const { context, slug, memoryBefore, memoryAfter, existing, written } = args;
  const floor = memoryFloorNote(memoryBefore, memoryAfter, slug, written.content, false);
  const reinjection = describeMemoryReinjectionEstimate(
    [written],
    memoryAfter,
    seenBefore(slug, existing),
  );
  const growth = memorySessionGrowthNote(memoryBefore, memoryAfter, context.runtime?.(), [
    written.content,
  ]);
  return { floor, reinjection, growth };
}

// 更新できたときの応答の全体
function renderMemoryFrontmatterSetResult(args: {
  slug: string;
  diff: string;
  kindChangeNote: string;
  aftermath: string;
}): string {
  const { slug, diff, kindChangeNote, aftermath } = args;
  return `記憶 ${slug} の frontmatter を更新した。\n\n${diff}${kindChangeNote}\n\n${aftermath}`;
}

export function memoryTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores, memoryCause } = shared;
  return [
    tool(
      'memory_list',
      [
        '記憶の文書一覧を返す。中身は返さない。',
        '各行は `[premise|fact|indexed] slug: title (作成: createdAt / 更新: updatedAt) — 要旨` の形。',
        '作成は書き込まれた瞬間にその場で分かる。「不明」と出るのは、この配線より前に作られ、',
        '日誌にも根拠（最初の書き込み）が無い古い記憶だけである（ファイルの mtime は使わない）。',
        'premise はプロンプトへ要旨と節の目次（節id・見出し・文字数）だけが焼かれ、本文は載らない',
        '（節id を memory_section_read に渡せば開ける）。indexed は要旨だけが焼かれ、節の目次は焼かれない',
        '（節id を確かめるにはまず memory_outline を呼ぶこと）。fact は目次の1行だけがプロンプトに載るので、',
        '中身が要るなら memory_read で開くこと。要旨の前には状態が必ず付く',
        '（要旨は本文より<期間>古い（本文は<変化量>変わった） / 要旨を書いた時刻が記録されていない /',
        '要旨の後に本文は動いていない）—— description が最後の本文変更より前に書かれた可能性の',
        '代理指標であって、本文と合っている保証ではない。「<期間>古い」だけでは、頻繁に手が入って',
        'いる文書ほど新しく見える（1時間前に古くなった文書と30日放置された文書が同じ「古い」に',
        '見える）ので、その間に本文が実際どれだけ変わったか（バイト数・割合）を変化量として併記する',
        '（変化量が記録されていない古い記憶は「記録されていない」とだけ言い、0とは扱わない）。',
        '階層は frontmatter の parent から組み立てた木で、インデントで表す。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        cursor: z
          .string()
          .optional()
          .describe(
            '続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。',
          ),
      },
      async ({ cursor }) => {
        const documents = await stores.persona.list();
        const resolved = resolveMemoryCursor(documents, cursor);
        if (resolved.kind === 'malformed') {
          // 黙って先頭からへ倒さない: 倒すと呼び手は「続きを読んだつもり」で同じ行を読むため
          return text(
            'この cursor は読めない（壊れているか、この道具のものではない）。' +
              'cursor は前回の応答の断り書きに出たものをそのまま渡すこと（自分で組み立てない）。' +
              '先頭から読み直すなら cursor を省いて呼ぶこと。',
          );
        }
        // cursor を渡されたときだけ「最後の頁」と言う: cursor 無しの0件は記憶が空で終端ではなく、早期に返すと空のときの言い方を奪うため
        if (cursor !== undefined && resolved.view.length === 0) {
          return text('（cursor より後ろの記憶は無い。これが最後の頁）');
        }
        return text(
          renderMemoryListing(
            resolved.view.map((doc) => ({
              slug: doc.slug,
              title: doc.title,
              kind: doc.kind,
              description: doc.description,
              descriptionFreshness: doc.descriptionFreshness,
              parent: doc.parent,
              updatedAt: doc.updatedAt,
              createdAt: doc.createdAt,
            })),
            { total: documents.length, anchor: resolved.anchor },
          ),
        );
      },
    ),

    tool(
      'memory_read',
      ['記憶の文書を1つ読む。', '長ければ切れて出る（続きの取り方が出力に付く）。'].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        offset: z
          .number()
          .optional()
          .describe(`何文字目から読むか（${formatIntRangeJa({ min: 0 })}。既定 0）`),
      },
      async ({ slug, offset = 0 }) => {
        // 不正なスラッグはここで断る: 無いと fs / pg の生の例外がそのまま抜けるため
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const doc = await stores.persona.read(slug);
        if (!doc) return text(`記憶 ${slug} は存在しない。`);
        const part = page(doc.content, offset, MEMORY_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは memory_read slug=${slug} offset=${part.to}）`
          : '';
        // 切れていないときは注記を出さない: 毎回付けると、本当に切れているときの目印が効かなくなるため
        const version = `\n\n${versionLine(doc.content)}`;
        if (part.from === 0 && !part.more) return text(`${part.body}${version}`);
        return text(`（${describePage(part)}）\n\n${part.body}${tail}${version}`);
      },
    ),

    tool(
      'memory_write',
      [
        '記憶の文書を全文置換する（無ければ作る）。',
        '**既存の文書を書き換えるときは、先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと。焼き込みの索引（プロンプトに載った premise のカード等）だけでは書けない**（版が無ければ何も書かずに断る。読んだ後に人間や別のターンが書いていたら、何も書かずに「その間に変わった」と返す。読み直して判断し直すこと）。**新しい文書の作成は版なしで通る。**',
        '人間がこのファイルを直接開いて読むことを前提に、Markdown として読みやすく書くこと。',
        '人間が手で書いた記述を、整形の都合で消さないこと。',
        '先頭に frontmatter を置ける（無くてもよい。無ければ premise として扱う——安全側の既定）。',
        '形は `---` で始まり `---` で閉じ、各行は `key: value`。使えるキーは description（要旨。目次の1行に載る）・',
        'type（premise・indexed・fact のいずれか。premise は「要旨＋節の目次」が焼かれ、' +
          'indexed は要旨だけが焼かれて節の目次は焼かれない（特定の作業でしか使わない記憶向け。' +
          '節を確かめるにはまず memory_outline を呼ぶこと）、fact は目次の1行だけになる。',
        'どれも本文は焼かれない——premise / indexed の節の本文は memory_section_read で開く。判断の前提なら premise、',
        '事実の蓄積で毎回全文を読む必要が無いものなら fact）・parent（親文書の slug。階層を作る）の3つだけ。',
        'ネスト・複数行・引用符の解釈は無い（値は文字列としてそのまま読む）。狭い形から外れると malformed として',
        '扱われ、文書は消えずに premise のまま残る（本文はプロンプトには載らず、memory_section_read で開く）。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
        '成功すると差分の要約が返る——前後の文字数（バイトではない）と、この書き込みで消えた見出しの名指し。',
        '**「消えた見出し: なし」を全幅で信じないこと**——同じ見出しが他所に1つでも残っていれば、その節を丸ごと消しても「なし」になる。',
        '見出しは行頭の `#`〜`######`（ATX）だけ（setext の下線は数えない）で、コードフェンスの中は除外しない（過剰に拾う側へ倒してある）。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（英小文字・数字・-・_）'),
        content: z.string().describe('Markdown 全文'),
        summary: z.string().describe('何を更新したかの一行要約（日誌に残る）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の memory_write の応答に出る base_version）。' +
              '**既存の文書を書き換えるときは必須**。',
          ),
      },
      async ({ slug, content, summary, base_version: baseVersion }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '全文置換');
        if (denial !== null) return text(denial);
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        // 版なしで既存の文書は書けない: 全文置換は読んだ時点の版を前提にし、読んでから書くまでがターンをまたぐこともあるため
        if (before !== null && baseVersion === undefined) {
          return text(
            `記憶 ${slug} は既に在る。全文を書き直すには、先に memory_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
          );
        }
        let written;
        try {
          written = await stores.persona.write(slug, content, {
            ifMatch: before === null ? (baseVersion ?? null) : baseVersion!,
          });
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            return text(describeMemoryConflict(slug, '全文置換', error.current));
          }
          throw error;
        }
        const memoryAfter = await stores.persona.documents();
        await appendJournalOrThrow(
          'memory_write',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause,
            action: 'write',
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(written.content, 'utf8'),
            summary,
          },
          'act-completed',
        );
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
        );
        const reinjection = describeMemoryReinjectionEstimate(
          [written],
          memoryAfter,
          seenBefore(slug, before),
        );
        const growth = memorySessionGrowthNote(memoryBefore, memoryAfter, context.runtime?.(), [
          written.content,
        ]);
        const tokenDiff = describeTokenDiff(
          before === null ? null : before.content,
          written.content,
        );
        // 新規作成は「新規作成」を床の行の1回だけにする: 「更新した」と言わず、差分の要約にも同じ語を重ねない
        return text(
          (before === null
            ? `記憶 ${slug} を作った（${written.content.length.toLocaleString('en-US')} 文字）。`
            : `記憶 ${slug} を更新した。\n\n${diff}`) +
            (tokenDiff === null ? '' : `\n${tokenDiff}`) +
            `\n\n${floor}\n\n${reinjection}\n\n${growth}\n\n${versionLine(written.content)}`,
        );
      },
    ),

    tool(
      'memory_append',
      [
        '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
        '成功すると memory_write と同じ差分の要約が返る（前後の文字数と、消えた見出しの名指し。見出しの数え方も同じ）。',
        '追記は既存を消さないので、消えた見出しは常に 0 件のはずである——0 件でなければ異常を疑うこと。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z
          .string()
          .describe(`追記する Markdown（${formatStringLengthJa({ min: 1 })}。空白だけは断る）`),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }, extra: unknown) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        // 空の追記を断る: 置き場は空の本文でも末尾へ空行を1本足して版を進め、「追記した」と答えることになるため（memory_section_move も同じ理由で空を渡さない）
        const contentError = describeStringLengthViolation('content', stripNul(content), {
          min: 1,
        });
        if (contentError !== null) return text(`${contentError}追記していない。`);
        if (stripNul(content).trim().length === 0) {
          return text('content が空白だけなので追記していない。足したい記述を書いて渡すこと。');
        }
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        const written = await stores.persona.append(slug, content);
        const memoryAfter = await stores.persona.documents();
        await appendJournalOrThrow(
          'memory_append',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause: memoryCause(),
            action: 'append',
            bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
            bytesAfter: Buffer.byteLength(written.content, 'utf8'),
            summary,
          },
          'act-completed',
        );
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        // 見出し・注記の固定語句だけを、同じ会話の2回目から札にする（数・slug・消えた見出しの名指しは畳まない）。応答を返す直前のここで1度だけ呼ぶ
        const fold = foldFixedFor(context, extra);
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
          fold,
        );
        const reinjection = describeMemoryReinjectionEstimate(
          [written],
          memoryAfter,
          seenBefore(slug, before),
          fold,
        );
        const growth = memorySessionGrowthNote(
          memoryBefore,
          memoryAfter,
          context.runtime?.(),
          [written.content],
          fold,
        );
        const head =
          before === null
            ? `記憶 ${slug} を作った（${written.content.length.toLocaleString('en-US')} 文字）。`
            : `記憶 ${slug} に追記した。\n\n${diff}`;
        return text(`${head}\n\n${floor}\n\n${reinjection}\n\n${growth}`);
      },
    ),

    // 部分削除の引数は作らない: 文書の一部を消したいなら `memory_write` の全文置換で足りる
    // 存在しないスラッグを黙って成功にしない: ストア層の `remove` は冪等で、そのまま返すと「消したつもりで何も消えていない」を作るため
    // 本文は日誌へ写さない: 記憶の中身を別の場所へ増やさないため、残すのはスラッグと文字数だけ
    tool(
      'memory_delete',
      [
        '記憶の文書を1つ、文書ごと消す（部分削除ではない。一部を変えたいだけなら memory_write を使う）。',
        '無いスラッグを渡しても成功にはならず、そう返る。',
        '**先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引だけでは消せない**——版が無ければ何も消さずに断る。読んだ後に人間や別のターンが書いていたら、何も消さずに「その間に変わった」と返す（読んでいない内容まで消さないため）。',
        '消した事実は日誌に残る（スラッグと直前の文字数のみ。本文は残らない）。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書は消せない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の削除は通る。',
      ].join(' '),
      {
        slug: z.string().describe('記憶のスラッグ（拡張子なし）'),
        summary: z.string().describe('なぜ消したかの一行要約（日誌に残る。本文は残らない）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の書き込みの応答に出る base_version）。**必須**。',
          ),
      },
      async ({ slug, summary, base_version: baseVersion }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const existing = await stores.persona.read(slug);
        if (existing === null) {
          return text(`記憶 ${slug} は存在しない（消せない。何も変わっていない）。`);
        }
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '削除');
        if (denial !== null) return text(denial);
        // 版なしでは消さない: 消すのは「読んだ内容を見て」の判断で、読んでいない内容まで消さないため
        if (baseVersion === undefined) {
          return text(
            `記憶 ${slug} を消すには、先に memory_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは消せない）。**何も消していない。**',
          );
        }
        try {
          await stores.persona.remove(slug, { ifMatch: baseVersion });
        } catch (error) {
          if (error instanceof MemoryConflictError) {
            return text(describeMemoryConflict(slug, '削除', error.current, 'remove'));
          }
          throw error;
        }
        await appendJournalOrThrow(
          'memory_delete',
          stores.journal,
          {
            type: 'memory_update',
            slug,
            cause,
            action: 'remove',
            bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
            bytesAfter: 0,
            summary: `${summary}（削除直前 ${existing.content.length} 文字）`,
          },
          'act-completed',
        );
        return text(`記憶 ${slug} を消した（削除直前 ${existing.content.length} 文字）。`);
      },
    ),

    // 既に在る文書にしか使えない: 「文書を直す口」であって「作る口」ではない
    // `malformed` な frontmatter には断る: 機械が推測して組み直すと本文を食う経路ができるため
    tool(
      'memory_frontmatter_set',
      [
        '記憶の frontmatter（description・type・parent）のうち、渡したキーだけを差し替える／追加する。',
        '本文には一切触れない——本文はストアから読んだ古い content からそのまま取るので、1バイトも失われない。',
        'この道具の呼び出しの中に本文が現れることは無いので、本文が途中で切れることも構造的に起こりえない。',
        'description・type・parent の値に改行（\\n / \\r）を含む値は渡せない（断る）——値から本文へ文字列が混ざる経路を構造的に無くすため。',
        '既に在る文書にしか使えない（存在しない slug には断る。新規作成は memory_write を使うこと）。',
        '**先に memory_read（または memory_outline）で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引（プロンプトに載った premise のカード等）だけでは書けない**——版が無ければ何も書かずに断る。読んだ後に人間が要旨などを直していたら、何も書かずに「その間に変わった」と返す（渡したキーで人間の直しを上書きしないため）。',
        'frontmatter が無い文書には、先頭に新しく frontmatter を作って足す（type を渡さなければ premise のまま——載り方は変わらない）。',
        'frontmatter が壊れている（malformed）文書には断る（機械が推測して組み直すと本文を食う経路ができるため）。',
        'memory_write で全文を書き直すか、人間に確認を通すこと。',
        'description・type・parent のうち少なくとも1つを渡すこと（1つも渡さない呼びは断る。何も変わらない）。',
        'type に渡せるのは premise・indexed・fact のいずれかだけ（それ以外の値は断る。綴りを間違えたまま黙って書かない）。',
        'premise は「要旨＋節の目次」がプロンプトへ焼かれ、indexed は要旨だけが焼かれて節の目次は焼かれない（節を確かめるにはまず memory_outline を呼ぶこと）、fact は目次の1行だけになる（どれも本文は焼かれない）。区分が変わったときは、その変化が応答に出る。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        description: z
          .string()
          .optional()
          .describe('要旨（目次の1行に載る）。渡さなければ既存の値のまま'),
        type: z
          .string()
          .optional()
          .describe(
            'premise・indexed・fact のいずれかのみ（それ以外は断る）。渡さなければ既存の値のまま（既定は premise）',
          ),
        parent: z.string().optional().describe('親文書の slug（階層）。渡さなければ既存の値のまま'),
        summary: z.string().describe('何を直したかの一行要約（日誌に残る）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（memory_read / memory_outline / 直前の書き込みの応答に出る base_version）。**必須**。',
          ),
      },
      async ({ slug, description, type, parent, summary, base_version: baseVersion }) => {
        const argsViolation = describeMemoryFrontmatterSetArgsViolation(
          slug,
          description,
          type,
          parent,
        );
        if (argsViolation !== null) return text(argsViolation);

        let existing;
        try {
          existing = await stores.persona.read(slug);
        } catch (error) {
          return text(
            `記憶 ${slug} を読めなかった（${collapseErrorCause(error)}）。` +
              'frontmatter は直していない（何も変わっていない）。',
          );
        }
        if (existing === null) return text(describeMemoryFrontmatterNotFound(slug));

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, 'frontmatter の更新');
        if (denial !== null) return text(denial);

        const versionCheck = checkMemoryFrontmatterBaseVersion(slug, baseVersion);
        if (versionCheck.kind === 'refused') return text(versionCheck.body);

        const priorCheck = checkMemoryFrontmatterPrior(slug, existing.content);
        if (priorCheck.kind === 'refused') return text(priorCheck.body);

        const priorKind = resolveMemoryDocKind(priorCheck.priorFrontmatter);
        const nextContent = applyMemoryFrontmatterPatch(existing.content, {
          description,
          type,
          parent,
        });
        // 同じ値なら書かない: 書くと版が進み、ほかの書き手の base_version が古くなるため
        if (nextContent === existing.content) {
          return text(
            `記憶 ${slug} の frontmatter は渡した値といまの値が同じなので、何も書いていない` +
              `（版は変わらない: base_version=${memoryVersion(existing.content)}）。`,
          );
        }
        const memoryBefore = await stores.persona.documents();
        const writeResult = await writeMemoryFrontmatter({
          stores,
          slug,
          nextContent,
          baseVersion: versionCheck.baseVersion,
        });
        if (writeResult.kind === 'refused') return text(writeResult.body);
        const { written } = writeResult;
        const nextKind = resolveMemoryDocKind(parseMemoryFrontmatter(written.content));

        // 日誌を書いた後の一覧の読みより先に残す: 一覧は応答の文にしか使わず、読みが落ちても記憶は書き換わっているため
        await journalMemoryFrontmatterSet({
          stores,
          slug,
          cause,
          existingContent: existing.content,
          writtenContent: written.content,
          summary,
        });

        const diff = describeMemoryWriteDiff(existing.content, written.content);
        const kindChangeNote = describeMemoryFrontmatterKindChange(priorKind, nextKind);
        let memoryAfter: Awaited<ReturnType<Stores['persona']['documents']>> | null;
        let afterError: unknown;
        try {
          memoryAfter = await stores.persona.documents();
        } catch (error) {
          memoryAfter = null;
          afterError = error;
        }
        let aftermath: string;
        if (memoryAfter === null) {
          aftermath = `（書いた後の記憶の一覧が読めなかったので、載り方の変化は確かめていない: ${collapseErrorCause(afterError)}）`;
        } else {
          const parts = describeMemoryFrontmatterAftermath({
            context,
            slug,
            memoryBefore,
            memoryAfter,
            existing,
            written,
          });
          aftermath = `${parts.floor}\n\n${parts.reinjection}\n\n${parts.growth}`;
        }

        return text(renderMemoryFrontmatterSetResult({ slug, diff, kindChangeNote, aftermath }));
      },
    ),

    // 本文は1文字も返さない: 返すと「文脈へ入れずに構造を見る」という存在理由を潰すため
    // `malformed` な frontmatter でも目次は返す: 読むだけで断る理由が無いが、`memory_section_move` が断ることは応答に書く
    // `side` だけにしない: 中央の節へ届かないため、`q` と `offset` で届く道を足してある
    tool(
      'memory_outline',
      [
        '記憶の文書の目次を返す（読むだけ。1文字も書き換えない）。',
        '各行は `[節id] 見出し行 — N 文字` で、インデントが見出しの深さを表す。文字数は入れ子の子を含むので、その節を動かしたときに動く量がそのまま出る。',
        '本文は1文字も返さない（本文が要るなら memory_read）。frontmatter の行も出ない。',
        '節id は memory_section_move の指し先であると同時に、その節の版の照合でもある——中身が変われば id も変わるので、目次を読んでから移すまでの間に誰かがその節を書き換えていたら断られる。移す直前に取り直すこと。',
        '中身まで同一の節が2つあると id が衝突する。その行には印が付き、その id では動かせない。',
        '目次は文字数の予算で切る。既定（side を渡さない）では先頭から詰めるので、落ちるのは末尾側である——大きな文書では新しく積んだ節の節id が出てこない。side=tail を渡すと末尾から詰め、落ちるのは先頭側になる。⚠どちらの向きでも中央は出ない（side だけでは届かない）。',
        '中央へ届く道は2つある。q=<文字列> は見出しをその文字列で絞り込む（大文字小文字を区別しない部分一致。正規表現ではない）——一致した節がそのまま目次と同じ形で出るので memory_section_read / memory_section_move へ渡せる。offset=<N> は先頭から N 節飛ばしてから予算を埋める——応答が返す次の offset の値ぶんずつ進めれば、文書がどれだけ大きくても有限回で全節に届く。offset を渡すと side は見ない。q も offset も渡さなければ出力は今までと同じ。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        side: z
          .enum(MEMORY_OUTLINE_SIDES)
          .optional()
          .describe(
            '予算に入りきらないとき、どちら側を出すか。head（既定。渡さなければ従来と同じ出力）は先頭から詰めて末尾側を落とす。tail は末尾から詰めて先頭側を落とす。⚠中央はどちらでも出ない。offset を渡すときは見ない。',
          ),
        q: z
          .string()
          .optional()
          .describe(
            `見出しをこの文字列で絞り込む（${formatStringLengthJa({ min: 1 })}。大文字小文字を区別しない部分一致。正規表現ではない——メタ文字を含んでいても文字どおりにしか一致しない）。side と併用できる（絞り込んだ結果をどちらから詰めるか）。一致0件と、一致はあるが予算で切れた場合は別の文言で返る。`,
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `先頭から何節を飛ばしてから予算を埋めるか（${formatIntRangeJa({ min: 0 })}。0起点）。応答が返す次の offset ぶんずつ進めれば、有限回の呼び出しで全節に届く（中央へ届くことを保証する側）。渡すと side は見ない。q と併用でき、その場合は絞り込んだ結果に対して窓を開く。範囲外（節数以上）なら断る。`,
          ),
      },
      async ({ slug, side, q, offset }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        const qError = describeStringLengthViolation('q', q, { min: 1 });
        if (qError !== null) return text(qError);
        const doc = await stores.persona.read(slug);
        if (doc === null) return text(`記憶 ${slug} は存在しない。`);
        const { sections } = scanMemorySections(doc.content);
        const malformedNote =
          parseMemoryFrontmatter(doc.content).kind === 'malformed'
            ? '\n\n⚠この文書の frontmatter は壊れている（malformed）。目次はこのまま読めるが、' +
              'memory_section_move はこの文書を断る（memory_write で全文を書き直すか、人間に確認を通すこと）。'
            : '';
        return text(
          `記憶 ${slug} の目次（${sections.length} 節）。本文は含まない。\n\n` +
            `${renderMemoryOutline(sections, { side, q, offset })}${malformedNote}\n\n${versionLine(doc.content)}`,
        );
      },
    ),

    // 断りを畳まない: 読み直せば済むのか指し先が間違っているのかが区別できなくなるため
    // 1つが読めなくても、読めた節は返す: 全部を断ると読めた分のターンが無駄になるため
    tool(
      'memory_section_read',
      [
        '記憶の文書の、節id で指した節の本文を開く（読むだけ。1文字も書き換えない）。',
        '節id は毎ターンの焼き込み（premise のカード）と memory_outline に出ている——目次を取り直さなくてもそのまま渡せる。',
        '複数の節id を1回で渡せる。返る順序は文書に現れる順である。',
        '読めなかった節id は理由ごとに分けて言う（古い＝誰かが書き換えた／同一の節が複数／そもそも無い）。読めた節は返る。',
        '入れ子の子は親に含まれる（親の節id を渡せば子も一緒に開く）。',
        '応答は文字数の予算で切る。切ったらそう言う。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        sections: z
          .array(z.string())
          .describe(
            `開く節の節id（複数可。${formatArrayLengthJa({ min: 1 })}）。焼き込みのカードか memory_outline に出ているもの`,
          ),
      },
      async ({ slug, sections: requested }) => {
        if (!memorySlugSchema.safeParse(slug).success) {
          return text(`記憶のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const sectionsError = describeArrayLengthViolation('sections', requested, { min: 1 });
        if (sectionsError !== null) return text(sectionsError);
        const doc = await stores.persona.read(slug);
        if (doc === null) return text(`記憶 ${slug} は存在しない。`);
        const { sections } = scanMemorySections(doc.content);

        const found: { id: string; section: MemorySection }[] = [];
        const refusals: string[] = [];
        for (const id of requested) {
          const lookup = lookupMemorySection(sections, id);
          switch (lookup.kind) {
            case 'found':
              found.push({ id, section: lookup.section });
              break;
            case 'stale':
              refusals.push(
                `- ${id}: **その id は古い**（見出しは一致するが中身が違う＝誰かが書き換えた）。` +
                  'memory_outline で取り直すこと。',
              );
              break;
            case 'ambiguous':
              refusals.push(
                `- ${id}: 中身まで同一の節が ${lookup.sections.length} 箇所に在り、1つに決まらない。` +
                  '見出しを変えて区別を付けること。',
              );
              break;
            case 'absent':
              refusals.push(
                `- ${id}: その節id はこの文書に無い（打ち間違いか、別の文書か、見出しごと書き換えられた）。`,
              );
              break;
            default: {
              const exhaustive: never = lookup;
              throw new Error(`未知の節id の引き当て結果: ${JSON.stringify(exhaustive)}`);
            }
          }
        }

        found.sort((a, b) => a.section.start - b.section.start);
        const bodies = found.map(
          ({ id, section }) =>
            `[${id}] ${section.heading}\n${doc.content.slice(section.start, section.end).trimEnd()}`,
        );

        const listing =
          bodies.length === 0
            ? '（1節も開けなかった）'
            : renderListing(bodies, {
                budget: MEMORY_PAGE,
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 節は応答から省略（${total} 節のうち ${shown} 節だけ返した）。` +
                  '残りは節id を分けて呼び直すこと（この道具は何も書き換えていないので、呼び直しは安全である）。',
              });

        const refusalNote =
          refusals.length === 0 ? '' : `\n\n読めなかった節:\n${refusals.join('\n')}`;
        return text(
          `記憶 ${slug} の節を ${found.length} 件開いた（この文書は全 ${sections.length} 節）。\n\n` +
            `${listing}${refusalNote}`,
        );
      },
    ),

    // 全件を先に照合してから動かす: 部分成功だと呼び手がどこまで動いたかを応答から逆算することになるため
    // 先に足して、後で消す: 2文書をまたぐトランザクションが無く、途中で落ちたとき残るのを消失ではなく重複にするため
    // 3層目の frontmatter 検査は到達しないが残す: 継ぎ足しをやめて組み直す形に変えたとき「本文だったものが frontmatter に化ける」を守る唯一の検査のため
    tool(
      'memory_section_move',
      [
        'memory_outline が出した節id（複数可）で指した節を、別の文書の末尾へまとめて移す（切り取って足す）。移し先が無ければ作る。',
        '本文はこの呼び出しにも応答にも一度も現れない（0文字）——これがこの道具の存在理由である。大きな文書を割るのに本文を作り直さなくてよい。',
        '節の範囲は見出し行から「同じ深さ以下の次の見出しの直前」までで、入れ子の子は一緒に動く。frontmatter は節ではないので指せない。',
        '先に移し先へ足し、後から出どころを消す——途中で落ちれば同じ節が両方に残る（重複するが、失われない）。そのときはそう返る。',
        // 断りの数を書かない: 数で名乗ると抜けや到達しない断りの扱いで腐るため列挙だけにする
        '断るのは: from と to が同じ／出どころの文書がそもそも無い（slug の打ち間違い）／出どころの frontmatter が壊れている／その id の節が無い／その id は古い（中身が書き換えられた。memory_outline を取り直すこと）／中身まで同じ節が複数あって id が曖昧（どちらかを選ばずに断る）／指定した節どうしの範囲が重なっている（親子関係や同じ id の重複）。',
        '⭐1つでも断りに当たれば、1節も動かさない——一部だけ動いて残りが断られる、ということは起きない。',
        '**⭐この口だけは、統合の走行（distill）からでも、人間が一度でも書いた文書・履歴の無い文書に対して通る**',
        '（2026-09-08 に緩めた。全文置換・削除・frontmatter の更新はいまも断る。移動は先に移し先へ足してから出どころを消すので、どの瞬間にも本文がどこかに在る＝失われない。だから保護状態を見ずに通す）。移し先には歯が掛からない（追記なので）。',
      ].join(' '),
      {
        fromSlug: z.string().describe('節を切り取る側の文書のスラッグ'),
        sections: z
          .array(z.string())
          .describe(
            `memory_outline が出した節id（\`[...]\` の中身）。複数渡せる——1回で全部移る（${formatArrayLengthJa({ min: 1 })}）。渡す順ではなく文書に現れる順で移し先の末尾に並ぶ`,
          ),
        toSlug: z.string().describe('節を足す側の文書のスラッグ（無ければ作る）'),
        summary: z.string().describe('なぜ移したかの一行要約（日誌に残る。本文は残らない）'),
      },
      async ({ fromSlug, sections: ids, toSlug, summary }) => {
        const argsCheck = checkMemorySectionMoveArgs(fromSlug, toSlug, ids);
        if (argsCheck.kind === 'refused') return text(argsCheck.body);

        const existing = await stores.persona.read(fromSlug);
        if (existing === null) {
          return text(`記憶 ${fromSlug} は存在しない（節を移せない。何も変わっていない）。`);
        }

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, fromSlug, cause, '節の移動');
        if (denial !== null) return text(denial);

        const frontmatterCheck = checkMemoryMoveSourceFrontmatter(fromSlug, existing.content);
        if (frontmatterCheck.kind === 'refused') return text(frontmatterCheck.body);

        const scan = scanMemorySections(existing.content);
        const resolved = resolveMemoryMoveTargets(fromSlug, ids, scan.sections);
        if (resolved.kind === 'refused') return text(resolved.body);
        const { targets } = resolved;

        const cutResult = cutMemoryMoveSource({
          fromSlug,
          existingContent: existing.content,
          scan,
          priorFrontmatter: frontmatterCheck.priorFrontmatter,
          targets,
        });
        if (cutResult.kind === 'refused') return text(cutResult.body);
        const { nextContent, cut, ordered } = cutResult;

        const [toBefore, memoryBefore] = await Promise.all([
          stores.persona.read(toSlug),
          stores.persona.documents(),
        ]);

        const plan = planMemoryMoveDestination(ordered, toBefore);
        const { toWritten, appendedChars } = await appendMemoryMoveDestination({
          stores,
          cause,
          toSlug,
          toBefore,
          existingContent: existing.content,
          plan,
          summary,
        });

        const fromResult = await writeMemoryMoveSource({
          stores,
          fromSlug,
          toSlug,
          existingContent: existing.content,
          nextContent,
          ordered,
          plan,
          appendedChars,
        });
        if (fromResult.kind === 'refused') return text(fromResult.body);
        const { fromWritten } = fromResult;
        await journalMemoryMoveOut({
          stores,
          cause,
          fromSlug,
          toSlug,
          existingContent: existing.content,
          fromWrittenContent: fromWritten.content,
          plan,
          summary,
        });

        const aftermath = await describeMemoryMoveAftermath({
          stores,
          context,
          memoryBefore,
          fromSlug,
          toSlug,
          existing,
          toBefore,
          toWritten,
          fromWritten,
        });

        return text(
          describeMemoryMoveResult({
            fromSlug,
            toSlug,
            ordered,
            cutChars: cut.length,
            plan,
            scanSections: scan.sections,
            targets,
            toBefore,
            toWritten,
            existingContent: existing.content,
            fromWritten,
            aftermath,
          }),
        );
      },
    ),
  ];
}
