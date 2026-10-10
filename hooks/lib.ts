import type { SessionMessage } from 'claude-code'

import type { Branch, Direction, Mode, Point, RewindResult, SummarizeOutcome, SummarizeRequest } from '../types'

// 1 行に複数のツール呼び出しが乗ることがあるので、uuid に種類 (tool_use id) を足して一意にする
export const pointKey = (p: Point) => `${p.uuid}:${p.toolUseId ?? p.kind}`

// カーソルを中央に置いた表示範囲 [start, end)。端では詰める
export function windowAround(index: number, total: number, size: number): [number, number] {
  if (total <= size) return [0, total]
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), total - size)
  return [start, start + size]
}

// 端末での表示幅。全角 (CJK・全角記号) は 2 とみなす
const charWidth = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1)
export const cellWidth = (s: string) => [...s].reduce((n, ch) => n + charWidth(ch), 0)

function sliceCells(s: string, cells: number): string {
  let used = 0
  let out = ''
  for (const ch of s) {
    if (used + charWidth(ch) > cells) break
    out += ch
    used += charWidth(ch)
  }
  return out
}

// 本文を幅で折り返したと見なして、rows 行に収まるところで切る
export function clipToRows(text: string, rows: number, columns: number): string {
  const width = Math.max(2, columns)
  const out: string[] = []
  let used = 0
  for (const line of text.split('\n')) {
    const need = Math.max(1, Math.ceil(cellWidth(line) / width))
    if (used + need > rows) {
      const room = rows - used
      if (room > 0) out.push(`${sliceCells(line, room * width - 1)}…`)
      else if (out.length > 0) out[out.length - 1] += '…'
      break
    }
    out.push(line)
    used += need
  }
  return out.join('\n')
}

// 2 行目の要約を組み込みの書き方で作る: 変更なし / 1 ファイルならその名前 / 複数なら件数。増減は 0 なら出さない
export function changesParts(c: Point['changes']): { text: string; added: string; removed: string } {
  const added = c.added > 0 ? `+${c.added}` : ''
  const removed = c.removed > 0 ? `-${c.removed}` : ''
  if (c.files.length === 0) return { text: 'No code changes', added: '', removed: '' }
  const only = c.files[0]
  const text = c.files.length === 1 && only ? (only.split(/[\\/]/).pop() ?? only) : `${c.files.length} files changed`
  return { text, added, removed }
}

// 件数と名詞 (1 file / 2 files)
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

export const BUSY = 'Cannot rewind while the AI is responding. Try again when it finishes'

// 回答を選び直せる地点か (AskUserQuestion で質問が読める)
export const isAsk = (p: Point) => p.tool === 'AskUserQuestion' && (p.questions?.length ?? 0) > 0

// 戻し方の選択肢の key。要約の 2 つは組み込みの値に合わせる
export type OptionKey = Mode | 'summarize' | 'summarize_up_to' | 'cancel'

// 戻し方の選択肢。並びは組み込みと同じく 戻す → 要約 → やめる。会話を戻せない地点・控えの無い地点では、その選択肢を出さない。
// AskUserQuestion の地点で会話を戻すときは、質問の直後に戻して回答を選び直す。
// 要約は記録の中で位置を探せる地点だけ。「ここまでを要約」は前に要約するものがある地点 (一覧の先頭でない) だけ
export function modeOptions(p: Point, list: readonly Point[]): { key: OptionKey; label: string }[] {
  const ask = isAsk(p)
  const out: { key: OptionKey; label: string }[] = []
  if (p.canCut && p.restorable) out.push({ key: 'both', label: ask ? 'Restore code and conversation, then re-answer' : 'Restore code and conversation' })
  if (p.canCut) out.push({ key: 'conversation', label: ask ? 'Restore conversation, then re-answer' : 'Restore conversation' })
  if (p.restorable) out.push({ key: 'files', label: 'Restore code' })
  if (canSummarize(p)) {
    out.push({ key: 'summarize', label: 'Summarize from here' })
    if (list.findIndex(q => pointKey(q) === pointKey(p)) > 0) out.push({ key: 'summarize_up_to', label: 'Summarize up to here' })
  }
  out.push({ key: 'cancel', label: 'Never mind' })
  return out
}

// ---- 要約 ----

// 人の発言を見比べる形。貼り付けの囲みを外して空白をすべて除く (記録の本文と SessionMessage の text で区切りの書き方が違ってもそろう)
const promptKey = (s: string) => s.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, '$1').replace(/\s+/g, '')

// 要約できる地点か。質問の地点は tool_use id で、人の発言は本文で e.messages の中の位置を探す
// (コマンドと長すぎる発言は本文を持たないので探せない)
export const canSummarize = (p: Point) => (p.kind === 'tool' ? p.toolUseId !== undefined : promptKey(p.text ?? '') !== '')

// 地点 p への要約の頼み。同じ本文の発言は、一覧で p より後ろにいくつあるか (fromEnd) で区別する。
// 前から数えないのは、要約済みの会話では e.messages が前の方を欠くため (後ろはどちらも今の会話の先端でそろう)
export function summarizeRequest(p: Point, list: readonly Point[], direction: Direction): SummarizeRequest | undefined {
  if (!canSummarize(p)) return undefined
  if (p.kind === 'tool') return { direction, toolUseId: p.toolUseId, fromEnd: 0 }
  const at = list.findIndex(q => pointKey(q) === pointKey(p))
  if (at < 0) return undefined
  const key = promptKey(p.text ?? '')
  const fromEnd = list.slice(at + 1).filter(q => q.kind === 'prompt' && promptKey(q.text ?? '') === key).length
  return { direction, text: p.text, fromEnd }
}

type Message = Pick<SessionMessage, 'role' | 'text' | 'toolUses' | 'toolResults'>

const NOT_FOUND = 'Could not find this point in the conversation (it may already be summarized). Nothing was changed'

// 地点が e.messages の何番目かを探す。見つからない・1 つに決まらないときは推測せず、要約を断る理由を返す。
// 人の発言は本文が同じものの後ろから fromEnd 番目。同じ本文が無いときに限り、本文で始まるメッセージが 1 つだけならそれを使う
// (エンジンが発言に何かを付けて 1 つのメッセージにしている場合)
export function locatePoint(messages: readonly Message[], r: SummarizeRequest): { index: number } | { skip: string } {
  const hits = (match: (m: Message) => boolean) => messages.flatMap((m, i) => (match(m) ? [i] : []))
  if (r.toolUseId !== undefined) {
    const found = hits(m => m.role === 'assistant' && m.toolUses.some(u => u.tool_use_id === r.toolUseId))
    if (found.length > 1) return { skip: 'This point matches more than one message in the conversation. Nothing was changed' }
    return found[0] === undefined ? { skip: NOT_FOUND } : { index: found[0] }
  }
  const key = promptKey(r.text ?? '')
  if (key === '') return { skip: NOT_FOUND }
  const isPrompt = (m: Message) => m.role === 'user' && (m.toolResults?.length ?? 0) === 0
  const same = hits(m => isPrompt(m) && promptKey(m.text) === key)
  if (same.length > 0) {
    const index = same[same.length - 1 - r.fromEnd]
    return index === undefined ? { skip: NOT_FOUND } : { index }
  }
  const starts = hits(m => isPrompt(m) && promptKey(m.text).startsWith(key))
  return starts.length === 1 && r.fromEnd === 0 && starts[0] !== undefined ? { index: starts[0] } : { skip: NOT_FOUND }
}

// 要約に回す部分と残す部分に分ける。from は地点から後ろを、up_to は地点より前を要約する。
// join は要約の結果 (core が返すメッセージ) を残す部分とつないで、要約した後の会話にする
export function splitForSummary<M extends Message>(messages: readonly M[], r: SummarizeRequest): { summarize: M[]; join: (summary: readonly M[]) => M[] } | { skip: string } {
  const at = locatePoint(messages, r)
  if ('skip' in at) return at
  const before = messages.slice(0, at.index)
  const after = messages.slice(at.index)
  if (r.direction === 'from') return { summarize: after, join: summary => [...before, ...summary] }
  if (before.length === 0) return { skip: 'There is nothing before this point to summarize' }
  return { summarize: before, join: summary => [...summary, ...after] }
}

// /compact を通して要約を頼み終えたときの一言。hook が分けた・断った・(結末が無く) hook まで届かなかったで分ける
export function summarizedMessage(direction: Direction, outcome: SummarizeOutcome | null): string {
  if (outcome?.kind === 'done') return direction === 'from' ? 'Summarized from here' : 'Summarized up to here'
  if (outcome?.kind === 'skip') return `Not summarized: ${outcome.reason}`
  return 'Could not summarize from this point: /compact did not reach better-rewind (it may have summarized the whole conversation)'
}

// 巻き戻しを終えたときの一言
export function doneMessage(mode: Mode, r: Pick<RewindResult, 'restored' | 'removed'>): string {
  const parts = [mode === 'files' ? 'Code restored' : 'Rewound']
  if (mode !== 'conversation') parts.push(plural(r.restored.length + r.removed.length, 'file'))
  if (mode !== 'files') parts.push('see the previous conversation with /better-rewind branches')
  return parts.join(' · ')
}

// 枝の一覧の 1 行目 (いつ・どの地点で) と 2 行目 (どう戻したか)
export function branchLines(b: Branch): { title: string; detail: string } {
  const d = new Date(b.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = Number.isNaN(d.getTime()) ? b.at : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const how = b.answered ? 'Answer changed' : b.mode === 'both' ? 'Code and conversation restored' : 'Conversation restored'
  return { title: `${when}  ${b.label}`, detail: how }
}

// Edit / Write / NotebookEdit が書き換えるファイル。それ以外のツールは undefined
export function editedFile(e: { tool: string }): string | undefined {
  const args = e as { tool: string; file_path?: unknown; notebook_path?: unknown }
  const file = e.tool === 'NotebookEdit' ? args.notebook_path : e.tool === 'Edit' || e.tool === 'Write' ? args.file_path : undefined
  return typeof file === 'string' && file !== '' ? file : undefined
}

// $.fs が「無い」(ENOENT) と断ったか。読み取り権限が無いなどの失敗とは分ける
export function isMissing(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined
  return e?.code === 'ENOENT' || /\bENOENT\b/.test(String(e?.message ?? err))
}

// 控えのファイル名。bin/transcript.mjs の snapName と同じ規則
export const snapName = (id: string) => id.replace(/[^\w-]/g, '_')
