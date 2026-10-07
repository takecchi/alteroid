// `pnpm test` の中で突き合わせない: 手元は offline でありうるうえ、CI の `GITHUB_TOKEN` にはブランチ保護を読む権限（administration）を付けられないため。
// `unreadable` を `match` へ丸めない: 権限が無くて読めていない状態が「ずれていない」として消えるため。
// どちらが正かを名指ししない: 宣言の側か protection の側かはこの検査には分からないため。

// `contexts` と `checks` の両方を見る: 片方だけ読むと、もう片方だけが動いた回を取り逃すため。
// 欄が無いときは空配列ではなく `null` を返す: 空配列は「required が1つも無い」という別の事実で、「読めなかった」と混ざるため。
export function contextsFromProtection(protection) {
  if (protection === null || typeof protection !== 'object') return null;
  const required = protection.required_status_checks;
  if (required === null || typeof required !== 'object') return null;

  const fromContexts = Array.isArray(required.contexts)
    ? required.contexts.filter((name) => typeof name === 'string')
    : null;
  const fromChecks = Array.isArray(required.checks)
    ? required.checks
        .map((check) => (check === null || typeof check !== 'object' ? null : check.context))
        .filter((name) => typeof name === 'string')
    : null;

  if (fromContexts === null && fromChecks === null) return null;

  const primary = fromChecks ?? fromContexts;
  const disagreement =
    fromContexts !== null && fromChecks !== null && !sameSet(fromContexts, fromChecks)
      ? { contexts: [...fromContexts].sort(), checks: [...fromChecks].sort() }
      : null;

  return { names: [...primary].sort(), disagreement };
}

export function contextsFromRules(rules) {
  if (!Array.isArray(rules)) return null;
  const names = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== 'object' || rule.type !== 'required_status_checks') {
      continue;
    }
    const list = rule.parameters?.required_status_checks;
    if (!Array.isArray(list)) return null;
    for (const check of list) {
      if (check !== null && typeof check === 'object' && typeof check.context === 'string') {
        names.push(check.context);
      }
    }
  }
  return { names: [...new Set(names)].sort() };
}

// 404 だけでは未保護と判定しない: 権限不足でも 404 になるため、本文が `Branch not protected` のときだけ未保護とする。
export function isBranchNotProtected(detail) {
  return typeof detail === 'string' && /Branch not protected/.test(detail) && /404/.test(detail);
}

// 片方が読めないときは読めた側だけで緑にも赤にもしない: 片方が読めないと和が決まらないため。
export function resolveLiveRequiredChecks(protection, rules) {
  const reasons = [];
  let fromProtection = { names: [], disagreement: null };
  let protectionAbsent = false;

  if (protection.status === 'absent') {
    protectionAbsent = true;
  } else if (protection.status === 'ok') {
    const parsed = contextsFromProtection(protection.body);
    if (parsed === null) {
      reasons.push('旧来の protection: 応答に required_status_checks が読み取れる形で無かった');
    } else {
      fromProtection = parsed;
    }
  } else {
    reasons.push(`旧来の protection: 読めなかった（${protection.detail}）`);
  }

  let fromRules = null;
  if (rules.status === 'ok') {
    fromRules = contextsFromRules(rules.body);
    if (fromRules === null) {
      reasons.push('ruleset（rules/branches）: 応答が規則の配列として読み取れなかった');
    }
  } else {
    reasons.push(`ruleset（rules/branches）: 読めなかった（${rules.detail ?? rules.status}）`);
  }

  if (reasons.length > 0 || fromRules === null) {
    return { live: null, reasons };
  }

  const names = [...new Set([...fromProtection.names, ...fromRules.names])].sort();
  return {
    live: {
      names,
      disagreement: fromProtection.disagreement,
      sources: {
        protection: protectionAbsent
          ? '未保護（404 Branch not protected）'
          : [...fromProtection.names],
        rulesets: [...fromRules.names],
      },
    },
    reasons: [],
  };
}

function formatSources(sources) {
  const part = (value) => (Array.isArray(value) ? value.join(' / ') || '（空）' : value);
  return `旧来の protection: ${part(sources.protection)} / ruleset: ${part(sources.rulesets)}`;
}

function sameSet(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

export function compareRequiredStatusChecks(declared, live, reasons = []) {
  const declaredSorted = [...declared].sort();
  if (live === null) {
    return { verdict: 'unreadable', declared: declaredSorted, reasons };
  }

  const liveNames = live.names;
  const missing = declaredSorted.filter((name) => !liveNames.includes(name));
  const extra = liveNames.filter((name) => !declaredSorted.includes(name));
  const drifted = missing.length > 0 || extra.length > 0 || live.disagreement !== null;

  return {
    verdict: drifted ? 'drift' : 'match',
    declared: declaredSorted,
    live: liveNames,
    missing,
    extra,
    disagreement: live.disagreement,
    sources: live.sources ?? null,
  };
}

export function formatComparison(result) {
  if (result.verdict === 'match') {
    return (
      `check-required-status-checks: OK — 宣言と main の required（protection ∪ ruleset）が一致 ` +
      `(${result.declared.join(' / ')})` +
      (result.sources ? `\n  出所 — ${formatSources(result.sources)}` : '')
    );
  }

  if (result.verdict === 'unreadable') {
    return (
      'check-required-status-checks: 判定できなかった — main の required を読み切れなかった。\n' +
      '【赤の意味】これは「ずれていない」ではない。**読めていない**。\n' +
      'ブランチ保護の読み出しは administration 相当の権限を要求し、GitHub Actions の\n' +
      '既定の GITHUB_TOKEN には付けられない（`permissions:` に administration は無い）。\n' +
      '旧来の protection と ruleset の両方が読めて初めて和が決まる。読めなかった口:\n' +
      (result.reasons ?? []).map((reason) => `  - ${reason}`).join('\n') +
      ((result.reasons ?? []).length > 0 ? '\n' : '') +
      `宣言の側だけは読めている: ${result.declared.join(' / ')}\n` +
      '手元で確かめるなら: gh api repos/takecchi/alteroid/branches/main/protection ' +
      '/ gh api repos/takecchi/alteroid/rules/branches/main'
    );
  }

  const lines = [
    'check-required-status-checks: NG — 宣言と protection がずれている。',
    '【赤の意味】**どちらが正しいかは、この検査には決められない。**',
    '  宣言（.github/required-status-checks.json）が古いのかもしれないし、',
    '  protection の側が意図せず変わったのかもしれない。**どちらを直すかを人間が決めること。**',
    `  宣言: ${result.declared.join(' / ') || '（空）'}`,
    `  protection: ${result.live.join(' / ') || '（空）'}`,
  ];
  if (result.sources) lines.push(`  出所 — ${formatSources(result.sources)}`);
  if (result.missing.length > 0) {
    lines.push(`  宣言に在って protection に無い: ${result.missing.join(' / ')}`);
  }
  if (result.extra.length > 0) {
    lines.push(`  protection に在って宣言に無い: ${result.extra.join(' / ')}`);
  }
  if (result.disagreement !== null) {
    lines.push(
      '  ⚠ protection の応答の中で contexts と checks が食い違っている' +
        `（contexts: ${result.disagreement.contexts.join(' / ')} / ` +
        `checks: ${result.disagreement.checks.join(' / ')}）。` +
        'GitHub 側で片方だけが動いた形なので、宣言を直す前にそちらを見ること。',
    );
  }
  lines.push(
    '  宣言を直すなら .github/required-status-checks.json の contexts と observedAt を、',
    '  protection を直すならリポジトリの設定を（このスクリプトは1バイトも書き換えない）。',
  );
  return lines.join('\n');
}
