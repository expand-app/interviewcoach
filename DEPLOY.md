# Deploy & Run

You have three options, from easiest to most involved.

---

## Option A — Run locally (for testing on your own machine)

Fastest way to see it working. Takes about 5 minutes.

### Prerequisites
- **Node.js 18.17 or newer.** Check with `node --version`. If you need it, install from https://nodejs.org/.
- **Chrome or Edge browser.** Safari doesn't support the Web Speech API reliably.

### Steps

```bash
# 1. Unzip and cd into the project
unzip interview-coach.zip
cd interview-coach

# 2. Install dependencies (~1-2 minutes)
npm install

# 3. Set up your API key
cp .env.local.example .env.local
# Open .env.local in any text editor and paste your GPT-6 Luna API key
# Get one at https://platform.openai.com/api-keys

# 4. Run the dev server
npm run dev
```

Open **http://localhost:3000** in Chrome or Edge. First time you click **Start**, the browser will ask for microphone permission — allow it.

---

## Option B — Push to GitHub + deploy on Vercel (recommended for testing with others)

This gets you a real URL like `https://interview-coach-yourname.vercel.app` that you can share. Free tier is fine.

### 1. Push the code to GitHub

```bash
# Unzip and cd in
unzip interview-coach.zip
cd interview-coach

# Initialize git
git init
git add .
git commit -m "Initial commit"

# Create a new repo on GitHub (via the web UI or `gh` CLI), then:
git remote add origin https://github.com/YOUR_USERNAME/interview-coach.git
git branch -M main
git push -u origin main
```

**Important:** The `.gitignore` is set up to exclude `.env.local`, so your API key will NOT be committed. Good.

### 2. Deploy on Vercel

1. Go to https://vercel.com/new
2. Click **Import Git Repository** → select your `interview-coach` repo
3. On the configuration screen:
   - Framework Preset: **Next.js** (auto-detected)
   - Root Directory: `./`
   - Build Command: `npm run build` (default)
   - Output Directory: `.next` (default)
4. Click **Environment Variables** and add:
   - `OPENAI_API_KEY` = `sk-...` (your real key)
5. Click **Deploy**

First deploy takes ~2 minutes. After it finishes you get a URL like `https://interview-coach-abc123.vercel.app`.

### 3. Open in Chrome/Edge

Visit the URL. Click **Start**, paste a JD, and go.

**Note about HTTPS and microphones:** Microphones only work over HTTPS or on `localhost`. Vercel gives you HTTPS automatically, so this just works. If you self-host on a plain-HTTP domain, mic access will be blocked by the browser.

---

## Option C — Run on a cloud dev environment

If you're doing this inside a remote dev environment (Codespaces, GitPod, etc.), the flow is the same as Option A, but:

- Your dev environment needs to **forward port 3000** to your local browser (most do this automatically).
- Some environments serve on `0.0.0.0:3000` through an HTTPS proxy — that's fine, microphones will work.
- If the forwarded URL is HTTP (not HTTPS), mic access will be blocked. Use HTTPS.

---

## Troubleshooting

### "Microphone permission denied"
Browser permission got blocked. In Chrome: click the 🔒 icon next to the URL → Site settings → set Microphone to Allow → reload.

### "Your browser doesn't support speech recognition"
You're on Safari or Firefox. Use Chrome or Edge.

### The page loads but nothing happens when I click Start
Open the browser's DevTools console (F12 → Console tab). Look for red errors. Most likely either:
- `OPENAI_API_KEY` isn't set — check your `.env.local`
- You're on a non-HTTPS URL and the browser is blocking microphone access

### AI commentary appears then disappears
That's the streaming — text appears token-by-token as the model generates it. It shouldn't disappear. If it does, something's wrong with SSE — open DevTools Network tab and check the `/api/commentary` request.

### Web Speech API drops words mid-session
Known Chrome limitation — the recognition engine disconnects every ~60 seconds. The code auto-reconnects, but you may lose 1-2 words at the seam. This is why the production plan is to switch to Deepgram.

### I want to upgrade to Deepgram for better quality
Replace `lib/audioSession.ts` with a WebSocket-based Deepgram streaming version. Same callback interface. Add `DEEPGRAM_API_KEY` to your env. Everything else stays the same.

---

## Text-model cost and cache validation

All former DeepSeek text calls now use OpenAI `gpt-6-luna` in Standard mode,
with `reasoning_effort: none`. Speech recognition, TTS and the optional
Realtime voice engine are separate and unchanged.

Published short-context prices (USD / 1M tokens, checked 2026-10-21):

| Input | Cache read | 30-minute cache write | Output |
|---|---|---|---|
| $0.10 | $0.01 | $0.125 | $0.50 |

Cache writes replace ordinary input pricing for those tokens; do not add
both rates. Requests above 272K input tokens have different pricing.
Official pricing: https://developers.openai.com/api/docs/models/gpt-6-luna

`lib/luna-request.ts` uses explicit 30-minute cache breakpoints on leading
instructions/session context only. Changing transcript text is not cached.
Prefixes below 1,024 tokens are ineligible; no padding or cache warmup calls
are sent. Commentary keeps shared rules first, stable JD/resume context
second, and changing question/answer/dialogue last. A first write and later
reads are billed by OpenAI; cache hits and latency are not guaranteed.

The existing `llm_call_usage` table records provider `openai`, actual model,
ordinary input, cache reads, cache writes and output separately. Historical
DeepSeek rows remain intact and the internal daily-report contract is
unchanged. Verify the billing hub has a `gpt-6-luna` pricing rule before
production release. Do not estimate a monthly bill without actual usage.

Validation:

```bash
npm run test:luna          # local mocked transport/accounting checks; no API key
npm run check:types
npm run smoke:luna         # 6 small billable calls, fictional data; local key needed
```

The smoke check exercises the real classification, commentary (SSE) and
question-detection routes without writing to the database. It checks cache
reads on repeated classification/commentary requests even when the current
question changes, and prints only token counts, timings and estimated cost.
A zero cache hit fails validation; investigate routing, prefix stability and
eligibility before release. This is a smoke check, not a full quality eval.

For deployment, configure `OPENAI_API_KEY` in the hosting environment; local
`.env.local` is not deployed. Do not change `NEXT_PUBLIC_RETAKE_ENGINE` just
to enable Luna: it selects the voice engine only. Keep `DEEPGRAM_API_KEY`.
Never commit keys, and never overwrite an existing `.env.local` from the
example file when updating an installation. Switching production requires a
separate release after validation; these edits do not deploy automatically.
