// mutate-core.mjs — 変異試験ハーネスの「純粋な層」。
//
// ここにあるのは手順を組み立てる関数だけである。CLI の argv 解析・exit code・
// `--help` の類は `mutate.mjs`（薄い CLI 層）に置く。自己検証（`mutate-selftest.mjs`）
// はここの関数を直接呼ぶ — サブプロセスを起こしたり、まして殺したりしない。
//
// **ここにテスト用の抜け道（環境変数で分岐する類）を作らない。** 抜け道自体が
// 次の穴になる。自己検証で「途中で終わった状態」が要るときは、この層の関数を
// 順番どおり呼んで、その先を単に呼ばないことで表現する（呼び出す側の話であって、
// この層の中に条件分岐を足す話ではない）。
//
// 依存なし・ビルド不要（node の組み込みモジュールだけを使う）。単一ファイルという
// 制約は、CLI 層・自己検証層と分けたことで崩れているが、それらは同じディレクトリの
// 素の `import` で足しているだけで、node_modules には一切依存しない。

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, '..', '..', '..');

export const MARKER_PATH = path.join(ROOT, 'MUTATION-IN-PROGRESS.json');
export const BACKUP_DIR = path.join(ROOT, '.mutation-testing', 'backups');

// **印も控えディレクトリも .gitignore に入れない。** git status と ls の両方に
// 出るのが狙いである。`git add -A` で誤って混入するリスクはあるが、混入は
// 「知らないファイルがステージに乗る」という騒がしい失敗で気づける。印が無い
// ことは、何も出ないという静かな失敗なので、そもそも気づく機会が無い。
// うるさい失敗のほうを選ぶ。

export class HarnessError extends Error {}

export function log(line = '') {
  process.stdout.write(`${line}\n`);
}

export function section(title) {
  log('');
  log(`── ${title} ──`);
}

export function md5(content) {
  return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

export function absPath(relFile) {
  return path.join(ROOT, relFile);
}

export function readRepoFile(relFile) {
  return fs.readFileSync(absPath(relFile), 'utf8');
}

export function writeRepoFile(relFile, content) {
  fs.writeFileSync(absPath(relFile), content);
}

export function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function gitStatusPorcelainFor(relFile) {
  return execFileSync('git', ['status', '--porcelain', '--', relFile], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** `from`/`to` を単純な文字列置換で数える・置換する。正規表現は使わない
 * （`from` に正規表現のメタ文字が入っていると意図しない一致をするため）。
 * `String.prototype.replaceAll` と同じ非重複・左から右の意味論。
 */
export function countOccurrences(haystack, needle) {
  if (needle === '') return Infinity; // 歯2: 空パターンは呼び出し側で先に弾く
  return haystack.split(needle).length - 1;
}

export function replaceAllLiteral(haystack, from, to) {
  return haystack.split(from).join(to);
}

// ── 判定の語彙 ──────────────────────────────────────────────────────
//
// **歯7の裏面**: 判定行（検出/生存/不明）と生ログ（vitest の生出力）は別区画に
// 出す。生ログには当然 `Tests N passed` のような文言が乗るが、それは加工前の
// 証跡であって判定ではない。禁止語チェックは判定行の側にだけ掛ける。
//
// **判定行に固定の `M1:`/`M2:`/`M3:` を焼き込まない。** かつてはこの3つを
// 判定の種別そのものとして固定文字列に埋め込んでいたが、変異の spec 自身が
// `id: 'M4'` のような名前を持てる（`SKILL.md` の解説表が `M1..M6` を変異の
// 名前として使っている）ため、「種別としての M2」と「変異としての M4」が
// 衝突し、判定行が実際の変異と無関係な番号を名乗る欠陥があった
// （実測で確認・修正。マネージャーからの差し戻し）。判定行には常に
// `spec.id` を差し込み、種別は日本語の語（検出/生存/不明）そのもので表す。
export const FORBIDDEN_IN_JUDGEMENT = [
  '合格',
  'OK',
  'ok',
  'pass',
  'passed',
  '成功',
  '問題なし',
  '緑',
  '✓',
];

/** 判定の種別ごとの文面テンプレート。`mutationId` を差し込んで完成させる。 */
const JUDGEMENT_TEMPLATES = {
  検出: (mutationId) => `変異 ${mutationId}: 検出 — この歯はこの変異を捕まえた`,
  生存: (mutationId) =>
    `変異 ${mutationId}: 生存 — この歯はこの変異を検出できない\n次にやること: 歯を強める。緩めるのではない`,
  不明: (mutationId) => `変異 ${mutationId}: 不明 — 変異が成果物へ届いていない（生存ではない）`,
};

function assertNoForbiddenWords(text, contextLabel) {
  for (const word of FORBIDDEN_IN_JUDGEMENT) {
    if (text.includes(word)) {
      throw new HarnessError(`${contextLabel} に禁止語 "${word}" が混ざっている: ${text}`);
    }
  }
}

/**
 * ハーネス自身の判定語彙に禁止語が混ざっていないかを検査する口。
 *
 * ここで検査するのはテンプレートそのもの（サンプル id `<id>` で埋めたもの）。
 * **これは起動時の安い自己検査であって、実際に判定を出すときの検査ではない。**
 * 変異の id 自体に禁止語が混ざっている可能性は、id を差し込んだ「後」の文言を
 * 検査する `formatJudgement` の側が見る（`judge` を呼ぶたびに毎回効く）。
 * 定義（テンプレート）だけ検査して整形後を素通りする形にしない。
 */
export function checkJudgementVocabulary() {
  const problems = [];
  for (const [name, template] of Object.entries(JUDGEMENT_TEMPLATES)) {
    const sample = template('<id>');
    try {
      assertNoForbiddenWords(sample, `JUDGEMENT_TEMPLATES.${name}`);
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length > 0) {
    throw new HarnessError(`判定語彙の自己検査に失敗:\n${problems.join('\n')}`);
  }
  return { ok: true, checked: Object.keys(JUDGEMENT_TEMPLATES) };
}

/** 種別 + 変異 id から判定行を組み立てる。整形後の文言にも禁止語検査を掛ける。 */
export function formatJudgement(category, mutationId) {
  const template = JUDGEMENT_TEMPLATES[category];
  if (!template) throw new HarnessError(`未知の判定種別: ${category}`);
  const text = template(mutationId);
  assertNoForbiddenWords(text, `judge(${mutationId})`);
  return text;
}

/** 生存/検出/不明のどれかを、成果物検査とテスト結果から決める（id とは無関係）。 */
export function decideJudgementCategory(artifactResult, testResult) {
  if (artifactResult.artifactState === 'undelivered') {
    return '不明';
  }
  if (!testsRanCleanly(testResult)) {
    throw new HarnessError(
      'テストの集計行（Test Files / Tests）が見つからない。' +
        '「落ちた」のか「1本も走らなかった」のか区別できないので判定を出さない。',
    );
  }
  const allPassed = testsAllPassed(testResult);
  return allPassed ? '生存' : '検出';
}

// ── 印 ──────────────────────────────────────────────────────────────

export function markerExists() {
  return fs.existsSync(MARKER_PATH);
}

export function writeMarkerFile(marker) {
  fs.writeFileSync(MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`);
}

export function clearMarker() {
  fs.rmSync(MARKER_PATH, { force: true });
}

/**
 * 印を読み、自己整合性を検査する。
 *
 * **印の中に原文そのもの（`originalContent`）を持たせてある。** 控え
 * （`.mutation-testing/backups/`）が汚染されている場合、復元の材料が控え側に
 * ゼロになる。「落ちた本人でなくても復元できる」という条件は、原文が印の
 * 側にもあって初めて満たせる。ここではその原文自身の md5 を計算し直し、
 * 印が記録している `md5Pre` と一致するかを返す（印そのものが壊れている場合を
 * 素通ししないため）。
 */
export function readMarkerVerified() {
  if (!markerExists()) {
    throw new HarnessError('印が無い。');
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
  } catch (err) {
    throw new HarnessError(`印(JSON)が壊れていて読めない: ${err.message}`);
  }
  const required = ['file', 'md5Pre', 'originalContent', 'backupPath', 'headBefore'];
  for (const key of required) {
    if (!(key in marker)) {
      throw new HarnessError(`印に必須フィールド "${key}" が無い。印そのものが壊れている。`);
    }
  }
  const originalContentMd5 = md5(marker.originalContent);
  const selfConsistent = originalContentMd5 === marker.md5Pre;
  return { marker, originalContentMd5, selfConsistent };
}

/** 印の中身を組み立てる。落ちた本人でなくても復元できることが条件。 */
function buildMarker(spec, ctx) {
  return {
    mutationId: spec.id,
    file: spec.file,
    from: spec.from,
    to: spec.to,
    // 復元後の後始末（dist の再 build と、その検証）に要る。`target` が無ければ
    // 後始末も無い。`artifact` が無ければ build 成功しか確認できない
    // （内容までは確認できないことを後始末の側で明示する）。
    target: spec.target ?? null,
    artifact: spec.artifact ?? null,
    startedAt: nowIso(),
    sessionId: process.env.CLAUDE_SESSION_ID ?? process.env.ALTEROID_SESSION_ID ?? null,
    pid: process.pid,
    headBefore: ctx.headBefore,
    md5Pre: ctx.md5Pre,
    // **原文そのもの。** 控えが汚染・消失していても、これがあれば戻せる。
    originalContent: ctx.original,
    backupPath: path.relative(ROOT, ctx.backupPath),
    manualRestore: {
      note: 'ハーネスを使わない復元手順。控えをそのまま書き戻し、md5 を照合する。',
      command: `cp '${path.relative(ROOT, ctx.backupPath)}' '${spec.file}'`,
      verifyMd5Command: `md5sum '${spec.file}'`,
      expectedMd5: ctx.md5Pre,
    },
    alternativeWithCaveat:
      `git show HEAD:${spec.file} > ${spec.file} でも戻せるが、これは HEAD に正解が在る状況でのみ` +
      '当たる。未コミットの修正を持っているときは当たらない。',
  };
}

// ── 変異1本ぶんの手順 ───────────────────────────────────────────────
//
// 順序がそのまま歯である。入れ替えない。

/**
 * 手順1〜7。印を「変異を書き込む前」に置く（手順6が手順7より前）。
 * ここを入れ替えると、書いてから死んだときに印の無いまま変異が残る
 * （自己検証「中断」参照。この対比自体はこの関数の中には無い —
 * 本体に抜け道を作らないため、対比は selftest 側が別の直線的な関数として持つ）。
 */
export function applyMutation(spec) {
  if (markerExists()) {
    throw new HarnessError(
      '印が既にある。前回の変異が復元されていない可能性がある。`status` で確認すること。',
    );
  }

  // 1. HEAD を記録する（同じツリーで HEAD を動かすのも汚染に見えるため）。
  const headBefore = gitHead();
  log(`[1] HEAD (適用前): ${headBefore}`);

  // 2. 原文を読み、読んだ中身から md5Pre を計算する（ファイルを2回読まない）。
  const original = readRepoFile(spec.file);
  const md5Pre = md5(original);
  log(`[2] 原文を読んだ。md5Pre=${md5Pre} (${spec.file}, ${original.length} 文字)`);

  // 3. 控えを書く。
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `${spec.id}.bak`);
  fs.writeFileSync(backupPath, original);
  log(`[3] 控えを書いた: ${path.relative(ROOT, backupPath)}`);

  // 4. 照合1: 控えをディスクから読み直して md5 が一致することを要求する。
  //    不一致なら変異を当てずに中止する。
  const rereadBackup = fs.readFileSync(backupPath, 'utf8');
  const md5Backup1 = md5(rereadBackup);
  if (md5Backup1 !== md5Pre) {
    throw new HarnessError(
      `[4] 照合1 失敗: 控えを読み直した md5 (${md5Backup1}) が原文の md5 (${md5Pre}) と` +
        '一致しない。変異を当てずに中止する。',
    );
  }
  log(`[4] 照合1: 控えの md5 が原文と一致 (${md5Backup1})`);

  // 5. 書く前にパターンを検査する。from が空でないこと（歯2）。
  //    一致件数が expect と厳密一致すること（歯3・歯6: 書いてから数えると
  //    落ちたときにファイルが変異したまま残るので、書く前に数える）。
  if (spec.from === '') {
    throw new HarnessError('[5] 歯2 違反: from が空文字である。空パターンは全箇所へ振り切れる。');
  }
  const occurrences = countOccurrences(original, spec.from);
  if (occurrences !== spec.expect) {
    throw new HarnessError(
      `[5] 歯3/6 違反: 一致件数が期待と不一致（実際 ${occurrences} / 期待 ${spec.expect}）。` +
        '書き込みは行わない。',
    );
  }
  log(`[5] パターン検査: 一致件数 ${occurrences} が期待 ${spec.expect} と一致`);

  // 6. 印を置く。**変異を書き込む前である。** ここが手順の要点で、7と入れ替えない。
  const marker = buildMarker(spec, { headBefore, md5Pre, backupPath, original });
  writeMarkerFile(marker);
  log(
    `[6] 印を設置した: ${path.relative(ROOT, MARKER_PATH)}（原文 ${original.length} 文字を埋め込み済み）`,
  );

  // 7. 変異を書き込む。md5Post !== md5Pre を要求する（歯5: 当て忘れの検出）。
  const mutated = replaceAllLiteral(original, spec.from, spec.to);
  writeRepoFile(spec.file, mutated);
  const md5Post = md5(mutated);
  if (md5Post === md5Pre) {
    throw new HarnessError(
      `[7] 歯5 違反: 変異前後の md5 が同一 (${md5Post})。当て忘れの疑いがある。`,
    );
  }
  log(`[7] 変異を書き込んだ: md5Post=${md5Post}（md5Pre と異なる: 確認済み）`);

  return { headBefore, md5Pre, backupPath, marker };
}

/** 手順8〜9: 対象パッケージを build し、成果物を検査する。
 * spec.target が null なら「build 境界を跨がない」と明示して build/artifact を
 * 両方スキップする（この判断は spec を書く側の責任。理由をログへ残す）。
 */
export function buildAndCheckArtifact(spec) {
  if (spec.target === null || spec.target === undefined) {
    log('[8] build: 対象外（この変異は dist 経由で消費されないと spec が明示している）');
    log('[9] 成果物検査: 対象外（8と同じ理由。9は8の続きなので、8を飛ばすなら9も飛ばす）');
    return { buildSkipped: true, artifactState: 'not-applicable' };
  }

  const result = spawnSync('pnpm', ['--filter', spec.target, 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  log(`[8] build (--filter ${spec.target}): exit=${result.status}`);
  log('--- build 生ログ ここから ---');
  log((result.stdout ?? '') + (result.stderr ?? ''));
  log('--- build 生ログ ここまで ---');

  if (!spec.artifact) {
    log(
      '[9] 成果物検査: 対象外（spec に artifact 検査が設定されていない）。' +
        '**build の終了コードでは判定しない** — これは「build が走ったか」しか答えない。',
    );
    return { buildSkipped: false, buildExitCode: result.status, artifactState: 'not-checked' };
  }

  const artifactAbs = absPath(spec.artifact.file);
  let delivered = false;
  if (fs.existsSync(artifactAbs)) {
    const artifactContent = fs.readFileSync(artifactAbs, 'utf8');
    delivered = artifactContent.includes(spec.artifact.contains);
  }
  log(
    `[9] 成果物検査: ${spec.artifact.file} を実際に読んで "${spec.artifact.contains}" を探した ` +
      `→ ${delivered ? '見つかった（届いている）' : '見つからなかった（届いていない）'}`,
  );

  return {
    buildSkipped: false,
    buildExitCode: result.status,
    artifactState: delivered ? 'delivered' : 'undelivered',
  };
}

/** 手順10: テストを走らせ、`Test Files ... passed` と `Tests ... passed` の
 * 両方の行を読む。行の不在は「走っていない」であって「通った/落ちた」ではない。
 */
export function runTests(extraArgs = []) {
  const result = spawnSync('pnpm', ['test', '--maxWorkers=4', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  const filesLine = combined.match(/^\s*Test Files\s+.+$/m)?.[0]?.trim() ?? null;
  const testsLine = combined.match(/^\s*Tests\s+.+$/m)?.[0]?.trim() ?? null;
  return { exitCode: result.status, raw: combined, filesLine, testsLine };
}

export function testsRanCleanly(testResult) {
  return testResult.filesLine !== null && testResult.testsLine !== null;
}

export function testsAllPassed(testResult) {
  if (!testsRanCleanly(testResult)) return null; // 判定できない
  const noFailures = !/failed/i.test(testResult.filesLine) && !/failed/i.test(testResult.testsLine);
  const hasPassed = /passed/.test(testResult.filesLine) && /passed/.test(testResult.testsLine);
  return noFailures && hasPassed;
}

/**
 * 手順11: 判定を出す。生存を「合格」と読める語で書かない。
 *
 * **`spec` を受け取り、`spec.id` を判定行へ差し込む。** 種別の決定
 * （`decideJudgementCategory`）と id の差し込み（`formatJudgement`）を分けて
 * あるのは、`cmdRun` のまとめが「種別」だけを欲しがる場面と、人間が読む
 * 判定行が「id + 種別」を欲しがる場面の両方があるため。戻り値は
 * `{ category, text }` — `category` は `'検出' | '生存' | '不明'`。
 */
export function judge(spec, artifactResult, testResult) {
  const category = decideJudgementCategory(artifactResult, testResult);
  const text = formatJudgement(category, spec.id);
  return { category, text };
}

/**
 * 手順12〜13: 復元する。
 *
 * **控えと印が食い違ったとき、自動で勝者を選ばない。** 両方の md5 と、どちらが
 * `md5Pre` に一致するかを出す。片方だけ一致するなら「そちらから戻せる」と
 * 明示するが、その復元は `{ fromMarker: true }`（CLI では `--restore-from-marker`）
 * を明示したときにしか走らない。既定（`fromMarker` 省略）は控えから戻す
 * 通常経路であり、控えが `md5Pre` と一致しないなら**復元しない**。
 */
export function restoreMutation(opts = {}) {
  const fromMarker = opts.fromMarker === true;
  const { marker, originalContentMd5, selfConsistent: markerSelfConsistent } = readMarkerVerified();

  const backupAbs = absPath(marker.backupPath);
  let backupContent = null;
  let backupReadable = true;
  try {
    backupContent = fs.readFileSync(backupAbs, 'utf8');
  } catch {
    backupReadable = false;
  }
  const backupMd5 = backupReadable ? md5(backupContent) : null;
  const backupMatches = backupReadable && backupMd5 === marker.md5Pre;

  log(
    `[12a] 照合2: 控え md5=${backupMd5 ?? '(読めない)'} / 印内の原文 md5=${originalContentMd5} / md5Pre=${marker.md5Pre}`,
  );
  log(
    `      控えは md5Pre と一致: ${backupMatches} / 印内の原文は md5Pre と一致: ${markerSelfConsistent}`,
  );

  let sourceContent;
  let restoredFrom;
  if (fromMarker) {
    if (!markerSelfConsistent) {
      throw new HarnessError(
        '--restore-from-marker が指定されたが、印内の原文の md5 が md5Pre と一致しない。' +
          '印そのものが壊れている。復元しない。印は残す。',
      );
    }
    sourceContent = marker.originalContent;
    restoredFrom = 'marker';
    log('[12b] 復元元: 印に埋め込まれた原文（--restore-from-marker が明示された）');
  } else {
    if (!backupMatches) {
      if (markerSelfConsistent) {
        throw new HarnessError(
          '控えの md5 が md5Pre と一致しない（控えが汚染されている疑い。原因は不明。ハーネスは' +
            '原因を問わずこの二重照合で検出する）。印内の原文は md5Pre と一致しており、そちらからは' +
            '復元できる。自動では選ばない — 復元するなら `restore --restore-from-marker` を明示すること。' +
            '復元しない。印は残す。',
        );
      }
      throw new HarnessError(
        '控えの md5 も、印内の原文の md5 も、どちらも md5Pre と一致しない。自動で復元できる材料が' +
          '無い。手で確認すること。印は残す。',
      );
    }
    sourceContent = backupContent;
    restoredFrom = 'backup';
    log('[12b] 復元元: 控え（通常経路）');
  }

  writeRepoFile(marker.file, sourceContent);
  const md5After = md5(readRepoFile(marker.file));
  if (md5After !== marker.md5Pre) {
    throw new HarnessError(
      `[12b] 歯4 違反: 書き戻し後の md5 (${md5After}) が md5Pre (${marker.md5Pre}) と一致しない。`,
    );
  }
  log(`[12b] 書き戻し完了。md5 が md5Pre と一致 (${md5After})`);

  // 12c. git status --porcelain に対象ファイルが出ないこと。
  const statusOut = gitStatusPorcelainFor(marker.file);
  if (statusOut.trim() !== '') {
    throw new HarnessError(`[12c] git status に対象ファイルが残っている:\n${statusOut}`);
  }
  log('[12c] git status --porcelain: 対象ファイルの差分なし');

  // 12d. git rev-parse HEAD が手順1と同じであること。
  const headAfter = gitHead();
  if (headAfter !== marker.headBefore) {
    throw new HarnessError(`[12d] HEAD が変わっている (${marker.headBefore} → ${headAfter})`);
  }
  log(`[12d] HEAD 一致: ${headAfter}`);

  // **後始末（手順1〜13には無い工程。番号は振らない）。** 手順8〜9は build 済みの
  // `dist` を検査するが、この時点まではソースだけを書き戻した状態なので、
  // ここで再 build して確かめない限り `dist` に変異が残ったまま次の作業者へ
  // 渡る——このハーネスが潰そうとしている「静かに壊れたツリー」そのものである。
  // `SKILL.md` に理由を残してある。
  //
  // **入り（手順9）と同じ基準を、逆向きに使う。** 「build の終了コードでは
  // 判定しない」を後始末にも適用する — build が exit 0 でも `dist` を実際に
  // 読み直し、`artifact.contains` が消えていることを確認する。
  //
  // **確認が取れなければ印を消さない。** ソース（git 管理下）の復元はここまでで
  // 完了・検査済みだが、`dist`（untracked）の整合性は別の保証であり、それが
  // 取れない限り「このツリーは触ったままではない」と言い切れない。だから
  // `clearMarker()` をこの検証の後に置く——「復元は成功したのに印が残る」形に
  // なるが、「静かに壊れた dist を伴ったまま印だけ消える」よりましだという
  // 判断である。印が残っていれば `status`/`baseline`/`run` が知らせ続ける。
  // 次に `restore` を呼べば、ソース側は既に一致しているので歯4・12a〜12dは
  // 素通りし、ここ（後始末）だけをやり直せる（べき等）。
  const rebuildCheck = rebuildAndVerify(marker);
  if (!rebuildCheck.ok) {
    throw new HarnessError(
      `[後始末] 失敗: ${rebuildCheck.reason}。ソース（git 管理下）の復元は完了しているが、` +
        'dist の整合性が確認できないため印を残す。`status` はこの印を報告し続ける。' +
        '再度 `restore` を呼べば、ここだけをやり直せる。',
    );
  }

  // 13. 12と後始末の検証が全部通ってから印を消す。
  clearMarker();
  log('[13] 印を解除した');

  // 復元が成功した後は控えも消す（読めていた場合のみ）。残すと
  // `.mutation-testing/backups/` がハーネスを回すたびに積み上がり、素の
  // `git status` が毎回汚れる。復元が失敗したときはここへ到達しない＝控えは
  // 残る（手動復元・`--restore-from-marker` に要る）。
  if (backupReadable) fs.rmSync(backupAbs, { force: true });

  return { marker, restoredFrom, rebuildCheck };
}

/**
 * 後始末: `target` が設定されていたら dist を再 build し、実際に読み直して
 * 変異が消えていることを確認する。`target` が無ければ後始末そのものが不要
 * （build 境界を跨がない変異にこれを課さない）。
 */
function rebuildAndVerify(marker) {
  if (!marker.target) {
    return {
      checked: false,
      ok: true,
      reason: 'target が無いので後始末は不要',
      buildExitCode: null,
    };
  }

  log(`[後始末] dist を再 build する（--filter ${marker.target}）`);
  const result = spawnSync('pnpm', ['--filter', marker.target, 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  log(`[後始末] build exit=${result.status}`);
  if (result.status !== 0) {
    log('--- 後始末 build 生ログ ここから ---');
    log((result.stdout ?? '') + (result.stderr ?? ''));
    log('--- 後始末 build 生ログ ここまで ---');
    return {
      checked: true,
      ok: false,
      reason: `再 build が exit ${result.status} で失敗した。dist が現物（復元後のソース）と一致している保証が無い`,
      buildExitCode: result.status,
    };
  }

  if (!marker.artifact) {
    log(
      '[後始末] artifact 情報が無いため、build の成功だけを根拠にする' +
        '（内容までは確認できない。以後の生存にはこの限界がある）',
    );
    return {
      checked: true,
      ok: true,
      reason: 'artifact 情報が無く、build 成功のみで判定した（内容未確認）',
      buildExitCode: 0,
    };
  }

  const artifactAbs = absPath(marker.artifact.file);
  const content = fs.existsSync(artifactAbs) ? fs.readFileSync(artifactAbs, 'utf8') : '';
  const stillContainsMutation = content.includes(marker.artifact.contains);
  log(
    `[後始末] ${marker.artifact.file} を読み直し、"${marker.artifact.contains}" が消えているか確認 → ` +
      `${stillContainsMutation ? '消えていない（失敗）' : '消えている（成功）'}`,
  );
  return {
    checked: true,
    ok: !stillContainsMutation,
    reason: stillContainsMutation
      ? 'build は成功したが、dist にまだ変異の痕跡が残っている'
      : 'dist から変異の痕跡が消えたことを確認した',
    buildExitCode: 0,
  };
}
