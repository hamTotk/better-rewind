// AskUserQuestion の質問 1 つ (ツールの入力のまま)
export type Question = {
  question: string
  header?: string
  multiSelect?: boolean
  options?: { label: string; description?: string }[]
}

// 巻き戻し地点。bin/transcript.mjs の points() が返す形
export type Point = {
  uuid: string
  // 人の発言 (prompt) か AskUserQuestion の質問 (tool)。ほかのツール呼び出しは地点にしない
  kind: 'prompt' | 'tool'
  label: string
  reply: string
  tool?: string
  toolUseId?: string
  resultUuid?: string
  // 人の発言の本文。巻き戻した後に入力欄へ戻す (コマンドと長すぎる発言では無い)
  text?: string
  // AskUserQuestion の地点の質問
  questions?: Question[]
  // その地点から次の人の発言までに Edit/Write で変わったファイル (絶対パス) と増減の行数
  changes: { files: string[]; added: number; removed: number }
  // 会話を戻せるか (最初の発言の前や、切ると記録が壊れる地点は false)
  canCut: boolean
  // 戻せるファイルの控えがあるか (restore.total > 0)
  restorable: boolean
  // Restore code が戻すファイル。rewind と同じ計画 (fileRestorePlan) で、地点より後の発言で変わったファイルも含む
  restore: RestorePlan
}

// Restore code が戻すファイルの要約。files と skipped は先頭の数件だけ (件数は total と skippedTotal)。
// total と files は実際に書く・消すファイルだけ (地点の時点で無く、今も無いファイルは消すものが無いので数えない)
export type RestorePlan = {
  total: number
  // write は控えの中身に戻す、delete は地点の時点で無かったので消す
  files: { path: string; action: 'write' | 'delete' }[]
  // 編集の直前に控えを取れなかった (か、実行されたか分からない) ので戻さないファイル
  skippedTotal: number
  skipped: string[]
}

// 途中で打ち切られた巻き戻し。bin/transcript.mjs の unfinished() が返す形 (points と一緒に届く)
export type Unfinished = {
  id: string
  at: string
  label: string
  // 戻そうとしていたファイル
  files: string[]
  // 戻す前の中身を退避したフォルダと、どのファイルかを書いた情報ファイル
  saved: string
  details: string
}

// ファイルの控えの情報 (snaps/<tool_use id>.json)。state は bin/transcript.mjs の「ファイルの控え」の説明を参照
// (拒否・失敗の結果でもファイルが変わっていれば 'ran')
export type Snap = {
  toolUseId: string
  tool: string
  path: string
  at: number
  existed: boolean
  data?: string
  state: 'pending' | 'ran' | 'denied'
  // 控えを取ろうとして失敗した印 (中身は無い)
  failed?: true
}

// 戻し方: 会話とファイル / 会話だけ / ファイルだけ
export type Mode = 'both' | 'conversation' | 'files'

// 要約の向き (組み込みの summarizeMetadata.direction と同じ値): 地点から後ろを要約する / 地点より前を要約する
export type Direction = 'from' | 'up_to'

// 要約の頼み。session.compact の hook が e.messages の中で地点を探す手がかり (SessionMessage には uuid が無い)。
// 質問の地点は toolUseId、人の発言は本文 (text) と、同じ本文の発言のうち後ろから何番目か (fromEnd)
export type SummarizeRequest = {
  direction: Direction
  toolUseId?: string
  text?: string
  fromEnd: number
}

// ペインから頼んだ要約の結末。session.compact の hook が記録し、要約を頼んだ側が読んで知らせる。
// done は地点の前後で分けて要約した、skip は分けずに断った (reason はその理由)
export type SummarizeOutcome = { kind: 'done' } | { kind: 'skip'; reason: string }

// ペインの段階: 地点の一覧 → 戻し方 → (AskUserQuestion なら) 回答 / (要約なら) 添える指示。枝の一覧 → 枝の全文
export type View = 'points' | 'modes' | 'answer' | 'summarize' | 'branches' | 'branch'

// 巻き戻す前の会話 (枝)。bin/transcript.mjs の branches() が返す形
export type Branch = {
  id: string
  at: string
  label: string
  mode: Mode
  answered: boolean
  // 切った地点より後ろの会話 (読むだけ)
  text: string
}

// bin/transcript.mjs の rewind() が返す形
export type RewindResult = {
  id: string
  mode: Mode
  leaf?: string
  dropped: number
  restored: string[]
  removed: string[]
  // 控えが取れていないので戻さなかったファイル
  skipped: string[]
  // 記録を書き換えたか (会話を戻したとき true)。helper は記録の rename を最後の書き換えに置くので、ふつうの失敗では
  // error と false を返す (記録は書き換えていない)。戻し終えた後で終わった印を書けなかったときだけ、error と一緒に
  // 戻した結果 (restored・removed など) と、会話を戻したなら true を返す。mod は true なら読み直してから失敗を知らせる
  transcriptChanged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'better-rewind': {
      points: Point[]
      // カーソルのある地点の key (pointKey)。null は一覧の最後の (現在)
      cursor: string | null
      // 読み込み中・失敗の一言。空なら表示しない
      status: string
      view: View
      // 戻し方・回答の段階で選んでいる地点
      picked: Point | null
      // 回答の段階に進んだときの戻し方
      mode: Mode | null
      // AskUserQuestion の質問ごとに選んだ回答 (先頭から)
      answers: string[]
      // 要約の段階に進んだときの向き
      direction: Direction | null
      // ペインから頼んだ要約。/compact を動かす間だけ立て、hook が最初の 1 回で下ろす (立っていない要約は hook が素通しする)
      pending: SummarizeRequest | null
      // pending を下ろした hook がどうしたか。/compact の前に null に戻す (null のままなら hook は動かなかった)
      outcome: SummarizeOutcome | null
      // 一覧以外の段階でフォーカスのある要素の key
      sub: string | null
      branches: Branch[]
      // 全文を開いている枝の id
      opened: string | null
      // ペインが開いているか
      isOpen: boolean
      // AI が応答している最中か (turn.start から turn.complete まで)
      isRunning: boolean
    }
  }
}
