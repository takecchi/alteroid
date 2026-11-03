import { execFileSync } from 'node:child_process';

// `test-guard-core.mjs` と `verify-core.mjs`（と、バイト数を出す2つの check script）が同じ中身で持っていた小関数。

// マッチの前に ANSI を剥がす: GitHub Actions では集計行が色付きで出て、`^\s*Test Files` が行頭の SGR に一致せず、完走して緑でも「1本も走っていない」「判定できない」に化けるため。
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- ANSI エスケープの検出そのものが目的
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// `new Date()` は `decideSkip`（verify-core）などの既定引数の中だけで呼ぶ: 純粋なロジックでは呼ばない。日付依存の検査を数え上げる形は、スイートの内側の日付依存テストまで数え切れず閉じないため、「記録した日」と「いま」を突き合わせて日が変わったら走り直す。
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// `-` で始まるものは値として飲まない: 位置引数側へ回るだけで安全側に倒れるため。
export function isFlagLike(arg) {
  return arg === undefined || arg.startsWith('-');
}

export function formatBytes(n) {
  return n.toLocaleString('en-US') + ' B';
}

// `execFileSync` が投げたエラーから失敗理由を取り出す: 子の stderr があればその trim、無ければ `String(error)`。gh / git を呼ぶ script の catch 節が同じ4行を9か所で持っていたものを1つにした。
export function errorDetail(error) {
  return error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
    ? String(error.stderr).trim()
    : String(error);
}

// `gh` を1回呼ぶ薄い包み（main-ci-alarm と record-release-prod-ci が逐語で同じ本体を持っていたもの）。投げず、`{ stdout, error }` のどちらか一方だけが null でない。
export function gh(argv, { input } = {}) {
  try {
    const stdout = execFileSync('gh', argv, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return { stdout, error: null };
  } catch (error) {
    return { stdout: null, error: errorDetail(error) };
  }
}
