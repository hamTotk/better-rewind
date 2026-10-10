import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Branch, Point, SummarizeRequest } from '../types'
import {
  branchLines,
  changesParts,
  clipToRows,
  doneMessage,
  editedFile,
  isMissing,
  locatePoint,
  modeOptions,
  pointKey,
  snapName,
  splitForSummary,
  summarizeRequest,
  summarizedMessage,
  windowAround,
} from '../hooks/lib'

const none = { files: [], added: 0, removed: 0 }
const QUESTIONS = [
  { question: '次は?', header: '進め方', multiSelect: false, options: [{ label: 'A' }, { label: 'B', description: 'B の説明' }] },
  { question: '色は?', multiSelect: false, options: [{ label: '赤' }, { label: '青' }] },
]
// 一覧に出る地点は人の発言と AskUserQuestion の質問だけ (helper の points() と同じ)
const POINTS: Point[] = [
  { uuid: 'u1', kind: 'prompt', label: '色を聞いて', text: '色を聞いて', reply: '聞きます', changes: { files: ['C:\\x\\foo.ts', 'C:\\x\\bar.ts'], added: 12, removed: 3 }, canCut: true, restorable: false },
  { uuid: 'u2', kind: 'prompt', label: 'foo を直して', text: 'foo を直して', reply: '▸ Edit foo.ts\n直しました', changes: { files: ['C:\\x\\foo.ts'], added: 3, removed: 1 }, canCut: true, restorable: true },
  { uuid: 'a4', kind: 'tool', tool: 'AskUserQuestion', toolUseId: 't2', label: 'AskUserQuestion 次は?', reply: '▸ AskUserQuestion 次は?', questions: QUESTIONS, changes: none, canCut: true, restorable: false },
]
const BRANCHES: Branch[] = [
  { id: '2026-10-10T05-03-00-000Z', at: '2026-10-10T05:03:00.000Z', label: 'foo を直して', mode: 'both', answered: false, text: '❯ foo を直して\n\n▸ Edit foo.ts\n\n直しました\n\n❯ 次\n\nはい' },
]

// session.compact の hook に渡る会話 (POINTS と同じ並び)。エンジンの handle 付き
const msg = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({ role, text, toolUses: [], ...extra })
const MESSAGES: SessionMessage[] = [
  msg('user', '色を聞いて', { handle: 'h0' }),
  msg('assistant', '聞きます', { handle: 'h1' }),
  msg('user', 'foo を直して', { handle: 'h2' }),
  msg('assistant', '', { handle: 'h3', toolUses: [{ tool_use_id: 'e1', tool: 'Edit', input: {} }] }),
  msg('user', '', { handle: 'h4', toolResults: [{ tool_use_id: 'e1', text: 'ok', isError: false }] }),
  msg('assistant', '直しました', { handle: 'h5', toolUses: [{ tool_use_id: 't2', tool: 'AskUserQuestion', input: {} }] }),
  msg('user', '', { handle: 'h6', toolResults: [{ tool_use_id: 't2', text: 'A', isError: false }] }),
  msg('assistant', 'A で進めます', { handle: 'h7' }),
]
const SUMMARY = msg('user', 'SUMMARY')
const handles = (list: readonly SessionMessage[]) => list.map(m => m.handle ?? m.text)

const done = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const run = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

const PANE = {
  component: 'Pane' as const,
  requestId: 'better-rewind',
  props: { title: 'Better Rewind', isFocused: true, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 60, rows: 30 },
}

const REWOUND = { file: 'S.jsonl', id: 'b1', mode: 'conversation', leaf: 'x', dropped: 3, restored: [], removed: [] }

// エンジン側の受け口をまとめて用意する。node の各サブコマンドの返事を replies で渡し、呼ばれた内容を記録する
function engine(on: On, replies: Record<string, unknown>, $test?: Engine) {
  mock.store(on)
  const seen = {
    node: [] as { sub: string; stdin?: string }[],
    closed: [] as string[],
    toasts: [] as string[],
    commands: [] as string[],
    submitted: [] as string[],
    filled: [] as string[],
    statuses: [] as (string | undefined)[],
    // /compact が要約する会話。undefined なら /compact は session.compact まで行かない (mod の hook に届かなかった場合)
    transcript: MESSAGES as SessionMessage[] | undefined,
    // session.compact の行き着いた先: 要約した後の会話 (handle) か、断った理由
    compacted: [] as { messages?: string[]; skip?: string }[],
    // core に届いた要約: 添えた指示と、要約に回ったメッセージ (handle)
    compacts: [] as { instructions?: string; summarized: string[] }[],
    // 立てると、/compact の中で要約がもう 1 回来る (頼みが 1 回で下ろされるかを見る)
    again: false,
    // 立てると、core の要約が失敗する / /compact そのものが失敗する
    coreFails: false,
    commandFails: false,
  }
  on('session.id', () => ({ value: 'S' }))
  on('process.run', ($, e) => {
    const sub = e.argv[2] ?? ''
    seen.node.push({ sub, stdin: e.init?.stdin })
    return { value: done(JSON.stringify(replies[sub] ?? { error: `no reply: ${sub}` })) }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.focus', () => ({}))
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(String(e.text))
    return { value: undefined }
  })
  // テストの kit ではこの hook がエンジンの代わりで、その下に組み込みの /compact は無い (mod の $.command.run('compact') は
  // ここで止まり、session.compact へは進まない)。そこで /compact だけは、実機の /compact と同じく session.compact を
  // trigger 'manual'・会話 (handle 付き)・指示 (args) で呼び、要約が済んでから戻る。呼ぶのはテスト本体の $ ($test) で、
  // mod の session.compact hook を通る (実機で /compact が mod の hook を通るのと同じ。2026-10-10 確認)。
  // この hook の $ からは呼べない (kit が「hooks module がこの呼び出しをしていない」と断る)
  on('command.run', async ($, e) => {
    seen.commands.push(`/${e.command} ${e.args}`)
    if (e.command !== 'compact') return { text: '' }
    if (!$test) throw new Error('/compact を通すテストは engine(on, replies, $) でテストの $ を渡す')
    if (seen.commandFails) throw new Error('compact failed')
    const times = seen.again ? 2 : seen.transcript ? 1 : 0
    for (let i = 0; i < times; i++) {
      const r = await compact($test, { trigger: 'manual', messages: seen.transcript ?? MESSAGES, ...(e.args ? { instructions: e.args } : {}) })
      seen.compacted.push(r.skip !== undefined ? { skip: r.skip } : { messages: handles(r.messages ?? []) })
    }
    // 実機の $.command.run('compact') は要約を終えてから {} で戻った
    return {}
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  // core の要約: 渡されたメッセージを SUMMARY 1 つに置き換える
  on('session.compact', ($, e) => {
    seen.compacts.push({ instructions: e.instructions, summarized: handles(e.messages) })
    if (seen.coreFails) throw new Error('summarizer failed')
    return { messages: [SUMMARY] }
  })
  return seen
}

// session.compact を、エンジンが hook に渡すのと同じ形 (trigger と handle 付きの会話) で呼ぶ。
// plugin の $.session.compact の型は指示しか受けないので型を外す
const compact = ($: { session: { compact: unknown } }, input: { trigger: 'manual' | 'plugin'; messages: SessionMessage[]; instructions?: string }) =>
  ($.session.compact as (input: unknown) => Promise<{ messages?: readonly SessionMessage[]; skip?: string }>)(input)

const rewinds = (seen: ReturnType<typeof engine>) => seen.node.filter(n => n.sub === 'rewind').map(n => JSON.parse(n.stdin ?? '{}'))

describe('一覧ペイン', () => {
  test('組み込みに似た 2 行の一覧が出て、フォーカスした地点の返答がプレビューされ、Enter で戻し方の段階へ進む', async ($, on) => {
    const seen = engine(on, { points: { file: 'S.jsonl', points: POINTS } })

    const { text } = await $.command.run(run('better-rewind'))
    expect(text).toStartWith('Opened 3 rewind points')

    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Better Rewind' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
    // 開いた直後は最後の (現在) にカーソル
    expect((await ui.find({ key: 'current' }))?.props).toMatchObject({ label: '❯' })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: 'This is the current state' })
    // 人の発言は上の階層、応答の中の質問は字下げ
    expect((await ui.find({ key: `row:${pointKey(POINTS[0]!)}` }))?.props).toMatchObject({ paddingLeft: 0 })
    expect((await ui.find({ key: `row:${pointKey(POINTS[1]!)}` }))?.props).toMatchObject({ paddingLeft: 0 })
    expect((await ui.find({ key: `row:${pointKey(POINTS[2]!)}` }))?.props).toMatchObject({ paddingLeft: 4 })
    // 2 行目: 複数ファイルは件数、1 ファイルは名前、無ければ変更なし
    expect(await ui.find({ type: 'Text', text: /2 files changed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /foo\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No code changes/ })).toBeDefined()

    // 矢印キーでフォーカスが動いたのと同じ知らせ
    await $.ui.focus({ component: 'Pane', requestId: 'better-rewind', element: pointKey(POINTS[1]!), origin: { kind: 'person' } })
    expect((await ui.find({ key: pointKey(POINTS[1]!) }))?.props).toMatchObject({ label: '❯' })
    expect((await ui.find({ key: 'current' }))?.props).toMatchObject({ label: ' ' })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: '▸ Edit foo.ts\n直しました' })

    // Enter: 戻し方を選ぶ段階。控えがあるのでファイルの選択肢も出る。要約の 2 つは戻す選択肢と「やめる」のあいだ (組み込みと同じ並び)
    await ui.press({ key: pointKey(POINTS[1]!) })
    expect(await ui.find({ type: 'Text', text: 'Rewind to just before "foo を直して"' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.key)).toEqual(['mode:both', 'mode:conversation', 'mode:files', 'mode:summarize', 'mode:summarize_up_to', 'mode:cancel'])
    expect(await ui.find({ type: 'Text', text: 'Summarize from here' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Summarize up to here' })).toBeDefined()
    expect((await ui.find({ key: 'mode:both' }))?.props).toMatchObject({ label: '❯' })
    await $.ui.focus({ component: 'Pane', requestId: 'better-rewind', element: 'mode:files', origin: { kind: 'person' } })
    expect((await ui.find({ key: 'mode:files' }))?.props).toMatchObject({ label: '❯' })

    // やめる: 一覧に戻り、カーソルは選んだ地点のまま
    await ui.press({ key: 'mode:cancel' })
    expect((await ui.find({ key: pointKey(POINTS[1]!) }))?.props).toMatchObject({ label: '❯' })
    expect(rewinds(seen)).toEqual([])

    await ui.press({ key: 'current' })
    expect(seen.closed).toEqual(['better-rewind'])
    await ui.unmount()
  })

  test('読み込みに失敗したら理由を出す', async ($, on) => {
    engine(on, { points: { error: 'transcript not found: S' } })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Could not load: transcript not found: S' })).toBeDefined()
  })
})

describe('巻き戻しの実行', () => {
  test('人の発言で「会話だけ戻す」: 記録を切って同じセッションを読み直し、発言を入力欄に戻す', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: REWOUND })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })

    await ui.press({ key: pointKey(POINTS[0]!) })
    // 控えが無いのでファイルの選択肢は出ない。一覧の先頭なので「ここまでを要約」も出ない
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.key)).toEqual(['mode:conversation', 'mode:summarize', 'mode:cancel'])
    await ui.press({ key: 'mode:conversation' })

    expect(rewinds(seen)).toEqual([{ uuid: 'u1', label: '色を聞いて', mode: 'conversation' }])
    expect(seen.closed).toEqual(['better-rewind'])
    expect(seen.commands).toEqual(['/resume S'])
    expect(seen.filled).toEqual(['色を聞いて'])
    expect(seen.submitted).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Rewound · see the previous conversation with /better-rewind branches')
  })

  test('AskUserQuestion: 質問ごとに選択肢か自分で書いた回答を選ぶと、回答を足して読み直し、AI に続きを始めさせる', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: REWOUND })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })

    await ui.press({ key: pointKey(POINTS[2]!) })
    expect(await ui.find({ type: 'Text', text: 'Change your answer to "AskUserQuestion 次は?"' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Restore conversation, then re-answer/ })).toBeDefined()
    await ui.press({ key: 'mode:conversation' })

    // 1 問目: 元の選択肢 (説明つき) と自分で書く欄
    expect(await ui.find({ type: 'Text', text: '進め方: 次は? (1/2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /B の説明/ })).toBeDefined()
    expect((await ui.find({ type: 'Input', key: 'answer:own' }))?.props).toMatchObject({ label: 'Your answer' })
    await ui.press({ key: 'answer:1' })

    // 2 問目は自分で書く
    expect(await ui.find({ type: 'Text', text: '色は? (2/2)' })).toBeDefined()
    expect(rewinds(seen)).toEqual([])
    await ui.input({ key: 'answer:own', text: ' 緑 ' })

    expect(rewinds(seen)).toEqual([{ uuid: 'a4', toolUseId: 't2', label: 'AskUserQuestion 次は?', mode: 'conversation', answers: ['B', '緑'] }])
    expect(seen.commands).toEqual(['/resume S'])
    // AI には新しい回答しか見えないので、「変えた」とは言わずに続きを頼む
    expect(seen.submitted).toEqual(['Continue based on my answer to your question.'])
    expect(seen.filled).toEqual([])
  })

  test('回答の段階で戻る: 2 問目なら前の質問へ、1 問目なら戻し方の選択へ', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: REWOUND })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })

    await ui.press({ key: pointKey(POINTS[2]!) })
    await ui.press({ key: 'mode:conversation' })
    expect(await ui.find({ type: 'Text', text: 'Back to rewind options' })).toBeDefined()
    await ui.press({ key: 'answer:back' })
    expect(await ui.find({ type: 'Text', text: 'Change your answer to "AskUserQuestion 次は?"' })).toBeDefined()
    expect((await ui.find({ key: 'mode:conversation' }))?.props).toMatchObject({ label: '❯' })

    await ui.press({ key: 'mode:conversation' })
    await ui.press({ key: 'answer:0' })
    expect(await ui.find({ type: 'Text', text: '色は? (2/2)' })).toBeDefined()
    await ui.press({ key: 'answer:back' })
    // 1 問目の回答は消えて、選び直せる
    expect(await ui.find({ type: 'Text', text: '進め方: 次は? (1/2)' })).toBeDefined()
    await ui.press({ key: 'answer:1' })
    await ui.press({ key: 'answer:0' })
    expect(rewinds(seen)).toEqual([{ uuid: 'a4', toolUseId: 't2', label: 'AskUserQuestion 次は?', mode: 'conversation', answers: ['B', '赤'] }])
  })

  test('helper が記録を書き換えた後に失敗しても、読み直してから失敗を知らせる', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: { error: 'Could not restore the file: C:/x/foo.ts (read-only or in use by another app)', transcriptChanged: true } })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(POINTS[0]!) })
    await ui.press({ key: 'mode:conversation' })
    expect(seen.closed).toEqual(['better-rewind'])
    expect(seen.commands).toEqual(['/resume S'])
    // 失敗したので発言は入力欄に戻さない
    expect(seen.filled).toEqual([])
    expect(seen.toasts.at(-1)).toBe('The conversation was rewound and reloaded, but part of it failed: Could not restore the file: C:/x/foo.ts (read-only or in use by another app)')
  })

  test('ファイルだけ戻すときは読み直さず、戻した件数を出す', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: { ...REWOUND, mode: 'files', restored: ['C:/x/foo.ts'], removed: ['C:/x/n.md'] } })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(POINTS[1]!) })
    await ui.press({ key: 'mode:files' })
    expect(rewinds(seen)).toEqual([{ uuid: 'u2', label: 'foo を直して', mode: 'files' }])
    expect(seen.commands).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Code restored · 2 files')
  })

  test('AI が応答している間は理由を出して戻さず、応答が終われば戻せる', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: REWOUND })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })

    await $.turn.start({ text: '', turnId: 'T1' })
    await ui.press({ key: pointKey(POINTS[0]!) })
    expect(seen.toasts.at(-1)).toBe('Cannot rewind while the AI is responding. Try again when it finishes')
    expect(await ui.find({ type: 'Text', text: 'Restore the code and/or conversation to the point before…' })).toBeDefined()

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'T1', reason: 'answer' })
    await ui.press({ key: pointKey(POINTS[0]!) })
    // 戻し方の段階で応答が始まっても、実行の前に断る
    await $.turn.start({ text: '', turnId: 'T2' })
    await ui.press({ key: 'mode:conversation' })
    expect(rewinds(seen)).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'Cannot rewind while the AI is responding. Try again when it finishes' })).toBeDefined()
    expect(seen.commands).toEqual([])
  })

  test('記録を切れなかったら理由を出し、読み直さない', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS }, rewind: { error: 'Cannot rewind here: it would leave a tool call without its result' } })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(POINTS[1]!) })
    await ui.press({ key: 'mode:both' })
    const message = 'Rewind failed: Cannot rewind here: it would leave a tool call without its result'
    expect(seen.toasts.at(-1)).toBe(message)
    expect(await ui.find({ type: 'Text', text: message })).toBeDefined()
    expect(seen.closed).toEqual([])
    expect(seen.commands).toEqual([])
  })

  test('会話もファイルも戻せず要約もできない地点 (本文の無いコマンド) は選べない', async ($, on) => {
    const seen = engine(on, { points: { points: [{ ...POINTS[0]!, label: '/model', text: undefined, canCut: false }] } })
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(POINTS[0]!) })
    expect(seen.toasts.at(-1)).toContain('Cannot rewind to this point')
    expect(await ui.find({ type: 'Text', text: 'Restore the code and/or conversation to the point before…' })).toBeDefined()
  })
})

describe('要約', () => {
  // 一覧から地点を選び、要約の段階まで進める
  async function toSummarize($: Engine, point: Point, m: 'mode:summarize' | 'mode:summarize_up_to') {
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(point) })
    await ui.press({ key: m })
    return ui
  }

  test('ここから要約: 指示を書いて Enter でペインを閉じ、/compact を指示つきで動かす。hook は地点より前を残し、地点から後ろだけを core に要約させてつなぐ', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    expect(await ui.find({ type: 'Text', text: 'Summarize from "foo を直して"' })).toBeDefined()
    // 入力欄はラベルの後ろに自分で「: 」を描くので、ラベルには付けない
    expect((await ui.find({ type: 'Input', key: 'summarize:context' }))?.props).toMatchObject({ label: 'Add context (optional)' })
    await ui.input({ key: 'summarize:context', text: ' API の決定を残す ' })

    expect(seen.closed).toEqual(['better-rewind'])
    expect(seen.commands).toEqual(['/compact API の決定を残す'])
    expect(seen.compacts).toEqual([{ instructions: 'API の決定を残す', summarized: ['h2', 'h3', 'h4', 'h5', 'h6', 'h7'] }])
    expect(seen.compacted).toEqual([{ messages: ['h0', 'h1', 'SUMMARY'] }])
    expect(seen.statuses).toEqual(['Summarizing…', undefined])
    expect(seen.toasts.at(-1)).toBe('Summarized from here')
    // ファイルにも記録にも触れない
    expect(rewinds(seen)).toEqual([])
  })

  test('ここまでを要約 (質問の地点・指示なしのボタン): /compact を指示なしで動かし、hook は地点より前だけを要約させて地点から後ろを残す', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    const ui = await toSummarize($, POINTS[2]!, 'mode:summarize_up_to')
    expect(await ui.find({ type: 'Text', text: 'Summarize up to "AskUserQuestion 次は?"' })).toBeDefined()
    await ui.press({ key: 'summarize:now' })
    expect(seen.commands).toEqual(['/compact '])
    expect(seen.compacts).toEqual([{ instructions: undefined, summarized: ['h0', 'h1', 'h2', 'h3', 'h4'] }])
    expect(seen.compacted).toEqual([{ messages: ['SUMMARY', 'h5', 'h6', 'h7'] }])
    expect(seen.toasts.at(-1)).toBe('Summarized up to here')
  })

  test('空白だけの指示は指示なしと同じ', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.input({ key: 'summarize:context', text: '  ' })
    expect(seen.commands).toEqual(['/compact '])
    expect(seen.compacts).toEqual([{ instructions: undefined, summarized: ['h2', 'h3', 'h4', 'h5', 'h6', 'h7'] }])
  })

  test('地点が会話の中に見つからなければ、推測せずに /compact を断り、断った理由を知らせる', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    // 地点の発言がもう要約済みで、会話に残っていない
    seen.transcript = [SUMMARY, ...MESSAGES.slice(5)]
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.press({ key: 'summarize:now' })
    expect(seen.compacted).toEqual([{ skip: expect.stringMatching(/^Could not find this point in the conversation/) }])
    // core には何も届かない (会話全体を要約しない)
    expect(seen.compacts).toEqual([])
    expect(seen.toasts.at(-1)).toMatch(/^Not summarized: Could not find this point in the conversation/)
  })

  test('core の要約が失敗したら、会話全体や要約した部分だけにせず断る', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    seen.coreFails = true
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.press({ key: 'summarize:now' })
    const reason = 'better-rewind could not split the conversation at this point. Nothing was changed'
    expect(seen.compacted).toEqual([{ skip: reason }])
    expect(seen.toasts.at(-1)).toBe(`Not summarized: ${reason}`)
  })

  test('/compact が mod の hook まで届かなければ、要約したとは言わずにそう知らせる', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    seen.transcript = undefined
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.press({ key: 'summarize:now' })
    expect(seen.commands).toEqual(['/compact '])
    expect(seen.toasts.at(-1)).toBe('Could not summarize from this point: /compact did not reach better-rewind (it may have summarized the whole conversation)')
    expect(seen.statuses).toEqual(['Summarizing…', undefined])
  })

  test('/compact そのものが失敗したら理由を出す', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    seen.commandFails = true
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.press({ key: 'summarize:now' })
    // kit では失敗した test の hook が飛ばされ、その下に答えが無いので $.command.run は拒まれる
    expect(seen.toasts.at(-1)).toMatch(/^Could not summarize: /)
    expect(seen.statuses).toEqual(['Summarizing…', undefined])
  })

  test('頼みは最初の 1 回の要約で下ろす: 同じ /compact の中の 2 回目も、後から人が打つ /compact も分けない', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    seen.again = true
    const ui = await toSummarize($, POINTS[1]!, 'mode:summarize')
    await ui.press({ key: 'summarize:now' })
    expect(seen.compacted).toEqual([{ messages: ['h0', 'h1', 'SUMMARY'] }, { messages: ['SUMMARY'] }])
    expect(seen.compacts.at(-1)).toEqual({ instructions: undefined, summarized: handles(MESSAGES) })
    expect(seen.toasts.at(-1)).toBe('Summarized from here')

    seen.again = false
    await $.command.run(run('compact', '残すこと'))
    expect(seen.compacted.at(-1)).toEqual({ messages: ['SUMMARY'] })
    expect(seen.compacts.at(-1)).toEqual({ instructions: '残すこと', summarized: handles(MESSAGES) })
  })

  test('ペインから頼んでいない要約 (/compact・plugin の要約) には手を付けない', async ($, on) => {
    const seen = engine(on, {}, $)
    await $.command.run(run('compact'))
    expect(seen.compacted).toEqual([{ messages: ['SUMMARY'] }])
    const r = await compact($, { trigger: 'plugin', messages: MESSAGES })
    expect(handles(r.messages ?? [])).toEqual(['SUMMARY'])
    expect(seen.compacts).toEqual([
      { instructions: undefined, summarized: handles(MESSAGES) },
      { instructions: undefined, summarized: handles(MESSAGES) },
    ])
  })

  test('戻る: 要約の段階から戻し方の選択へ。AI が応答している間は要約しない', async ($, on) => {
    const seen = engine(on, { points: { points: POINTS } }, $)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    await $.command.run(run('better-rewind'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    await ui.press({ key: pointKey(POINTS[1]!) })
    await ui.press({ key: 'mode:summarize_up_to' })
    await ui.press({ key: 'summarize:back' })
    expect((await ui.find({ key: 'mode:summarize_up_to' }))?.props).toMatchObject({ label: '❯' })

    await ui.press({ key: 'mode:summarize' })
    await $.turn.start({ text: '', turnId: 'T1' })
    await ui.input({ key: 'summarize:context', text: 'x' })
    expect(seen.toasts.at(-1)).toBe('Cannot rewind while the AI is responding. Try again when it finishes')
    expect(seen.compacts).toEqual([])
    expect(seen.closed).toEqual([])
  })
})

describe('要約の位置', () => {
  const prompt = (uuid: string, text: string | undefined): Point => ({ uuid, kind: 'prompt', label: text ?? '/model', text, reply: '', changes: none, canCut: true, restorable: false })
  // 同じ本文の発言「続けて」が 2 回ある一覧
  const LIST = [prompt('p1', '続けて'), prompt('p2', '直して'), prompt('p3', '続けて'), POINTS[2]!]

  test('summarizeRequest: 同じ本文の発言は一覧で後ろにいくつあるかで区別し、質問は tool_use id で探す。本文の無い地点は要約できない', () => {
    expect(summarizeRequest(LIST[0]!, LIST, 'from')).toEqual({ direction: 'from', text: '続けて', fromEnd: 1 })
    expect(summarizeRequest(LIST[2]!, LIST, 'up_to')).toEqual({ direction: 'up_to', text: '続けて', fromEnd: 0 })
    expect(summarizeRequest(POINTS[2]!, LIST, 'from')).toEqual({ direction: 'from', toolUseId: 't2', fromEnd: 0 })
    expect(summarizeRequest(prompt('c1', undefined), LIST, 'from')).toBeUndefined()
    // 一覧に無い地点は数えられない
    expect(summarizeRequest(prompt('px', '続けて'), LIST, 'from')).toBeUndefined()
  })

  test('locatePoint: 同じ本文は後ろから数えて選び (前の方が要約済みで欠けていても合う)、貼り付けの囲みと空白の違いは無視する', () => {
    const messages = [msg('user', '続けて'), msg('assistant', 'a'), msg('user', '続けて'), msg('assistant', 'b'), msg('user', '直して'), msg('user', ' 続け\nて ')]
    expect(locatePoint(messages, { direction: 'from', text: '続けて', fromEnd: 1 })).toEqual({ index: 2 })
    expect(locatePoint(messages, { direction: 'from', text: '続けて', fromEnd: 0 })).toEqual({ index: 5 })
    expect(locatePoint(messages, { direction: 'from', text: '続けて', fromEnd: 3 })).toMatchObject({ skip: expect.any(String) })
    expect(locatePoint([msg('user', '見て <pasted_content id="1">長い本文</pasted_content id="1">')], { direction: 'from', text: '見て\n長い本文', fromEnd: 0 })).toEqual({ index: 0 })
    // ツールの結果のメッセージは人の発言として数えない
    expect(locatePoint([msg('user', '続けて', { toolResults: [{ tool_use_id: 'x', text: '', isError: false }] })], { direction: 'from', text: '続けて', fromEnd: 0 })).toMatchObject({ skip: expect.any(String) })
  })

  test('locatePoint: 同じ本文が無いときだけ、本文で始まるメッセージが 1 つなら使う。2 つ以上なら決めない', () => {
    const r: SummarizeRequest = { direction: 'from', text: '直して', fromEnd: 0 }
    expect(locatePoint([msg('user', 'x'), msg('user', '直して\n<system-reminder>…</system-reminder>')], r)).toEqual({ index: 1 })
    expect(locatePoint([msg('user', '直して A'), msg('user', '直して B')], r)).toMatchObject({ skip: expect.any(String) })
  })

  test('locatePoint: 質問は tool_use id で探し、見つからない・2 つ以上なら決めない', () => {
    const r: SummarizeRequest = { direction: 'from', toolUseId: 't2', fromEnd: 0 }
    expect(locatePoint(MESSAGES, r)).toEqual({ index: 5 })
    expect(locatePoint(MESSAGES.slice(0, 5), r)).toMatchObject({ skip: expect.stringMatching(/^Could not find/) })
    expect(locatePoint([MESSAGES[5]!, MESSAGES[5]!], r)).toMatchObject({ skip: expect.stringMatching(/more than one/) })
  })

  test('splitForSummary: from は地点から後ろ、up_to は地点より前を要約に回し、要約を残す部分とつなぐ。前に何も無ければ up_to は断る', () => {
    const from = splitForSummary(MESSAGES, { direction: 'from', text: 'foo を直して', fromEnd: 0 })
    if ('skip' in from) throw new Error(from.skip)
    expect(handles(from.summarize)).toEqual(['h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
    expect(handles(from.join([SUMMARY]))).toEqual(['h0', 'h1', 'SUMMARY'])
    const upTo = splitForSummary(MESSAGES, { direction: 'up_to', toolUseId: 't2', fromEnd: 0 })
    if ('skip' in upTo) throw new Error(upTo.skip)
    expect(handles(upTo.summarize)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4'])
    expect(handles(upTo.join([SUMMARY]))).toEqual(['SUMMARY', 'h5', 'h6', 'h7'])
    expect(splitForSummary(MESSAGES, { direction: 'up_to', text: '色を聞いて', fromEnd: 0 })).toEqual({ skip: 'There is nothing before this point to summarize' })
  })
})

describe('ファイルの控え', () => {
  test('Edit / Write の直前に中身 (無ければ無かったこと) を tool_use id の名前で控え、他のツールでは控えない', async ($, on) => {
    mock.store(on)
    const writes = new Map<string, string>()
    const nodeCalls: string[][] = []
    let ran = 0
    on('session.id', () => ({ value: 'S' }))
    on('process.run', ($, e) => {
      nodeCalls.push([...e.argv.slice(2)])
      return { value: done(JSON.stringify(e.argv[2] === 'dir' ? { dir: 'C:/rd' } : { toolUseId: 'x' })) }
    })
    // エンジンはパスを OS の書き方に直して渡すので / にそろえて比べる
    on('fs.stat', ($, e) => {
      const p = e.path.replace(/\\/g, '/')
      if (p === 'C:/x/a.ts') return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
      if (p === 'C:/x/big.bin') return { value: { kind: 'file' as const, size: 5 * 1024 * 1024, mtimeMs: 0, isLink: false } }
      throw new Error('ENOENT')
    })
    // テストの $ には stat の ENOENT が届かないので、無いことは exists で答える
    on('fs.exists', () => ({ value: false }))
    on('fs.read', () => ({ value: { base64: 'eA==' } }))
    on('fs.write', ($, e) => {
      writes.set(e.path.replace(/\\/g, '/'), e.text)
      return { value: undefined }
    })
    on('tool.call', () => {
      ran++
      return { deny: 'テストでは実行しない' }
    })

    await $.tool.call({ tool: 'Edit', file_path: 'C:/x/a.ts', old_string: 'x', new_string: 'y' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/x/new.md', content: 'n' })
    await $.tool.call({ tool: 'Bash', command: 'echo hi' })
    await $.tool.call({ tool: 'Write', file_path: 'C:/x/big.bin', content: 'n' })
    expect(ran).toBe(4)

    const metas = [...writes].filter(([p]) => p.endsWith('.json')).map(([p, t]) => ({ p, meta: JSON.parse(t) as { toolUseId: string; tool: string; path: string; existed: boolean; data?: string } }))
    expect(metas.map(m => [m.meta.tool, m.meta.path, m.meta.existed])).toEqual([
      ['Edit', 'C:/x/a.ts', true],
      ['Write', 'C:/x/new.md', false],
    ])
    for (const { p, meta } of metas) expect(p).toBe(`C:/rd/snaps/${snapName(meta.toolUseId)}.json`)
    const edit = metas[0]!.meta
    expect(writes.get(`C:/rd/snaps/${edit.data}`)).toBe('eA==')
    // 4 MiB を超えるファイルは node に写させる。保存先を聞くのはセッションで 1 度だけ
    expect(nodeCalls.filter(a => a[0] === 'dir')).toHaveLength(1)
    const big = nodeCalls.find(a => a[0] === 'snap')
    expect(big?.slice(1, 3)).toEqual(['S', expect.any(String)])
    expect(big?.slice(3, 5)).toEqual(['Write', 'C:/x/big.bin'])
  })

  test('控えに失敗してもツールは止めない', async ($, on) => {
    mock.store(on)
    let ran = 0
    on('session.id', () => ({ value: 'S' }))
    on('process.run', () => ({ value: done(JSON.stringify({ error: 'boom' }), 1) }))
    on('ui.log', () => ({ value: undefined }))
    on('tool.call', () => {
      ran++
      return { deny: 'テストでは実行しない' }
    })
    await $.tool.call({ tool: 'Edit', file_path: 'C:/x/a.ts', old_string: 'x', new_string: 'y' })
    expect(ran).toBe(1)
  })

  test('stat が「無い」以外の理由で失敗したら、「無かった」と控えずにログだけ残す', async ($, on) => {
    mock.store(on)
    const writes: string[] = []
    const logs: string[] = []
    on('session.id', () => ({ value: 'S' }))
    on('process.run', () => ({ value: done(JSON.stringify({ dir: 'C:/rd' })) }))
    on('fs.stat', () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    on('fs.exists', () => ({ value: true }))
    on('fs.write', ($, e) => {
      writes.push(e.path)
      return { value: undefined }
    })
    on('ui.log', ($, e) => {
      logs.push(String(e.text))
      return { value: undefined }
    })
    on('tool.call', () => ({ deny: 'テストでは実行しない' }))
    await $.tool.call({ tool: 'Write', file_path: 'C:/x/locked.md', content: 'n' })
    expect(writes).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('could not back up C:/x/locked.md')
  })
})

describe('巻き戻す前の会話', () => {
  test('/better-rewind branches で枝を一覧し、切った地点より後ろの会話をプレビュー・全文で読める', async ($, on) => {
    engine(on, { branches: { branches: BRANCHES } })
    const { text } = await $.command.run(run('better-rewind', 'branches'))
    expect(text).toStartWith('Opened 1 saved conversation')

    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Saved conversations (read-only)' })).toBeDefined()
    expect((await ui.find({ key: BRANCHES[0]!.id }))?.props).toMatchObject({ label: '❯' })
    expect(await ui.find({ type: 'Text', text: /Code and conversation restored/ })).toBeDefined()
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: clipToRows(BRANCHES[0]!.text, 9, 60) })

    await ui.press({ key: BRANCHES[0]!.id })
    expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: BRANCHES[0]!.text })
    expect(await ui.find({ type: 'Text', text: /Back to list/ })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'Saved conversations (read-only)' })).toBeDefined()
  })

  test('枝が無ければその旨を出す', async ($, on) => {
    engine(on, { branches: { branches: [] } })
    await $.command.run(run('better-rewind', 'branches'))
    const ui = await $.ui.mount({ plugin: 'better-rewind', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'No saved conversations yet' })).toBeDefined()
  })
})

describe('表示の計算', () => {
  test('windowAround はカーソルを中央に置き、端では詰める', () => {
    expect(windowAround(0, 10, 4)).toEqual([0, 4])
    expect(windowAround(5, 10, 4)).toEqual([3, 7])
    expect(windowAround(9, 10, 4)).toEqual([6, 10])
    expect(windowAround(1, 3, 4)).toEqual([0, 3])
  })

  test('clipToRows は全角を 2 幅として行数に収め、溢れたら … で切る', () => {
    expect(clipToRows('あいう\nえお', 2, 6)).toBe('あいう\nえお')
    expect(clipToRows('あいうえお', 1, 6)).toBe('あい…')
    expect(clipToRows('a\nb\nc', 2, 10)).toBe('a\nb…')
  })

  test('changesParts は 0 の増減を出さず、Windows のパスからも名前を取る', () => {
    expect(changesParts({ files: ['C:\\x\\tail.tsx'], added: 212, removed: 0 })).toEqual({ text: 'tail.tsx', added: '+212', removed: '' })
    expect(changesParts({ files: ['/a/b.md', '/a/c.md'], added: 0, removed: 4 })).toEqual({ text: '2 files changed', added: '', removed: '-4' })
    expect(changesParts(none)).toEqual({ text: 'No code changes', added: '', removed: '' })
  })

  test('modeOptions は会話を戻せない・控えが無い地点でその選択肢を出さず、要約は位置を探せる地点だけに出す', () => {
    const keys = (p: Point) => modeOptions(p, POINTS).map(o => o.key)
    expect(keys(POINTS[1]!)).toEqual(['both', 'conversation', 'files', 'summarize', 'summarize_up_to', 'cancel'])
    expect(modeOptions(POINTS[1]!, POINTS).slice(3).map(o => o.label)).toEqual(['Summarize from here', 'Summarize up to here', 'Never mind'])
    // 一覧の先頭は前に要約するものが無い
    expect(keys(POINTS[0]!)).toEqual(['conversation', 'summarize', 'cancel'])
    expect(keys({ ...POINTS[1]!, canCut: false })).toEqual(['files', 'summarize', 'summarize_up_to', 'cancel'])
    expect(keys(POINTS[2]!)).toEqual(['conversation', 'summarize', 'summarize_up_to', 'cancel'])
    // 本文の無い発言 (コマンド・長すぎる発言) は記録の中で探せないので要約を出さない
    expect(keys({ ...POINTS[1]!, text: undefined })).toEqual(['both', 'conversation', 'files', 'cancel'])
    expect(modeOptions({ ...POINTS[2]!, restorable: true }, POINTS)[0]).toEqual({ key: 'both', label: 'Restore code and conversation, then re-answer' })
  })

  test('summarizedMessage は hook が分けた・断った・届かなかったを言い分ける', () => {
    expect(summarizedMessage('from', { kind: 'done' })).toBe('Summarized from here')
    expect(summarizedMessage('up_to', { kind: 'done' })).toBe('Summarized up to here')
    expect(summarizedMessage('from', { kind: 'skip', reason: 'nope' })).toBe('Not summarized: nope')
    expect(summarizedMessage('up_to', null)).toMatch(/^Could not summarize from this point: \/compact did not reach better-rewind/)
  })

  test('doneMessage・branchLines・editedFile', () => {
    expect(doneMessage('both', { restored: ['a'], removed: [] })).toBe('Rewound · 1 file · see the previous conversation with /better-rewind branches')
    expect(branchLines({ ...BRANCHES[0]!, answered: true }).detail).toBe('Answer changed')
    expect(branchLines(BRANCHES[0]!).title).toMatch(/^10\/10 \d\d:03 {2}foo を直して$/)
    expect(editedFile({ tool: 'NotebookEdit', notebook_path: 'C:/n.ipynb' } as { tool: string })).toBe('C:/n.ipynb')
    expect(editedFile({ tool: 'Write', file_path: 'C:/a.md' } as { tool: string })).toBe('C:/a.md')
    expect(editedFile({ tool: 'Read', file_path: 'C:/a.md' } as { tool: string })).toBeUndefined()
    expect(snapName('toolu_01:ab/c')).toBe('toolu_01_ab_c')
    expect(isMissing(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissing(new Error("ENOENT: no such file or directory, stat 'C:/x'"))).toBe(true)
    expect(isMissing(new Error('EACCES: permission denied'))).toBe(false)
  })
})
