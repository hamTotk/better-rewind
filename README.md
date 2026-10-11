# better-rewind

A Claude Code mod that lets you rewind or summarize from any of your prompts, any tool call, or any question Claude asked you with AskUserQuestion.

The built-in `/rewind` goes back to one of your prompts. better-rewind adds a few things to that:

- **Rewind to a tool call:** go back to just before any tool call in a reply, not only to your prompts.
- **Re-answer a question:** go back to just after one of Claude's AskUserQuestion questions and pick a different answer. Claude then carries on from the new answer by itself.
- **Preview the reply:** see the reply that followed each point before you choose it.
- **Keep the old branch:** the conversation you rewound away is saved, and `/better-rewind branches` lets you read it.

It replaces the `/rewind` command and adds its own command, `/better-rewind`. Pressing Esc twice still opens the built-in Rewind; see [Open it with a key](#open-it-with-a-key).

[日本語の説明は下にあります](#日本語)

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install better-rewind --marketplace hamTotk/better-rewind
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first). The mod is active at once, no restart needed. Node.js must be on your `PATH`.

To remove it: `claude plugin uninstall better-rewind`.

## Use

- `/rewind` or `/better-rewind` opens the list of points: each of your prompts, each AskUserQuestion question (indented under its prompt), and the other tool calls (indented one step further).
- Tool calls in a row are folded into one line, such as `▸ 3 tool calls`. Press `Enter` on that line to show them, and again to fold them. Each time the list opens, they start folded. (Space cannot do this: the pane does not receive it.)
- When Claude ran several tools at once, only the first is listed: rewinding to the middle of them would leave a call without its result.
- `↑` / `↓` select a point, and the reply that followed it is shown below. `Enter` chooses it; `Esc` closes the pane.
- Then pick what to do. The wording and order follow the built-in Rewind:
  - **Restore code and conversation**, **Restore conversation**, **Restore code**: go back to just before the point. When the conversation is rewound to one of your prompts, that prompt is put back in the input field (**Restore code** alone leaves the conversation and the input field as they are). When it is rewound to a tool call, Claude's reply stops just before that call and you type what comes next.
  - **Restore code** puts back every file that changed after the point, including changes made after later prompts. Before you choose, the pane lists how many files that is and their names, and any file it cannot restore.
  - On a question point, the conversation choices read **…, then re-answer**. You choose an answer for each question (one of the options, or your own), and Claude continues from it.
  - **Summarize from here**: replace the point and everything after it with a summary; earlier messages stay as they are.
  - **Summarize up to here**: replace everything before the point with a summary; the point and what follows stay as they are.
  - **Never mind**.
- Before summarizing you can add context ("what the summary should keep"), or summarize without it.
- `/better-rewind branches` lists the conversations you rewound away, newest first, read-only.
- Nothing is rewound or summarized while Claude is responding; the pane says so.

### Open it with a key

Pressing Esc twice opens the built-in Rewind, and a mod cannot change that: Claude Code opens it without going through any hook. You can give better-rewind a key of its own instead. Add this to `~/.claude/keybindings.json` (create the file if it does not exist; if it does, add the line to its `"Chat"` block):

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "alt+r": "command:better-rewind" } }
  ]
}
```

Claude Code does not use Alt+R for anything else. Your terminal may take some keys before Claude Code sees them; if Alt+R does nothing, pick another free key, such as `ctrl+q` or `ctrl+x ctrl+r`.

You could bind `"escape escape"` instead, but then a single Esc no longer stops Claude while it is responding (Claude Code waits up to 3 seconds for the second Esc and drops the first). Ctrl+C still stops it.

## How it works

- **`/rewind`:** the mod answers the `/rewind` command itself, so the built-in Rewind does not open. If better-rewind cannot open its list, the built-in Rewind opens instead.
- **Conversation:** the mod cuts the session's transcript (`~/.claude/projects/<project>/<session>.jsonl`) at the point and reloads the same session with `/resume`. No new session is created. The full transcript from before the cut is saved first.
- **Code:** just before each Edit, Write or NotebookEdit, the mod saves the file as it was (or notes that it did not exist), then notes whether the call actually ran. Restoring puts every file changed after the point back to that state, and removes files that were created after it. Changes made through Bash are not tracked, and edits made before the mod was installed cannot be restored.
  - A call you declined, or one that failed, is not used: the mod never writes a file through a call that did not run, and it clears the copy it took of that file. If the file changed anyway (the call was stopped after it had already written, or stopped partway), the copy is kept and used like any other edit, so the file is not put back to an in-between version.
  - If a file could not be saved before an edit, you get a notice at that moment, and later that file is listed as not restored instead of being put back to a later, in-between version.
  - Files changed by a rewind are saved the same way, so rewinding again to an earlier point gets the contents that point really had.
  - A file that is now a symbolic link is not written. For a file inside the working folder (the folder the session started in), the folders between the working folder and the file are checked too, and the file is not written if one of them is now a symbolic link or junction. The rewind then stops with the reason and changes nothing. For a file outside the working folder, only the file itself is checked.
- **Summary:** the mod runs the built-in `/compact` and splits the conversation at the point, so only one side is summarized. The transcript is not edited directly, and a `/compact` line appears in the conversation.
- **If something fails, nothing changes.** Files are restored first and the transcript last; if a step fails, the files it touched (including one that failed partway through writing) are put back and the reason is shown. If a file cannot be put back either, the message names it and the folder holding its earlier contents. If Claude adds to the conversation while the rewind runs, the rewind stops and changes nothing, so no new lines are lost.
- If a rewind is stopped before it finishes (it ran longer than 10 minutes, or Claude Code was closed while it ran), you are told right away that it may not have finished. The next time you open `/better-rewind`, a notice says which rewind it was, which files may be affected and where their earlier contents are. That notice appears only once.

Saved data lives in `~/.claude/better-rewind/<session>/` (under `CLAUDE_CONFIG_DIR` if set): `snaps/` holds the file backups, `branches/` what each rewind replaced. Nothing is deleted automatically; delete the folder when you no longer need it.

**Getting back files that Restore code overwrote.** Before a rewind changes any file, it copies the file's current contents to `branches/<time>.files/<n>`. `branches/<time>.json` lists each restored file's `path` and its copy in `backup` (`null` when the file did not exist), so copy that file back over `path`. `<time>` is when you rewound (UTC, for example `2026-10-10T05-03-00-000Z`). `branches/<time>.jsonl` is the whole transcript from before a conversation rewind.

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

自分の発言、ツール呼び出し、Claude が AskUserQuestion で聞いてきた質問のどこからでも、会話とコードを戻したり要約したりできる Claude Code の mod です。

組み込みの `/rewind` は自分の発言の地点に戻れます。better-rewind はそれに次のことを足します。

- **ツール呼び出しへの巻き戻し:** 自分の発言だけでなく、返答の途中のツール呼び出しの直前にも戻れます。
- **質問への回答のやり直し:** Claude が AskUserQuestion で聞いてきた質問の直後に戻り、別の回答を選べます。選ぶと Claude が新しい回答で自動的に続きを始めます。
- **返答のプレビュー:** 地点を選ぶ前に、その地点の後に続いた返答を見られます。
- **戻す前の会話を残す:** 巻き戻して捨てた会話は保存され、`/better-rewind branches` で読めます。

`/rewind` コマンドを置き換え、専用のコマンド `/better-rewind` も足します。Esc を 2 回押したときは組み込みの Rewind が開きます ([キーで開く](#キーで開く) を参照)。

### 入れ方

ターミナル版の Claude Code で次の 1 行を打ちます。

```
/plugin install better-rewind --marketplace hamTotk/better-rewind
```

マーケットプレイスを追加するか聞かれたら `y`、続けて入れる範囲を選びます (先頭がユーザー全体)。入れた時点で使えるようになり、再起動は要りません。Node.js が `PATH` にある必要があります。

外すときは `claude plugin uninstall better-rewind` です。

### 使い方

- `/rewind` か `/better-rewind` で地点の一覧が開きます。地点は自分の発言、AskUserQuestion の質問 (発言の下に字下げして表示)、ほかのツール呼び出し (さらに 1 段字下げして表示) です。
- 続けて並ぶツール呼び出しは `▸ 3 tool calls` のような 1 行に畳まれています。その行で Enter を押すと開き、もう一度押すと畳みます。一覧を開くたびに畳んだ状態から始まります (Space はペインに届かないので使えません)。
- Claude が複数のツールを同時に呼んだときは、最初の 1 つだけが一覧に出ます。途中に戻すと、結果の無い呼び出しが残ってしまうためです。
- ↑ / ↓ で地点を選ぶと、その後に続いた返答が下に出ます。Enter で決定、Esc で閉じます。
- 続けて何をするかを選びます。言葉と並びは組み込みの Rewind に合わせて英語です。
  - **Restore code and conversation** / **Restore conversation** / **Restore code:** 地点の直前に戻します。会話を自分の発言の地点に戻すと、その発言が入力欄に戻ります (**Restore code** だけのときは、会話も入力欄もそのままです)。ツール呼び出しの地点に戻すと、Claude の返答がその呼び出しの直前で止まり、続きは自分で打ちます。
  - **Restore code** は、地点より後に変わったファイルをすべて戻します。後の発言で変わったファイルも含みます。選ぶ前の画面に、戻すファイルの数と名前、戻せないファイルが出ます。
  - 質問の地点では、会話を戻す選択肢が「…, then re-answer」になります。質問ごとに回答 (選択肢か自分で書いた文) を選ぶと、Claude がその回答で続けます。
  - **Summarize from here:** 地点から後ろを要約に置き換えます。地点より前はそのまま残ります。
  - **Summarize up to here:** 地点より前を要約に置き換えます。地点から後ろはそのまま残ります。
  - **Never mind:** やめます。
- 要約の前に、要約で残してほしいことを書き足せます。書かずに要約することもできます。
- `/better-rewind branches` で、巻き戻して捨てた会話を新しい順に読めます (読むだけです)。
- Claude が応答している間は戻さず、要約もしません (画面に理由を出します)。

### キーで開く

Esc を 2 回押すと組み込みの Rewind が開き、これは mod からは変えられません (Claude Code が hook を通さずに開くため)。代わりに、better-rewind を開くキーを割り当てられます。`~/.claude/keybindings.json` に次を書いてください (ファイルが無ければ作り、あればその `"Chat"` の欄に 1 行足します)。

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "alt+r": "command:better-rewind" } }
  ]
}
```

Alt+R は Claude Code のほかの機能では使われていません。端末が先にキーを使うことがあるので、Alt+R で開かなければ `ctrl+q` や `ctrl+x ctrl+r` などほかの空いているキーにしてください。

`"escape escape"` に割り当てることもできますが、そうすると Claude の応答中に Esc を 1 回押しても止まらなくなります (Claude Code が 2 回目の Esc を最大 3 秒待ち、1 回目を捨てるため)。Ctrl+C では止まります。

### 仕組み

- **`/rewind`:** mod が `/rewind` コマンドに自分で答えるので、組み込みの Rewind は開きません。better-rewind が一覧を開けなかったときは、組み込みの Rewind が開きます。
- **会話:** セッションの記録ファイル (`~/.claude/projects/<project>/<session>.jsonl`) を地点で切り、同じセッションを `/resume` で読み直します。新しいセッションは増えません。切る前の記録は先に丸ごと保存します。
- **コード:** Edit・Write・NotebookEdit の直前に、対象のファイルの中身 (無ければ「無かった」こと) を控え、その呼び出しが実際に実行されたかも書き足します。戻すときは、地点より後に変わったファイルを控えの状態に戻し、地点より後に作られたファイルは消します。Bash で変わったファイルと、mod を入れる前の編集は戻せません。
  - 拒否した呼び出しと失敗した呼び出しの控えは使いません。実行されなかった呼び出しを通してファイルを書くことはなく、その控えの中身も消します。ただし、それでもファイルが変わっていたとき (書いた後で止められた、途中で止まった) は控えを残し、ふつうの編集と同じく戻すのに使います。ファイルを途中の版へ戻さないためです。
  - 編集の前にファイルを控えられなかったときは、その場で通知します。後で戻すときも、そのファイルを途中の版へ戻さず「戻せない」と出します。
  - 巻き戻しで変えたファイルも同じように控えます。後でもっと前の地点へ戻すと、その地点の本当の中身になります。
  - 戻す先が今シンボリックリンクになっているファイルは書きません。作業フォルダ (セッションを始めたフォルダ) の中のファイルは、作業フォルダからそのファイルまでの途中のフォルダも確かめ、どれかが今シンボリックリンクかジャンクションなら書きません。そのときは理由を出して止まり、何も変えません。作業フォルダの外のファイルは、そのファイル自体だけを確かめます。
- **要約:** 組み込みの `/compact` を動かし、会話を地点で分けて片側だけを要約させます。記録ファイルは直接書き換えません。会話には `/compact` の行が残ります。
- **失敗したときは何も変えません。** ファイルを先に戻し、記録の書き換えを最後にします。途中で失敗したら、手を付けたファイル (書いている途中で失敗したファイルも) を元に戻してから理由を出します。元に戻せないファイルが残ったときは、そのファイル名と、前の中身を置いたフォルダを出します。巻き戻しの最中に Claude が会話へ書き足したときも、何も変えずに止まります (書き足した行は消えません)。
- 巻き戻しが終わる前に止まったとき (10 分を超えた、動いている間に Claude Code を閉じた) は、その場で「終わっていないかもしれない」と通知します。次に `/better-rewind` を開いたときには、どの巻き戻しだったか、影響を受けたかもしれないファイル、その前の中身の場所を通知します。この通知は 1 度だけです。

保存先は `~/.claude/better-rewind/<session>/` (`CLAUDE_CONFIG_DIR` があればその下) です。`snaps/` にファイルの控え、`branches/` に巻き戻しで置き換えた中身が入ります。自動では消さないので、要らなくなったらフォルダごと消してください。

**Restore code で上書きしたファイルを取り戻すには:** 巻き戻しはファイルを変える前に、今の中身を `branches/<時刻>.files/<番号>` に写します。`branches/<時刻>.json` の `files` に、戻したファイルの `path` と写しの場所 `backup` (ファイルが無かったときは `null`) が並ぶので、その写しを `path` へコピーし直してください。`<時刻>` は巻き戻した時刻 (UTC。例: `2026-10-10T05-03-00-000Z`) です。会話を戻したときは、切る前の記録全体が `branches/<時刻>.jsonl` に入ります。

### 注意

- Claude Code の mod の仕組みは先行公開の段階で、更新で動かなくなる可能性があります。確認済みの版は 2.1.296 です。
- 巻き戻すと、今のセッションの記録ファイルを書き換えます (元の記録は `branches/` に残ります)。
- 回答をやり直した直後、Claude が続きを始める前に、Claude Code 本体が "No response requested." という短い返答を 1 つ挟みます。
- 複数選択の質問は、選択肢から 1 つ選ぶか、自分で「,」区切りで書きます。
- 入れる操作はターミナル版でだけできます。
