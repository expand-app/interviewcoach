import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
// Generous server-side timeout. Opus 4.7 on a 45-minute recording can
// take 3-5 minutes. 600s gives comfortable headroom before Next.js /
// serverless platforms would kill the function.
export const maxDuration = 600;

interface ExtractBody {
  jd: string;
  resume?: string;
  lang: "en" | "zh";
  /** Full transcript with roles + timestamps. */
  utterances: Array<{
    role: "interviewer" | "candidate" | "unknown";
    text: string;
    start: number;
    end: number;
  }>;
  /** Questions already extracted in the previous round. Commentary
   *  is anchored to these by `questionId`. */
  questions: Array<{
    id: string;
    text: string;
    parentId?: string;
    askedAtSec: number;
  }>;
}

/**
 * Round 3 of the upload-mode analysis pipeline. Given the full
 * transcript and the questions extracted in round 2, produce Live
 * Commentary entries anchored to specific moments of the recording.
 *
 * Each commentary is a 3–4 sentence observation (~70 words max /
 * ~150 Chinese chars max) tied to a moment DURING the candidate's
 * answer to a specific question. The upper bound is hard — the UI
 * pane is fixed-height and any overflow is clipped. The UI displays
 * these as playback reaches each `atSec`.
 *
 * Tone matches the live-session commentary: calibrated, not harsh,
 * mix of positive / neutral / critical, reads the room (interviewer
 * reactions), bilingual Chinese+English when lang = "zh".
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ExtractBody;
  const { jd, resume, lang, utterances, questions } = body;
  if (!utterances || utterances.length === 0) {
    return NextResponse.json({ error: "No utterances" }, { status: 400 });
  }

  const fmtTime = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };
  const transcript = utterances
    .map((u, i) => {
      const role =
        u.role === "interviewer" ? "I" : u.role === "candidate" ? "C" : "?";
      return `[${i}|${fmtTime(u.start)}|${role}] ${u.text}`;
    })
    .join("\n");

  const questionBlock = questions.length
    ? questions
        .map(
          (q) =>
            `- ${q.id} [${fmtTime(q.askedAtSec)}]${q.parentId ? ` (probe of ${q.parentId})` : ""}: ${q.text}`
        )
        .join("\n")
    : "(no questions — entire recording is off-topic or chitchat)";

  const langClauseZh = `中文为主 + 英文关键词,和 Live Commentary 一致的 bilingual 风格:
- 产品 / 技术术语(recommendation model, feature store, A/B test, tradeoff 等)→ 保留英文
- JD / 简历里的专有名词 → 保留原文
- 引用候选人原话 → 保留原语言
- 日常评价词(具体, 模糊, 清晰, 空洞, 跑题, 深入, 主动)→ 中文
- 每条评论 3-4 句(严格上限:主体 150 字以内,英文术语不计入)。这段要放进一个固定大小的展示框,超出会被裁掉,宁可短不能超。用这个空间真正展开:指出哪个瞬间、问题/亮点是什么、下一步该看什么或候选人可以怎么改。不要硬凑字数;只有一句 sharp 的就停。
不要输出纯英文,不要输出纯中文 —— 保持 mix。`;

  const langClauseEn = `All commentary text in English. Each comment 3–4 sentences (strict upper bound: ~70 words / ~450 characters). Must fit in a FIXED display pane — anything longer will be clipped. Use the space to develop a point — name the moment, name the gap or strength, say what to do or watch for next. Don't pad; a single sharp sentence is fine when that's all there is.`;

  const system = `You are a senior interview coach producing Live Commentary for a recorded interview. Given the full transcript and the list of questions (already extracted and labelled), you output a set of short observations anchored to specific moments of the recording.

== TRANSCRIPT FORMAT ==
Each line:  [index|mm:ss|I|C|?] text
where I = interviewer, C = candidate, ? = unknown speaker.

== OUTPUT (strict JSON, no prose wrapper) ==
{
  "commentary": [
    {"id": "c1", "questionId": "q1", "atSec": 145, "text": "…short observation…"}
  ]
}

== PRODUCING COMMENTARY — DENSE, EDUCATIONAL, ONGOING ==

Commentary is the user's primary learning surface. The user is watching a recorded interview and wants to learn, not just get a verdict. That means commentary should be:
- **DENSE BY FILLING GAPS, NOT BY SPLITTING**: aim for one entry every 30–45 seconds during substantive dialogue. If one moment warrants ONE focused observation, write ONE — don't artificially split it into two shallow halves just to hit a count. When there's a long stretch with nothing observation-worthy (e.g. 60+ seconds of candidate still working through the same point), FILL IT with domain knowledge, a relevant framework, interview-skills tip, or "here's what a stronger candidate would do next" — not with a repeated version of the previous observation.
- **EDUCATIONAL**: each comment should teach something. Not just "good" / "missed" — explain WHY it matters, WHAT the interviewer is looking for, WHAT a stronger candidate would do.
- **LENGTH MATTERS**: each observation should have enough substance to read in 8–15 seconds. Two-clause one-liners ("Good specificity.") are too short to justify the screen time — combine them with a second angle or expand the reasoning. Floor each entry at ~50 characters of actual substance (English terms don't count toward the floor but also don't satisfy it).
- **VARIED IN TYPE**: cycle through the categories below rather than hammering on answer quality alone.

Commentary categories (use ALL of these across the session — don't pick just one):

1. **Question decoder** — commentary anchored NEAR when the interviewer is asking the question. Explain what the question is really testing.
   *Example*: "面试官问 'walk me through a hard engineering decision' —— 这是在测 <strong>tradeoff reasoning</strong> 和 decision framing,他会 probe 你 why 不 pick the other option。候选人要准备好把 alternatives 主动拿出来讲。"

2. **Knowledge drop** — teach a concept or framework the candidate should know for this type of question.
   *Example*: "这里的 case 属于 <strong>recsys cold-start</strong> 典型题。标准 frame 是:数据策略 → 模型选型 → evaluation 设计 → ramp-up plan。候选人现在跳过了第一步直接讲模型,面试官通常会 push 回来。"

3. **Mistake call-out + fix** — what the candidate did wrong and what the stronger answer would have been. Concrete, not abstract.
   *Example*: "他刚才说 'we used ML' —— 信息量为零。更强的讲法是 'we used a <strong>gradient boosted ranker</strong> with ~40 hand-engineered features, trained on 90 days of click data',这样面试官才能 probe 下去。"

4. **Positive call-out** — when something lands, name what made it land.
   *Example*: "这个 'let me clarify before I answer' 是 senior signal —— 不是 'what do you mean',而是直接 narrow 到 tradeoff 轴,面试官会记下来。"

5. **Meta-reading** — what the interviewer's behavior tells you about their priorities.
   *Example*: "面试官到现在 probe 了三次关于 <strong>cross-team influence</strong>,一次都没碰技术细节 —— 说明这个岗位真实 bar 是协作能力,候选人后面答题要把这个当 anchor。"

6. **Forward-looking prep** — tell the candidate what to watch for NEXT based on what just happened.
   *Example*: "前面答 CCAR 提了一嘴但没展开 —— 面试官大概率会回来深挖。候选人可以提前准备 regulatory timeline 和 stress test 的具体 metric。"

Coverage rules:
- Every Lead Question gets 2–5 commentary entries (not 1, not 7). Split across the categories above.
- Probe Questions can add 1–2 more if the probe meaningfully changes what's worth saying.
- During substantive interviewer speech (asking a case, giving feedback, describing something), add a "question decoder" or "meta-reading" commentary.
- **Fill long dialogue gaps with fresh content, not repeats**: if there's a 60+ second stretch of dialogue with no commentary, drop a knowledge nugget (category 2) or a forward-looking tip (category 6) tied to what's happening there. Do NOT split an existing entry.
- Keep MINIMUM 15 seconds between consecutive commentary entries' atSec values. If two angles land close in time, prefer to COMBINE them into one longer entry (separated by "—" or "·") rather than firing two short entries back-to-back — the user needs reading time.
- ONLY skip a Lead Question entirely when the candidate's answer was genuinely trivial (one word, "I don't know" with no elaboration, audio breakdown). In practice rare.

Tone:
- Light, conversational, calibrated — a coach sitting next to the candidate, not a panelist writing a debrief. NOT a roast.
- Mix positive / neutral / critical across the session. Real interviews have strengths too — surface them.
- When the answer is thin, still say it, but don't dress it up into a bigger problem than it is.
- Pronouns: "he" or "she" (pick one and stick with it — default "he" if unknown). Never singular "they" for the candidate.

What to observe:
- Did he answer what was asked, or pivot / dodge / restate background?
- Specific work, numbers, decisions vs. generalities?
- Tradeoffs, scope narrowing, clarifying questions when the prompt was ambiguous?
- Role fit — did he hit the signals the JD calls out?
- Delivery: structure, pacing, filler, presence of mind.

Resume cross-check (when a resume is provided):
- Flag claims that don't match or aren't supported by the resume (e.g. "we shipped this in 6 months" but the role only spans 3 months).
- Call out MISSED opportunities to invoke relevant resume experience — a named past project, a metric, a team he led — that would have made the current answer much stronger.
- Do NOT fabricate mismatches or resume details that aren't there. If the resume is empty or unrelated, skip this axis.

READ THE ROOM. The interviewer's reactions in the transcript are strong signals:
- Laughs, "that's great", warm banter, quick engaged follow-ups → the answer landed. Credit for presence of mind / a good joke / a confident "I don't know, but here's how I'd find out" even when technical content is thin.
- Flat "hmm" / "okay…" / silence / immediate rephrasing / shift to a simpler question → the answer did NOT land. Call it out and note whether he noticed + recovered.

DON'T TAKE WORDS AT FACE VALUE. Interviewers are trained to be courteous. Polite verbal feedback often masks a non-landing answer:
- "Interesting." / "Good point." / "Right." followed immediately by a topic pivot, a simpler question, or a long pause → politeness, NOT enthusiasm. Treat as non-landing.
- Warm words PLUS deeper follow-ups that build on the answer → real engagement.
- Perfunctory "yeah, makes sense" that closes the thread without probing → checkbox courtesy.
- Polite chuckle + immediate re-rail → the joke didn't land.
- Laughter / affirmation that BUILDS on what the candidate said ("hah, yeah, I've seen that too") → genuine rapport.
When words and behavior conflict, trust the behavior.

May use <strong>…</strong> to highlight 1–2 key terms. No markdown. No preamble.

== EXAMPLES — mix of positive / neutral / critical ==

Positive:
- "Nice anchoring — named the metric (<strong>14% lift</strong>) and tied it to the model change rather than the launch. That's the specificity the JD rewards."
- "Clarifying question was well-scoped — didn't ask 'what do you mean', narrowed right to the tradeoff axis. Good signal."
- "Turned 'I don't know' into 'here's how I'd find out' — the interviewer warmed up. Presence of mind worked here."
- "Structure is clean: problem → options → pick → why. This is the shape interviewers want."

Neutral / light:
- "Starting broad, which is fine for a case prompt — watching to see if he narrows before getting lost in the space."
- "Building toward the tradeoff; a number on the impact would tighten it."

Critical (calibrated, not harsh):
- "The question was ambiguous and he answered directly without clarifying — may misread intent; worth flagging if the interviewer re-asks."
- "Pivoted to a safer topic rather than the actual question about <strong>tradeoffs</strong> — a short 'let me come back to that' would have helped."
- "Strong on the metric, but the JD weighs <strong>cross-team influence</strong> and he hasn't touched that thread yet."
- "Interviewer's flat 'okay…' plus re-ask suggests the answer didn't quite land. Hasn't clocked the cue yet."

With resume cross-check:
- "He's describing a 'recent' ML platform rebuild but the resume only shows 4 months in that role — panel may probe the actual scope."
- "Missed a chance to invoke his <strong>ranking work at Shopify</strong> from the resume — would have made the recsys framing much tighter."

Timing anchor:
- \`atSec\` should be the timestamp of the moment you're observing, PLUS a tiny forward offset (2–5s) so the model isn't commenting in lockstep with the utterance itself. The UI adds its own display lag on top, so you don't need a large cushion here. Cap atSec at the end of the recording.

== OUTPUT LANGUAGE ==
${lang === "zh" ? langClauseZh : langClauseEn}

Return JSON only.`;

  const resumeBlock = resume
    ? `\n=== CANDIDATE RESUME ===\n${resume}\n=== END RESUME ===\n`
    : "";

  const user = `=== JOB DESCRIPTION ===
${jd}
=== END JD ===
${resumeBlock}
=== QUESTIONS ALREADY EXTRACTED ===
${questionBlock}
=== END QUESTIONS ===

=== TRANSCRIPT ===
${transcript}
=== END TRANSCRIPT ===

Produce commentary. JSON only.`;

  try {
    // Opus 4.7 — stronger observational writing and better at
    // distinguishing landed-vs-polite interviewer reactions, picking
    // the right moment to anchor a comment. Budget: ~200 tokens per
    // commentary × up to 3 per question × ~10-20 questions = ~12k
    // tokens, set above that so Opus isn't truncated mid-JSON.
    const client = getAnthropicClient();
    const t0 = Date.now();
    console.log(
      `[extract-commentary] calling Opus · questions=${questions.length} utterances=${utterances.length}`
    );
    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 12000,
      system,
      messages: [{ role: "user", content: user }],
    });
    console.log(
      `[extract-commentary] Opus returned in ${Date.now() - t0}ms · output_tokens=${resp.usage?.output_tokens ?? "?"} stop_reason=${resp.stop_reason ?? "?"}`
    );

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      commentary?: Array<{
        id?: string;
        questionId?: string;
        atSec?: number;
        text?: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }

    // Validate: a commentary entry needs a questionId that matches one
    // of the input questions, a positive atSec, and non-empty text.
    // Invalid entries are dropped rather than patched.
    const validIds = new Set(questions.map((q) => q.id));
    const rawCount = (parsed.commentary || []).length;
    const droppedReasons: string[] = [];
    const commentary = (parsed.commentary || [])
      .filter((c) => {
        if (typeof c.id !== "string") {
          droppedReasons.push("no id");
          return false;
        }
        if (typeof c.questionId !== "string") {
          droppedReasons.push(`${c.id}: no questionId`);
          return false;
        }
        if (!validIds.has(c.questionId)) {
          droppedReasons.push(
            `${c.id}: questionId=${c.questionId} not in ${[...validIds].join(",")}`
          );
          return false;
        }
        if (typeof c.atSec !== "number" || !isFinite(c.atSec)) {
          droppedReasons.push(`${c.id}: invalid atSec`);
          return false;
        }
        if (typeof c.text !== "string" || c.text.trim().length === 0) {
          droppedReasons.push(`${c.id}: empty text`);
          return false;
        }
        return true;
      })
      .map((c) => ({
        id: c.id as string,
        questionId: c.questionId as string,
        atSec: Math.max(0, c.atSec as number),
        text: (c.text as string).trim(),
      }))
      .sort((a, b) => a.atSec - b.atSec);

    // Post-process so commentary reads comfortably:
    //
    //   1. MERGE close + short entries. If two consecutive entries are
    //      within 20s AND both are short enough to combine without
    //      blowing the length budget, fuse them into a single entry.
    //      Two 40-char comments displayed for 2s each is worse than one
    //      90-char comment displayed for 20s.
    //
    //   2. ENFORCE a 15s minimum gap between whatever's left. If the
    //      model clustered two comments too tightly AND they weren't
    //      mergeable, push the later one forward so the first has time
    //      to be read.
    //
    // Order matters: merge first (shortens the list), then space.
    const MERGE_WINDOW_SEC = 20;
    const SHORT_TEXT_CHARS = 90;
    const MAX_MERGED_CHARS = 200;
    const MIN_GAP_SEC = 15;

    const merged: typeof commentary = [];
    for (const entry of commentary) {
      const prev = merged[merged.length - 1];
      const gap = prev ? entry.atSec - prev.atSec : Infinity;
      const bothShort =
        prev &&
        prev.text.length <= SHORT_TEXT_CHARS &&
        entry.text.length <= SHORT_TEXT_CHARS;
      const combinedFits =
        prev && prev.text.length + entry.text.length + 3 <= MAX_MERGED_CHARS;
      const sameQuestion = prev && prev.questionId === entry.questionId;
      if (
        prev &&
        gap < MERGE_WINDOW_SEC &&
        bothShort &&
        combinedFits &&
        sameQuestion
      ) {
        // Join with a bullet separator so the two observations stay
        // visually distinct inside the same card.
        merged[merged.length - 1] = {
          ...prev,
          text: `${prev.text} · ${entry.text}`,
        };
      } else {
        merged.push(entry);
      }
    }

    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1];
      const cur = merged[i];
      if (cur.atSec - prev.atSec < MIN_GAP_SEC) {
        merged[i] = { ...cur, atSec: prev.atSec + MIN_GAP_SEC };
      }
    }

    // Replace the original array with the post-processed version.
    commentary.length = 0;
    commentary.push(...merged);

    // Diagnostics: count of raw model output, count after validation,
    // and reasons any entries were dropped. Helps diagnose "commentary
    // didn't show up" reports.
    console.log(
      `[extract-commentary] raw=${rawCount} valid=${commentary.length} dropped=${
        droppedReasons.length
      }${droppedReasons.length ? " · reasons: " + droppedReasons.slice(0, 5).join(" | ") : ""}`
    );
    // If the raw count was ALSO zero, the model itself produced nothing —
    // log the head of its response so we can see what shape it came back
    // in (empty array? prose refusal? wrong key name?).
    if (rawCount === 0) {
      console.log(
        `[extract-commentary] raw model output head (500 chars): ${text.slice(0, 500)}`
      );
    }

    return NextResponse.json({ commentary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
