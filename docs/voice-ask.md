# Voice answers for `ask`

When the agent needs a decision, the `ask` tool opens a dialog. With a live
realtime session (`/live`) or the local speech stack, that dialog can also be
answered aloud: the question is spoken (with its options on the live channel),
the spoken reply is transcribed, and the dialog resolves with the matching
option (or with free text). The visual dialog stays on screen the whole time;
whichever answers first wins.

## What is intercepted

Only `askDialog`. Approvals (`approve`, `confirm`) and plain `select`/`input`
dialogs keep requiring explicit keyboard interaction, so a sensitive action can
never be authorized by voice by accident.

The wrapper lives in `packages/coding-agent/src/voice/registry.ts` and is
installed where the tool UI context is created (`tools/context.ts`). No change
is made to the `ask` tool itself.

## Channels

- **Live** (`voice/live-speech.ts`): the realtime model is the voice. The
  question is appended with `session.context.append` on the `speakable`
  channel, so the model reads it naturally, options included. The answer comes
  from the next final user transcript (`turn.done`), or from the text of the
  delegation the model would otherwise run. While a question is pending, and
  until the user's next turn after it is answered, those delegations are
  swallowed instead of starting a session turn.
- **Local** (`voice/local-speech.ts`): used when no live session is attached
  and both `speech.enabled` and `stt.enabled` are on, on an interactive
  terminal. The `ask` tool already vocalizes the question through the TTS
  worker; this channel captures the reply with the native microphone and the
  local STT worker. Headless RPC/ACP hosts never open a microphone.

With no channel available the decorator is transparent: the dialog behaves
exactly as before.

## Behavior guarantees

- Silence never answers anything: there is no voice timeout and no
  auto-selection. While a voice channel is attached the dialog's `ask.timeout`
  deadline is ignored, so an elapsed timer cannot submit the recommended
  option.
- A spoken answer that matches no option becomes `customInput`, preserving the
  question ids and option labels the dialog declared.
- Multi-select questions accept several options ("um e três", "todos").
- Cancelling the dialog, aborting the turn, or stopping `/live` releases the
  listener and leaves the normal keyboard path in charge.
- A Windows toast (`OMP_VOICE_ASK_NOTIFY=0` disables it) announces the pending
  question when the terminal is minimized.

## Kill switch

`OMP_VOICE_ASK=0` restores the plain keyboard-only dialog without touching any
other setting.
