// 記録ファイル (セッション jsonl) から巻き戻し地点を取り出し、巻き戻しを行う。mod から node で呼ぶ
//   node transcript.mjs points <sessionId>
//   node transcript.mjs rewind <sessionId> [specFile]    spec (JSON) は specFile か stdin から
//   node transcript.mjs snap <sessionId> <toolUseId> <tool> <path> [atMs]
//   node transcript.mjs branches <sessionId>
//   node transcript.mjs dir <sessionId>
// 結果は stdout に JSON 1 行で返す。$.fs は 4 MiB までなので、記録と大きなファイルはここで扱う
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPLY_MAX = 1500
const POINTS_MAX = 400
const LABEL_MAX = 60
const BRANCH_TEXT_MAX = 20000
const PROMPT_TEXT_MAX = 20000
const MODES = ['both', 'conversation', 'files']

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function findTranscript(sessionId, base = configDir()) {
  const projects = path.join(base, 'projects')
  for (const dir of fs.readdirSync(projects)) {
    const p = path.join(projects, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p)) return p
  }
  throw new Error(`transcript not found: ${sessionId}`)
}

// mod の保存先: <設定フォルダ>/better-rewind/<session>/ の下に snaps (ファイルの控え) と branches (巻き戻す前の記録)
export function dataDir(sessionId, base = configDir()) {
  if (!/^[\w-]+$/.test(String(sessionId ?? ''))) throw new Error(`Invalid session id: ${sessionId}`)
  return path.join(base, 'better-rewind', sessionId)
}

export function readRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const oneLine = (s, max = LABEL_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const textOf = content =>
  typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')

const timeOf = row => {
  const t = Date.parse(row?.timestamp ?? '')
  return Number.isNaN(t) ? undefined : t
}

const hasToolUse = r => r?.type === 'assistant' && (r.message?.content ?? []).some?.(b => b.type === 'tool_use')
const isThinkingOnly = r => {
  const c = r?.type === 'assistant' && r.message?.content
  return Array.isArray(c) && c.length > 0 && c.every(b => b.type === 'thinking' || b.type === 'redacted_thinking')
}

// ツール呼び出しを 1 行で言う: Edit foo.ts / Bash npm test / AskUserQuestion 最初の質問
export function toolLabel(name, input = {}) {
  const base = p => String(p).split(/[\\/]/).pop()
  const arg =
    input.file_path ? base(input.file_path)
    : input.notebook_path ? base(input.notebook_path)
    : input.description ? input.description
    : input.command ? input.command
    : input.questions ? input.questions[0]?.question
    : input.skill ? input.skill
    : input.pattern ?? input.url ?? input.query ?? input.prompt ?? ''
  return oneLine(`${name} ${arg}`)
}

// 人の発言の本文 (ツール結果・meta・コマンドの記録なら null)。コマンドは /name として返す。
// 要約の跡 (要約の本文の行と /compact の行) も人の発言にしない (2026-10-10 実機で一覧に出ていた)
function promptText(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary === true) return null
  const c = row.message?.content
  if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) return null
  const text = textOf(c)
  const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/)
  if (cmd?.[1].trim() === 'compact') return null
  if (cmd) return `/${cmd[1]}`
  if (/^<(local-command|command-|bash-)/.test(text.trim())) return null
  return text
}

const pasted = text => text.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[Pasted text]')

// 人の発言か。ラベルは 1 行に縮め、貼り付けた文章は [Pasted text] にする
function humanPrompt(row) {
  const text = promptText(row)
  return text === null ? null : { label: oneLine(pasted(text)) }
}

// Edit/Write の結果 (toolUseResult) から、変えたファイルと増減の行数を数える。失敗した呼び出しは数えない
export function editStats(toolUseResult) {
  const t = toolUseResult
  if (!t || typeof t !== 'object' || typeof t.filePath !== 'string') return null
  let added = 0
  let removed = 0
  if (t.type === 'create' && typeof t.content === 'string') {
    added = t.content.split('\n').length - (t.content.endsWith('\n') ? 1 : 0)
  } else if (Array.isArray(t.structuredPatch)) {
    for (const hunk of t.structuredPatch)
      for (const line of hunk.lines ?? []) {
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
  } else {
    return null
  }
  return { file: t.filePath, added, removed }
}

const EMPTY_LEAF = /^0{8}-0{4}-0{4}-0{4}-0{12}$/

// 今の会話の先端。ふつうは subagent 以外で最後に書かれた uuid の行。
// ただし最後の uuid 行より後に書かれた last-prompt が記録にある行を指していれば、そちらを先端にする
// (この mod が切った直後。切った位置の手前に、先端の兄弟の attachment / system 行が書かれていることがある)。
// 空の leafUuid (0000…) は使わない: 組み込みの rewind の後に書かれ、その後の会話には last-prompt が
// 無いことがある (2026-10-10 に実際の記録で確認)
export function leafOf(rows) {
  const last = rows.findLastIndex(r => r.uuid && !r.isSidechain)
  const prompt = rows.findLastIndex(r => r.type === 'last-prompt')
  const leafUuid = rows[prompt]?.leafUuid
  if (prompt > last && typeof leafUuid === 'string' && !EMPTY_LEAF.test(leafUuid)) {
    const row = rows.find(r => r.uuid === leafUuid)
    if (row && !row.isSidechain) return leafUuid
  }
  return rows[last]?.uuid
}

// 今の会話の行だけを返す。先端 (leafOf) から parentUuid を辿り、巻き戻しや編集で捨てられた枝を除く。
// 並列のツール呼び出しは兄弟の枝に分かれて記録されるので、辿った行と同じ message.id の行と、
// 辿った行のツール呼び出しへの結果の行も拾う
export function activeRows(rows) {
  const byUuid = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]))
  const leafId = leafOf(rows)
  const onPath = new Set()
  for (let r = byUuid.get(leafId); r && !onPath.has(r.uuid); r = byUuid.get(r.parentUuid)) onPath.add(r.uuid)

  const messageIds = new Set()
  const toolUseIds = new Set()
  for (const r of rows) {
    if (!onPath.has(r.uuid) || r.type !== 'assistant') continue
    if (r.message?.id) messageIds.add(r.message.id)
  }
  for (const r of rows) {
    if (r.type === 'assistant' && (onPath.has(r.uuid) || messageIds.has(r.message?.id)))
      for (const b of r.message?.content ?? []) if (b.type === 'tool_use') toolUseIds.add(b.id)
  }
  return rows.filter(r => {
    if (onPath.has(r.uuid)) return true
    if (r.type === 'assistant') return messageIds.has(r.message?.id)
    const c = r.type === 'user' && r.message?.content
    return Array.isArray(c) && c.some(b => b.type === 'tool_result' && toolUseIds.has(b.tool_use_id))
  })
}

// 先端から辿った会話で、結果の行が無いツール呼び出しの id。読み直すと API に拒まれる形
function danglingToolUses(rows, leafUuid) {
  const byUuid = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]))
  const onPath = new Set()
  for (let r = byUuid.get(leafUuid); r && !onPath.has(r.uuid); r = byUuid.get(r.parentUuid)) onPath.add(r.uuid)
  const messageIds = new Set(rows.filter(r => onPath.has(r.uuid) && r.type === 'assistant' && r.message?.id).map(r => r.message.id))
  const uses = new Set()
  const results = new Set()
  for (const r of rows) {
    const c = r.message?.content
    if (r.isSidechain || !Array.isArray(c)) continue
    if (r.type === 'assistant' && (onPath.has(r.uuid) || messageIds.has(r.message?.id)))
      for (const b of c) if (b.type === 'tool_use') uses.add(b.id)
    if (r.type === 'user') for (const b of c) if (b.type === 'tool_result') results.add(b.tool_use_id)
  }
  return [...uses].filter(id => !results.has(id))
}

// AskUserQuestion への新しい回答の行。書式は本物の記録 (2026-10-10 に確認) に合わせる
function answerRow(ask, block, answers, now) {
  const questions = Array.isArray(block.input?.questions) ? block.input.questions : []
  const given = (answers ?? []).map(a => String(a ?? '').trim())
  if (questions.length === 0 || given.length !== questions.length || given.some(a => !a)) throw new Error('Answer every question')
  const pairs = questions.map((q, i) => [q.question, given[i]])
  return {
    parentUuid: ask.uuid,
    isSidechain: false,
    promptId: crypto.randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: `Your questions have been answered: ${pairs.map(([q, a]) => `"${q}"="${a}"`).join(', ')}. You can now continue with these answers in mind.`,
          tool_use_id: block.id,
        },
      ],
    },
    uuid: crypto.randomUUID(),
    timestamp: now.toISOString(),
    toolUseResult: { questions, answers: Object.fromEntries(pairs) },
    sourceToolAssistantUUID: ask.uuid,
    userType: ask.userType,
    entrypoint: ask.entrypoint,
    cwd: ask.cwd,
    sessionId: ask.sessionId,
    version: ask.version,
    gitBranch: ask.gitBranch,
  }
}

// 地点で切る位置を決める。地点の意味は組み込みと同じく「その地点の直前に戻す」:
//   人の発言 → その発言の親を新しい先端にする
//   ツール呼び出し → その呼び出しの行の親を先端にする。並列の呼び出しの途中なら、同じメッセージで最初に
//     ツールを呼んだ行へ寄せる (後ろの呼び出しだけ残すと結果の無い呼び出しが残る)
//   考えているだけの行 (thinking) は先端にせず、その親まで下がる
//   answers があれば AskUserQuestion の行は残し、新しい回答の行を足してそれを先端にする
// 返す値: cutIndex (この行から後ろを捨てる)、leafUuid (新しい先端。最初の発言の前なら無し)、
// append (足す行)、since (この時刻以降に取ったファイルの控えが戻す対象)
export function cutPlan(rows, target, { active = activeRows(rows), now = new Date() } = {}) {
  const row = rows.find(r => r.uuid === target.uuid)
  if (!row || row.isSidechain || !active.includes(row)) throw new Error('This point is not in the current conversation')
  const byUuid = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]))
  const block = target.toolUseId ? (row.message?.content ?? []).find?.(b => b.type === 'tool_use' && b.id === target.toolUseId) : undefined
  if (target.toolUseId && (row.type !== 'assistant' || !block)) throw new Error('The tool call for this point was not found in the transcript')
  const first = block && row.message?.id ? (active.find(r => r.message?.id === row.message.id && hasToolUse(r)) ?? row) : row

  if (target.answers !== undefined) {
    if (block?.name !== 'AskUserQuestion') throw new Error('Answers can only be changed at an AskUserQuestion point')
    const firstUse = first.message.content.find(b => b.type === 'tool_use')
    if (first !== row || firstUse?.id !== block.id) throw new Error('Cannot change the answer to a question asked in the middle of parallel tool calls')
    const answer = answerRow(row, block, target.answers, now)
    return { cutIndex: rows.indexOf(row) + 1, leafUuid: answer.uuid, append: [answer], since: timeOf(row) }
  }

  let head = first
  let leaf = byUuid.get(head.parentUuid)
  while (isThinkingOnly(leaf)) {
    head = leaf
    leaf = byUuid.get(leaf.parentUuid)
  }
  return { cutIndex: rows.indexOf(head), leafUuid: leaf?.uuid, append: [], since: timeOf(head) }
}

// 切った後の記録が読み直せる形かを確かめる。今の会話に元からある欠けは咎めない
export function assertCuttable(rows, plan, before = danglingToolUses(rows, leafOf(rows))) {
  if (!plan.leafUuid) throw new Error('Cannot rewind to before the first message')
  const kept = [...rows.slice(0, plan.cutIndex), ...plan.append]
  // 新しい先端は残す行の中になければならない (地点の親が地点より後ろに書かれている記録は切らない)
  if (!kept.some(r => r.uuid === plan.leafUuid && !r.isSidechain)) throw new Error('Cannot rewind: the entry just before this point was not found in the transcript')
  const broken = danglingToolUses(kept, plan.leafUuid).filter(id => !before.includes(id))
  if (broken.length > 0) throw new Error('Cannot rewind here: it would leave a tool call without its result')
}

// 巻き戻し地点: 人の発言と AskUserQuestion の質問 (新しい方から POINTS_MAX 件)。各地点に、そこから次の人の発言までの
// AI の返答 (reply) と、その間に Edit/Write で変わったファイルの要約 (changes) を付ける。
// canCut は会話を戻せるか、restorable は戻せるファイルの控えがあるか (snaps は readSnaps の結果)
export function points(rows, snaps = []) {
  const active = activeRows(rows)
  const chain = active.filter(r => !r.isSidechain && (r.type === 'user' || r.type === 'assistant'))
  const resultOf = new Map()
  const editOf = new Map()
  for (const r of chain) {
    if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue
    for (const b of r.message.content) {
      if (b.type !== 'tool_result') continue
      resultOf.set(b.tool_use_id, r.uuid)
      const stats = !b.is_error && editStats(r.toolUseResult)
      if (stats) editOf.set(b.tool_use_id, stats)
    }
  }

  const out = []
  const toolMessages = new Set()
  chain.forEach((r, i) => {
    if (r.type === 'user') {
      const text = promptText(r)
      if (text === null) return
      // text は巻き戻した後に入力欄へ戻す発言。コマンドと長すぎる発言は戻さない
      const draft = text.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, '$1')
      const refill = !text.startsWith('/') && draft.length <= PROMPT_TEXT_MAX ? draft : undefined
      out.push({ uuid: r.uuid, kind: 'prompt', label: oneLine(pasted(text)), text: refill, at: i })
      return
    }
    // AI の文章は地点にしない (回答が地点に並ぶと紛らわしい)。返答のプレビューにだけ出す
    for (const b of r.message?.content ?? []) {
      if (b.type !== 'tool_use') continue
      // 並列の呼び出しは最初の 1 つだけを地点にする (途中で切ると結果の無い呼び出しが残る)。残りは返答のプレビューに出る
      const message = r.message?.id ?? r.uuid
      if (toolMessages.has(message)) continue
      toolMessages.add(message)
      // ツール呼び出しは地点にしない (一覧を発言と質問だけにする)。質問 (AskUserQuestion) だけを地点にする
      if (b.name !== 'AskUserQuestion') continue
      const questions = Array.isArray(b.input?.questions) ? b.input.questions : undefined
      out.push({ uuid: r.uuid, kind: 'tool', tool: b.name, toolUseId: b.id, resultUuid: resultOf.get(b.id), label: toolLabel(b.name, b.input), questions, at: i })
    }
  })

  // 返答: 地点の行から次の人の発言の手前まで。文章はそのまま、ツールは「▸ ラベル」の 1 行
  const replyFrom = start => {
    const parts = []
    let len = 0
    for (let j = start; j < chain.length && len < REPLY_MAX; j++) {
      const r = chain[j]
      if (j > start && humanPrompt(r)) break
      if (r.type !== 'assistant') continue
      for (const b of r.message?.content ?? []) {
        const piece = b.type === 'text' ? b.text.trim() : b.type === 'tool_use' ? `▸ ${toolLabel(b.name, b.input)}` : ''
        if (!piece) continue
        parts.push(piece)
        len += piece.length
      }
    }
    const all = parts.join('\n')
    return all.length > REPLY_MAX ? `${all.slice(0, REPLY_MAX - 1)}…` : all
  }

  const changesFrom = start => {
    const files = new Set()
    let added = 0
    let removed = 0
    for (let j = start; j < chain.length; j++) {
      const r = chain[j]
      if (j > start && humanPrompt(r)) break
      if (r.type !== 'assistant') continue
      for (const b of r.message?.content ?? []) {
        const stats = b.type === 'tool_use' && editOf.get(b.id)
        if (!stats) continue
        files.add(stats.file)
        added += stats.added
        removed += stats.removed
      }
    }
    return { files: [...files], added, removed }
  }

  const before = danglingToolUses(rows, leafOf(rows))
  const reach = p => {
    let since
    let canCut = false
    try {
      const plan = cutPlan(rows, p, { active })
      since = plan.since
      assertCuttable(rows, plan, before)
      canCut = true
    } catch {
      // 戻せない地点は canCut: false のまま一覧に残す (ファイルだけは戻せることがある)
    }
    return { canCut, restorable: since !== undefined && snaps.some(s => s.at >= since) }
  }

  return out.slice(-POINTS_MAX).map(({ at, ...p }) => ({ ...p, reply: replyFrom(at), changes: changesFrom(at), ...reach(p) }))
}

// ---- ファイルの控え ----
// 1 回の Edit/Write/NotebookEdit につき snaps/<tool_use id>.json (控えの情報) と、元のファイルがあれば中身
// (<id>.b64 は mod が $.fs で書いた base64、<id>.bin は snap コマンドが写した元のバイト列)

export const snapName = id => String(id).replace(/[^\w-]/g, '_')
const snapsDir = dir => path.join(dir, 'snaps')
const pathKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

// 4 MiB を超えるファイルの控え。mod の $.fs では読めないので node で写す
export function snap(dir, toolUseId, tool, file, at = Date.now()) {
  const sd = snapsDir(dir)
  const id = snapName(toolUseId)
  fs.mkdirSync(sd, { recursive: true })
  const meta = { toolUseId, tool, path: file, at, existed: fs.existsSync(file) }
  if (meta.existed) {
    fs.copyFileSync(file, path.join(sd, `${id}.bin`))
    meta.data = `${id}.bin`
  }
  fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify(meta))
  return meta
}

export function readSnaps(dir) {
  const sd = snapsDir(dir)
  if (!fs.existsSync(sd)) return []
  const out = []
  for (const name of fs.readdirSync(sd)) {
    if (!name.endsWith('.json')) continue
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sd, name), 'utf8'))
      if (typeof s.path === 'string' && typeof s.at === 'number') out.push(s)
    } catch {
      // 書きかけの控えは使わない
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

// 戻すファイルの計画: since 以降に控えを取ったファイルごとに、最初の控え (= その地点での中身) を選ぶ
export function fileRestorePlan(snaps, since) {
  if (since === undefined) return []
  const first = new Map()
  for (const s of [...snaps].sort((a, b) => a.at - b.at)) {
    if (s.at < since) continue
    const key = pathKey(s.path)
    if (!first.has(key)) first.set(key, s)
  }
  return [...first.values()]
}

function snapData(dir, s) {
  if (!s.existed) return null
  if (typeof s.data !== 'string') throw new Error(`Backup has no contents: ${s.path}`)
  const p = path.join(snapsDir(dir), path.basename(s.data))
  return s.data.endsWith('.b64') ? Buffer.from(fs.readFileSync(p, 'utf8'), 'base64') : fs.readFileSync(p)
}

// ---- 巻き戻し ----

// node のファイル操作の失敗を、ファイル名つきの日本語にする
export function fileError(what, file, err) {
  const code = err?.code
  const why =
    code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? 'read-only or in use by another app'
    : code === 'ENOENT' ? 'not found'
    : code === 'ENOSPC' ? 'disk is full'
    : String(err?.message ?? err)
  return new Error(`${what}: ${file} (${why})`)
}

// spec: { uuid, toolUseId?, label?, mode: 'both' | 'conversation' | 'files', answers?: string[] }
// 失敗したときは「何も変わっていない」を守る。記録の書き換え (rename) を最後に置き、それより前の失敗では
// 戻したファイルを退避した中身へ書き戻し、作りかけの保存を消してから throw する。
// 1. 計画を立てて確かめる (記録の形・控えの中身をすべて読む)。ここまでで失敗すれば何も変えない
// 2. 戻すファイルの今の中身、切る前の記録、どこで切ったかを branches/<時刻>.* に保存する
// 3. ファイルを控えの中身に戻す (控えで無かったファイルは消す)
// 4. 切った記録を tmp に書いて rename (会話を戻すとき)
// 返す値の transcriptChanged は記録を書き換えたか。true なら mod は必ず /resume で読み直す
export function rewind(file, spec, dir, now = new Date()) {
  const mode = spec?.mode
  if (!MODES.includes(mode)) throw new Error(`Invalid rewind mode: ${mode}`)
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  const rows = lines.map(l => JSON.parse(l))
  const answers = mode === 'files' ? undefined : spec.answers
  const plan = cutPlan(rows, { uuid: spec.uuid, toolUseId: spec.toolUseId, answers }, { now })
  let out
  if (mode !== 'files') {
    assertCuttable(rows, plan)
    const leafRow = [...rows.slice(0, plan.cutIndex), ...plan.append].find(r => r.uuid === plan.leafUuid)
    const lastPrompt = lastPromptText(rows.slice(0, plan.cutIndex), plan.leafUuid)
    out = [
      ...lines.slice(0, plan.cutIndex),
      ...plan.append.map(r => JSON.stringify(r)),
      JSON.stringify({ type: 'last-prompt', lastPrompt, leafUuid: plan.leafUuid, sessionId: leafRow?.sessionId ?? path.basename(file, '.jsonl') }),
    ]
    // 切った後に読み直したとき、選んだ地点の直前が先端になるか
    if (leafOf(out.map(l => JSON.parse(l))) !== plan.leafUuid) throw new Error('After cutting, the conversation would not end just before this point')
  }

  const files = mode === 'conversation' ? [] : fileRestorePlan(readSnaps(dir), plan.since)
  if (mode === 'files' && files.length === 0) throw new Error('No file backups to restore')
  const contents = files.map(s => {
    try {
      return { path: s.path, data: snapData(dir, s) }
    } catch (err) {
      throw err?.code ? fileError('Could not read the file backup', s.path, err) : err
    }
  })

  const id = now.toISOString().replace(/[:.]/g, '-')
  const branches = path.join(dir, 'branches')
  const saved = path.join(branches, `${id}.files`)
  const archived = path.join(branches, `${id}.jsonl`)
  const metaFile = path.join(branches, `${id}.json`)
  const tmp = `${file}.better-rewind.tmp`
  const meta = { id, at: now.toISOString(), mode, point: { uuid: spec.uuid, toolUseId: spec.toolUseId, label: spec.label ?? '' }, answers, files: [] }
  if (mode !== 'files') Object.assign(meta, { transcript: `${id}.jsonl`, cutLine: plan.cutIndex, leafUuid: plan.leafUuid, dropped: lines.length - plan.cutIndex })

  // 作りかけの保存を消す。branches が空になったらそれも消す
  const discard = (keep = []) => {
    for (const p of [tmp, archived, metaFile, saved]) if (!keep.includes(p)) fs.rmSync(p, { force: true, recursive: true })
    try {
      fs.rmdirSync(branches)
    } catch {
      // ほかの保存が残っている
    }
  }
  const step = (what, target, fn) => {
    try {
      return fn()
    } catch (err) {
      discard()
      throw fileError(what, target, err)
    }
  }

  // 2. 戻すファイルの今の中身も残す (戻した後に要るものがあっても拾えるように。失敗時の書き戻しにも使う)
  step('Could not create the backup folder', branches, () => fs.mkdirSync(contents.length > 0 ? saved : branches, { recursive: true }))
  contents.forEach((c, i) => {
    const exists = fs.existsSync(c.path)
    if (exists) step('Could not save the current file before restoring', c.path, () => fs.copyFileSync(c.path, path.join(saved, String(i))))
    meta.files.push({ path: c.path, action: c.data === null ? 'delete' : 'write', backup: exists ? `${id}.files/${i}` : null })
  })
  if (mode !== 'files') step('Could not save the transcript before cutting', archived, () => fs.writeFileSync(archived, raw))
  step('Could not save the rewind details', metaFile, () => fs.writeFileSync(metaFile, JSON.stringify(meta)))

  // 3 と 4 の失敗: 戻したファイルを退避した中身へ書き戻してから保存を消す。
  // 書き戻せないファイルがあれば、退避した中身と情報は消さずに場所を伝える
  const applied = []
  const fail = err => {
    const stuck = []
    for (const i of applied.reverse()) {
      const { backup } = meta.files[i]
      try {
        if (backup) fs.copyFileSync(path.join(branches, backup), contents[i].path)
        else fs.rmSync(contents[i].path, { force: true })
      } catch {
        stuck.push(contents[i].path)
      }
    }
    if (stuck.length === 0) {
      discard()
      return err
    }
    discard([saved, metaFile])
    return new Error(`${err.message}. These files could not be put back: ${stuck.join(', ')} (their previous contents are in ${saved})`)
  }

  // 3. ファイルを戻す
  const restored = []
  const removed = []
  contents.forEach((c, i) => {
    try {
      if (c.data === null) {
        if (fs.existsSync(c.path)) {
          fs.rmSync(c.path, { force: true })
          removed.push(c.path)
        }
      } else {
        fs.mkdirSync(path.dirname(c.path), { recursive: true })
        fs.writeFileSync(c.path, c.data)
        restored.push(c.path)
      }
    } catch (err) {
      throw fail(fileError('Could not restore the file', c.path, err))
    }
    applied.push(i)
  })

  // 4. 記録を切る。ここが最後の書き換えなので、成功すれば後は失敗しない
  if (mode !== 'files') {
    try {
      fs.writeFileSync(tmp, `${out.join('\n')}\n`)
      fs.renameSync(tmp, file)
    } catch (err) {
      throw fail(fileError('Could not rewrite the transcript', file, err))
    }
  }
  return { id, mode, leaf: plan.leafUuid, dropped: meta.dropped ?? 0, restored, removed, transcriptChanged: mode !== 'files' }
}

// 先端から辿って最後の人の発言 (last-prompt 行の lastPrompt。/resume の一覧に出る)
function lastPromptText(rows, leafUuid) {
  const byUuid = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]))
  const seen = new Set()
  for (let r = byUuid.get(leafUuid); r && !seen.has(r.uuid); r = byUuid.get(r.parentUuid)) {
    seen.add(r.uuid)
    const text = promptText(r)
    if (text !== null) return oneLine(pasted(text), 200)
  }
  return ''
}

// ---- 巻き戻す前の会話 (枝) ----

// 切った位置より後ろの会話を読める文にする: 人の発言は ❯、AI の文章はそのまま、ツールは ▸、質問への回答は ⎿
export function branchText(rows, cutLine) {
  const tail = new Set(rows.slice(cutLine))
  // 回答を選び直した枝は質問の直後で切っているので、質問の行は切った位置より前にある
  const asks = new Set(rows.flatMap(r => (r.type === 'assistant' ? (r.message?.content ?? []) : []).filter(b => b.type === 'tool_use' && b.name === 'AskUserQuestion').map(b => b.id)))
  const parts = []
  for (const r of activeRows(rows)) {
    if (!tail.has(r) || r.isSidechain) continue
    if (r.type === 'user') {
      const text = promptText(r)
      if (text !== null) {
        parts.push(`❯ ${oneLine(pasted(text), 400)}`)
        continue
      }
      for (const b of Array.isArray(r.message?.content) ? r.message.content : [])
        if (b.type === 'tool_result' && asks.has(b.tool_use_id)) parts.push(`⎿ ${oneLine(textOf(b.content), 400)}`)
    } else if (r.type === 'assistant') {
      for (const b of r.message?.content ?? []) {
        if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim())
        if (b.type === 'tool_use') parts.push(`▸ ${toolLabel(b.name, b.input)}`)
      }
    }
  }
  const all = parts.join('\n\n')
  return all.length > BRANCH_TEXT_MAX ? `${all.slice(0, BRANCH_TEXT_MAX - 1)}…` : all
}

// 保存した枝の一覧 (新しい順)。ファイルだけ戻した記録は会話が変わっていないので出さない
export function branches(dir) {
  const bd = path.join(dir, 'branches')
  if (!fs.existsSync(bd)) return []
  const out = []
  for (const name of fs.readdirSync(bd)) {
    if (!name.endsWith('.json')) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(bd, name), 'utf8'))
      if (!meta.transcript) continue
      const rows = readRows(path.join(bd, path.basename(meta.transcript)))
      out.push({
        id: meta.id,
        at: meta.at,
        label: meta.point?.label ?? '',
        mode: meta.mode,
        answered: Array.isArray(meta.answers),
        text: branchText(rows, meta.cutLine),
      })
    } catch {
      // 壊れた保存は一覧に出さない
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

const readStdin = () => fs.readFileSync(0, 'utf8')

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, sessionId, ...rest] = process.argv.slice(2)
  try {
    const dir = dataDir(sessionId)
    let out
    if (cmd === 'points') {
      const file = findTranscript(sessionId)
      out = { file, points: points(readRows(file), readSnaps(dir)) }
    } else if (cmd === 'rewind') {
      const file = findTranscript(sessionId)
      const spec = JSON.parse(rest[0] ? fs.readFileSync(rest[0], 'utf8') : readStdin())
      out = { file, ...rewind(file, spec, dir) }
    } else if (cmd === 'snap') {
      const [toolUseId, tool, file, at] = rest
      if (!toolUseId || !file) throw new Error('Usage: snap <sessionId> <toolUseId> <tool> <path> [atMs]')
      out = snap(dir, toolUseId, tool, file, Number(at) || Date.now())
    } else if (cmd === 'branches') {
      out = { branches: branches(dir) }
    } else if (cmd === 'dir') {
      out = { dir }
    } else {
      throw new Error(`unknown command: ${cmd}`)
    }
    console.log(JSON.stringify(out))
  } catch (err) {
    // rewind の失敗は記録を書き換えたか (transcriptChanged) も返す。mod は true なら読み直す
    const changed = cmd === 'rewind' ? { transcriptChanged: err?.transcriptChanged === true } : {}
    console.log(JSON.stringify({ error: String(err?.message ?? err), ...changed }))
    process.exitCode = 1
  }
}
