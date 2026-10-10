// 記録ファイル (セッション jsonl) から巻き戻し地点を取り出し、巻き戻しを行う。mod から node で呼ぶ
//   node transcript.mjs points <sessionId>
//   node transcript.mjs rewind <sessionId> [specFile]    spec (JSON) は specFile か stdin から
//   node transcript.mjs snap <sessionId> <toolUseId> <tool> <path> [atMs]
//   node transcript.mjs drop <sessionId> <toolUseId>       拒否・失敗した呼び出しの控えを片付ける (settleDenied)
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
// 地点ごとに Restore code の確認画面へ渡すファイル名の数 (件数は全部数える)
const RESTORE_LIST_MAX = 5
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
    // 空のファイルを作ったときは 0 行 (''.split は [''] の 1 つになる)
    added = t.content === '' ? 0 : t.content.split('\n').length - (t.content.endsWith('\n') ? 1 : 0)
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
// canCut は会話を戻せるか、restorable は戻せるファイルの控えがあるか (snaps は readSnaps の結果)。
// restore は Restore code が戻すファイル (rewind と同じ fileRestorePlan の結果。名前は先頭 RESTORE_LIST_MAX 件まで)。
// exists を渡すと、地点の時点で無かったファイルのうち今も無いもの (rewind が消さないもの) を restore の件数と名前から除く
// (CLI は fs.existsSync を渡す。渡さなければ計画どおりに数える)
export function points(rows, snaps = [], exists = undefined) {
  const active = activeRows(rows)
  const results = toolResults(rows)
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
    const { files, skipped } = fileRestorePlan(snaps, since, results)
    // 確認画面に出すのは実際に書く・消すファイルだけ。今も無いファイルを「消す」とは数えない
    const acts = exists ? files.filter(s => s.existed || exists(s.path)) : files
    const restore = {
      total: acts.length,
      files: acts.slice(0, RESTORE_LIST_MAX).map(s => ({ path: s.path, action: s.existed ? 'write' : 'delete' })),
      skippedTotal: skipped.length,
      skipped: skipped.slice(0, RESTORE_LIST_MAX).map(s => s.path),
    }
    return { canCut, restorable: files.length > 0, restore }
  }

  return out.slice(-POINTS_MAX).map(({ at, ...p }) => ({ ...p, reply: replyFrom(at), changes: changesFrom(at), ...reach(p) }))
}

// ---- ファイルの控え ----
// 1 回の Edit/Write/NotebookEdit につき snaps/<tool_use id>.json (控えの情報) と、元のファイルがあれば中身
// (<id>.b64 は mod が $.fs で書いた base64、<id>.bin は snap コマンドや rewind が写した元のバイト列)。
// 情報の state: 'pending' はツールの実行前に取った控え (mod がツールの結果を見て書き直す)、'ran' は実行された呼び出しの控え
// (拒否・失敗の結果でも、ファイルが控えと変わっていれば実行されたとみなして 'ran')、'denied' は拒否・失敗してファイルも
// 変わっていない呼び出しの控え (戻すのに使わない)。state の無い控えは 1.0.0 のもの。
// failed: true は控えを取ろうとして失敗した印 (中身は無い。そのファイルはこの時点より前へ戻せない)

export const snapName = id => String(id).replace(/[^\w-]/g, '_')
const snapsDir = dir => path.join(dir, 'snaps')
const pathKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

// 4 MiB を超えるファイルの控え。mod の $.fs では読めないので node で写す。
// state は呼ぶ側が決める (snap コマンドはツールの実行前に mod が呼ぶので 'pending')
export function snap(dir, toolUseId, tool, file, at = Date.now(), state = 'ran') {
  const sd = snapsDir(dir)
  const id = snapName(toolUseId)
  fs.mkdirSync(sd, { recursive: true })
  const meta = { toolUseId, tool, path: file, at, existed: fs.existsSync(file), state }
  if (meta.existed) {
    fs.copyFileSync(file, path.join(sd, `${id}.bin`))
    meta.data = `${id}.bin`
  }
  fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify(meta))
  return meta
}

// 実行されなかった呼び出しの控えを、中身ごと消す (拒否されたファイルの中身を残さない)
export function dropSnap(dir, toolUseId) {
  const id = snapName(toolUseId)
  for (const ext of ['json', 'b64', 'bin']) fs.rmSync(path.join(snapsDir(dir), `${id}.${ext}`), { force: true })
  return { dropped: toolUseId }
}

// 拒否・失敗の結果が来た呼び出しの、node が写した大きいファイルの控え (<id>.bin) を片付ける (CLI の drop)。
// 後段の hook がツールの実行後に断ったときや、ツールが途中で止まったときは、ファイルがもう変わっている。そのときは
// 控えを消さずに 'ran' にする (消すと、後でこのファイルを途中の版へ黙って戻してしまう)。変わっていなければ中身ごと消す
export function settleDenied(dir, toolUseId) {
  const sd = snapsDir(dir)
  const id = snapName(toolUseId)
  const bin = path.join(sd, `${id}.bin`)
  let meta
  try {
    meta = JSON.parse(fs.readFileSync(path.join(sd, `${id}.json`), 'utf8'))
  } catch {
    meta = undefined
  }
  if (meta && typeof meta.path === 'string' && fs.existsSync(bin)) {
    const changed = !fs.existsSync(meta.path) || !fs.readFileSync(meta.path).equals(fs.readFileSync(bin))
    if (changed) {
      const kept = { ...meta, existed: true, data: `${id}.bin`, state: 'ran' }
      fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify(kept))
      return { kept: toolUseId, state: 'ran' }
    }
  }
  return dropSnap(dir, toolUseId)
}

// 記録の中のツール結果: tool_use id → エラーだったか (拒否・失敗なら true)
export function toolResults(rows) {
  const out = new Map()
  for (const r of rows) {
    const c = r.type === 'user' && r.message?.content
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') out.set(b.tool_use_id, b.is_error === true)
  }
  return out
}

// 控えを戻すのに使えるか。'use' は実行された呼び出しの直前の中身、'ignore' は拒否・失敗した呼び出し (ファイルは
// 変わっていないので見なくてよい)、'unknown' は控えに失敗したか、実行されたか分からない (その時点の中身が分からない)。
// 'ran' は mod がツールの成功を見たか、拒否・失敗の結果でもファイルが変わったのを確かめた控えなので、記録の結果が
// エラーでも使う。'pending' (mod が結果を書き込めなかった) は、記録の結果が成功のときだけ使い、エラーや結果無しは
// 実行後に断られた・途中で止まった場合と見分けられないので 'unknown'
function snapUse(s, results) {
  const isError = results.get(s.toolUseId)
  if (s.state === 'denied') return 'ignore'
  if (s.failed === true) return 'unknown'
  if (s.state === 'ran') return 'use'
  if (s.state === 'pending') return isError === false ? 'use' : 'unknown'
  // state の無い 1.0.0 の控えは、記録の結果だけで決める
  return isError === true ? 'ignore' : 'use'
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

// 戻すファイルの計画: since 以降に控えを取ったファイルごとに、最初の控え (= その地点での中身) を選ぶ。
// 拒否・失敗した呼び出しの控えは飛ばす (results は toolResults の結果)。最初の控えが失敗の印か、実行されたか
// 分からない控えなら、そのファイルは途中の版へ黙って戻さず skipped に入れる
export function fileRestorePlan(snaps, since, results = new Map()) {
  if (since === undefined) return { files: [], skipped: [] }
  const first = new Map()
  for (const s of [...snaps].sort((a, b) => a.at - b.at)) {
    if (s.at < since) continue
    const use = snapUse(s, results)
    if (use === 'ignore') continue
    const key = pathKey(s.path)
    if (!first.has(key)) first.set(key, { s, use })
  }
  const files = []
  const skipped = []
  for (const { s, use } of first.values()) (use === 'use' ? files : skipped).push(s)
  return { files, skipped }
}

function snapData(dir, s) {
  if (!s.existed) return null
  if (typeof s.data !== 'string') throw new Error(`Backup has no contents: ${s.path}`)
  const p = path.join(snapsDir(dir), path.basename(s.data))
  return s.data.endsWith('.b64') ? Buffer.from(fs.readFileSync(p, 'utf8'), 'base64') : fs.readFileSync(p)
}

// ---- 巻き戻し ----

// node のファイル操作の失敗を、ファイル名と理由つきの英語の文にする (理由は errno を利用者の言葉に直す)
export function fileError(what, file, err) {
  const code = err?.code
  const why =
    code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ? 'read-only or in use by another app'
    : code === 'ENOENT' ? 'not found'
    : code === 'ENOSPC' ? 'disk is full'
    : String(err?.message ?? err)
  return new Error(`${what}: ${file} (${why})`)
}

// 復元先 (file) が今リンクで、書くとリンクの先を書き換えてしまうときの理由。link はリンクになっていた要素
const linkMessage = (file, link) =>
  path.resolve(link) === path.resolve(file)
    ? `Cannot restore ${file}: it is now a symbolic link, so writing it could change a file somewhere else. Nothing was changed. Replace the link with a normal file, or restore that file yourself`
    : `Cannot restore ${file}: the folder ${link} on its path is now a symbolic link (or junction), so writing it could change a file somewhere else. Nothing was changed. Replace the link with a normal folder, or restore that file yourself`

// 記録の作業フォルダ (最初に書かれた cwd。セッションを始めたフォルダ)
const workDirOf = rows => rows.find(r => typeof r.cwd === 'string' && r.cwd !== '')?.cwd

// 復元先のパスで、今シンボリックリンク (Windows のジャンクションも) になっている要素。無ければ undefined。
// 作業フォルダの中のファイルは、作業フォルダから先の途中のフォルダもすべて見る (repo/sub が外へのリンクなら、
// repo/sub/x へ書くと外のファイルを書き換える)。作業フォルダより上と、作業フォルダの外のファイルの途中のフォルダは
// 見ない (macOS の /tmp のように元からリンクの場所で断らないため)。外のファイルはそのファイル自体だけを見る。
// 無い要素から先は見ない (無いフォルダは mkdirSync が普通のフォルダとして作る)
function linkOnPath(io, file, workDir) {
  const target = path.resolve(file)
  const root = workDir ? path.resolve(workDir) : undefined
  const rel = root ? path.relative(root, target) : ''
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  const parts = inside ? rel.split(path.sep) : []
  const checks = inside ? parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1))) : [target]
  for (const p of checks) {
    let st
    try {
      st = io.lstatSync(p)
    } catch (err) {
      if (err?.code === 'ENOENT') return undefined
      throw fileError('Could not check the file before restoring', file, err)
    }
    if (st.isSymbolicLink()) return p
  }
  return undefined
}

function assertNoLink(job, file) {
  const link = linkOnPath(job.io, file, job.workDir)
  if (link !== undefined) throw new Error(linkMessage(file, link))
}

// 読んだ時から記録が増えていれば (Claude が書き足している)、切った記録で置き換えると書き足した行が消えるので断る
function assertUnchanged(job) {
  if (job.io.statSync(job.file).size !== job.bytes.length) throw new Error('Claude added to the conversation while it was being rewound, so nothing was changed. Try again when Claude finishes')
}

// spec: { uuid, toolUseId?, label?, mode: 'both' | 'conversation' | 'files', answers?: string[] }
// 失敗したときは「何も変わっていない」を守る。記録の書き換え (rename) を最後に置き、それより前の失敗では
// 戻したファイル (書きかけで失敗したファイルも) を退避した中身へ書き戻し、作りかけの保存を消してから throw する。
// 1. planRewind: 計画を立てて確かめる (記録の形・控えの中身をすべて読む・復元先とその途中のフォルダがリンクでない)。
//    ここまでで失敗すれば何も変えない
// 2. saveBeforeRestore: 戻すファイルの今の中身、切る前の記録、どこで切ったかを branches/<時刻>.* に保存する。戻すファイルの
//    今の中身は snaps/ にも rewind 自身の控えとして書く (後でこの時刻より前の地点へ戻すとき、ここで変えたファイルもその時点の中身に戻す)
// 3. restoreFiles: ファイルを控えの中身に戻す (控えで無かったファイルは消す)
// 4. cutTranscript: 記録が読んだ時から増えていないかを確かめ、切った記録を tmp に書いて rename (会話を戻すとき)
// 5. finishRewind: 情報ファイルに終わった印を書く
// 情報ファイル (branches/<時刻>.json) の state は、始めたとき 'started'、終わったら 'done'、書き戻せないファイルが
// 残ったら 'failed'。'started' のまま残っていれば途中で打ち切られた (points の unfinished で知らせる)。
// 返す値の transcriptChanged は記録を書き換えたか (会話を戻したとき true)。1〜4 の失敗は throw だけで、記録は書き換えていない。
// 5 の失敗 (戻し終えた後) だけは、エラーに transcriptChanged と戻した結果 (result) を付けて throw する (CLI がそのまま返す)。
// io はテストでファイル操作の失敗を起こすための差し替え口 (既定は node:fs)
export function rewind(file, spec, dir, now = new Date(), io = fs) {
  const job = planRewind(file, spec, dir, now, io)
  saveBeforeRestore(job)
  const done = restoreFiles(job)
  if (job.mode !== 'files') cutTranscript(job)
  return finishRewind(job, done)
}

// 1. 計画: 切った後の記録 (out)、戻すファイルの中身 (contents)、保存先のパスと情報 (meta) を決める。ここではまだ何も書かない
function planRewind(file, spec, dir, now, io) {
  const mode = spec?.mode
  if (!MODES.includes(mode)) throw new Error(`Invalid rewind mode: ${mode}`)
  const bytes = io.readFileSync(file)
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  const rows = lines.map(l => JSON.parse(l))
  const answers = mode === 'files' ? undefined : spec.answers
  const plan = cutPlan(rows, { uuid: spec.uuid, toolUseId: spec.toolUseId, answers }, { now })
  let out
  if (mode !== 'files') {
    assertCuttable(rows, plan)
    // 回答を選び直すときの先端は足す行 (append) なので、それも含めて辿る
    const kept = [...rows.slice(0, plan.cutIndex), ...plan.append]
    const leafRow = kept.find(r => r.uuid === plan.leafUuid)
    const lastPrompt = lastPromptText(kept, plan.leafUuid)
    out = [
      ...lines.slice(0, plan.cutIndex),
      ...plan.append.map(r => JSON.stringify(r)),
      JSON.stringify({ type: 'last-prompt', lastPrompt, leafUuid: plan.leafUuid, sessionId: leafRow?.sessionId ?? path.basename(file, '.jsonl') }),
    ]
    // 切った後に読み直したとき、選んだ地点の直前が先端になるか
    if (leafOf(out.map(l => JSON.parse(l))) !== plan.leafUuid) throw new Error('After cutting, the conversation would not end just before this point')
  }

  const { files, skipped } = mode === 'conversation' ? { files: [], skipped: [] } : fileRestorePlan(readSnaps(dir), plan.since, toolResults(rows))
  if (mode === 'files' && files.length === 0) {
    const why = skipped.length > 0 ? ` (no backup could be taken before ${skipped.map(s => s.path).join(', ')} was edited)` : ''
    throw new Error(`No file backups to restore${why}`)
  }
  const contents = files.map(s => {
    try {
      return { path: s.path, data: snapData(dir, s) }
    } catch (err) {
      throw err?.code ? fileError('Could not read the file backup', s.path, err) : err
    }
  })

  const id = now.toISOString().replace(/[:.]/g, '-')
  const branches = path.join(dir, 'branches')
  const meta = { id, at: now.toISOString(), mode, state: 'started', point: { uuid: spec.uuid, toolUseId: spec.toolUseId, label: spec.label ?? '' }, answers, files: [] }
  if (mode !== 'files') Object.assign(meta, { transcript: `${id}.jsonl`, cutLine: plan.cutIndex, leafUuid: plan.leafUuid, dropped: lines.length - plan.cutIndex })
  const job = {
    io,
    file,
    dir,
    mode,
    now,
    bytes,
    plan,
    out,
    skipped,
    contents,
    workDir: workDirOf(rows),
    id,
    meta,
    branches,
    saved: path.join(branches, `${id}.files`),
    archived: path.join(branches, `${id}.jsonl`),
    metaFile: path.join(branches, `${id}.json`),
    tmp: `${file}.better-rewind.tmp`,
    // rewind 自身の控え (snaps/ に書いたファイル)
    ownSnaps: [],
    // 手を付けた (書き始めた・消した) ファイルの contents の番号
    applied: [],
  }
  for (const c of contents) assertNoLink(job, c.path)
  if (mode !== 'files') assertUnchanged(job)
  return job
}

// 作りかけの保存を消す (keep に挙げたものは残す)。branches が空になったらそれも消す
function discard(job, keep = []) {
  const { io } = job
  for (const p of [job.tmp, job.archived, job.metaFile, job.saved, ...job.ownSnaps]) if (!keep.includes(p)) io.rmSync(p, { force: true, recursive: true })
  try {
    io.rmdirSync(job.branches)
  } catch {
    // ほかの保存が残っている
  }
}

// 2. 戻すファイルの今の中身も残す (戻した後に要るものがあっても拾えるように。失敗時の書き戻しにも使う)。
// ここではまだファイルにも記録にも触れていないので、失敗したら作りかけの保存を消して throw するだけ
function saveBeforeRestore(job) {
  const { io, contents, meta, saved, id } = job
  const step = (what, target, fn) => {
    try {
      return fn()
    } catch (err) {
      discard(job)
      throw fileError(what, target, err)
    }
  }
  step('Could not create the backup folder', job.branches, () => io.mkdirSync(contents.length > 0 ? saved : job.branches, { recursive: true }))
  contents.forEach((c, i) => {
    const exists = io.existsSync(c.path)
    if (exists) step('Could not save the current file before restoring', c.path, () => io.copyFileSync(c.path, path.join(saved, String(i))))
    meta.files.push({ path: c.path, action: c.data === null ? 'delete' : 'write', backup: exists ? `${id}.files/${i}` : null })
    // 無いファイルを消す計画なら何も変わらないので、控えも要らない
    if (c.data === null && !exists) return
    const sid = snapName(`better-rewind-${id}-${i}`)
    const sd = snapsDir(job.dir)
    const own = { toolUseId: sid, tool: 'better-rewind', path: c.path, at: job.now.getTime(), existed: exists, state: 'ran', ...(exists ? { data: `${sid}.bin` } : {}) }
    job.ownSnaps.push(path.join(sd, `${sid}.json`), path.join(sd, `${sid}.bin`))
    step('Could not record the current file before restoring', c.path, () => {
      io.mkdirSync(sd, { recursive: true })
      if (exists) io.copyFileSync(path.join(saved, String(i)), path.join(sd, `${sid}.bin`))
      io.writeFileSync(path.join(sd, `${sid}.json`), JSON.stringify(own))
    })
  })
  if (job.mode !== 'files') step('Could not save the transcript before cutting', job.archived, () => io.writeFileSync(job.archived, job.bytes))
  step('Could not save the rewind details', job.metaFile, () => io.writeFileSync(job.metaFile, JSON.stringify(meta)))
}

// 3 と 4 の失敗: 手を付けたファイルを退避した中身へ書き戻してから保存を消し、throw するエラーを返す。
// 書き戻せないファイルがあれば、退避した中身・切る前の記録・情報は消さずに場所を伝える
function rollback(job, err) {
  const { io, contents, meta } = job
  // 今の中身が退避した中身と同じか (書く前に断られたファイルは変わっていないので、書き戻さなくてよい)
  const isIntact = (file, backup) => {
    try {
      return io.readFileSync(file).equals(io.readFileSync(backup))
    } catch {
      return false
    }
  }
  const stuck = []
  for (const i of [...job.applied].reverse()) {
    const { backup } = meta.files[i]
    const from = backup && path.join(job.branches, backup)
    try {
      if (from) {
        if (!isIntact(contents[i].path, from)) io.copyFileSync(from, contents[i].path)
      } else io.rmSync(contents[i].path, { force: true })
    } catch {
      stuck.push(contents[i].path)
    }
  }
  if (stuck.length === 0) {
    discard(job)
    return err
  }
  discard(job, [job.saved, job.metaFile, job.archived, ...job.ownSnaps])
  try {
    io.writeFileSync(job.metaFile, JSON.stringify({ ...meta, state: 'failed', notRestored: stuck }))
  } catch {
    // 情報は 'started' のまま残る (次に開いたとき、途中で止まった巻き戻しとして知らせる)
  }
  return new Error(`${err.message}. These files could not be put back: ${stuck.join(', ')}. Their contents from before the rewind are in ${job.saved} (${job.metaFile} lists which file is which)`)
}

// 3. ファイルを戻す。書く前に applied へ入れる (書きかけで失敗したファイルも書き戻す)
function restoreFiles(job) {
  const { io, contents, applied } = job
  const restored = []
  const removed = []
  contents.forEach((c, i) => {
    try {
      // 確かめてから書くまでの間に、ファイルや途中のフォルダがリンクへ置き換えられていないかを、書く直前にも見る
      assertNoLink(job, c.path)
    } catch (err) {
      throw rollback(job, err)
    }
    try {
      if (c.data === null) {
        if (io.existsSync(c.path)) {
          applied.push(i)
          io.rmSync(c.path, { force: true })
          removed.push(c.path)
        }
      } else {
        applied.push(i)
        io.mkdirSync(path.dirname(c.path), { recursive: true })
        io.writeFileSync(c.path, c.data)
        restored.push(c.path)
      }
    } catch (err) {
      throw rollback(job, fileError('Could not restore the file', c.path, err))
    }
  })
  return { restored, removed }
}

// 4. 記録を切る。rename が最後の書き換え
function cutTranscript(job) {
  const { io, tmp, file } = job
  try {
    io.writeFileSync(tmp, `${job.out.join('\n')}\n`)
    assertUnchanged(job)
    io.renameSync(tmp, file)
  } catch (err) {
    throw rollback(job, err?.code ? fileError('Could not rewrite the transcript', file, err) : err)
  }
}

// 5. 終わった印を書く。ファイルも記録も書き換え済みなので、ここで失敗しても書き戻さない。印が無いと次に一覧を開いたとき
// 「途中で止まった」と知らせてしまうので、そのことを添えたエラーに、戻した結果 (result) と transcriptChanged を付けて throw する
// (mod は記録が書き換わっていれば読み直してから知らせる)
function finishRewind(job, { restored, removed }) {
  const result = { id: job.id, mode: job.mode, leaf: job.plan.leafUuid, dropped: job.meta.dropped ?? 0, restored, removed, skipped: job.skipped.map(s => s.path), transcriptChanged: job.mode !== 'files' }
  try {
    job.io.writeFileSync(job.metaFile, JSON.stringify({ ...job.meta, state: 'done' }))
  } catch (err) {
    const why = fileError('The rewind finished, but could not record that it finished', job.metaFile, err).message
    throw Object.assign(new Error(`${why}. If /better-rewind later says this rewind was stopped before it finished, you can ignore that`), { transcriptChanged: result.transcriptChanged, result })
  }
  return result
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

// 保存した枝の一覧 (新しい順)。ファイルだけ戻した記録と、終わらなかった巻き戻し (会話は切れていない) は出さない。
// state の無い情報は 1.0.0 のもの (終わった巻き戻しだけが残っている)
export function branches(dir) {
  const bd = path.join(dir, 'branches')
  if (!fs.existsSync(bd)) return []
  const out = []
  for (const name of fs.readdirSync(bd)) {
    if (!name.endsWith('.json')) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(bd, name), 'utf8'))
      if (!meta.transcript || (meta.state !== undefined && meta.state !== 'done')) continue
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

// 途中で打ち切られた巻き戻し (情報の state が 'started' のまま)。mod の node 呼び出しが時間切れになったときなどに残る。
// mark なら知らせた印 ('reported') を付け、次からは出さない
export function unfinished(dir, { mark = false } = {}) {
  const bd = path.join(dir, 'branches')
  if (!fs.existsSync(bd)) return []
  const out = []
  for (const name of fs.readdirSync(bd)) {
    if (!name.endsWith('.json')) continue
    const metaFile = path.join(bd, name)
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      if (meta.state !== 'started') continue
      out.push({ id: meta.id, at: meta.at, label: meta.point?.label ?? '', files: (meta.files ?? []).map(f => f.path), saved: path.join(bd, `${meta.id}.files`), details: metaFile })
      if (mark) fs.writeFileSync(metaFile, JSON.stringify({ ...meta, state: 'reported' }))
    } catch {
      // 読めない情報は飛ばす
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
      out = { file, points: points(readRows(file), readSnaps(dir), fs.existsSync), unfinished: unfinished(dir, { mark: true }) }
    } else if (cmd === 'rewind') {
      const file = findTranscript(sessionId)
      const spec = JSON.parse(rest[0] ? fs.readFileSync(rest[0], 'utf8') : readStdin())
      out = { file, ...rewind(file, spec, dir) }
    } else if (cmd === 'snap') {
      const [toolUseId, tool, file, at] = rest
      if (!toolUseId || !file) throw new Error('Usage: snap <sessionId> <toolUseId> <tool> <path> [atMs]')
      out = snap(dir, toolUseId, tool, file, Number(at) || Date.now(), 'pending')
    } else if (cmd === 'drop') {
      if (!rest[0]) throw new Error('Usage: drop <sessionId> <toolUseId>')
      out = settleDenied(dir, rest[0])
    } else if (cmd === 'branches') {
      out = { branches: branches(dir) }
    } else if (cmd === 'dir') {
      out = { dir }
    } else {
      throw new Error(`unknown command: ${cmd}`)
    }
    console.log(JSON.stringify(out))
  } catch (err) {
    // rewind の失敗は、記録を書き換えたか (transcriptChanged) を必ず付けて返す。rename より前の失敗では false。
    // 戻し終えた後の失敗 (終わった印を書けなかった) では、rewind が付けた true と戻した結果 (restored など) も返す
    const rewound = cmd === 'rewind' ? { ...(err?.result ?? {}), transcriptChanged: err?.transcriptChanged === true } : {}
    console.log(JSON.stringify({ ...rewound, error: String(err?.message ?? err) }))
    process.exitCode = 1
  }
}
