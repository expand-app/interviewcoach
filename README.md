# Interview Coach

Real-time AI commentary on interview answers. Listens to your mic, detects
the interviewer's questions, streams per-question commentary from Claude,
and lets you replay the whole session afterwards with timestamped notes.

**Current version uses the browser's built-in Web Speech API for transcription
(free, no extra API key needed). For a production deployment with longer
sessions and better multi-language accuracy, swap `lib/audioSession.ts` for
a Deepgram streaming implementation.**

> 📘 **Setting this up for the first time?** See **[DEPLOY.md](./DEPLOY.md)** for
> step-by-step instructions on running locally, pushing to GitHub, and deploying
> to Vercel.

## Architecture

```
Browser mic
    │
    ├─► MediaRecorder ─────────► Blob (saved for playback)
    │
    └─► Web Speech API ────► transcript stream
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │       Orchestrator           │
                     │                              │
                     │  every final utterance →     │
                     │  POST /api/detect-question   │──► Claude Haiku (is this a Q?)
                     │                              │
                     │  every ~220 chars of answer →│
                     │  POST /api/commentary (SSE)  │──► Claude Sonnet (streamed comment)
                     └─────────────────────────────┘
                                   │
                                   ▼
                            Zustand store
                                   │
                                   ▼
                             React UI
```

## Setup

### 1. Install deps

```bash
npm install
```

### 2. Get an Anthropic API key

https://console.anthropic.com/ → API Keys → Create Key

### 3. Configure env

```bash
cp .env.local.example .env.local
# Edit .env.local and paste your key
```

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000 **in Chrome or Edge** (Safari's Web Speech API
is unreliable). Click **Start**, paste a JD, and start talking. First time,
the browser will ask for microphone permission.

## How it works

### Live session flow

1. **Start** → Shows the JD + Resume modal.
2. **Confirm** → Opens the browser mic, starts Web Speech API + MediaRecorder.
3. **Every finalized transcript utterance** is sent to `/api/detect-question`.
   Claude Haiku decides if it's a new question. If yes → a new Question
   block appears at the top. If no → the utterance is added to the current
   Question's running answer buffer.
4. **Every ~220 chars of new answer text** triggers `/api/commentary`. This
   streams a one-sentence observation back via SSE; the frontend appends
   deltas as they arrive.
5. **Pause** stops the recorder and halts new commentary. Resume picks up
   where you left off.
6. **End & Save** stops everything, turns the recorded audio into an object
   URL, and pushes the session into Past Sessions.

### Past session flow

Click any past session in the sidebar. You get:

- Full Q&A list with timestamps
- Audio player with **question markers** on the timeline (blue tick marks)
- Clicking a timestamp or marker jumps the audio there
- The currently-playing Q&A is highlighted

### Data persistence

**None.** Sessions live in Zustand + memory only. Refresh the page and it's
gone. This was a deliberate choice to ship faster — add IndexedDB or a
backend DB later.

## Tunables

In `lib/orchestrator.ts`:

- `COMMENT_TRIGGER_CHARS` (default 220) — how much new answer text
  triggers a comment. Lower = more frequent, chattier.
- `COMMENT_MIN_GAP_MS` (default 8000) — minimum time between comments on
  the same question, to prevent over-commenting during a long answer.

## Known limitations (Web Speech API mode)

- **Chrome / Edge only.** Safari's implementation is too flaky to use.
- **Engine disconnects every ~60s.** The code auto-reconnects, but you may
  lose 1-2 words at the seam.
- **Chinese accuracy is mediocre** — especially with accent or background
  noise. If you want reliable Chinese, upgrade to Deepgram.
- **No word-level timestamps** — question markers on the playback timeline
  are based on when our app received the final utterance, not the true
  in-audio time. Usually within ~1s but drifts over long sessions.

## Upgrading to Deepgram later

Replace `lib/audioSession.ts` with a streaming version (it needs to:
open a `wss://api.deepgram.com/v1/listen` socket, pipe `MediaRecorder`
chunks into it, and call the same four callbacks). Add a
`/api/deepgram-token` route that mints short-lived project keys so the
browser never sees your main Deepgram key. Everything else stays the same.
