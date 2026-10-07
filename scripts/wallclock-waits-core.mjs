// 字面で数える: コメントや文字列の中の同じ形も1件になるが、数えすぎはラチェットを下げられないだけで、新しい待ちを見逃す向きには倒れないため。
// `setTimeout(resolve, 0)` は数えない: マイクロタスクより後へ1回譲るだけで、時間には賭けないため。

export const WALLCLOCK_WAIT_RE =
  /setTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*(?:[1-9]\d*|\d*\.\d*[1-9]\d*)\s*\)/g;

export function countWallclockWaits(source) {
  return (source.match(WALLCLOCK_WAIT_RE) ?? []).length;
}

export function isTestFile(file) {
  return /\.test\.tsx?$/.test(file);
}

export function compareWithBaseline(actual, baseline) {
  const increased = [];
  const decreased = [];
  for (const file of Object.keys({ ...actual, ...baseline }).sort()) {
    const now = actual[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (now > allowed) increased.push({ file, now, allowed });
    else if (now < allowed) decreased.push({ file, now, allowed });
  }
  return { increased, decreased };
}

const HOW_TO_FIX =
  '直し方: 実時間で待たずに、偽の時計を使う。\n' +
  '  - テストの頭で `vi.useFakeTimers()`、`afterEach` で `vi.useRealTimers()`\n' +
  '  - `await new Promise((r) => setTimeout(r, 20))` を `await vi.advanceTimersByTimeAsync(20)` に置き換える\n' +
  '  - 待っている相手が `Date.now()` を読むなら `vi.setSystemTime(...)` も進める。時計を注入できる口（`now: () => …`）が在ればそれを使う\n' +
  '  - 「待ちの間に見張りが回った」ことは、回数や呼ばれた順を `expect` で測る（待った時間ではなく）\n' +
  '  - 実例: PR #2153（`apps/daemon/src/token-trial-watch.test.ts` / `token-watch.test.ts`）';

export function describeRatchetFailure({ increased, decreased }, baselinePath) {
  const lines = [];
  if (increased.length > 0) {
    lines.push(
      'テストの中の実時間の待ち（`setTimeout(resolve, <ms>)`、ms > 0）が増えた（#2146）。' +
        '器が混むと、待ちの間に相手が進みきらず、早すぎる expect が時々落ちる。',
    );
    for (const { file, now, allowed } of increased) {
      lines.push(`  ${file}: ${String(now)} 件（基準 ${String(allowed)} 件）`);
    }
    lines.push(HOW_TO_FIX);
    lines.push(
      `どうしても実時間が要る（実プロセスの生死を待つなど）なら、理由を PR 本文に書いたうえで ${baselinePath} の数を上げる。`,
    );
  }
  if (decreased.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `実時間の待ちが減った。ラチェットを締めるため ${baselinePath} の数を下げること（0件になったら行ごと消す）:`,
    );
    for (const { file, now } of decreased) {
      lines.push(now === 0 ? `  "${file}": 行を消す` : `  "${file}": ${String(now)}`);
    }
  }
  return lines.join('\n');
}
