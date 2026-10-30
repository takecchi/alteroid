// 読んだ後に別の手段で消された行の案内。内容と書きかけは残したまま、保存が「書き戻し」に当たることを言う。
export function GoneAfterReadNote({ noun }: { noun: string }) {
  return (
    <p role="alert" className="mb-3 rounded-lg border border-warn/50 p-3 text-sm text-warn">
      {`この${noun}は、読んだ後に別の手段で消された（または見つからない）。下の内容は前に読めたときのもので、書きかけもそのまま残してある。保存するときは、消されたものを書き戻すかどうかを確認する。`}
    </p>
  );
}
