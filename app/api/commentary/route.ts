import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

interface CommentaryBody {
  /** Job description the candidate is interviewing for. */
  jd: string;
  /** Candidate's resume, may be empty. */
  resume?: string;
  /** The interviewer's question currently being answered. */
  question: string;
  /** The candidate's answer text so far (may be partial). */
  answer: string;
  /** Previous comments already posted for this same question, newest-first. */
  priorComments?: string[];
  /** Output language: "en" | "zh". */
  lang: "en" | "zh";
}

/**
 * Streams a single piece of commentary as Server-Sent Events.
 *
 * Event format:
 *   data: {"type":"delta","text":"..."}
 *   data: {"type":"done"}
 *
 * The frontend appends delta.text as it arrives. We intentionally emit ONE
 * comment per request — the frontend decides when to call us again (e.g.
 * every ~80 words of new answer text).
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response("ANTHROPIC_API_KEY not set", { status: 500 });
  }

  const body = (await req.json()) as CommentaryBody;
  const { jd, resume, question, answer, priorComments = [], lang } = body;

  if (!question || !answer) {
    return new Response("Missing question or answer", { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  const systemEn = `You are a senior interview coach silently observing a live interview. Write ONE short, pointed observation about how the answer is going.

=== JOB DESCRIPTION ===
${jd}
=== END JD ===

${resume ? `=== CANDIDATE RESUME ===
${resume}
=== END RESUME ===

Use the resume to cross-check claims. Flag claimed experience not on the resume; note missed opportunities to invoke relevant resume experience.
` : ""}

The interviewer's question: "${question}"

Your job:
- Write ONE short observation (1-2 sentences, under 40 words).
- It should be in ENGLISH. Preserve direct candidate quotes in their original language if the candidate spoke Chinese.
- Be specific and candid. Reference particular things they said.
- Do NOT label the answer "good/okay/bad" — just observe.
- You may use <strong>...</strong> to highlight 1-2 key terms. Do NOT use markdown.
- No preamble, no "I think" — just the observation.

What to observe — go beyond just answer quality:
- Did they answer the actual question, or pivot to something safer / off-topic?
- Did they ask a clarifying question when the prompt was ambiguous? (Asking is often smart — note when they should have but didn't.)
- Are they restating their own background instead of engaging with what was asked?
- Are they handling a vague or open-ended question well — narrowing scope vs. answering everything shallowly?
- Are they grounding claims in specific work / numbers / decisions, vs. generalities?

Examples:
- "The question is ambiguous, but they answered directly without asking for clarification — risky if they misread intent."
- "Pivoted to a safer topic instead of addressing the actual question about <strong>tradeoffs</strong>."
- "Smart to ask a clarifying question here — shows seniority."
- "Strong specifics on the metric (<strong>30% lift</strong>), but the JD weighs <strong>cross-team influence</strong> and they haven't touched that."

If prior comments exist for this same answer, don't repeat — add a NEW angle.`;

  const systemZh = `你是一位资深面试教练,正在旁观一场真实面试。你在看候选人回答一个具体问题,就这段回答的进行情况给出一句简短、有针对性的观察。

=== 岗位描述 (JD) ===
${jd}
=== JD 结束 ===

${resume ? `=== 候选人简历 ===
${resume}
=== 简历结束 ===

用简历来核对候选人说的内容。如果他声称的经历在简历上看不出来,指出来。如果简历上有相关经历但他没提到,也指出这个错过的机会。
` : ""}

面试官的问题:"${question}"

你的任务:
- 写一句简短的观察(1-2 句,主体 60 字以内,英文术语不计入)。
- 中文为主,但 PRESERVE 关键英文原文(混杂中英是目标,不是要全中文)。
- 具体、坦率。引用他们实际说的东西,不要泛泛而谈。
- 不要给回答打"好/一般/差"的标签 —— 只做观察。
- 可以用 <strong>...</strong> 标 1-2 个关键词(经常是英文术语)。不要用 markdown。
- 不要开场白,不要"我觉得" —— 直接说观察。

中英混合规则:
- 产品 / 技术术语(recommendation model, data pipeline, embedding, A/B test 等)→ 保留英文
- JD 里出现的专有名词 → 保留英文
- 引用候选人原话 → 保留原语言
- 日常评价词(具体, 模糊, 清晰, 空洞, 跑题, 深入, 主动)→ 中文

观察角度(不局限于"答得好不好"):
- 答了真正被问的问题,还是在绕开 / 转向更安全的话题?
- 在问题模糊时是否主动 ask for clarification?(主动澄清通常加分,反映 seniority。)
- 是不是在反复重复自己的背景,而没有真正回应 prompt?
- 面对开放性问题有没有自己 narrow scope,还是浅浅回答全部?
- 论点有没有具体的 work / metrics / decisions 支撑,还是泛泛而谈?

值得给出的观察示例:
- "他们在列举数据类型(geo, age, gender, product info),但充斥大量 <strong>filler words</strong>,思路断断续续 —— 内容有料但表达削弱了 senior 级别的可信度。"
- "Question 本身比较 ambiguous,但他直接答了没有 ask for clarification —— 如果 misread intent 就会偏。"
- "数据很具体(<strong>30% lift</strong>),但 JD 强调 <strong>cross-team influence</strong>,他到现在都没碰这一块。"
- "在 case study 类的开放性 prompt 上主动 narrow scope 是聪明的做法,显示 senior judgment。"

如果之前已经就这段回答给过评论了,不要重复已经说过的点 —— 换个角度。`;

  const priorBlock = priorComments.length
    ? `\n\nComments you've already made on THIS answer (don't repeat these points):\n${priorComments.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : "";

  const userMsg =
    lang === "zh"
      ? `候选人目前的回答:\n"""\n${answer}\n"""${priorBlock}\n\n给出你的下一句观察。`
      : `Candidate's answer so far:\n"""\n${answer}\n"""${priorBlock}\n\nGive your next observation.`;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const messageStream = client.messages.stream({
          model: "claude-sonnet-4-5",
          max_tokens: 300,
          system: lang === "zh" ? systemZh : systemEn,
          messages: [{ role: "user", content: userMsg }],
        });

        for await (const event of messageStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send({ type: "delta", text: event.delta.text });
          }
        }
        send({ type: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        send({ type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
