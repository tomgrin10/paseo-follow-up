# PR 3 shape brief: repairs are Tasks (Q49)

**North star (Tom):** "I just want this feature to be more seamless, and easy to use, and integrated." Fewer concepts,
no new screens or vocabulary (tasks are tasks; auto-send is how a task reaches the agent). The normal case takes zero
clicks. Send now, Auto per task and Preview are quiet secondary controls, never prompts. Every line tells the truth in plain words.
Reuse existing rows, chips and the #129 task-agent links. Cut anything that doesn't earn its place.

1. **Job.** The developer glances at a workspace's Tasks to see what's left and who has it. Operate mode. Success:
   they never wonder what "4 repairs queued" means, and the only time they act on auto-send is the capped case.
2. **Direction.** Inside the existing Paseo-native world (DESIGN.md), with no new tokens. Repairs become rows in the
   Tasks card (existing TaskRow: glyph, title, meta line, chevron), with the PR as the existing tinted chip in its
   state colour (red = agent must fix, amber = review, muted = restack). One quiet strip at the top of Tasks, "Next
   message to Main agent · N tasks · <reason/time>", with Preview and Send now as quiet buttons. It shows only while
   something is queued.
3. **States, one per row, plain words:** Queued · sends at 14:32 / sends after the agent's current turn / waits for
   a clean read of #144 (the same reason as sendDecision). Sent 14:32 · waiting for Main agent · Open agent (the
   #129 link). Needs you · sent twice, no change on GitHub (amber; Retry lives in Needs you only). Done · resolved on
   GitHub / Main agent finished it (in the existing "N done" fold).
4. **Cut, and why.**
   - The panel's Agent card: the rows and the header live line now say the same thing.
   - The word "repairs" in the UI.
   - Send now while the agent is mid-turn: the server refuses it (Invariant 8). The strip names the wait instead.
   - When the send waits on the developer (Auto off, an idle agent Follow-up won't wake), Send lives in Needs you
     only, and the strip drops its button ("say it once").
5. **Per-task Auto.** A switch in the existing Task sheet ("Auto-send · Off: it stays here for you"). It is off for
   none by default. The sheet also shows the next message's exact text.
6. **Responsive.** At 390px the strip wraps: the text on its own line, the buttons under it at 44px. There's no
   horizontal scroll. Desktop rows stay 44px.
7. **Out of scope** (PR 4): Home's Sending group and the machine-wide hold line.

## Data model note

A repair task is a `tasksFor()` item (kind conflict/review/checks/restack, key `<kind>:<pr>`, the PR as target, and a
fingerprint of the condition). Nothing new is stored per repair: the Tasks list derives each repair row from the
current `tasksFor()` repairs plus the batches that carried that key and fingerprint. In the pending batch it's
Queued (reason and time from `sendDecision`). In a sending or sent batch it's Sent. If `cappedTasks` says so it's
Needs you. A key and fingerprint that went out in a settled batch and is gone from `tasksFor()` is Done, worded from
how that batch settled.

The batch stays as the internal delivery record: one message, its messageId, its acknowledgment. It never shows as a
concept. The cap moves from the batch to the task. A turn that ends without an acknowledgment always settles its
batch as completed + unacknowledged, so it never blocks and the queue keeps moving. `reconcile` keeps capped tasks
out of the next message, and each capped task is its own Needs-you row. Retry on that row stores
`w.repairRetries["<key>:<fingerprint>"] = sends so far`, which re-arms that one condition for two more sends, and the
`retry_batch` tool gains a `task` form for agent parity. Auto per task is `w.manualRepairs: string[]` of task keys
(by key, so a new push keeps the choice); `reconcile` leaves those out of messages. Preview is a read-only
`follow.preview` RPC that returns `batchPrompt()` for the pending batch (read, PARITY-exempt: agents already get the
same text in the message itself). Send now reuses `follow.send` (a manual send already skips the settle).

## Revision 1 (orchestrator review)

- **Say it once.** The strip carries when and why. Rows in the pending message say only "Queued" (sent ones only
  "Sent"); a row adds words only when it differs from the strip (Manual, Auto off, Needs you). The header live line
  says who and what ("Billing fix is idle · 4 tasks queued"), never the time. The strip is always the first row of Tasks.
- **Why not now.** Each wait has a reason clause from `sendDecision`: "waits a minute so new changes join the same
  message", "sends when its current turn ends, so it isn't interrupted", "waits until GitHub answers for #144 (rate
  limited), so the message isn't based on stale PRs". Send now stays beside it wherever the server would accept it.
- **Glyphs.** The leading column is status only: dashed ring = queued (every kind), spinner = sent and the agent is
  working, ! = needs you, check = done. The kind colour stays on the PR chip.
- The strip and the sheet use the agent's real title. Preview and Send now are bordered buttons at every size.
- The sheet shows the exact message text with no batch id line, and highlights this task's line.

**a. One rule for every task in a message.** Auto tasks (obligations with Auto and a due trigger) ride the same message
and get the same Queued / Sent / Needs you / Done states and the same per-task cap (key `obligation:<id>`, fingerprint
from its revision). The Done check is not a task: it never auto-sends and stays the "Ready to finish" ask in Needs you,
unchanged.
**b. Resolved before it was ever sent: it vanishes.** It was never the agent's work, and keeping it would flood Done
with the flapping churn PR 1 measured (4,387 never-sent cancellations). Done only means a task that went out.
**c. Parity.** `set_auto_send` gains an optional `task` (a task key): the same per-task switch, planned with confirm,
recorded as `agent:<id>`. `workspace_status` gains `nextMessage { to, tasks, text, reason, eta }`, the exact pending
text, so there's no exemption for Preview. Send now is `send_repairs` (renamed in the description only to "send the
next message"); per-task Retry is `retry_batch` with `task`.
**d. What the Agent card shows today, and where each item goes:**
- Title ("Main agent is on it" / "Queued for the main agent") → the header live line and the strip's lead.
- Its line ("4 repairs queued · sending in a moment") → the strip's reason clause.
- "Sent N repairs Xm ago. Follow-up waits for the agent to report back." → the strip in Sent state ("Sent to Billing
  fix at 14:32 · 4 tasks · waiting for it to report back").
- The numbered task list → the task rows themselves, plus the exact text in Preview and the sheet.
- The batch's result in amber (a refusal, an unacknowledged turn) → a refusal is the strip's reason; an
  unacknowledged turn is each row's state (Done / Queued again / Needs you).
- Open (the recipient's chat) → Open agent on the strip while sent, and on a capped task's Needs-you row.
