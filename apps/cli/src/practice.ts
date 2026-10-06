import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';
import { stderr, stdout, writeShownBody } from './terminal-out.js';

import { createClient, type DaemonClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { keepDraftOnFailure, openEditor, readInputFile } from './input-errors.js';

/**
 * `alteroid practice` — 仕事のやり方を読む・書き換える・消す（#1055 段3③）。
 *
 * **`alteroid memory`（`memory.ts`）が型紙である。** サブコマンドの構成
 * （`list` / `show` / `edit` / `set` / `remove`）はそちらに揃えてある。
 *
 * **やり方に無い概念は写さない。**
 * - `PracticeStore` は human guard（`memory` の `markHumanTouched` に当たる
 *   保護状態）を持たない（`packages/core/src/store.ts` の `PracticeStore` の
 *   doc）。ここには対応する概念が無い
 * - `kind`（frontmatter の種別 `premise`/`fact`/`indexed` に相当するもの）は
 *   `practiceKindSchema` が自由文字列で、列挙ではない（`practiceKindSchema`
 *   の doc「⛔ ここを `z.enum` にしないこと」）。CLI でも固定の選択肢にしない
 *   — Web UI（`apps/web/app/routes/practice-detail.tsx`）で `<select>` を
 *   置かなかったのと同じ理由
 * - **`kind` / `title` はやり方の本体（`content`）とは別の必須フィールドで
 *   ある。** `PracticeStore.write` は `slug`/`kind`/`title`/`content` の
 *   全文置換で、`content` だけの部分更新は無い（`memory` の `PUT` が
 *   `{content}` だけで足りるのとの違い）。`set`/`edit` は `--kind`/`--title`
 *   を受け、既存のやり方を編集するときは省略すると現在の値を引き継ぐ
 *
 * **`apply` / `enforce` に当たるサブコマンドは無い。** やり方は読む素材で
 * あって実行される定義ではない（`docs/north_star.md`、段3②・#1316 と同じ
 * 設計）。
 *
 * **CLI 専用の HTTP 経路は無い。** #1316 で足した `GET`/`PUT`/`DELETE
 * /practices(/:slug)` にそのまま乗る（`docs/PRD.md`「Web UI は API の
 * 特権的な消費者ではない」と同じ理由が CLI にも効く——CLI もデーモンの
 * HTTP API の薄いクライアントに徹する）。
 *
 * **版の履歴（#1309）も同じ形。** `GET /practices/:slug/versions(/:version)`
 * にそのまま乗る——`history` サブコマンドと、`show --version` オプションで出す。
 */

/** 一覧に出す1件（`GET /practices` の要素）。 */
export interface PracticeSummary {
  slug: string;
  kind: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 本文の文字数（コードポイント数。保存された値ではなく本文から導出——#1340）。 */
  chars: number;
}

export async function practiceListCommand(): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.practices.$get();
  if (!response.ok) {
    // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#3452。`read` と同じ）。
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方の一覧を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const { practices, unreadable = [] } = (await response.json()) as {
    practices: PracticeSummary[];
    /** 読めなかった行（issue #2346）。1件でも在るときだけ載る。 */
    unreadable?: { slug?: string; reason: string }[];
  };
  if (practices.length === 0 && unreadable.length === 0) {
    // **「0 件」で終わらせない。** `memory list` と同じ理由——空なのか
    // 読めていないのかを、次の一手が無いと人間の側から区別できない。
    // **ただしここは異常ではない。** やり方が1件も無いのは正常な状態
    // （`practice_list` クローンの道具の文言と同じ語彙）。**「正常」と言えるのは、
    // 読めない行が0件のときだけ**（issue #2346。下の断りを見よ）。
    stdout.write('やり方はまだ1件も無い（これは正常な状態）。\n');
    stdout.write('置くには: alteroid practice edit <slug> --kind <種類> --title <題>\n');
    return;
  }
  if (practices.length === 0) {
    stdout.write('読めたやり方は無い（無いとも、正常だとも言えない。読めない行が在る——下）。\n');
  }
  for (const p of practices) {
    stdout.write(
      `  [${p.kind}] ${p.slug}  — ${p.title}` +
        ` (作成: ${p.createdAt} / 更新: ${p.updatedAt} / ${String(p.chars)} 文字)\n`,
    );
  }
  // **読めない行は末尾で言う**（issue #2346）。0件なら何も出さない。題・本文は出ない
  // （デーモンが返さない）。slug が取れた行は書き直す（`practice edit`）か消せる。
  if (unreadable.length > 0) {
    stdout.write(
      `読めないやり方が ${String(unreadable.length)} 件ある（消えたのではなく、読めない形で入っている）。` +
        'この一覧には載っていない:\n',
    );
    for (const row of unreadable) {
      stdout.write(`  ${row.slug ?? '（slug も取れない）'}  ${row.reason}\n`);
    }
    stdout.write(
      'slug が分かる行は、alteroid practice edit <slug> で書き直すか、' +
        'alteroid practice remove <slug> で外せる。\n',
    );
  }
  // **一覧から次の一手へつなぐ。** `memory list` と同じ（`memoryListCommand` の doc）。
  if (practices.length > 0) stdout.write('本文を読むには: alteroid practice show <slug>\n');
}

export async function practiceShowCommand(
  slug: string,
  options: { version?: number } = {},
): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;

  if (options.version !== undefined) {
    const response = await client.practices[':slug'].versions[':version'].$get({
      param: { slug, version: String(options.version) },
    });
    if (!response.ok) {
      // 「無い」は 404 だけ。5xx 等を「そんな版はありません」と言わない。
      // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#3452）。
      if (response.status === 400) {
        throw new Error(`版番号として成立しません: ${String(options.version)}`);
      }
      if (response.status === 404) {
        throw new Error(`そんな版はありません: ${slug} 版${String(options.version)}`);
      }
      const described = describeAuthFailure(response.status, target);
      if (described !== null) throw new Error(described);
      throw new Error(
        await withErrorReason(
          `版を読めませんでした: ${slug} 版${String(options.version)}（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
    const body = await response.json();
    const content = 'version' in body ? body.version.content : '';
    stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const found = await read(client, conn.target, slug);
  if (found === null) {
    throw new Error(`そんなやり方はありません: ${slug}`);
  }
  const content = found.content;
  writeShownBody(stdout, content.endsWith('\n') ? content : `${content}\n`);
  // **版は stderr へ1行（Issue #2984。`memory show` と同じ）。** stdout は本文をそのまま出す口で、
  // パイプやリダイレクトで使う人がいる（版を混ぜると本文が壊れる）。端末では両方見える。
  // 古いデーモンが `version` を返さなければ出す版が無い。
  if (found.version !== undefined) {
    stderr.write(
      `版: ${found.version}（読んだ版を前提に消すなら: alteroid practice remove ${slug} --if-match ${found.version}）\n`,
    );
  }
}

/**
 * やり方の版の履歴を出す（#1309）。**メタだけ**——本文は
 * `alteroid practice show <slug> --version <n>` で読む。
 */
export async function practiceHistoryCommand(slug: string): Promise<void> {
  const conn = await connect('read');
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.practices[':slug'].versions.$get({ param: { slug } });
  if (!response.ok) {
    // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#3452）。
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `版の履歴を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const { versions } = (await response.json()) as {
    versions: Array<{ version: number; kind: string; title: string; at: string; chars: number }>;
  };
  if (versions.length === 0) {
    stdout.write(`やり方 ${slug} の版はまだ無い（一度も書かれていないか、打ち間違い）。\n`);
    return;
  }
  for (const v of versions) {
    stdout.write(
      `  版${String(v.version)} [${v.kind}] ${v.title} (${v.at} / ${String(v.chars)} 文字)\n`,
    );
  }
  stdout.write(`本文は: alteroid practice show ${slug} --version <版番号>\n`);
}

/**
 * `$EDITOR` で本文を開いて、閉じたら反映する。
 *
 * **無い slug でも開ける**（`memory edit` と同じ——`PUT` は全文置換で、
 * 存在しない slug でも作られる）。**`--kind`/`--title` は省略できる**が、
 * 意味は状況で変わる——既存のやり方なら現在の値を引き継ぎ、新しいやり方
 * なら両方とも必須（`practiceKindSchema` が `kind` に `min(1)` を課す
 * ので、省略したまま新規作成しようとすると人間に分かる形で断る）。
 */
export async function practiceEditCommand(
  slug: string,
  options: { kind?: string; title?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const current = await read(client, target, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    throw new Error(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice edit <slug> --kind <種類> --title <題>',
    );
  }

  // **読んだ時の版を持ち回る（Issue #2853。`memory edit` と同じ）。** エディタを開いている間に
  // クローンが同じやり方へ書くと、版が変わっていて 409 になる（黙って上書きしない）。無い slug は
  // `null`（「読んだ時には無かった」）。古いデーモンが `version` を返さなければ前提なしで書く。
  const ifMatch = current === null ? null : current.version;
  const dir = await mkdtemp(join(tmpdir(), 'alteroid-practice-'));
  const path = join(dir, `${slug}.md`);
  try {
    await writeFile(path, current?.content ?? template(slug), 'utf8');
    await openEditor(path, 'alteroid practice set <slug> --file <path>');
  } catch (error) {
    // まだ人間は何も書いていない（エディタが起きなかった・異常終了した）。
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  // **成功したときと「変更なし」のときだけ、一時ディレクトリを消す。** 保存の失敗（衝突以外も）は
  // 人間が書いた内容を残し、場所と続きのやり方を言う（#3453）。衝突は下で自分で案内する。
  // 種類と題は、いまと違う（新しいやり方や --kind / --title を渡した）ときだけ `set` へ持ち越す。
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const resume = [
    `alteroid practice set ${slug} --file ${path}`,
    ...(kind === current?.kind ? [] : [`--kind ${shellQuote(kind)}`]),
    ...(title === current?.title ? [] : [`--title ${shellQuote(title)}`]),
  ].join(' ');
  await keepDraftOnFailure(dir, path, resume, async (keep) => {
    const edited = await readFile(path, 'utf8');

    if (
      current !== null &&
      edited === current.content &&
      kind === current.kind &&
      title === current.title
    ) {
      // **書き換えていないなら書き込まない**（`memory edit` と同じ理由——
      // 同じ内容でも `PUT` は日誌へ `decision` を積むので、押し戻すたびに
      // 「人間が書き換えた」という跡が実際には無かった変更ぶん増える）。
      stdout.write('変更はありません。\n');
      return;
    }
    try {
      await write(client, target, slug, kind, title, edited, ifMatch);
    } catch (error) {
      if (!(error instanceof PracticeConflictCliError)) throw error;
      // **人間が書いた内容を失わない。** 消さずに残し、いまの版も隣へ置いて、見比べる道具と次の手を案内する。
      keep();
      const theirs = join(dir, `${slug}.current.md`);
      if (error.current !== null) await writeFile(theirs, error.current.content, 'utf8');
      stdout.write(
        [
          `書き換えていません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、消されました）。`,
          `  あなたの編集（残してあります）: ${path}`,
          error.current === null
            ? '  いまのやり方: 無い（消されています）'
            : `  いまのやり方: ${theirs}`,
          ...(error.current === null ? [] : [`  見比べる: diff -u ${theirs} ${path}`]),
          `  取り込んだら \`alteroid practice edit ${slug}\` で開き直して直してください。`,
          `  そのまま置き換えてよいなら \`alteroid practice set ${slug} --file ${path}\`（先の書き込みを消します）。`,
          '',
        ].join('\n'),
      );
      throw new Error(`やり方が読んだ後に変わっていたので書き換えませんでした: ${slug}`, {
        cause: error,
      });
    }
  });
}

/**
 * ファイル（または標準入力）の内容で丸ごと置き換える。
 *
 * **`--kind`/`--title` の省略時は既存の値を引き継ぐ**（`edit` と同じ規則）。
 * 新規作成では両方必須。
 */
export async function practiceSetCommand(
  slug: string,
  options: { file?: string; kind?: string; title?: string; allowEmpty?: boolean } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const current = await read(client, target, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    throw new Error(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice set <slug> --kind <種類> --title <題>',
    );
  }

  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
  // 空の本文は通信の前に断る（#3456。`memory set`・`profile set` と同じ線）。空にしたい人だけ `--allow-empty`。
  if (options.allowEmpty !== true && content.trim().length === 0) {
    throw new Error(
      `やり方 ${slug}: 本文が空なので置き換えません（既存の本文は変えていません）。` +
        '空にしたいときだけ --allow-empty を付けてください。',
    );
  }
  await write(client, target, slug, kind, title, content);
}

/**
 * やり方を1つ消す。
 *
 * **確認を求めない（Issue #3141 で、戻せるかを見直したうえで残した）。** `memory remove` と違い、
 * やり方は**版の履歴が消した後も残る**（`PracticeStore.remove` の doc、#1309）ので、
 * `practice history <slug>` と `practice show <slug> --version <n>` で本文を読み、
 * `practice set` で作り直せる。戻せない操作にだけ確認を足す方針（`confirm.ts`）なので、ここには足さない。
 * 消した事実は日誌に残る。
 *
 * **経緯: かつての理由は「Web UI に確認の段が無く、CLI にだけ `--yes` を要求すると
 * 『CLI だけができないこと』を作る」だった。** Web が確認を挟んだ今、その理由は偽であり、
 * 確認を省く根拠は「履歴から戻せる」に置き換えた。**履歴ごと消える`reset` は別で、確認がある。**
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** `memory.ts` の
 * `memoryRemoveCommand` と同じ理由（#1621 / #1641）。
 *
 * **「無い」と「名前として不正」は、サーバが 404 と 400 で分けているものを
 * そのまま伝える。それ以外（401/403/5xx）を、この2つのどちらかだと取り違え
 * ない**——以前はここが「400 以外は全部『無い』」という形をしていたため、
 * 認証切れやサーバの内部エラーでも「そんなやり方はありません」と誤案内して
 * いた。
 *
 * **読んだ版を持ち回る（Issue #2959。`memory remove` の #2881 と同じ取り方）。** 消す直前に
 * `GET /practices/<slug>` で読み、その `version` を `DELETE` の `ifMatch` に付ける。
 * 読んだ後に別の書き手（クローンなど）が書いていたら、デーモンは**消さずに** 409 を返す。
 * そのときは消さずに、いまの版と次の手（`practice show` で確かめてから再実行）を案内して失敗で終わる。
 * 古いデーモン（#2959 より前。`version` を返さない）には前提なしで打つ——その段階のデーモンは
 * 版なしの削除を通す。**版必須のデーモン（段階2）は 428 で断る**ので、そのときは消していないと
 * 言って失敗する（`--if-match` で版を渡せば通る）。
 * **読んで無かった（404 / 400）ときも版なしで DELETE を打つ**——「無い」と「名前が不正」の
 * 切り分けはサーバが持つので、ここで再実装しない。**読めない形で入っている行（GET が 409）も
 * 版なしで DELETE を打つ**——版が無いので前提を付けようがなく、ここで止めると壊れた行を外す
 * 回復手段が塞がる（`practice show` と違い、この口は 409 を失敗にしない）。
 * **`--if-match <版>`（Issue #2984）を渡すと、読み直さずにその版だけで照合する**——`practice show` が
 * stderr に出した版を渡せば、「見て決めた内容」を前提に消せる（`memory remove` と同じ）。
 */
export async function practiceRemoveCommand(
  slug: string,
  options: { ifMatch?: string } = {},
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  // **`--if-match` があれば、それだけで照合する**（Issue #2984）。人間が判断の根拠にしたのは
  // `practice show` で読んだ内容なので、消す直前に読み直した版へ差し替えない。
  // 無ければ、消す直前に読んだ版を前提にする（上の段落）。
  const ifMatch = options.ifMatch ?? (await readVersionForRemove(client, target, slug));
  const response = await client.practices[':slug'].$delete({
    param: { slug },
    query: ifMatch === undefined ? {} : { ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { practice?: { content?: string }; version?: string } | null;
    };
    const current = body.current ?? null;
    stdout.write(
      [
        `消していません: ${slug} は、あなたが読んだ後に変わっています（クローンなど別の書き手が書いたか、すでに消されました）。`,
        current === null
          ? '  いまのやり方: 無い（すでに消されています）'
          : `  いまのやり方の版: ${current.version ?? '（不明）'}（${String(current.practice?.content?.length ?? 0)} 文字）`,
        ...(current === null
          ? []
          : [
              `  いまの内容を読み直す: \`alteroid practice show ${slug}\`（版そのものは GET /practices/${slug} の version）`,
              `  確かめたうえで消してよければ、もう一度 \`alteroid practice remove ${slug}\`（いまの版を読み直して消します）。`,
            ]),
        '',
      ].join('\n'),
    );
    throw new Error(`やり方が読んだ後に変わっていたので消しませんでした: ${slug}`);
  }
  if (response.status === 428) {
    // 版必須のデーモンが、版なしの削除を断った（何も消していない）。通常は上で読んだ版を付けるので、
    // 読んだ応答に version が無かったときだけ当たる。
    throw new Error(
      await withErrorReason(
        `消していません: ${slug}（HTTP 428。このデーモンは削除に読んだ版を必須としています。` +
          `\`alteroid practice show ${slug}\` で版を確かめ、\`alteroid practice remove ${slug} --if-match <版>\` で打ち直してください）`,
        response,
      ),
    );
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(`やり方の名前として成立しません: ${slug}`);
    }
    if (response.status === 404) {
      throw new Error(`そんなやり方はありません: ${slug}`);
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を消せませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`消しました: ${slug}\n`);
}

/**
 * 消す直前に読んだ版。無い（404）・名前が不正（400）・読めない形で入っている（409）・古いデーモンが
 * `version` を返さないときは `undefined`（版なしで DELETE を打ち、サーバに判断させる）。
 * それ以外の失敗（401/403/5xx）は `read` と同じく例外で上へ通す。
 */
async function readVersionForRemove(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<string | undefined> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400 || response.status === 409) {
    return undefined;
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  return 'version' in body && typeof body.version === 'string' ? body.version : undefined;
}

/**
 * **`target` も一緒に返す。** 書き込み系（`write` / `practiceRemoveCommand`）
 * が HTTP の失敗を `describeAuthFailure` で判定するのに要る（#1641。
 * `memory.ts` の `connect` と同じ理由）。
 *
 * **`access: 'write'` のときは、未ログインの note を例外にする**（#2456、クローン
 * teto の判断 2026-09-30。`memory.ts` の `connect` と同じ）。読み取り系（`'read'`）は
 * 今のまま、note を stdout に出して `null` を返す。
 */
async function connect(
  access: 'read' | 'write',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}

/**
 * 無ければ `null`。**`null` は「無い」（404）と「名前が成立しない」（400）だけである。**
 * それ以外の失敗（401/403/5xx）を `null` にすると、`show` は「そんなやり方はありません」と
 * 嘘を言い、`edit` / `set` は**読めていないだけの既存のやり方を無いものとして**扱う
 * （`memory.ts` の `read` と同じ理由）。読めなかった理由は例外で上へ通す。
 */
async function read(
  client: DaemonClient,
  target: Target,
  slug: string,
): Promise<{ kind: string; title: string; content: string; version?: string } | null> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `やり方を読めませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const body = await response.json();
  if (!('practice' in body)) return null;
  return {
    kind: body.practice.kind,
    title: body.practice.title,
    content: body.practice.content,
    // 古いデーモンは `version` を返さない（その場合は前提なし＝従来どおり後勝ちで書く）。
    ...('version' in body && typeof body.version === 'string' ? { version: body.version } : {}),
  };
}

/** `PUT` が 409（読んだ後に変わっていた。Issue #2853）を返した。`current` はいまの本文（消えていれば null）。 */
class PracticeConflictCliError extends Error {
  readonly current: { kind: string; title: string; content: string } | null;
  constructor(slug: string, current: { kind: string; title: string; content: string } | null) {
    super(`やり方が読んだ後に変わっています: ${slug}`);
    this.current = current;
  }
}

/**
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** `memory.ts` の
 * `write` と同じ理由（#1641）。
 *
 * **400 は「種類・題・スラッグのどれかが不正」の意味を保つ**（サーバの
 * `practiceSlugSchema` / `practiceKindSchema` 検証。`PUT /practices/:slug`
 * が返す唯一の明示的な失敗コード）。**それ以外（401/403/5xx）を、それだと
 * 取り違えない。**
 */
async function write(
  client: DaemonClient,
  target: Target,
  slug: string,
  kind: string,
  title: string,
  content: string,
  ifMatch?: string | null,
): Promise<void> {
  const response = await client.practices[':slug'].$put({
    param: { slug },
    json: ifMatch === undefined ? { kind, title, content } : { kind, title, content, ifMatch },
  });
  if (response.status === 409) {
    const body = (await response.json()) as {
      current?: { practice?: { kind?: string; title?: string; content?: string } } | null;
    };
    const now = body.current?.practice;
    throw new PracticeConflictCliError(
      slug,
      now === undefined
        ? null
        : { kind: now.kind ?? '', title: now.title ?? '', content: now.content ?? '' },
    );
  }
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(
        `書き換えられませんでした: ${slug}（種類・題・スラッグのどれかが不正かもしれません）`,
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `書き換えられませんでした: ${slug}（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  stdout.write(`書き換えました: ${slug}\n`);
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 空から始めるときの雛形。
 *
 * **「何をしてよいかの表」を書かせない**（`memory` の `template` と同じ
 * 理由——`permissions.yaml` 的な一覧にしない、AGENTS.md 地雷表3行目）。
 */
function template(slug: string): string {
  return `# ${slug}

（ここに仕事のやり方を書きます。これは実行される定義ではなく、読んで
従うかどうかはそのときのクローンが決めます）
`;
}
