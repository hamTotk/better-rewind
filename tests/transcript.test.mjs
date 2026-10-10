import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeRows,
  assertCuttable,
  branches,
  cutPlan,
  dataDir,
  editStats,
  fileRestorePlan,
  leafOf,
  points,
  readSnaps,
  rewind,
  snap,
  toolLabel,
} from '../bin/transcript.mjs'

const SCRIPT = fileURLToPath(new URL('../bin/transcript.mjs', import.meta.url))

const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, isSidechain: false, message: { role: 'user', content }, ...extra })
const ai = (uuid, content, extra = {}) => ({ type: 'assistant', uuid, isSidechain: false, message: { role: 'assistant', content }, ...extra })
// message.id 付きの AI の行 (同じ応答が text 行・tool_use 行に分かれる本物の形)
const aim = (uuid, id, content, extra = {}) => ai(uuid, content, { message: { id, role: 'assistant', content }, ...extra })

// 行を上から順に parentUuid でつなぐ (本物の記録は常につながっている)
const linked = list => {
  let parent = null
  return list.map(r => {
    if (!r.uuid) return r
    const out = { parentUuid: parent, ...r }
    parent = r.uuid
    return out
  })
}

const rows = linked([
  user('u1', '色を聞いて'),
  { type: 'attachment', uuid: 'x1' },
  ai('a1', [{ type: 'text', text: '聞きます' }]),
  ai('a2', [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: '好きな色は?' }] } }]),
  user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '赤' }]),
  ai('a3', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:\\x\\src\\foo.ts' } }]),
  user('r2', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
  ai('a4', [{ type: 'text', text: '赤ですね' }]),
  user('m1', 'meta', { isMeta: true }),
  ai('s1', [{ type: 'text', text: 'subagent' }], { isSidechain: true }),
  user('c1', '<command-name>/compact</command-name>'),
  user('o1', '<local-command-stdout>done</local-command-stdout>'),
  user('u2', '次'),
  ai('a5', [{ type: 'text', text: '次の返答' }]),
])

test('points は人の発言と AskUserQuestion を順に拾い、ほかのツール呼び出し・AI の文章・結果・meta・subagent・コマンド出力・/compact は拾わない', () => {
  assert.deepEqual(
    points(rows).map(p => `${p.uuid}:${p.kind}:${p.label}`),
    ['u1:prompt:色を聞いて', 'a2:tool:AskUserQuestion 好きな色は?', 'u2:prompt:次'],
  )
})

test('points: 要約の跡 (/compact の行と要約の本文の行) は地点にせず、返答の区切りにもしない。ほかのコマンドは地点のまま', () => {
  const rows = linked([
    user('u1', '最初'),
    ai('a1', [{ type: 'text', text: 'はい' }]),
    user('c1', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>API の決定を残す</command-args>'),
    user('o1', '<local-command-stdout>Compacted</local-command-stdout>'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'b1', isSidechain: false },
    user('s1', 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.', { isCompactSummary: true }),
    ai('a2', [{ type: 'text', text: '要約の後の返答' }]),
    user('m1', '<command-name>/model</command-name>'),
    user('u2', '次'),
    ai('a3', [{ type: 'text', text: '次の返答' }]),
  ])
  const list = points(rows)
  assert.deepEqual(list.map(p => `${p.uuid}:${p.label}`), ['u1:最初', 'm1:/model', 'u2:次'])
  // 要約の行で区切らないので、u1 の返答は次の地点 (/model) の手前まで続く
  assert.equal(list[0].reply, 'はい\n要約の後の返答')
})

test('質問の地点は tool_use id と結果の行を持つ', () => {
  const ask = points(rows).find(p => p.uuid === 'a2')
  assert.equal(ask.toolUseId, 't1')
  assert.equal(ask.resultUuid, 'r1')
})

test('返答はその地点から次の人の発言の手前まで。地点にしないツールも ▸ の 1 行で並ぶ', () => {
  const byUuid = Object.fromEntries(points(rows).map(p => [p.uuid, p.reply]))
  assert.equal(byUuid.u1, '聞きます\n▸ AskUserQuestion 好きな色は?\n▸ Edit foo.ts\n赤ですね')
  assert.equal(byUuid.a2, '▸ AskUserQuestion 好きな色は?\n▸ Edit foo.ts\n赤ですね')
  assert.equal(byUuid.u2, '次の返答')
})

test('toolLabel は Bash では説明文を、無ければコマンドを使う', () => {
  assert.equal(toolLabel('Bash', { command: 'npm test', description: 'テストを走らせる' }), 'Bash テストを走らせる')
  assert.equal(toolLabel('Bash', { command: 'npm test' }), 'Bash npm test')
  assert.equal(toolLabel('Skill', { skill: 'plugin-authoring' }), 'Skill plugin-authoring')
})

test('捨てられた枝は拾わず、最後に書かれた行から辿った枝と並列ツールの兄弟は拾う (組み込み rewind 後の空の leafUuid に惑わされない)', () => {
  const rows = [
    { type: 'last-prompt', leafUuid: 'u1' },
    user('u1', '最初', { parentUuid: null }),
    ai('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }], { parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] } }),
    ai('a2', [], { parentUuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.md' } }] } }),
    user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'A' }], { parentUuid: 'a1' }),
    user('r2', [{ type: 'tool_result', tool_use_id: 't2', content: 'B' }], { parentUuid: 'a2' }),
    user('old', '打ち間違い', { parentUuid: 'r2' }),
    { type: 'last-prompt', leafUuid: 'old' },
    { type: 'last-prompt', leafUuid: '00000000-0000-0000-0000-000000000000' },
    user('new', '言い直し', { parentUuid: 'r2' }),
  ]
  assert.deepEqual(activeRows(rows).map(r => r.uuid), ['u1', 'a1', 'a2', 'r1', 'r2', 'new'])
  // 兄弟の枝に分かれた並列の呼び出しも返答のプレビューに出る
  assert.deepEqual(points(rows).map(p => p.label), ['最初', '言い直し'])
  assert.equal(points(rows)[0].reply, '▸ Read a.md\n▸ Read b.md')
})

test('points: 並列の呼び出しの 2 つ目にある質問は地点にしない (途中で切ると結果の無い呼び出しが残る)。1 つ目の質問は地点にする', () => {
  const ask = (id, q) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: q }] } })
  const rows = linked([
    user('u1', '始めて'),
    aim('a1', 'm1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }]),
    aim('a2', 'm1', [ask('q1', '後ろの質問')]),
    user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'A' }]),
    user('r2', [{ type: 'tool_result', tool_use_id: 'q1', content: 'はい' }]),
    aim('a3', 'm2', [ask('q2', '先の質問')]),
    aim('a4', 'm2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.md' } }]),
    user('r3', [{ type: 'tool_result', tool_use_id: 'q2', content: 'はい' }]),
    user('r4', [{ type: 'tool_result', tool_use_id: 't2', content: 'B' }]),
  ])
  assert.deepEqual(points(rows).map(p => p.label), ['始めて', 'AskUserQuestion 先の質問'])
  assert.equal(points(rows)[0].reply, '▸ Read a.md\n▸ AskUserQuestion 後ろの質問\n▸ AskUserQuestion 先の質問\n▸ Read b.md')
})

test('leafOf: 最後の uuid 行より後に書かれた last-prompt が記録にある行を指せば、それを先端にする', () => {
  const head = [
    user('u1', '最初', { parentUuid: null }),
    ai('a1', [{ type: 'text', text: 'はい' }], { parentUuid: 'u1' }),
    { type: 'system', uuid: 'y1', parentUuid: 'a1', isSidechain: false },
  ]
  const r = [...head, { type: 'last-prompt', leafUuid: 'a1' }]
  assert.equal(leafOf(r), 'a1')
  assert.deepEqual(activeRows(r).map(x => x.uuid), ['u1', 'a1'])
  // last-prompt の後に会話が続けば、最後の uuid 行に戻る
  assert.equal(leafOf([...r, user('u2', '次', { parentUuid: 'a1' })]), 'u2')
  // 空の leafUuid・記録に無い leafUuid・subagent の行は使わない
  assert.equal(leafOf([...head, { type: 'last-prompt', leafUuid: '00000000-0000-0000-0000-000000000000' }]), 'y1')
  assert.equal(leafOf([...head, { type: 'last-prompt', leafUuid: 'gone' }]), 'y1')
  assert.equal(leafOf([...head, ai('s1', [], { isSidechain: true, parentUuid: 'a1' }), { type: 'last-prompt', leafUuid: 's1' }]), 'y1')
})

test('editStats は Edit の差分行と、Write の新規作成の行数を数える', () => {
  assert.deepEqual(editStats({ filePath: 'C:/x/a.ts', structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] }), { file: 'C:/x/a.ts', added: 2, removed: 1 })
  assert.deepEqual(editStats({ type: 'create', filePath: 'n.md', content: 'x\ny\n', structuredPatch: [] }), { file: 'n.md', added: 2, removed: 0 })
  assert.equal(editStats({ stdout: 'ok' }), null)
})

test('地点の changes は次の人の発言までの Edit/Write を合計し、失敗した呼び出しは数えない', () => {
  const rows = linked([
    user('u1', '直して'),
    ai('a1', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'C:/x/a.ts' } }]),
    user('r1', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }], { toolUseResult: { filePath: 'C:/x/a.ts', structuredPatch: [{ lines: ['-b', '+c'] }] } }),
    ai('a2', [{ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: 'C:/x/b.ts' } }]),
    user('r2', [{ type: 'tool_result', tool_use_id: 'e2', content: 'fail', is_error: true }], { toolUseResult: { filePath: 'C:/x/b.ts', structuredPatch: [{ lines: ['+z'] }] } }),
    user('u2', '書いて'),
    ai('a3', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'C:/x/n.md' } }]),
    user('r3', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }], { toolUseResult: { type: 'create', filePath: 'C:/x/n.md', content: '1\n2\n3', structuredPatch: [] } }),
    ai('a4', [{ type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: 'C:/x/a.ts' } }]),
    user('r4', [{ type: 'tool_result', tool_use_id: 'e3', content: 'ok' }], { toolUseResult: { filePath: 'C:/x/a.ts', structuredPatch: [{ lines: ['+d'] }] } }),
    user('u3', '次'),
  ])
  const byUuid = Object.fromEntries(points(rows).map(p => [`${p.uuid}`, p.changes]))
  assert.deepEqual(byUuid.u1, { files: ['C:/x/a.ts'], added: 1, removed: 1 })
  assert.deepEqual(byUuid.u2, { files: ['C:/x/n.md', 'C:/x/a.ts'], added: 4, removed: 0 })
  assert.deepEqual(byUuid.u3, { files: [], added: 0, removed: 0 })
})

test('貼り付けた文章はラベルで [貼り付け] に置き換え、入力欄へ戻す本文では中身に戻す', () => {
  const rows = [user('u1', '見て\n<pasted_content id="1">長い本文</pasted_content id="1">')]
  assert.equal(points(rows)[0].label, '見て [Pasted text]')
  assert.equal(points(rows)[0].text, '見て\n長い本文')
})

// ---- 巻き戻し ----

const T = s => new Date(Date.UTC(2026, 9, 10, 0, 0, s)).toISOString()
const ms = s => Date.parse(T(s))
const QUESTIONS = [{ question: '色は?', header: '色', multiSelect: false, options: [{ label: '赤' }, { label: '青' }] }]

// 人の発言 → 文章と Edit (同じ応答) → 考えるだけの行と質問 (同じ応答) → 並列の Write 2 つ → 文章 → 次の発言
const convo = (dir = 'C:/x') =>
  linked([
    user('u1', '直して', { timestamp: T(1), sessionId: 'S' }),
    aim('a1', 'm1', [{ type: 'text', text: 'やります' }], { timestamp: T(2) }),
    aim('a2', 'm1', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: `${dir}/a.ts` } }], { timestamp: T(3) }),
    user('r1', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }], { timestamp: T(4) }),
    aim('a3', 'm2', [{ type: 'thinking', thinking: '考える', signature: 'x' }], { timestamp: T(5) }),
    aim('a4', 'm2', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: QUESTIONS } }], { timestamp: T(6), sessionId: 'S', cwd: dir }),
    user('r2', [{ type: 'tool_result', tool_use_id: 'q1', content: 'Your questions have been answered: "色は?"="赤". You can now continue with these answers in mind.' }], { timestamp: T(7) }),
    aim('a5', 'm3', [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: `${dir}/n.md` } }], { timestamp: T(8) }),
    aim('a6', 'm3', [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: `${dir}/o.md` } }], { timestamp: T(8) }),
    user('r3', [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }], { timestamp: T(9) }),
    user('r4', [{ type: 'tool_result', tool_use_id: 'w2', content: 'ok' }], { timestamp: T(9) }),
    aim('a7', 'm4', [{ type: 'text', text: '赤で書きました' }], { timestamp: T(10) }),
    user('u2', '次', { timestamp: T(11) }),
    aim('a8', 'm5', [{ type: 'text', text: 'はい' }], { timestamp: T(12) }),
  ])

const at = (rows, uuid) => rows.findIndex(r => r.uuid === uuid)

test('cutPlan: 人の発言はその親が先端、考えるだけの行は先端にせず、並列の途中は最初の呼び出しへ寄せる', () => {
  const r = convo()
  assert.deepEqual(cutPlan(r, { uuid: 'u2' }), { cutIndex: at(r, 'u2'), leafUuid: 'a7', append: [], since: ms(11) })
  // 一覧の地点は質問だけだが、cutPlan はどのツール呼び出しの id でも切る位置を決められる
  assert.deepEqual(cutPlan(r, { uuid: 'a2', toolUseId: 'e1' }), { cutIndex: at(r, 'a2'), leafUuid: 'a1', append: [], since: ms(3) })
  assert.deepEqual(cutPlan(r, { uuid: 'a4', toolUseId: 'q1' }), { cutIndex: at(r, 'a3'), leafUuid: 'r1', append: [], since: ms(5) })
  assert.deepEqual(cutPlan(r, { uuid: 'a6', toolUseId: 'w2' }), { cutIndex: at(r, 'a5'), leafUuid: 'r2', append: [], since: ms(8) })
  // 最初の発言の前には戻せない
  const first = cutPlan(r, { uuid: 'u1' })
  assert.equal(first.leafUuid, undefined)
  assert.throws(() => assertCuttable(r, first), /Cannot rewind to before the first message/)
  assert.throws(() => cutPlan(r, { uuid: 'nope' }), /not in the current conversation/)
})

test('cutPlan: AskUserQuestion の回答を選び直すと質問の行を残して本物の書式の回答を足す', () => {
  const r = convo()
  const plan = cutPlan(r, { uuid: 'a4', toolUseId: 'q1', answers: ['青'] }, { now: new Date(T(20)) })
  assert.equal(plan.cutIndex, at(r, 'a4') + 1)
  const [row] = plan.append
  assert.equal(plan.leafUuid, row.uuid)
  assert.equal(row.parentUuid, 'a4')
  assert.deepEqual(row.message.content, [
    { type: 'tool_result', content: 'Your questions have been answered: "色は?"="青". You can now continue with these answers in mind.', tool_use_id: 'q1' },
  ])
  assert.deepEqual(row.toolUseResult.answers, { '色は?': '青' })
  assert.equal(row.sessionId, 'S')
  assert.throws(() => cutPlan(r, { uuid: 'a4', toolUseId: 'q1', answers: [] }), /Answer every question/)
  assert.throws(() => cutPlan(r, { uuid: 'a2', toolUseId: 'e1', answers: ['x'] }), /only be changed at an AskUserQuestion point/)
})

test('assertCuttable は結果の無いツール呼び出しが残る切り方を断る', () => {
  const r = convo()
  // 並列の Write の 1 つ目だけを残す切り方
  assert.throws(() => assertCuttable(r, { cutIndex: at(r, 'a6'), leafUuid: 'a5', append: [] }), /tool call without its result/)
  assert.doesNotThrow(() => assertCuttable(r, cutPlan(r, { uuid: 'a6', toolUseId: 'w2' })))
})

test('points: 会話を戻せるかと、地点より後に取った控えがあるか (戻せるファイルがあるか) を付ける', () => {
  const r = convo()
  const snaps = [{ path: 'C:/x/n.md', at: ms(8) + 5, existed: false }]
  const list = points(r, snaps)
  assert.deepEqual(list.map(p => p.label), ['直して', 'AskUserQuestion 色は?', '次'])
  assert.deepEqual(list.map(p => p.canCut), [false, true, true])
  assert.deepEqual(list.map(p => p.restorable), [true, true, false])
  assert.deepEqual(list[1].questions, QUESTIONS)
  // 控えが地点より前にしか無ければ、戻せるファイルは無い
  assert.deepEqual(points(r, [{ path: 'C:/x/a.ts', at: ms(3) + 1, existed: true }]).map(p => p.restorable), [true, false, false])
})

test('fileRestorePlan は時刻以降の控えのうち、ファイルごとに最初のものを選ぶ', () => {
  const snaps = [
    { path: 'C:/x/a.ts', at: 1, existed: true },
    { path: 'C:/x/b.ts', at: 5, existed: true, data: 'b1' },
    { path: 'C:/x/b.ts', at: 3, existed: false },
    { path: 'C:/x/c.ts', at: 4, existed: true },
  ]
  assert.deepEqual(fileRestorePlan(snaps, 3).map(s => `${s.path}@${s.at}`), ['C:/x/b.ts@3', 'C:/x/c.ts@4'])
  assert.deepEqual(fileRestorePlan(snaps, undefined), [])
})

// 一時フォルダに偽の設定フォルダ (projects/p/S.jsonl) と作業フォルダを作る。make は作業フォルダから記録の行を作る
function sandbox(make = convo) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'better-rewind-'))
  const work = path.join(base, 'work')
  fs.mkdirSync(path.join(base, 'projects', 'p'), { recursive: true })
  fs.mkdirSync(work)
  const file = path.join(base, 'projects', 'p', 'S.jsonl')
  const raw = `${make(work).map(r => JSON.stringify(r)).join('\n')}\n`
  fs.writeFileSync(file, raw)
  return { base, work, file, raw, dir: dataDir('S', base) }
}

// mod が $.fs で書くのと同じ形の控え (.json と .b64)
function writeSnap(dir, id, meta, content) {
  const sd = path.join(dir, 'snaps')
  fs.mkdirSync(sd, { recursive: true })
  if (content !== undefined) fs.writeFileSync(path.join(sd, `${id}.b64`), Buffer.from(content).toString('base64'))
  fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify({ toolUseId: id, ...meta, existed: content !== undefined, ...(content !== undefined ? { data: `${id}.b64` } : {}) }))
}

const fileRows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

test('rewind (会話だけ): 発言の直前で切り、last-prompt で先端を示し、切る前の記録とどこで切ったかを残す', () => {
  const s = sandbox()
  const out = rewind(s.file, { uuid: 'u2', label: '次', mode: 'conversation' }, s.dir, new Date(T(30)))
  const after = fileRows(s.file)
  const before = s.raw.split('\n').filter(Boolean)
  assert.deepEqual(after.slice(0, -1).map(r => r.uuid), convo().slice(0, at(convo(), 'u2')).map(r => r.uuid))
  assert.deepEqual(after.at(-1), { type: 'last-prompt', lastPrompt: '直して', leafUuid: 'a7', sessionId: 'S' })
  assert.equal(out.dropped, before.length - at(convo(), 'u2'))
  assert.deepEqual(out.restored, [])

  const bd = path.join(s.dir, 'branches')
  assert.equal(fs.readFileSync(path.join(bd, `${out.id}.jsonl`), 'utf8'), s.raw)
  const meta = JSON.parse(fs.readFileSync(path.join(bd, `${out.id}.json`), 'utf8'))
  assert.equal(meta.cutLine, at(convo(), 'u2'))
  assert.equal(meta.leafUuid, 'a7')
  assert.deepEqual(meta.point, { uuid: 'u2', label: '次' })

  const [branch] = branches(s.dir)
  assert.equal(branch.label, '次')
  assert.equal(branch.answered, false)
  assert.equal(branch.text, '❯ 次\n\nはい')
})

test('rewind (回答を選び直す): 質問の直後で切って新しい回答を足し、元の回答は枝で読める', () => {
  const s = sandbox()
  const out = rewind(s.file, { uuid: 'a4', toolUseId: 'q1', label: 'AskUserQuestion 色は?', mode: 'conversation', answers: ['青'] }, s.dir, new Date(T(30)))
  const after = fileRows(s.file)
  const [answer, last] = after.slice(-2)
  assert.equal(after.at(-3).uuid, 'a4')
  assert.equal(answer.message.content[0].tool_use_id, 'q1')
  assert.match(answer.message.content[0].content, /"色は\?"="青"/)
  assert.equal(last.leafUuid, answer.uuid)
  assert.equal(out.leaf, answer.uuid)

  const [branch] = branches(s.dir)
  assert.equal(branch.answered, true)
  assert.match(branch.text, /^⎿ Your questions have been answered: "色は\?"="赤"/)
  assert.match(branch.text, /▸ Write n\.md\n\n▸ Write o\.md\n\n赤で書きました\n\n❯ 次\n\nはい$/)
})

test('rewind (会話とファイル): 地点以降に変わったファイルを最初の控えに戻し、新しく作られたファイルは消す', () => {
  const s = sandbox()
  const w = name => path.join(s.work, name)
  fs.writeFileSync(w('a.ts'), 'a 今')
  fs.writeFileSync(w('n.md'), '新規')
  fs.writeFileSync(w('o.md'), 'o 今')
  fs.writeFileSync(w('big.bin'), Buffer.alloc(5 * 1024 * 1024, 7))
  writeSnap(s.dir, 'e1', { tool: 'Edit', path: w('a.ts'), at: ms(3) + 1 }, 'a 前')
  writeSnap(s.dir, 'w1', { tool: 'Write', path: w('n.md'), at: ms(8) + 1 })
  writeSnap(s.dir, 'w2', { tool: 'Write', path: w('o.md'), at: ms(8) + 2 }, 'o 前')
  writeSnap(s.dir, 'later', { tool: 'Edit', path: w('o.md'), at: ms(12) }, 'o 後')
  // 4 MiB を超えるファイルは node の snap で写す
  snap(s.dir, 'toolu_big', 'Write', w('big.bin'), ms(9))
  fs.writeFileSync(w('big.bin'), 'changed')
  assert.equal(readSnaps(s.dir).length, 5)

  // 質問の地点で回答を選び直す: 質問より前の Edit (a.ts) は戻さず、後の Write は戻す
  const out = rewind(s.file, { uuid: 'a4', toolUseId: 'q1', label: 'AskUserQuestion 色は?', mode: 'both', answers: ['青'] }, s.dir, new Date(T(30)))
  assert.equal(fs.readFileSync(w('a.ts'), 'utf8'), 'a 今')
  assert.equal(fs.existsSync(w('n.md')), false)
  assert.equal(fs.readFileSync(w('o.md'), 'utf8'), 'o 前')
  assert.equal(fs.statSync(w('big.bin')).size, 5 * 1024 * 1024)
  assert.deepEqual(out.removed, [w('n.md')])
  assert.deepEqual(out.restored.sort(), [w('big.bin'), w('o.md')].sort())
  assert.equal(fileRows(s.file).at(-1).leafUuid, out.leaf)
  assert.equal(fileRows(s.file).at(-2).parentUuid, 'a4')

  // 戻す前の中身も残っている
  const meta = JSON.parse(fs.readFileSync(path.join(s.dir, 'branches', `${out.id}.json`), 'utf8'))
  const o = meta.files.find(f => f.path === w('o.md'))
  assert.equal(fs.readFileSync(path.join(s.dir, 'branches', o.backup), 'utf8'), 'o 今')
})

test('rewind (ファイルだけ): 記録は変えず、枝の一覧にも出さない。(会話だけ) はファイルに触れない', () => {
  const s = sandbox()
  const w = name => path.join(s.work, name)
  fs.writeFileSync(w('o.md'), 'o 今')
  writeSnap(s.dir, 'w2', { tool: 'Write', path: w('o.md'), at: ms(8) + 2 }, 'o 前')

  rewind(s.file, { uuid: 'u2', mode: 'conversation' }, s.dir, new Date(T(30)))
  assert.equal(fs.readFileSync(w('o.md'), 'utf8'), 'o 今')

  const s2 = sandbox()
  fs.writeFileSync(path.join(s2.work, 'o.md'), 'o 今')
  writeSnap(s2.dir, 'w2', { tool: 'Write', path: path.join(s2.work, 'o.md'), at: ms(8) + 2 }, 'o 前')
  const out = rewind(s2.file, { uuid: 'u1', mode: 'files' }, s2.dir, new Date(T(30)))
  assert.equal(fs.readFileSync(s2.file, 'utf8'), s2.raw)
  assert.equal(fs.readFileSync(path.join(s2.work, 'o.md'), 'utf8'), 'o 前')
  assert.deepEqual(out.restored, [path.join(s2.work, 'o.md')])
  assert.deepEqual(branches(s2.dir), [])
})

test('rewind に失敗したときは記録もファイルも変えず、保存も残さない', () => {
  const s = sandbox()
  const tries = [
    [{ uuid: 'u1', mode: 'conversation' }, /Cannot rewind to before the first message/],
    [{ uuid: 'a4', toolUseId: 'q1', mode: 'both', answers: [''] }, /Answer every question/],
    [{ uuid: 'nope', mode: 'both' }, /not in the current conversation/],
    [{ uuid: 'u2', mode: 'files' }, /No file backups to restore/],
    [{ uuid: 'u2', mode: 'all' }, /Invalid rewind mode/],
  ]
  for (const [spec, message] of tries) assert.throws(() => rewind(s.file, spec, s.dir), message)
  // 中身の読めない控えがあれば、ファイルに触れる前に止まる
  writeSnap(s.dir, 'w2', { tool: 'Write', path: path.join(s.work, 'o.md'), at: ms(8) + 2 }, 'o 前')
  fs.rmSync(path.join(s.dir, 'snaps', 'w2.b64'))
  assert.throws(() => rewind(s.file, { uuid: 'a4', toolUseId: 'q1', mode: 'both', answers: ['青'] }, s.dir))
  assert.throws(() => rewind(s.file, { uuid: 'u1', mode: 'files' }, s.dir))
  assert.equal(fs.readFileSync(s.file, 'utf8'), s.raw)
  assert.equal(fs.existsSync(path.join(s.dir, 'branches')), false)
})

// a.ts (質問の後の Edit の控え) と o.md (並列 Write の控え) を「今」の中身にして、質問の地点で回答を選び直し両方を戻す用意
function twoFiles() {
  const s = sandbox()
  const w = name => path.join(s.work, name)
  fs.writeFileSync(w('a.ts'), 'a 今')
  fs.writeFileSync(w('o.md'), 'o 今')
  writeSnap(s.dir, 'e9', { tool: 'Edit', path: w('a.ts'), at: ms(6) + 1 }, 'a 前')
  writeSnap(s.dir, 'w2', { tool: 'Write', path: w('o.md'), at: ms(8) + 2 }, 'o 前')
  const unchanged = () => {
    assert.equal(fs.readFileSync(s.file, 'utf8'), s.raw)
    assert.equal(fs.readFileSync(w('a.ts'), 'utf8'), 'a 今')
    assert.equal(fs.readFileSync(w('o.md'), 'utf8'), 'o 今')
    assert.equal(fs.existsSync(path.join(s.dir, 'branches')), false)
    assert.equal(fs.existsSync(`${s.file}.better-rewind.tmp`), false)
  }
  return { ...s, w, unchanged, spec: { uuid: 'a4', toolUseId: 'q1', label: 'AskUserQuestion 色は?', mode: 'both', answers: ['青'] } }
}

test('rewind: 戻す先のファイルが読み取り専用なら、先に戻したファイルも書き戻し、記録も保存も変えない', () => {
  const s = twoFiles()
  fs.chmodSync(s.w('o.md'), 0o444)
  try {
    assert.throws(() => rewind(s.file, s.spec, s.dir, new Date(T(30))), err => {
      assert.match(err.message, /^Could not restore the file: .*o\.md \(/)
      if (process.platform === 'win32') assert.match(err.message, /read-only or in use by another app/)
      assert.equal(err.transcriptChanged, undefined)
      return true
    })
    s.unchanged()
  } finally {
    fs.chmodSync(s.w('o.md'), 0o644)
  }
})

// Windows では読み取り専用のファイルへ rename で上書きできない。それで記録の書き換えだけを失敗させる
test('rewind: 記録を書き換えられなければ、戻したファイルを書き戻して何も変えない', { skip: process.platform !== 'win32' && 'Windows でだけ再現できる' }, () => {
  const s = twoFiles()
  fs.chmodSync(s.file, 0o444)
  try {
    assert.throws(() => rewind(s.file, s.spec, s.dir, new Date(T(30))), /^Error: Could not rewrite the transcript: .*S\.jsonl \(read-only/)
    s.unchanged()
  } finally {
    fs.chmodSync(s.file, 0o644)
  }
})

test('rewind: 戻す前のファイルを退避できなければ、作りかけの保存を片付けて日本語で理由を出す', () => {
  const s = twoFiles()
  const id = new Date(T(30)).toISOString().replace(/[:.]/g, '-')
  // o.md (2 つ目) の退避先にフォルダを置いて、写せないようにする
  fs.mkdirSync(path.join(s.dir, 'branches', `${id}.files`, '1'), { recursive: true })
  assert.throws(() => rewind(s.file, s.spec, s.dir, new Date(T(30))), /^Error: Could not save the current file before restoring: .*o\.md \(/)
  s.unchanged()
})

test('rewind: 地点の親が attachment で、その後ろに system 行があっても、切った後の先端は地点の直前になる', () => {
  const s = sandbox(() => [
    user('u1', '直して', { parentUuid: null, timestamp: T(1), sessionId: 'S' }),
    ai('a1', [{ type: 'text', text: 'やります' }], { parentUuid: 'u1', timestamp: T(2) }),
    { type: 'attachment', uuid: 'x1', parentUuid: 'a1', isSidechain: false, timestamp: T(3) },
    { type: 'system', uuid: 'y1', parentUuid: 'a1', isSidechain: false, timestamp: T(3) },
    user('u2', '次', { parentUuid: 'x1', timestamp: T(4) }),
    ai('a2', [{ type: 'text', text: 'はい' }], { parentUuid: 'u2', timestamp: T(5) }),
  ])
  const out = rewind(s.file, { uuid: 'u2', mode: 'conversation' }, s.dir, new Date(T(30)))
  assert.equal(out.leaf, 'x1')
  assert.equal(out.transcriptChanged, true)
  const after = fileRows(s.file)
  assert.equal(leafOf(after), 'x1')
  assert.deepEqual(activeRows(after).map(r => r.uuid), ['u1', 'a1', 'x1'])
  assert.deepEqual(points(after).map(p => p.label), ['直して'])
})

test('コマンドとして: rewind は spec を stdin で受け、失敗は JSON の error と終了コード 1 で返す', () => {
  const s = sandbox()
  const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: s.base } })

  const bad = run(['rewind', 'S'], JSON.stringify({ uuid: 'u1', mode: 'conversation' }))
  assert.equal(bad.status, 1)
  assert.match(JSON.parse(bad.stdout).error, /Cannot rewind to before the first message/)
  assert.equal(JSON.parse(bad.stdout).transcriptChanged, false)
  assert.equal(fs.readFileSync(s.file, 'utf8'), s.raw)

  const ok = run(['rewind', 'S'], JSON.stringify({ uuid: 'u2', mode: 'conversation' }))
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.stdout).leaf, 'a7')
  assert.equal(JSON.parse(ok.stdout).transcriptChanged, true)
  const listed = JSON.parse(run(['branches', 'S']).stdout).branches
  assert.equal(listed.length, 1)
  const after = JSON.parse(run(['points', 'S']).stdout).points
  assert.deepEqual(after.map(p => p.label), ['直して', 'AskUserQuestion 色は?'])
  assert.match(JSON.parse(run(['points', '../x']).stdout).error, /Invalid session id/)
})
