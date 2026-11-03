// 実践（practice_*）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { renderListing, renderListingEntry } from './excerpt.js';
import { describeTokenDiff } from './token-diff.js';
import { stripNul } from './nul-guard.js';
import { practiceKindSchema, practiceSlugSchema, type Practice } from './schema.js';
import {
  UnreadablePracticeError,
  describeUnreadablePractices,
  PracticeConflictError,
  practiceVersion,
} from './store.js';
import {
  describeIntRangeViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import { tool, text, appendJournalOrThrow } from './clone-tools-common.js';

// `LIST_BUDGET` / `RUNNER_LIST_BUDGET` を使い回さない: 同じ理由
const PRACTICE_LIST_BUDGET = 8_000;

// 下限・上限の数値を書き写さない: 2箇所に手で書くと片方だけ直して食い違うため `practiceKindSchema` を検査・説明文の両方から参照する
export function formatPracticeKindRangeJa(): string {
  return formatStringLengthJa({
    min: practiceKindSchema.minLength ?? undefined,
    max: practiceKindSchema.maxLength ?? undefined,
  });
}

function describePracticeKindViolation(
  value: string | undefined,
  field: string = 'kind',
): string | null {
  if (value === undefined) return null;
  if (practiceKindSchema.safeParse(value).success) return null;
  if (value.length > 0 && stripNul(value).length === 0) {
    return `${field} は使えない（NUL（\\u0000）だけの値は空と同じ。${formatPracticeKindRangeJa()}のみ）。`;
  }
  return `${field} は使えない（${formatPracticeKindRangeJa()}のみ）。`;
}

function practiceVersionLine(practice: Pick<Practice, 'kind' | 'title' | 'content'>): string {
  return `（版 base_version=${practiceVersion(practice)} ——このやり方を全文で書き直す practice_write と、消す practice_remove には、これを base_version に渡すこと）`;
}

function describePracticeConflict(
  slug: string,
  action: string,
  current: Pick<Practice, 'kind' | 'title' | 'content'> | null,
  kind: 'write' | 'remove' = 'write',
): string {
  const now =
    current === null
      ? 'いまそのやり方は無い（読んだ後に消された）。'
      : `いまの版は base_version=${practiceVersion(current)}（${current.content.length} 文字）。`;
  if (kind === 'remove') {
    return (
      `やり方 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**しなかった**。` +
      `${now}**何も消していない**（読んでいない内容を消さないため。いまの内容は1文字も変わっていない）。` +
      `practice_read slug=${slug} で読み直し、いまの内容でも消してよいか判断し直してから、` +
      '読み直した版の base_version を付けて practice_remove し直すこと。'
    );
  }
  return (
    `やり方 ${slug} は、読んだ後にその間に変わった（人間または別のターンが書いた）ので、${action}を**書かなかった**。` +
    `${now}**何も書いていない**（あなたの内容は書かれておらず、いまの内容は1文字も変わっていない）。` +
    `practice_read slug=${slug} で読み直し、いまの内容に対してやりたいことが変わらないか判断し直してから、` +
    '読み直した版の base_version を付けて書き直すこと。'
  );
}

export function practiceTools(_context: ToolContext, shared: CloneToolsShared) {
  const { stores } = shared;
  return [
    // `practice_apply` / `practice_enforce` を足さない: 従わせた時点でクローンは「制限された自動化ジョブ」に戻り、やり方は読む素材で実行される定義ではないため
    tool(
      'practice_list',
      [
        '仕事のやり方の一覧を返す（本文は返さない。slug・種類・題・文字数・作成/更新時刻だけ）。',
        'やり方はあなたが読んで従うかどうかを毎回自分で決める素材であって、実行される定義ではない',
        '（従わせる道具はここには無い）。',
        '**読めない行が無いのにやり方が1件も無いのは正常な状態である。** やり方が書かれていない仕事も普通に進む——',
        '空を「まだ設定されていない」という異常として読まないこと。',
        '読めない行が在るときは、応答の末尾にその件数と slug が出る（壊れた行であって、消されたやり方ではない）。',
        '中身が要るなら practice_read slug=<slug> で開くこと。',
      ].join(' '),
      {},
      async () => {
        const { entries, unreadable } = await stores.practices.list();
        // 読めない行は予算の外に別に言う: 一覧が溢れても「壊れた行が在る」は必ず届けるため
        const unreadableNote = describeUnreadablePractices(unreadable);
        // 空は正常と言う: 異常や未設定であるかのような文言を出さない。ただし「無い」と言えるのは読めない行が0件のときだけ
        if (entries.length === 0) {
          if (unreadableNote !== null) {
            return text(
              `（読めたやり方は無い）${unreadableNote}` +
                '**やり方が無いとも、正常だとも言えない。**' +
                'slug が分かる行は、practice_write で同じ slug を書き直すか practice_remove で外せる。',
            );
          }
          return text(
            'やり方はまだ1件も無い。**これは正常な状態である**——やり方が書かれていない' +
              '仕事も普通に進む。書くなら practice_write slug=<slug> kind=<種類> title=<題> content=<本文>。',
          );
        }
        const items = entries.map((entry) =>
          renderListingEntry({
            id: entry.slug,
            title: `[${entry.kind}] ${entry.title}`,
            summary: `${String(entry.chars)} 文字`,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          }),
        );
        const listing = renderListing(items, {
          budget: PRACTICE_LIST_BUDGET,
          omitted: ({ rest, shown, total }) =>
            // 続きを取る口が無いので、無いと正直に言う: 口が無いまま断り書きだけ出すと、落ちた分へ呼び手が到達できないため
            `…ほか ${String(rest)} 件は省略（全 ${String(total)} 件のうち slug の昇順に ${String(shown)} 件だけ出した）。` +
            'この一覧に続きを取る口はまだ無い——個別に読むには practice_read slug=<slug> を使うこと。',
        });
        return text(unreadableNote === null ? listing : `${listing}\n\n${unreadableNote}`);
      },
    ),

    tool(
      'practice_read',
      [
        '仕事のやり方を1件、本文まで読む。無ければ、その旨を返す（例外で落とさない）。',
        'version を指定すると、いまの本文ではなく過去の版（practice_history に出ている version）を',
        '読む——version を省く既定は、いまのやり方（全文置換の最新の姿）を読む。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
        version: z
          .number()
          .optional()
          .describe(
            `省略時はいまの本文。指定すると practice_history にある過去の版を読む（${formatIntRangeJa({ min: 1 })}）`,
          ),
      },
      async ({ slug, version }) => {
        // 不正なスラッグはここで断る: 無いと pg は生の例外を投げ、fs / インメモリは「無い」として扱い、器によって結果が違ってしまうため
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const versionError = describeIntRangeViolation('version', version, { min: 1 });
        if (versionError !== null) return text(versionError);
        if (version !== undefined) {
          // 読めない行は理由の分かる文に変える: `isError` と生の Zod issue より読み手に親切なため
          let found: Awaited<ReturnType<typeof stores.practices.readVersion>>;
          try {
            found = await stores.practices.readVersion(slug, version);
          } catch (error) {
            if (!(error instanceof UnreadablePracticeError)) throw error;
            return text(
              `やり方 ${slug} の版 ${String(version)} は読めない形で入っている` +
                '（消されたのではない）。本文はここでは取れない。',
            );
          }
          if (found === null) {
            return text(
              `やり方 ${slug} の版 ${String(version)} は無い。` +
                'practice_history slug=<slug> で在る版を確かめること。',
            );
          }
          return text(
            [
              `${found.slug} 版${String(found.version)}（${found.kind}） ${found.title}`,
              `この版が書かれた時刻: ${found.at} / ${String(found.chars)} 文字`,
              '',
              found.content,
            ].join('\n'),
          );
        }
        let found: Awaited<ReturnType<typeof stores.practices.read>>;
        try {
          found = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          return text(
            `やり方 ${slug} は読めない形で入っている（消されたのではない）。` +
              '本文はここでは取れない。書き直すなら practice_write、外すなら practice_remove。',
          );
        }
        if (found === null) {
          return text(
            `やり方 ${slug} は無い。practice_list で在るものを確かめるか、` +
              'practice_write で新しく書けること。',
          );
        }
        return text(
          [
            `${found.slug}（${found.kind}） ${found.title}`,
            `作成: ${found.createdAt} / 更新: ${found.updatedAt} / ${String(found.chars)} 文字`,
            '',
            found.content,
            '',
            practiceVersionLine(found),
          ].join('\n'),
        );
      },
    ),

    tool(
      'practice_history',
      [
        'やり方1件の、追記専用の版の履歴を返す（本文は返さない。版番号・種類・題・',
        '文字数・書かれた時刻だけ）。',
        '**write のたびに版が1つ増える。remove しても版は消えない**——消した slug を',
        '同じ名前で作り直しても、版番号は消える前の続きから振られる。',
        '中身が要るなら practice_read slug=<slug> version=<版番号> で開くこと。',
        '各版は作成時刻だけを出す（版は追記専用なので、更新はいつも作成と同じ）。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
      },
      async ({ slug }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        const versions = await stores.practices.listVersions(slug);
        if (versions.length === 0) {
          return text(
            `やり方 ${slug} の版は無い。practice_write で一度も書かれていない` +
              '（または slug を打ち間違えている）可能性がある。',
          );
        }
        const items = versions.map((entry) =>
          renderListingEntry({
            id: `版${String(entry.version)}`,
            title: `[${entry.kind}] ${entry.title}`,
            summary: `${String(entry.chars)} 文字`,
            createdAt: entry.at,
            // 更新は出さない: 版は追記専用で、書かれた時刻が作成でも更新でもあるため（同じ値の2回目を積まない）
          }),
        );
        return text(
          renderListing(items, {
            budget: PRACTICE_LIST_BUDGET,
            omitted: ({ rest, shown, total }) =>
              `…ほか ${String(rest)} 件は省略（全 ${String(total)} 件のうち版番号の昇順に ` +
              `${String(shown)} 件だけ出した）。個別に読むには practice_read slug=${slug} ` +
              'version=<版番号> を使うこと。',
          }),
        );
      },
    ),

    tool(
      'practice_write',
      [
        '仕事のやり方を書く（全文置換。無ければ作る）。',
        'kind は仕事の種類（実装・調査・相談・レビュー・日報・外部サービスの確認…）を自由文字列で書く',
        '（**列挙ではない**。知らない種類のやり方を弾かない。表記ゆれは束ねる側の負担として引き受ける）。',
        'これは実行される定義ではない——読んで従うかどうかは、そのときのあなたが決める' +
          '（従わせる道具はここには無い）。人間もこの3入口のどこからでも同じものを読み書きできる。',
        '本文の末尾改行は正規化される（無ければ足す。既に在れば増やさない）。',
        '**既存のやり方を書き換えるときは、先に practice_read で読んで、応答に出る base_version を渡すこと。焼き込みの索引だけでは書けない**（版が無ければ何も書かずに断る。読んだ後に人間や別のターンが書いていたら、何も書かずに「その間に変わった」と返す。読み直して判断し直すこと）。**新規作成は版なしで通る。**',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（英小文字・数字・. _ - のみ）'),
        kind: z.string().describe('仕事の種類（自由文字列。例: 実装・調査・相談・レビュー・日報）'),
        title: z.string().describe('一覧で見る短い題'),
        content: z.string().describe('本文（人間もこのまま読む。Markdown を想定）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（practice_read / 直前の practice_write の応答に出る base_version）。' +
              '**既存のやり方を書き換えるときは必須**。',
          ),
      },
      async ({ slug, kind, title, content, base_version: baseVersion }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        // `kind` も書く前に見る: 見ないと保存層の `parse` が生の ZodError を投げ、そのままクローンへ返るため
        const kindError = describePracticeKindViolation(kind);
        if (kindError !== null) return text(kindError);
        // `UnreadablePracticeError` だけを捕まえて「在ったが読めない」として先へ進む: 投げっぱなしだと `write()` まで届かず、壊れた行を書き直す唯一の回復手段が塞がるため
        let before: Practice | null;
        let beforeWasUnreadable = false;
        try {
          before = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          before = null;
          beforeWasUnreadable = true;
        }
        // 読めない形で入っていた行だけ版の前提なしで通す: 版が無く、書き直しの回復手段を塞がないため
        if (before !== null && baseVersion === undefined) {
          return text(
            `やり方 ${slug} は既に在る。全文を書き直すには、先に practice_read slug=${slug} で読み、` +
              '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
              '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは書けない）。**何も書いていない。**',
          );
        }
        let written;
        try {
          written = await stores.practices.write(
            { slug, kind, title, content },
            beforeWasUnreadable
              ? undefined
              : { ifMatch: before === null ? (baseVersion ?? null) : baseVersion! },
          );
        } catch (error) {
          if (error instanceof PracticeConflictError) {
            return text(describePracticeConflict(slug, '書き直し', error.current));
          }
          throw error;
        }
        await appendJournalOrThrow(
          'practice_write',
          stores.journal,
          {
            type: 'decision',
            decision: beforeWasUnreadable
              ? `読めない形で入っていたやり方 ${slug}（${kind}）を書き直した: ${title}`
              : `やり方 ${slug}（${kind}）を${before === null ? '作った' : '書き直した'}: ${title}`,
            grounds: beforeWasUnreadable
              ? '読めない形で入っていたやり方を書き直した（全文置換。前の本文は読めなかった' +
                'ため分からない。版の履歴には今回の内容だけが新しい版として積まれる）'
              : before === null
                ? '新しいやり方を器に置いた'
                : 'やり方を書き直した（全文置換。いまの本文の読み口は最新の1本だが、' +
                  '前の本文は版の履歴（practice_history）に残る）',
            target: { kind: 'practice', slug },
          },
          'act-completed',
        );
        return text(
          `やり方 ${slug} を${
            beforeWasUnreadable
              ? '（読めない形で入っていたやり方を）書き直した'
              : before === null
                ? '新しく作った'
                : '書き直した'
          }` +
            `（${String(written.chars)} 文字。前の版は practice_history slug=${slug} で読める）。` +
            'practice_list で一覧に出る。' +
            ((note) => (note === null ? '' : `\n${note}`))(
              describeTokenDiff(before === null ? null : before.content, content),
            ) +
            `\n\n${practiceVersionLine(written)}`,
        );
      },
    ),

    tool(
      'practice_remove',
      [
        '仕事のやり方を1件消す。',
        '**無い slug を指定しても失敗しない（冪等）**——その場合は何もしていないとだけ返す。',
        '**既存のやり方を消すときは、先に practice_read で読んで、応答に出る base_version を渡すこと（必須）。焼き込みの索引だけでは消せない**——版が無ければ何も消さずに断る。読んだ後に人間や別のターンが書いていたら、何も消さずに「その間に変わった」と返す（読んでいない内容まで消さないため）。',
      ].join(' '),
      {
        slug: z.string().describe('やり方のスラッグ（practice_list に出ている slug）'),
        base_version: z
          .string()
          .optional()
          .describe(
            '読んだ時点の版（practice_read / 直前の practice_write の応答に出る base_version）。**必須**。',
          ),
      },
      async ({ slug, base_version: baseVersion }) => {
        if (!practiceSlugSchema.safeParse(slug).success) {
          return text(`やり方のスラッグが不正: ${slug}（英小文字・数字・. _ - のみ）。`);
        }
        // `UnreadablePracticeError` だけを捕まえて「在ったが読めない」として先へ進む: 投げっぱなしだと `remove()` まで届かず、壊れた行を消す唯一の回復手段が塞がるため
        let before: Practice | null;
        let wasUnreadable = false;
        try {
          before = await stores.practices.read(slug);
        } catch (error) {
          if (!(error instanceof UnreadablePracticeError)) throw error;
          before = null;
          wasUnreadable = true;
        }
        // 無かったときは日誌を書かない: 何も起きていないのに「消した」という判断の跡を残すと日誌が実際の変化と食い違うため。「読めなかった」は「無かった」ではない
        if (before === null && !wasUnreadable) {
          return text(`やり方 ${slug} はもともと無かった（何もしていない）。`);
        }
        // 読めない形の行には版が無いので前提なしで消せる: 回復手段を塞がないため
        if (before !== null) {
          if (baseVersion === undefined) {
            return text(
              `やり方 ${slug} を消すには、先に practice_read slug=${slug} で読み、` +
                '応答に出る base_version をこの呼び出しの base_version に渡すこと' +
                '（読んだ後に人間や別のターンが書いた内容を、気づかずに消さないため。焼き込みの索引だけでは消せない）。**何も消していない。**',
            );
          }
        }
        try {
          await stores.practices.remove(
            slug,
            before === null ? undefined : { ifMatch: baseVersion },
          );
        } catch (error) {
          if (error instanceof PracticeConflictError) {
            return text(describePracticeConflict(slug, '削除', error.current, 'remove'));
          }
          throw error;
        }
        if (before !== null) {
          await appendJournalOrThrow(
            'practice_remove',
            stores.journal,
            {
              type: 'decision',
              decision: `やり方 ${slug}（${before.kind}）を消した: ${before.title}`,
              grounds: '不要になったと判断した',
              target: { kind: 'practice', slug },
            },
            'act-completed',
          );
          return text(`やり方 ${slug} を消した。`);
        }
        await appendJournalOrThrow(
          'practice_remove',
          stores.journal,
          {
            type: 'decision',
            decision: `読めない形で入っていたやり方 ${slug} を消した`,
            grounds: '読めない形で入っていたやり方を外した',
            target: { kind: 'practice', slug },
          },
          'act-completed',
        );
        return text(`読めない形で入っていたやり方 ${slug} を消した。`);
      },
    ),
  ];
}
