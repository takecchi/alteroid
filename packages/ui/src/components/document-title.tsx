import type { ReactNode } from 'react';

/** タブの題名の末尾に付ける名前。 */
export const APP_TITLE = 'alteroid';

/**
 * 題名の組み立て（`<画面名> - alteroid`）。テストが同じ式で期待値を作る。
 */
export function formatDocumentTitle(screen: string): string {
  return `${screen} - ${APP_TITLE}`;
}

/**
 * タブの題名（`document.title`）を、いま描いている画面の名前にする。
 *
 * **画面の見出し（h1）を描く部品の中から使う**（`Page` / `ScreenState` / `ChatHeader`）。
 * h1 と題名が別々の場所で書かれると、片方だけ直ってずれる。React 19 は `<title>` を
 * どこに描いても `<head>` へ引き上げ、画面が外れれば取り除くので、SPA の遷移で題名が
 * 追従する（root の meta に固定の題名を置くとこれと重なるので、置かない）。
 */
export function DocumentTitle({ children }: { children: string }): ReactNode {
  return <title>{formatDocumentTitle(children)}</title>;
}
