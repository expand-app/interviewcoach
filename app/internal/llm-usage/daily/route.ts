/**
 * GET /internal/llm-usage/daily — internal, read-only LLM token usage.
 *
 * Consumed by LKC's daily「LLM Token 花费日报」hub, which pulls every service's
 * previous-day counts, prices them all with ITS OWN table, and posts one
 * message per vendor to 企业微信. Same URL, same auth header and the same row
 * shape as SSC / Cortex / MailFlow / Probea, so the hub needs one puller
 * rather than one per service.
 *
 * Deliberately NOT under /api: the contract path has no prefix, and the hub
 * builds it as `${base}/internal/llm-usage/daily`.
 *
 * **Raw tokens, never money.** Pricing lives in exactly one place (the hub),
 * so two services cannot drift apart on rates the way they would if each
 * shipped its own number.
 *
 * **Window** — `since`/`until` (ISO-8601, offset required) requests an
 * arbitrary half-open window, which is what lets the hub pull a per-vendor
 * settlement day AND the DeepSeek peak/off-peak sub-intervals it prices
 * separately. `date=YYYY-MM-DD` is the older shorthand for that UTC calendar
 * day. Rows carry real timestamps, so any window is exact — and the response
 * echoes the window actually used, which the hub compares against what it
 * asked for and footnotes on mismatch.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { isDbConfigured, ensureMigrated, query } from "@/lib/db";

const PROJECT = "Puebulo";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `llm_call_usage.feature` (stable key) → the label the digest renders. An
 * unknown key falls through as itself rather than being dropped: a new call
 * site that forgot to register a label should look odd in the digest, not go
 * missing from it.
 */
const FEATURE_LABELS: Record<string, string> = {
  commentary: "实时点评",
  detect_question: "问题识别",
  score_session: "会话打分",
  session_title: "会话标题",
  summarize_context: "上下文摘要",
  summarize_interviewer: "面试官摘要",
  mock_interviewer: "模拟面试官",
  retake_plan: "重做计划",
  expand_suggestions: "建议展开",
  identify_speakers: "说话人识别",
  analyze_session: "会话分析",
  classify_moment: "片段分类",
};

function unauthorized() {
  return Response.json({ detail: "unauthorized" }, { status: 401 });
}

/**
 * Constant-time check of the shared secret against its stored hash.
 *
 * Only the sha256 is stored (#1049): the caller still sends the plaintext, so
 * the wire contract is unchanged, but nothing here can leak a usable
 * credential. `timingSafeEqual` so the check cannot be timed byte by byte, on
 * Buffers of equal length by construction (both are 64-char hex digests), and
 * an unset secret must 401 everyone rather than degrade to open.
 */
function authorized(req: Request): boolean {
  // The default IS the hash, deliberately committed. It is not a credential:
  // what authenticates is its PREIMAGE, and recovering that from a sha256 is
  // computationally out of reach — the plaintext is a 43-byte high-entropy
  // random string, so there is no dictionary/rainbow-table path either. (That
  // premise matters: publish the hash of a human-chosen password and you have
  // handed out an offline cracking target.) The real credential lives in
  // exactly two places: LKC's cluster Secret, and the password manager.
  //
  // This does not contradict "never hardcode a token default" — that rule is
  // about PLAINTEXT, where a committed default is a live credential. A
  // committed hash is useless to whoever reads it, which is the entire point
  // of #1049.
  //
  // The env override stays so a rotation needs no deploy.
  const expected = (
    process.env.INTERNAL_USAGE_TOKEN_SHA256 ??
    "cd481417b3f35d0b4625f0524ebc22e7d49251b4dc9506a11b434e5012d801c9"
  )
    .trim()
    .toLowerCase();
  if (!expected) {
    console.warn("[llm-usage] INTERNAL_USAGE_TOKEN_SHA256 unset — refusing every request");
    return false;
  }
  const token = req.headers.get("x-internal-token") ?? "";
  // An empty token is never a valid credential — rejected before hashing. Not
  // redundant: if sha256("") is ever configured by mistake (a generator command
  // that read an empty line produces exactly that), a request with NO header at
  // all would hash to a matching digest and open this endpoint to everyone. The
  // "unset secret" check above does not catch it, because that value is
  // non-empty and looks perfectly configured.
  if (!token) return false;
  const got = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  // A malformed setting (not a 64-char hex digest) would make the lengths
  // differ, and timingSafeEqual throws on that rather than returning false.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** UTC calendar day → half-open window. */
function windowForUtcDate(day: Date): [Date, Date] {
  const since = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  );
  return [since, new Date(since.getTime() + DAY_MS)];
}

/** The most recent COMPLETE UTC day — never one still in progress. */
function lastDailyWindow(): [Date, Date] {
  return windowForUtcDate(new Date(Date.now() - DAY_MS));
}

/**
 * ISO-8601 → Date, or null. A value without an offset is rejected rather than
 * guessed at: the whole point of these windows is an exact boundary, and
 * assuming a timezone for the caller is how an off-by-8-hours ships.
 */
function parseIso(value: string): Date | null {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Row = {
  feature: string;
  provider: string;
  model: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  call_count: string | number;
};

export async function GET(req: Request) {
  if (!authorized(req)) return unauthorized();

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const untilParam = url.searchParams.get("until");
  const dateParam = url.searchParams.get("date");

  let since: Date;
  let until: Date;
  let windowKind: "custom" | "utc_day";

  if (sinceParam || untilParam) {
    // An explicit window wins over `date` — this is the branch the hub uses
    // for per-vendor settlement days and DeepSeek peak sub-intervals.
    const s = sinceParam ? parseIso(sinceParam) : null;
    const u = untilParam ? parseIso(untilParam) : null;
    if (!s || !u) {
      return Response.json(
        { detail: "since/until must both be ISO-8601 with a UTC offset" },
        { status: 400 },
      );
    }
    if (u.getTime() <= s.getTime()) {
      return Response.json({ detail: "until must be after since" }, { status: 400 });
    }
    [since, until, windowKind] = [s, u, "custom"];
  } else if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return Response.json({ detail: "invalid date, expected YYYY-MM-DD" }, { status: 400 });
    }
    const day = new Date(`${dateParam}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) {
      return Response.json({ detail: "invalid date, expected YYYY-MM-DD" }, { status: 400 });
    }
    [since, until] = windowForUtcDate(day);
    windowKind = "utc_day";
  } else {
    [since, until] = lastDailyWindow();
    windowKind = "utc_day";
  }

  let rows: Row[] = [];
  if (isDbConfigured()) {
    await ensureMigrated();
    // Grouped by feature × provider × model: the hub renders one line per
    // feature, settles per vendor, and needs the model id to pick a rate.
    // Rows that spent nothing carry no signal and only cost the hub bytes.
    const res = await query<Row>(
      `SELECT feature, provider, model,
              SUM(input_tokens)       AS input_tokens,
              SUM(output_tokens)      AS output_tokens,
              SUM(cache_read_tokens)  AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(calls)              AS call_count
         FROM llm_call_usage
        WHERE created_at >= $1 AND created_at < $2
     GROUP BY feature, provider, model
       HAVING SUM(calls) > 0 OR SUM(input_tokens) > 0 OR SUM(output_tokens) > 0`,
      [since.toISOString(), until.toISOString()],
    );
    rows = res.rows;
  }

  return Response.json({
    // `date` is kept for older consumers; the authoritative statement of the
    // window is the since/until echoed below.
    date: since.toISOString().slice(0, 10),
    project: PROJECT,
    window: windowKind,
    since: since.toISOString(),
    until: until.toISOString(),
    rows: rows.map((r) => ({
      feature: FEATURE_LABELS[r.feature] ?? r.feature,
      provider: (r.provider || "").toLowerCase(),
      model: r.model || "",
      // pg returns SUM() as a string (bigint); the hub expects numbers.
      input_tokens: Number(r.input_tokens) || 0,
      output_tokens: Number(r.output_tokens) || 0,
      cache_read_tokens: Number(r.cache_read_tokens) || 0,
      cache_write_tokens: Number(r.cache_write_tokens) || 0,
      call_count: Number(r.call_count) || 0,
    })),
  });
}
