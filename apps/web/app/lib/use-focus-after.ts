import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

// 行の中の確認を Esc でやめる: 要素の onKeyDown に渡すので、焦点が中にあるときだけ効き、画面全体の Esc は奪わない。
export function onEscape(cancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Escape') cancel();
  };
}

// 押したボタンが差し替わる・消えると、ブラウザは焦点を body へ落とす。その描き直しのあとに、container の中の `selector` の要素（'' なら container 自身）へ焦点を移す。
// 移すのは `request` した操作のあと、`dep` が変わった描き直しの1回だけ: 別の経路で dep が変わっても焦点を奪わない。
// 移し先が disabled（送信中）の間は要求を残し、次に dep が変わる描き直しで移す: disabled の要素には焦点を置けないため。
// `request(selector, action)` は action が投げたら要求を取り下げる: 失敗のとき、あとで届く別の描き直しに焦点を奪わせないため。
// 共通の Button は ref を受けない型なので、要素は container から selector で引く。
export function useFocusAfter(container: RefObject<HTMLElement | null>, dep: unknown) {
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    const selector = pending.current;
    if (selector === undefined) return;
    const root = container.current;
    const target = selector === '' ? root : (root?.querySelector<HTMLElement>(selector) ?? null);
    if ((target as HTMLButtonElement | null)?.disabled === true) return;
    pending.current = undefined;
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dep が変わった描き直しにだけ反応する（container は ref）
  }, [dep]);
  return async (selector: string | undefined, action?: () => Promise<unknown>) => {
    pending.current = selector;
    if (action === undefined) return;
    try {
      await action();
    } catch (caught) {
      pending.current = undefined;
      throw caught;
    }
  };
}
