import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Branch, Mode, Point, RewindResult, Snap, Unfinished, View } from '../types'
import type { OptionKey } from './lib'
import {
  BUSY,
  BUSY_SUMMARIZE,
  branchLines,
  changesParts,
  clipToRows,
  doneMessage,
  editedFile,
  isAsk,
  isMissing,
  modeOptions,
  plural,
  pointKey,
  restoreLines,
  snapName,
  splitForSummary,
  summarizeRequest,
  summarizedMessage,
  unfinishedMessage,
  windowAround,
} from './lib'

// /better-rewind で巻き戻し地点 (人の発言と AskUserQuestion の質問) の一覧ペインを開く。見た目は組み込みの Rewind 画面に寄せる:
// 1 地点 2 行 (内容と、そこから次の人の発言までに変わったファイルの要約)、選択中は ❯ と suggestion 色、最後に (現在)。
// キー操作はペインのフォーカスリング (矢印で移動・Enter で決定・Esc で閉じる) に任せ、
// フォーカスの移動を ui.focus で受けてカーソルとし、その地点の AI の返答を下にプレビューする。
// 地点を Enter で選ぶと戻し方 (AskUserQuestion なら続けて回答) を選ばせ、bin/transcript.mjs (node) で記録を切って
// /resume で同じセッションを読み直す。要約を選ぶと添える指示を聞いて $.command.run で /compact を動かし、
// session.compact の hook が地点の前後で要約する部分と残す部分を分ける (記録は書き換えない)。
// $.session.compact は呼ばない: 呼んだ mod 自身の session.compact hook が飛ばされ、会話全体が要約される
// (2026-10-10 実機で確認)。/compact を経由すると hook が trigger 'manual' で呼ばれ、要約が終わってから戻る。
// /better-rewind branches は巻き戻す前の会話を読むだけの一覧。
// Edit / Write / NotebookEdit の直前には tool.call で対象ファイルの控えを取り、ツールが実行されたかを控えに書き足す

const PANE = 'better-rewind'
// 一覧の最後の「(現在)」の key。選ぶと巻き戻さずに閉じる
const CURRENT = 'current'
// 枝の全文から一覧へ戻るボタンの key
const BACK = 'back'
// 回答を自分で書く入力欄の key
const OWN = 'answer:own'
// 回答の段階で 1 つ前へ戻るボタンの key
const ANSWER_BACK = 'answer:back'
// 要約に添える指示の入力欄・指示なしで要約するボタン・戻し方の選択へ戻るボタンの key
const CONTEXT = 'summarize:context'
const SUMMARIZE_NOW = 'summarize:now'
const SUMMARIZE_BACK = 'summarize:back'
// 見出し・説明・一覧前の空行・区切り前の空行・区切り・案内前の空行・案内
const FIXED_ROWS = 7
// 応答の中の地点の字下げ幅
const NEST = 4
// 回答を選び直して読み直したあと、AI に続きを始めさせる一言
// (AI には新しい回答しか見えないので「変えた」とは言わない)
const CONTINUE = 'Continue based on my answer to your question.'
// 要約を地点で分けられなかったときに /compact を断る理由
const SPLIT_FAILED = 'better-rewind could not split the conversation at this point. Nothing was changed'
// $.fs で控えを取る上限。base64 で 4/3 倍になり $.fs.write の 4 MiB に収める。超えたら node で写す
const INLINE_MAX = 2.5 * 1024 * 1024

const points = atom({ plugin: 'better-rewind', key: 'points' } as const, [])
const cursor = atom({ plugin: 'better-rewind', key: 'cursor' } as const, null)
const status = atom({ plugin: 'better-rewind', key: 'status' } as const, '')
const view = atom({ plugin: 'better-rewind', key: 'view' } as const, 'points')
const picked = atom({ plugin: 'better-rewind', key: 'picked' } as const, null)
const mode = atom({ plugin: 'better-rewind', key: 'mode' } as const, null)
const answers = atom({ plugin: 'better-rewind', key: 'answers' } as const, [])
const direction = atom({ plugin: 'better-rewind', key: 'direction' } as const, null)
const pending = atom({ plugin: 'better-rewind', key: 'pending' } as const, null)
const outcome = atom({ plugin: 'better-rewind', key: 'outcome' } as const, null)
const sub = atom({ plugin: 'better-rewind', key: 'sub' } as const, null)
const branches = atom({ plugin: 'better-rewind', key: 'branches' } as const, [])
const opened = atom({ plugin: 'better-rewind', key: 'opened' } as const, null)
const isOpen = atom({ plugin: 'better-rewind', key: 'isOpen' } as const, false)
const isRunning = atom({ plugin: 'better-rewind', key: 'isRunning' } as const, false)

type Ui = Elements[RenderSurface]

// node の呼び出しの既定の時間切れ。巻き戻しは書き込みの途中で打ち切られないよう、$.process.run の上限 (10 分) にする
const NODE_TIMEOUT = 60_000
const REWIND_TIMEOUT = 600_000

type NodeOut<T> = Partial<T> & {
  error?: string
  // helper が答えを返さなかった (起動できない・時間切れ・読めない出力)。途中まで進んだかもしれない
  isUnknown?: true
}

// bin/transcript.mjs を呼んで、最後の行の JSON を返す。helper が答えなければ error に理由を入れ、isUnknown を立てる (reject しない)
async function node<T>($: EngineInterface, args: string[], stdin?: string, timeoutMs = NODE_TIMEOUT): Promise<NodeOut<T>> {
  let r: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    r = await $.process.run(['node', `${$.plugin.root}/bin/transcript.mjs`, ...args], { timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
  } catch (err) {
    return { error: `better-rewind's helper did not finish (${String(err)})`, isUnknown: true } as NodeOut<T>
  }
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1) || '') as NodeOut<T>
    if (out && typeof out === 'object') return out
  } catch {
    // 下で読めない答えとして扱う
  }
  return { error: `better-rewind's helper gave no answer${r.stderr ? ` (${r.stderr.trim().slice(0, 120)})` : ''}`, isUnknown: true } as NodeOut<T>
}

async function loadPoints($: EngineInterface): Promise<Point[]> {
  await update($, status, () => 'Loading…')
  const out = await node<{ points: Point[]; unfinished: Unfinished[] }>($, ['points', await $.session.id()])
  if (!out.points) {
    await update($, status, () => `Could not load: ${out.error ?? ''}`)
    return []
  }
  await update($, points, () => out.points ?? [])
  // 前に途中で打ち切られた巻き戻しがあれば 1 度だけ知らせる (helper が知らせた印を付ける)
  const warning = unfinishedMessage(out.unfinished ?? []) ?? ''
  await update($, status, () => warning)
  if (warning) $.ui.toast(warning, LONG_TOAST)
  return out.points
}

// 段階を切り替え、キーボードをその段階の要素に置く
async function showView($: EngineInterface, v: View, key: string) {
  await update($, view, () => v)
  await update($, sub, () => (v === 'points' ? null : key))
  if (v === 'points') await update($, cursor, () => (key === CURRENT ? null : key))
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

async function closePane($: EngineInterface) {
  await update($, isOpen, () => false)
  await update($, view, () => 'points')
  await $.ui.close({ id: PANE })
}

async function refuseWhileRunning($: EngineInterface, message = BUSY): Promise<boolean> {
  if (!(await read($, isRunning))) return false
  await update($, status, () => message)
  $.ui.toast(message)
  return true
}

// 長い知らせ (ファイルの場所を含むもの) は読めるだけの間出しておく
const LONG_TOAST = { timeoutMs: 15_000 }

// Enter で地点を選んだとき。(現在) なら閉じる。それ以外は戻し方の段階へ (選べるのが「やめる」だけの地点は断る)
async function choose($: EngineInterface, p: Point | undefined) {
  if (!p) return closePane($)
  if (await refuseWhileRunning($)) return
  const options = modeOptions(p, await read($, points))
  if (options.length <= 1) {
    $.ui.toast('Cannot rewind to this point (the conversation cannot be cut or summarized here and no file backups exist)')
    return
  }
  await update($, picked, () => p)
  await update($, mode, () => null)
  await update($, answers, () => [])
  await update($, direction, () => null)
  await update($, status, () => '')
  await showView($, 'modes', `mode:${options[0]?.key ?? 'cancel'}`)
}

async function pickMode($: EngineInterface, p: Point, m: OptionKey) {
  if (m === 'cancel') return showView($, 'points', pointKey(p))
  if (m === 'summarize' || m === 'summarize_up_to') {
    await update($, direction, () => (m === 'summarize' ? 'from' : 'up_to'))
    return showView($, 'summarize', CONTEXT)
  }
  if (isAsk(p) && m !== 'files') {
    await update($, mode, () => m)
    await update($, answers, () => [])
    return showView($, 'answer', 'answer:0')
  }
  return execute($, p, m)
}

// 要約に添える指示を受けて (空でもよい)、ペインを閉じて /compact を動かす。どこで分けるかは session.compact の hook が
// pending を読んで決め、どうしたかを outcome に残す。終わったらそれを読んで知らせる。ファイルには触れず、枝も残さない
async function summarize($: EngineInterface, p: Point, context: string) {
  if (await refuseWhileRunning($, BUSY_SUMMARIZE)) return
  const d = await read($, direction)
  const request = d ? summarizeRequest(p, await read($, points), d) : undefined
  if (!request) {
    const msg = 'Cannot summarize from this point'
    await update($, status, () => msg)
    $.ui.toast(msg)
    return
  }
  await update($, status, () => '')
  await closePane($)
  await update($, outcome, () => null)
  await update($, pending, () => request)
  $.ui.status('Summarizing…')
  const instructions = context.trim()
  try {
    await $.command.run({ command: 'compact', ...(instructions ? { args: instructions } : {}) })
    $.ui.toast(summarizedMessage(request.direction, await read($, outcome)))
  } catch (err) {
    // hook が断った後で /compact が失敗を返しても、断った理由の方を出す
    const o = await read($, outcome)
    $.ui.toast(o?.kind === 'skip' ? summarizedMessage(request.direction, o) : `Could not summarize: ${String(err)}`)
  } finally {
    $.ui.status(undefined)
    await update($, pending, () => null)
  }
}

// 質問 1 つ分の回答。全部そろったら巻き戻す
async function giveAnswer($: EngineInterface, p: Point, text: string) {
  const answer = text.trim()
  const m = await read($, mode)
  if (!answer || !m) return
  const given = [...(await read($, answers)), answer]
  if (given.length < (p.questions?.length ?? 0)) {
    await update($, answers, () => given)
    return showView($, 'answer', 'answer:0')
  }
  return execute($, p, m, given)
}

// 回答の段階で 1 つ前へ。1 問目なら戻し方の選択へ戻る
async function stepBack($: EngineInterface, p: Point) {
  const given = await read($, answers)
  if (given.length === 0) return showView($, 'modes', `mode:${(await read($, mode)) ?? modeOptions(p, await read($, points))[0]?.key ?? 'cancel'}`)
  await update($, answers, () => given.slice(0, -1))
  return showView($, 'answer', 'answer:0')
}

// ログに書く (知らせの文に出さない生の理由)。ログの失敗は巻き戻しに響かせない
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`better-rewind: ${text}`)
  } catch {
    // ログが書けなくても続ける
  }
}

// 記録を切り (とファイルを戻し)、同じセッションを読み直す。回答を選び直したときは Claude に続きを始めさせ、
// 人の発言の地点ではその発言を入力欄に戻す (会話を戻したときだけ)。
// helper の失敗 (error) では、ふつう記録もファイルも変わっていない (書き戻せなかったファイルは error の文に場所が出る)。
// ただし戻し終えた後で終わった印を書けなかったときは、error に transcriptChanged と戻した結果 (restored など) が付いてくる。
// 記録が書き換わっていれば (transcriptChanged: true) 読み直してから知らせ、ファイルだけ戻したときは戻した件数と一緒に知らせる。
// helper が答えなかったとき (isUnknown) は途中まで進んだかもしれないので、会話を戻す巻き戻しなら読み直して知らせる
async function execute($: EngineInterface, p: Point, m: Mode, given?: string[]) {
  if (await refuseWhileRunning($)) return
  await update($, status, () => 'Rewinding…')
  const sessionId = await $.session.id()
  const spec = { uuid: p.uuid, toolUseId: p.toolUseId, label: p.label, mode: m, answers: given }
  const out = await node<RewindResult>($, ['rewind', sessionId], JSON.stringify(spec), REWIND_TIMEOUT)
  const isUnknown = out.isUnknown === true || (out.error === undefined && (!out.restored || !out.removed))
  const changed = out.transcriptChanged === true
  // 戻し終えた後の失敗 (戻した結果が付いている)
  const finished = out.error !== undefined && Array.isArray(out.restored) && Array.isArray(out.removed)
  if (out.error !== undefined && !isUnknown && !changed && !finished) {
    const msg = `Rewind failed: ${out.error}`
    await update($, status, () => msg)
    $.ui.toast(msg, LONG_TOAST)
    return
  }
  await update($, status, () => '')
  await closePane($)
  if (isUnknown) {
    // 生の理由 (時間切れ・起動できない・読めない出力) はログへ。知らせには利用者が次にすることを書く
    log($, `the rewind did not report back: ${out.error ?? 'no answer'}`)
    // 記録が書き換わったか分からない。読み直せば、動いている会話を記録に合わせられる (変わっていなければ同じ会話が戻る)
    const reloaded = m !== 'files' && (await $.command.run({ command: 'resume', args: sessionId }).then(() => true, () => false))
    const next = m === 'files' ? '' : reloaded ? ' The conversation was reloaded in case it changed.' : ` Run /resume ${sessionId} to reload the conversation in case it changed.`
    $.ui.toast(
      `The rewind may not have finished: it stopped before reporting back (for example, because it ran longer than 10 minutes).${next} If it stopped partway, the next time you open /better-rewind it tells you which files may be affected and where their earlier contents are`,
      LONG_TOAST,
    )
    return
  }
  if (m !== 'files' || changed) {
    try {
      await $.command.run({ command: 'resume', args: sessionId })
    } catch (err) {
      $.ui.toast(`The transcript was rewound but could not be reloaded. Run /resume ${sessionId} (${String(err)})`, LONG_TOAST)
      return
    }
    if (out.error !== undefined) {
      $.ui.toast(`The conversation was rewound and reloaded, but part of it failed: ${out.error}`, LONG_TOAST)
      return
    }
    if (given) void $.prompt.submit({ text: CONTINUE }).catch(() => undefined)
    else if (p.kind === 'prompt' && p.text) await $.prompt.fill({ text: p.text }).catch(() => undefined)
  }
  const done = doneMessage(m, { restored: out.restored ?? [], removed: out.removed ?? [], skipped: out.skipped ?? [] })
  // ファイルだけ戻した後の失敗は、戻したことと一緒に知らせる
  if (out.error !== undefined) $.ui.toast(`${done}. ${out.error}`, LONG_TOAST)
  else $.ui.toast(done)
}

// 控えの保存先 (<設定フォルダ>/better-rewind/<session>)。セッションごとに 1 度だけ node に聞く
const dataDirs = new Map<string, Promise<string>>()
function dataDir($: EngineInterface, sessionId: string): Promise<string> {
  const known = dataDirs.get(sessionId)
  if (known) return known
  const asked = node<{ dir: string }>($, ['dir', sessionId]).then(out => {
    if (!out.dir) throw new Error(out.error ?? 'Backup folder not found')
    return out.dir
  })
  dataDirs.set(sessionId, asked)
  asked.catch(() => dataDirs.delete(sessionId))
  return asked
}

// Edit / Write / NotebookEdit の実行直前の中身を snaps/<tool_use id>.json (と .b64) に控える (state は 'pending')。
// 無いファイル (ENOENT) は「無かった」と記録する。あるのに読めないなど他の理由で stat に失敗したら控えを取らない
// (「無かった」と控えると、戻すときに消してしまう)。エラーに ENOENT が読めないときは exists で確かめる。
// 大きいファイルは node に写させる。返す値は書いた情報 (ファイルでないものは控えないので undefined)。
// $.fs で読んだ中身 (base64) は、ツールが断られたときにファイルが変わったかを比べるために、書いた情報の外で持って返す
type Taken = Snap & { base64?: string }
async function snapshot($: EngineInterface, toolUseId: string, tool: string, file: string): Promise<Taken | undefined> {
  const sessionId = await $.session.id()
  const dir = `${await dataDir($, sessionId)}/snaps`
  const id = snapName(toolUseId)
  const meta: Snap = { toolUseId, tool, path: file, at: Date.now(), existed: false, state: 'pending' }
  const stat = await $.fs.stat(file).catch(async (err: unknown) => {
    if (isMissing(err) || !(await $.fs.exists(file))) return undefined
    throw err
  })
  if (stat && stat.kind !== 'file') return undefined
  if (stat && stat.size > INLINE_MAX) {
    const out = await node<Snap>($, ['snap', sessionId, toolUseId, tool, file, String(meta.at)])
    if (out.error !== undefined) throw new Error(out.error)
    return { ...meta, existed: true, data: `${id}.bin` }
  }
  if (stat) {
    const { base64 } = await $.fs.read(file, { as: 'bytes' })
    const taken: Snap = { ...meta, existed: true, data: `${id}.b64` }
    // 中身を書いてから情報を書く (情報があれば中身もある)
    await $.fs.write(`${dir}/${id}.b64`, base64)
    await $.fs.write(`${dir}/${id}.json`, JSON.stringify(taken))
    return { ...taken, base64 }
  }
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify(meta))
  return meta
}

// 控えに失敗したとき: 利用者に知らせ、「控えが無い」印 (failed) を残す。印があれば、後でこの時点より前へ戻すとき
// このファイルを途中の版へ黙って戻さずに「戻さない」と出せる。印も書けなければ undefined
async function snapFailed($: EngineInterface, toolUseId: string, tool: string, file: string, err: unknown): Promise<Snap | undefined> {
  $.ui.log(`better-rewind: could not back up ${file}: ${String(err)}`)
  $.ui.toast(`better-rewind could not back up ${file} before ${tool} changed it, so Restore code cannot bring back its earlier contents`, LONG_TOAST)
  const marker: Snap = { toolUseId, tool, path: file, at: Date.now(), existed: false, state: 'pending', failed: true }
  try {
    await $.fs.write(`${await dataDir($, await $.session.id())}/snaps/${snapName(toolUseId)}.json`, JSON.stringify(marker))
    return marker
  } catch {
    return undefined
  }
}

// 拒否・失敗の結果が来たのに、ファイルが控えた時から変わっているか。後段の hook がツールの実行後に断ったときや、
// ツールが途中で止まったときに起きる。読めないなど比べられなければ throw する (控えは 'pending' のまま残り、
// 後で戻すときに「実行されたか分からない」として途中の版へ黙って戻さない)
async function changedSince($: EngineInterface, taken: Taken, file: string): Promise<boolean> {
  if (!taken.existed) return $.fs.exists(file)
  // 消えていれば変わった。ほかの理由で読めなければ比べられない
  const now = await $.fs.read(file, { as: 'bytes' }).catch(async (err: unknown) => {
    if (isMissing(err) || !(await $.fs.exists(file))) return undefined
    throw err
  })
  return now === undefined || now.base64 !== taken.base64
}

// ツールの結果を見て控えの state を決める。実行されたら 'ran'。拒否・失敗でもファイルが変わっていれば、実行された
// (控えはその直前の中身) として 'ran' にする。変わっていなければ戻す対象から外し ('denied')、中身を消す (人が拒んだ
// ファイルの中身を残さない)。控えに失敗した印は、拒否・失敗のとき比べる中身が無いので 'pending' のまま残す。
// 大きいファイル (.bin) は node が比べて決める。ここでの失敗はツールの結果に響かせない
async function settleSnap($: EngineInterface, taken: Taken, file: string, ran: boolean) {
  const sessionId = await $.session.id()
  const dir = `${await dataDir($, sessionId)}/snaps`
  const id = snapName(taken.toolUseId)
  const { base64: _, ...snap } = taken
  if (!ran && snap.failed === true) return
  const isBig = snap.data !== undefined && !snap.data.endsWith('.b64')
  if (ran || (!isBig && (await changedSince($, taken, file)))) {
    await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ ...snap, state: 'ran' }))
    return
  }
  const { data, ...rest } = snap
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ ...rest, state: 'denied' }))
  if (data?.endsWith('.b64')) await $.fs.write(`${dir}/${data}`, '')
  // 大きいファイルは node が今の中身と比べ、変わっていれば控えを 'ran' に戻し、変わっていなければ中身ごと消す
  else if (data) await node($, ['drop', sessionId, taken.toolUseId])
}

async function openBranches($: EngineInterface) {
  const out = await node<{ branches: Branch[] }>($, ['branches', await $.session.id()])
  const list = out.branches ?? []
  await update($, branches, () => list)
  await update($, opened, () => null)
  await update($, status, () => (out.branches ? '' : `Could not load: ${out.error ?? ''}`))
  await update($, view, () => 'branches')
  await update($, sub, () => list[0]?.id ?? null)
  const placed = await $.ui.open({ id: PANE, title: 'Better Rewind', focus: true, closeOnEscape: true })
  await update($, isOpen, () => true)
  if (list[0]) await $.ui.focus({ requestId: PANE, key: list[0].id }).catch(() => undefined)
  return { text: `Opened ${plural(list.length, 'saved conversation')}${placed.isPlaced ? '' : ' (waiting: terminal too narrow)'}` }
}

// 枝の全文を開く (id) か一覧へ戻る (null)。focus は次に置くキー
async function openBranch($: EngineInterface, id: string | null, focus: string) {
  await update($, opened, () => id)
  await showView($, id === null ? 'branches' : 'branch', focus)
}

// 見出しと説明の 2 行。どの段階でも同じ
function header(ui: Ui, line: string) {
  const { Text } = ui
  return [
    <Text key="title" bold color="suggestion">
      Better Rewind
    </Text>,
    <Text key="lead">{line}</Text>,
  ]
}

// 段階の選択肢 1 行。一覧と同じく ❯ の 1 文字ボタンと suggestion 色
function choiceRow(ui: Ui, key: string, label: string, isFocused: boolean, onPress: () => void, detail?: string) {
  const { Box, Text, Button } = ui
  return (
    <Box key={`row:${key}`} flexDirection="column">
      <Box flexDirection="row">
        <Button key={key} plain label={isFocused ? '❯' : ' '} onPress={onPress} />
        <Text> </Text>
        <Text color={isFocused ? 'suggestion' : undefined} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      {detail && (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {detail}
        </Text>
      )}
    </Box>
  )
}

function footer(ui: Ui, note: string, hint: string) {
  const { Box, Text } = ui
  return (
    <Box key="footer" flexDirection="column" marginTop={1}>
      {note && <Text color="warning">{note}</Text>}
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

async function renderModes($: EngineInterface, ui: Ui, p: Point) {
  const { Box, Text } = ui
  const focus = await read($, sub)
  const options = modeOptions(p, await read($, points))
  const at = options.some(o => `mode:${o.key}` === focus) ? focus : `mode:${options[0]?.key}`
  // Restore code が戻すファイル: rewind と同じ計画 (地点より後の発言で変わったファイルも含む) を helper から受け取って出す
  const r = restoreLines(p.restore)
  return (
    <Box flexDirection="column">
      {header(ui, isAsk(p) ? `Change your answer to "${p.label}"` : `Rewind to just before "${p.label}"`)}
      <Box flexDirection="column" marginTop={1}>
        {options.map(o => choiceRow(ui, `mode:${o.key}`, o.label, `mode:${o.key}` === at, () => void pickMode($, p, o.key)))}
      </Box>
      {(p.restorable || r.skipped) && (
        <Box flexDirection="column" marginTop={1}>
          {p.restorable && (
            <Text key="restore:lead" dimColor wrap="truncate-end">
              {r.lead}
            </Text>
          )}
          {p.restorable &&
            r.files.map((f, i) => (
              <Text key={`restore:${i}`} dimColor wrap="truncate-end">
                {'  '}
                {f}
              </Text>
            ))}
          {r.skipped && (
            <Text key="restore:skipped" color="warning" wrap="truncate-end">
              {r.skipped}
            </Text>
          )}
        </Box>
      )}
      {footer(ui, await read($, status), '↑↓ to select · Enter to confirm · Esc to close')}
    </Box>
  )
}

// 要約に添える指示を聞く段階。組み込みと同じく指示は任意で、空のまま Enter でも要約する
async function renderSummarize($: EngineInterface, ui: Ui, p: Point) {
  const { Box, Text } = ui
  const d = await read($, direction)
  const focus = await read($, sub)
  const back = `mode:${d === 'up_to' ? 'summarize_up_to' : 'summarize'}`
  return (
    <Box flexDirection="column">
      {header(ui, d === 'up_to' ? `Summarize up to "${p.label}"` : `Summarize from "${p.label}"`)}
      <Box marginTop={1}>
        <Text dimColor>
          {d === 'up_to'
            ? 'Messages before this point are replaced with a summary. This point and later stay as they are. Files are not changed'
            : 'This point and everything after it are replaced with a summary. Earlier messages stay as they are. Files are not changed'}
        </Text>
      </Box>
      {/* 入力欄の無い画面 (mobile) では指示なしで要約するボタンだけ。ラベルの後ろの「: 」は入力欄が自分で描く */}
      {'Input' in ui && (
        <Box marginTop={1}>
          <ui.Input key={CONTEXT} label="Add context (optional)" placeholder="What the summary should keep" submitLabel="Summarize" onSubmit={(value: string) => void summarize($, p, value)} />
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {choiceRow(ui, SUMMARIZE_NOW, 'Summarize without context', focus === SUMMARIZE_NOW, () => void summarize($, p, ''))}
        {choiceRow(ui, SUMMARIZE_BACK, 'Back to rewind options', focus === SUMMARIZE_BACK, () => void showView($, 'modes', back))}
      </Box>
      {footer(ui, await read($, status), 'Enter to summarize · Esc to close')}
    </Box>
  )
}

async function renderAnswer($: EngineInterface, ui: Ui, p: Point) {
  const { Box, Text } = ui
  const questions = p.questions ?? []
  const done = (await read($, answers)).length
  const q = questions[done]
  if (!q) return <Text dimColor>No questions</Text>
  const focus = await read($, sub)
  const options = q.options ?? []
  const count = questions.length > 1 ? ` (${done + 1}/${questions.length})` : ''
  return (
    <Box flexDirection="column">
      {header(ui, `${q.header ? `${q.header}: ` : ''}${q.question}${count}`)}
      <Box flexDirection="column" marginTop={1}>
        {options.map((o, i) => choiceRow(ui, `answer:${i}`, o.label, `answer:${i}` === focus, () => void giveAnswer($, p, o.label), o.description))}
        {choiceRow(ui, ANSWER_BACK, done > 0 ? 'Back to previous question' : 'Back to rewind options', focus === ANSWER_BACK, () => void stepBack($, p))}
      </Box>
      {/* 入力欄の無い画面 (mobile) では選択肢だけ */}
      {'Input' in ui && (
        <Box marginTop={1}>
          <ui.Input
            key={OWN}
            label="Your answer"
            placeholder={q.multiSelect ? 'Separate multiple answers with commas' : 'Type an answer and press Enter'}
            submitLabel="Answer"
            onSubmit={(value: string) => void giveAnswer($, p, value)}
          />
        </Box>
      )}
      {footer(ui, await read($, status), '↑↓ to select · Enter to confirm · Esc to close')}
    </Box>
  )
}

async function renderBranches($: EngineInterface, ui: Ui, rows: number, columns: number) {
  const { Box, Text, Markdown } = ui
  const list = await read($, branches)
  const note = await read($, status)
  const openId = await read($, opened)
  const shown = list.find(b => b.id === openId)

  // 全文: 読むだけ。一覧へ戻るボタンを最後に置く
  if (shown) {
    const lines = branchLines(shown)
    return (
      <Box flexDirection="column">
        {header(ui, `${lines.title} (${lines.detail})`)}
        <Box flexDirection="column" marginTop={1}>
          <Markdown text={shown.text || '(no conversation)'} />
        </Box>
        <Box marginTop={1}>{choiceRow(ui, BACK, 'Back to list', true, () => void openBranch($, null, shown.id))}</Box>
        {footer(ui, '', 'Enter to go back · Esc to close')}
      </Box>
    )
  }

  if (list.length === 0) return <Text dimColor>{note || 'No saved conversations yet'}</Text>
  const focus = await read($, sub)
  const found = list.findIndex(b => b.id === focus)
  const index = found >= 0 ? found : 0
  const previewRows = Math.min(10, Math.max(3, Math.floor(rows * 0.3)))
  const visible = Math.max(1, Math.floor((rows - FIXED_ROWS - previewRows + 1) / 3))
  const [start, end] = windowAround(index, list.length, visible)
  const items = list.slice(start, end).map((b, i) => {
    const lines = branchLines(b)
    return (
      <Box key={`gap:${b.id}`} marginTop={i > 0 ? 1 : 0}>
        {choiceRow(ui, b.id, lines.title, start + i === index, () => void openBranch($, b.id, BACK), lines.detail)}
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      {header(ui, 'Saved conversations (read-only)')}
      <Box flexDirection="column" marginTop={1}>
        {items}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>── Conversation after the rewind point</Text>
      </Box>
      <Markdown text={clipToRows(list[index]?.text || '(no conversation)', previewRows, columns)} />
      {footer(ui, note, '↑↓ to select · Enter to read all · Esc to close')}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, isRunning, () => false)
    await $.command.register({ name: 'better-rewind', description: 'Rewind or summarize from any prompt or question', argumentHint: '[branches]' })
    return started
  })

  on('command.run', { command: 'better-rewind' }, async ($, e) => {
    if (e.args.trim() === 'branches') return openBranches($)
    await update($, cursor, () => null)
    await update($, view, () => 'points')
    await update($, sub, () => null)
    const list = await loadPoints($)
    const opened = await $.ui.open({ id: PANE, title: 'Better Rewind', focus: true, closeOnEscape: true })
    await update($, isOpen, () => true)
    // キーボードを一覧の (現在) に置く。渡せなかったときは Tab かクリックで渡せることを案内する (理由はログへ)
    const focused = await $.ui.focus({ requestId: PANE, key: CURRENT }).catch((err: unknown) => ({ deny: String(err) }))
    if ('deny' in focused) $.ui.log(`better-rewind: could not move keyboard focus: ${focused.deny}`)
    const note = 'deny' in focused ? ' (press Tab or click the list to use the keyboard there)' : ''
    return { text: `Opened ${plural(list.length, 'rewind point')}${opened.isPlaced ? '' : ' (waiting: terminal too narrow)'}${note}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpen, () => false)
      await update($, view, () => 'points')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // AI が応答している間は巻き戻しを断る (記録へ書き足している最中に切ると壊れる)
  on('turn.start', async ($, e, next) => {
    await update($, isRunning, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  // 応答が終わったら断るのをやめ、開いているペインは地点を読み直す (戻し方・回答・要約の段階でも、
  // 要約の頼みで同じ本文の発言を後ろから数えるのに新しい一覧を使う)
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await update($, isRunning, () => false)
      const v = await read($, view)
      if ((await read($, isOpen)) && v !== 'branches' && v !== 'branch') await loadPoints($)
    }
    return done
  })

  // ペインから頼んだ要約 (pending) だけを、地点の前後で分けて行う。ペインは /compact を動かすので trigger は manual
  // (plugin も同じに扱う)。from は地点から後ろを、up_to は地点より前を core に要約させ、残す部分とつなぐ。
  // 頼みの無い /compact・自動の要約・subagent の要約には手を付けずに通す
  on('session.compact', async ($, e, next) => {
    if ((e.trigger !== 'manual' && e.trigger !== 'plugin') || e.agentId !== undefined) return next(e)
    const request = await read($, pending)
    if (!request) return next(e)
    // 頼み 1 つで分けるのは 1 回だけ。先に下ろして、後から来た要約を分けない
    await update($, pending, () => null)
    let result: Awaited<ReturnType<typeof next>>
    try {
      const split = splitForSummary(e.messages, request)
      if ('skip' in split) result = { skip: split.skip }
      else {
        const done = await next({ ...e, messages: split.summarize })
        result = done.skip !== undefined ? done : { ...done, messages: split.join(done.messages) }
      }
    } catch {
      // 分ける途中や core の要約で失敗したら断る。next(e) に任せると、会話全体の要約か、要約した部分だけ (残す部分が消える) になる
      result = { skip: SPLIT_FAILED }
    }
    await update($, outcome, () => (result.skip !== undefined ? { kind: 'skip' as const, reason: result.skip } : { kind: 'done' as const })).catch(() => undefined)
    return result
  })
    // ここに来るのは頼みを下ろす前の失敗だけ。分けずにそのまま通す
    .catch(($, e, next) => next(e))

  // 書き換える直前のファイルを控える。控えに失敗してもツールは止めない (知らせて印を残す)。
  // 控えは権限の確認より前に取るので、ツールの結果を見て、実行された呼び出しの控えだけを戻す対象にする
  // (拒否・失敗した呼び出しの控えで、人が拒んだファイルを後から書き換えない)
  on('tool.call', async ($, e, next) => {
    const file = editedFile(e)
    if (file === undefined) return next(e)
    const taken: Taken | undefined = await snapshot($, e.tool_use_id, e.tool, file).catch((err: unknown) => snapFailed($, e.tool_use_id, e.tool, file, err))
    const result = await next(e)
    if (taken) await settleSnap($, taken, file, result.deny === undefined && result.isError !== true).catch((err: unknown) => log($, `could not record whether ${e.tool} ran on ${file}: ${String(err)}`))
    return result
  }).catch(($, e, next) => next(e))

  // 矢印・Tab・クリックでフォーカスが動いたら、それをカーソルにする (一覧以外の段階では sub に)
  on('ui.focus', async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId === PANE && e.element) {
      const key = e.element
      if ((await read($, view)) === 'points') await update($, cursor, () => (key === CURRENT ? null : key))
      else await update($, sub, () => key)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const rows = e.viewport?.rows ?? 24
    const columns = e.viewport?.columns ?? 80
    const v = await read($, view)
    const p = await read($, picked)
    if (v === 'modes' && p) return renderModes($, ui, p)
    if (v === 'answer' && p) return renderAnswer($, ui, p)
    if (v === 'summarize' && p) return renderSummarize($, ui, p)
    if (v === 'branches' || v === 'branch') return renderBranches($, ui, rows, columns)

    const list = await read($, points)
    const note = await read($, status)
    if (list.length === 0) return <Text dimColor>{note || 'No rewind points'}</Text>

    const at = await read($, cursor)
    const found = at === null ? -1 : list.findIndex(p => pointKey(p) === at)
    // 一覧の並び: 地点のあとに (現在)。カーソルが無ければ (現在)
    const index = found >= 0 ? found : list.length
    const selected = found >= 0 ? list[found] : undefined

    const previewRows = Math.min(10, Math.max(3, Math.floor(rows * 0.3)))
    // 1 地点 = 2 行 + 地点のあいだの空行 1 行 (組み込みと同じ間隔)
    const visible = Math.max(1, Math.floor((rows - FIXED_ROWS - previewRows + 1) / 3))
    const [start, end] = windowAround(index, list.length + 1, visible)

    const items = []
    for (let i = start; i < end; i++) {
      const isFocused = i === index
      const p = list[i]
      const key = p ? pointKey(p) : CURRENT
      const c = p ? changesParts(p.changes) : undefined
      // 人の発言 (組み込みの rewind に出る項目) を上の階層に置き、その応答の中の地点は字下げする
      const isNested = p !== undefined && p.kind !== 'prompt'
      items.push(
        <Box key={`row:${key}`} flexDirection="column" marginTop={i > start ? 1 : 0} paddingLeft={isNested ? NEST : 0}>
          <Box flexDirection="row">
            <Button key={key} plain label={isFocused ? '❯' : ' '} onPress={() => void choose($, p)} />
            <Text> </Text>
            <Text color={isFocused ? 'suggestion' : undefined} italic={!p || undefined} wrap="truncate-end">
              {p ? `${p.kind === 'prompt' ? '' : '● '}${p.label}` : '(current)'}
            </Text>
          </Box>
          {c && (
            <Text color="inactive" dimColor={!isFocused} wrap="truncate-end">
              {'  '}
              {c.text}
              {c.added && <Text color="success"> {c.added}</Text>}
              {c.removed && <Text color="error"> {c.removed}</Text>}
            </Text>
          )}
        </Box>,
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold color="suggestion">
          Better Rewind
        </Text>
        <Text>Restore the code and/or conversation to the point before…</Text>
        <Box flexDirection="column" marginTop={1}>
          {items}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>── Claude's reply from this point</Text>
        </Box>
        {/* AI の返答と同じ描き方 (見出し・強調・コード)。行数は元の文で見積もって切る */}
        <Markdown text={clipToRows(selected ? selected.reply || '(no reply)' : 'This is the current state', previewRows, columns)} />
        <Box marginTop={1}>
          <Text dimColor>↑↓ to select · Enter to confirm · Esc to close</Text>
        </Box>
      </Box>
    )
  })
}
