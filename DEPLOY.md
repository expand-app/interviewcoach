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
# Open .env.local in any text editor and paste your Anthropic API key
# Get one at https://console.anthropic.com/

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
   - `ANTHROPIC_API_KEY` = `sk-ant-...` (your real key)
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
- `ANTHROPIC_API_KEY` isn't set — check your `.env.local`
- You're on a non-HTTPS URL and the browser is blocking microphone access

### AI commentary appears then disappears
That's the streaming — text appears token-by-token as Claude generates it. It shouldn't disappear. If it does, something's wrong with SSE — open DevTools Network tab and check the `/api/commentary` request.

### Web Speech API drops words mid-session
Known Chrome limitation — the recognition engine disconnects every ~60 seconds. The code auto-reconnects, but you may lose 1-2 words at the seam. This is why the production plan is to switch to Deepgram.

### I want to upgrade to Deepgram for better quality
Replace `lib/audioSession.ts` with a WebSocket-based Deepgram streaming version. Same callback interface. Add `DEEPGRAM_API_KEY` to your env. Everything else stays the same.

---

## Cost estimate (Anthropic only, Web Speech API is free)

- **Claude Haiku** for question detection: ~$0.001 per utterance × ~50 utterances per interview ≈ **$0.05 per interview**
- **Claude Sonnet** for commentary: ~$0.01 per comment × ~15 comments per interview ≈ **$0.15 per interview**

**Total: ~$0.20 per 30-minute interview.**

If this adds up, you can swap Sonnet → Haiku in `app/api/commentary/route.ts` for 1/10th the cost (lower quality commentary, but often still useful).
