import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeEditConflict,
  keepDraftOnFailure,
  openEditorKeepingEdits,
} from './input-errors.js';
import { stdout } from './terminal-out.js';

/** 保存の段（`save`）が受け取る、一時ファイルの場所と「残す」の合図。 */
export interface EditDraft {
  dir: string;
  path: string;
  /** 失敗しても下書きを消さずに残す（案内は `keepDraftOnFailure` が出す） */
  keep: () => void;
}

// `memory edit` と `practice edit` に共通の骨格:
// 一時ファイルに書く → エディタで開く → 読み直す → 変わっていなければ何もしない → 空なら断る → 送る。
// どの段で落ちても、人間が書いた内容は残す（`openEditorKeepingEdits` と `keepDraftOnFailure`）。
// サービスごとに違う所（雛形・変更なしの判定・空の案内・送り先・衝突の扱い）は呼び手が渡す。
export async function runEditSession(options: {
  /** 一時ディレクトリの名前の頭（`alteroid-memory-` など） */
  dirPrefix: string;
  /** 一時ファイルの名前（`<slug>.md` など） */
  fileName: string;
  /** エディタで最初に開く中身 */
  initial: string;
  /** 下書きを残したときに案内する、打ち直しのコマンド（一時ファイルの場所から作る） */
  resume: (path: string) => string;
  alternative: string;
  /** 読み直した中身が「変更なし」か。変更なしなら書かずに「変更はありません。」と言う */
  isUnchanged: (edited: string) => boolean;
  /** 本文が空（空白だけを含む）のときの断りの文。`edit` に無い `--allow-empty` を案内しないため、呼び手が書く */
  emptyMessage: (path: string, resume: string) => string;
  save: (edited: string, draft: EditDraft) => Promise<void>;
}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), options.dirPrefix));
  const path = join(dir, options.fileName);
  const resume = options.resume(path);
  await openEditorKeepingEdits({
    dir,
    path,
    initial: options.initial,
    resume,
    alternative: options.alternative,
  });
  await keepDraftOnFailure(dir, path, resume, async (keep) => {
    const edited = await readFile(path, 'utf8');

    if (options.isUnchanged(edited)) {
      // 書き換えていないなら書き込まない: 同じ内容でも PUT は日誌へ行を積むため
      stdout.write('変更はありません。\n');
      return;
    }
    // 「変更なし」の判定より後に置く: 元から空のものを触らずに閉じたのは、変更なしのため
    if (edited.trim().length === 0) throw new Error(options.emptyMessage(path, resume));
    await options.save(edited, { dir, path, keep });
  });
}

/**
 * 版違い（409）で書き換えなかったときの後始末: 下書きを残し、いまの中身を隣のファイルへ書き、
 * 見比べ方と次の手を stdout へ出して、書き換えなかったと投げる。常に投げる。
 */
export async function failEditConflict(
  draft: EditDraft,
  options: {
    command: 'memory' | 'practice';
    noun: string;
    slug: string;
    /** いまの中身。読んだ後に消されていたら `null` */
    current: string | null;
    replaceNote: string;
    cause: unknown;
  },
): Promise<never> {
  const { command, noun, slug, current, replaceNote, cause } = options;
  draft.keep();
  const theirs = join(draft.dir, `${slug}.current.md`);
  if (current !== null) await writeFile(theirs, current, 'utf8');
  stdout.write(
    describeEditConflict({
      command,
      noun,
      slug,
      path: draft.path,
      theirs,
      currentMissing: current === null,
      replaceNote,
    }),
  );
  throw new Error(`${noun}が読んだ後に変わっていたので書き換えませんでした: ${slug}`, { cause });
}
