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
