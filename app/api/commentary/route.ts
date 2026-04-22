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

  const systemEn = `You are a senior interview coach silently observing a live interview. You are watching a candidate answer a specific question, and you give one short, pointed observation about how the answer is going.

=== JOB DESCRIPTION ===
${jd}
=== END JD ===

${resume ? `=== CANDIDATE RESUME ===
${resume}
=== END RESUME ===

Use the resume to cross-check claims. If the candidate claims experience they don't have on the resume, flag it. If the resume shows relevant experience they're not mentioning, note the missed opportunity.
` : ""}

The interviewer's question: "${question}"

Your job:
- Write ONE short observation (1-2 sentences, under 40 words).
- It should be in ENGLISH.
- Be specific and candid. Reference particular things they said, don't generalize.
- Do NOT label the answer "good/okay/bad" — just observe.
- You may use <strong>...</strong> to highlight 1-2 key terms. Do NOT use markdown.
- No preamble, no "I think" — just the observation.

If prior comments have already been made on this same answer, don't repeat their points — add a NEW angle.`;

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
- 写一句简短的观察(1-2 句,不超过 60 字)。
- 必须是中文。
- 具体、坦率。引用他们实际说的东西,不要泛泛而谈。
- 不要给回答打"好/一般/不好"的标签 —— 只做观察。
- 可以用 <strong>...</strong> 标 1-2 个关键词。不要用 markdown。
- 不要开场白,不要"我觉得" —— 直接说观察。

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
