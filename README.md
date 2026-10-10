# better-rewind

A Claude Code mod that lets you rewind or summarize from any of your prompts, or from any question Claude asked you with AskUserQuestion.

The built-in `/rewind` goes back to one of your prompts. better-rewind adds a few things to that:

- **Re-answer a question:** go back to just after one of Claude's AskUserQuestion questions and pick a different answer. Claude then carries on from the new answer by itself.
- **Preview the reply:** see the reply that followed each point before you choose it.
- **Keep the old branch:** the conversation you rewound away is saved, and `/better-rewind branches` lets you read it.

It does not replace `/rewind`; it adds its own command, `/better-rewind`.

[日本語の説明は下にあります](#日本語)

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install better-rewind --marketplace hamTotk/better-rewind
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first). The mod is active at once, no restart needed. Node.js must be on your `PATH`.

To remove it: `claude plugin uninstall better-rewind`.

## Use

- `/better-rewind` opens the list of points: each of your prompts, and each AskUserQuestion question (indented under its prompt). Other tool calls are not listed; they show as `▸ Tool` lines in the reply preview.
- `↑` / `↓` select a point, and the reply that followed it is shown below. `Enter` chooses it; `Esc` closes the pane.
- Then pick what to do. The wording and order follow the built-in Rewind:
  - **Restore code and conversation**, **Restore conversation**, **Restore code**: go back to just before the point. A prompt you rewind to is put back in the input field.
  - On a question point, the conversation choices read **…, then re-answer**. You choose an answer for each question (one of the options, or your own), and Claude continues from it.
  - **Summarize from here**: replace the point and everything after it with a summary; earlier messages stay as they are.
  - **Summarize up to here**: replace everything before the point with a summary; the point and what follows stay as they are.
  - **Never mind**.
- Before summarizing you can add context ("what the summary should keep"), or summarize without it.
- `/better-rewind branches` lists the conversations you rewound away, newest first, read-only.
- Nothing is rewound or summarized while Claude is responding; the pane says so.

## How it works

- **Conversation:** the mod cuts the session's transcript (`~/.claude/projects/<project>/<session>.jsonl`) at the point and reloads the same session with `/resume`. No new session is created. The full transcript from before the cut is saved first.
- **Code:** just before each Edit, Write or NotebookEdit, the mod saves the file as it was (or notes that it did not exist). Restoring puts every file changed after the point back to that state, and removes files that were created after it. Changes made through Bash are not tracked, and edits made before the mod was installed cannot be restored.
- **Summary:** the mod runs the built-in `/compact` and splits the conversation at the point, so only one side is summarized. The transcript is not edited directly, and a `/compact` line appears in the conversation.
- **If something fails, nothing changes.** Files are restored first and the transcript last; if a step fails, the restored files are put back and the reason is shown.

Saved data lives in `~/.claude/better-rewind/<session>/` (under `CLAUDE_CONFIG_DIR` if set): `snaps/` holds the file backups, `branches/` the transcripts before each rewind. Nothing is deleted automatically; delete the folder when you no longer need it.

## Notes

- **The mod API is early access.** better-rewind is built on Claude Code's function-hook mods, which may change between releases. Tested on Claude Code 2.1.296.
- **It edits your session transcript.** Rewinding rewrites the transcript file of the current session (a copy of the original is kept in `branches/`).
- Right after a re-answer, Claude Code inserts a short "No response requested." reply before Claude continues. This comes from Claude Code itself.
- For a multi-select question, choose one option or type several separated by commas.
- **Install from a terminal.** The `/plugin install` line works in the terminal.

## Develop

```
node --test tests/transcript.test.mjs
claude plugin test .
claude plugin validate .
claude --plugin-dir .
```

## License

MIT

---

## 日本語

自分の発言と、Claude が AskUserQuestion で聞いてきた質問のどこからでも、会話とコードを戻したり要約したりできる Claude Code の mod です。

組み込みの `/rewind` は自分の発言の地点に戻れます。better-rewind はそれに次のことを足します。

- **質問への回答のやり直し:** Claude が AskUserQuestion で聞いてきた質問の直後に戻り、別の回答を選べます。選ぶと Claude が新しい回答で自動的に続きを始めます。
- **返答のプレビュー:** 地点を選ぶ前に、その地点の後に続いた返答を見られます。
- **戻す前の会話を残す:** 巻き戻して捨てた会話は保存され、`/better-rewind branches` で読めます。

組み込みの `/rewind` は置き換えません。専用のコマンド `/better-rewind` で使います。

### 入れ方

ターミナル版の Claude Code で次の 1 行を打ちます。

```
/plugin install better-rewind --marketplace hamTotk/better-rewind
```

マーケットプレイスを追加するか聞かれたら `y`、続けて入れる範囲を選びます (先頭がユーザー全体)。入れた時点で使えるようになり、再起動は要りません。Node.js が `PATH` にある必要があります。

外すときは `claude plugin uninstall better-rewind` です。

### 使い方

- `/better-rewind` で地点の一覧が開きます。地点は自分の発言と、AskUserQuestion の質問 (発言の下に字下げして表示) です。ほかのツール呼び出しは一覧に出ず、返答のプレビューに `▸ ツール名` の 1 行で出ます。
- ↑ / ↓ で地点を選ぶと、その後に続いた返答が下に出ます。Enter で決定、Esc で閉じます。
- 続けて何をするかを選びます。言葉と並びは組み込みの Rewind に合わせて英語です。
  - **Restore code and conversation** / **Restore conversation** / **Restore code:** 地点の直前に戻します。自分の発言の地点に戻すと、その発言が入力欄に戻ります。
  - 質問の地点では、会話を戻す選択肢が「…, then re-answer」になります。質問ごとに回答 (選択肢か自分で書いた文) を選ぶと、Claude がその回答で続けます。
  - **Summarize from here:** 地点から後ろを要約に置き換えます。地点より前はそのまま残ります。
  - **Summarize up to here:** 地点より前を要約に置き換えます。地点から後ろはそのまま残ります。
  - **Never mind:** やめます。
- 要約の前に、要約で残してほしいことを書き足せます。書かずに要約することもできます。
- `/better-rewind branches` で、巻き戻して捨てた会話を新しい順に読めます (読むだけです)。
- Claude が応答している間は戻さず、要約もしません (画面に理由を出します)。

### 仕組み

- **会話:** セッションの記録ファイル (`~/.claude/projects/<project>/<session>.jsonl`) を地点で切り、同じセッションを `/resume` で読み直します。新しいセッションは増えません。切る前の記録は先に丸ごと保存します。
- **コード:** Edit・Write・NotebookEdit の直前に、対象のファイルの中身 (無ければ「無かった」こと) を控えます。戻すときは、地点より後に変わったファイルを控えの状態に戻し、地点より後に作られたファイルは消します。Bash で変わったファイルと、mod を入れる前の編集は戻せません。
- **要約:** 組み込みの `/compact` を動かし、会話を地点で分けて片側だけを要約させます。記録ファイルは直接書き換えません。会話には `/compact` の行が残ります。
- **失敗したときは何も変えません。** ファイルを先に戻し、記録の書き換えを最後にします。途中で失敗したら、戻したファイルを元に戻してから理由を出します。

保存先は `~/.claude/better-rewind/<session>/` (`CLAUDE_CONFIG_DIR` があればその下) です。`snaps/` にファイルの控え、`branches/` に巻き戻す前の記録が入ります。自動では消さないので、要らなくなったらフォルダごと消してください。

### 注意

- Claude Code の mod の仕組みは先行公開の段階で、更新で動かなくなる可能性があります。確認済みの版は 2.1.296 です。
- 巻き戻すと、今のセッションの記録ファイルを書き換えます (元の記録は `branches/` に残ります)。
- 回答をやり直した直後、Claude が続きを始める前に、Claude Code 本体が "No response requested." という短い返答を 1 つ挟みます。
- 複数選択の質問は、選択肢から 1 つ選ぶか、自分で「,」区切りで書きます。
- 入れる操作はターミナル版でだけできます。
