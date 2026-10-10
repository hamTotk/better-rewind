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
  // 戻せるファイルの控えがあるか
  restorable: boolean
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
  // 記録を書き換えたか。失敗の結果でも true なら mod は読み直す
  transcriptChanged?: boolean
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
