// 読めた後の取り直しの失敗の注記。前に読めた中身を残したまま、その中身が古いかもしれないと言う。
// 文は「下は前に読めたときのもの。」に固定する（置き場所が中身の下にある注記だけが使う）。
// 外側の余白だけを呼び元から渡す: 置き場所（タイルの中・カードの中・会話の上）で要る余白が違うため。
// role="status" は常に付ける: 注記は取り直しが失敗した時点で後から現れるので、読み上げに届ける。
export function StaleNote({ what, className = 'mt-2' }: { what: string; className?: string }) {
  return (
    <p role="status" className={`${className} text-xs text-warn`}>
      {`最新の${what}を取り直せなかった。下は前に読めたときのもの。`}
    </p>
  );
}
