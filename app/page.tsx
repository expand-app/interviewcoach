import Link from "next/link";
import { MarketingHeader } from "@/components/marketing/MarketingHeader";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Marketing landing page at /.
 *
 * Public-facing entry point — the protected coaching app lives at
 * /app under an auth gate. Structure mirrors the marketing-source
 * index.html exactly: hero with H1 + product visual, social proof,
 * 6-feature grid, 3-step "how it works", footer CTA, footer.
 *
 * Server component (no "use client") since the entire page is
 * static content — no state, no event handlers beyond <Link>
 * navigation and anchor-jump scroll which Next handles natively.
 */
export default function MarketingLanding() {
  return (
    <>
      <MarketingHeader />
      <main>
        <Hero />
        <SocialProof />
        <Features />
        <HowItWorks />
        <FooterCta />
      </main>
      <MarketingFooter />
    </>
  );
}

/* ============================================================
   Hero — H1 + sub + CTAs + the coaching-panel product visual.
   The product visual is a static mockup whose three columns map
   directly to the three product highlights: question captured,
   live commentary, instant feedback. Same three are echoed in
   the Features grid below so the marketing narrative reinforces
   them twice (once visually, once in copy).
   ============================================================ */
function Hero() {
  return (
    <section
      className="text-center pt-12 sm:pt-24 pb-8 sm:pb-12 px-4 sm:px-0"
    >
      <div className="container mx-auto px-2 sm:px-6 max-w-[1120px]">
        <h1
          className="mx-auto text-[2rem] sm:text-[clamp(2.5rem,5vw,3.25rem)]"
          style={{ maxWidth: "20ch", marginBottom: "var(--space-4)" }}
        >
          Coach yourself through the interview, and after it.
        </h1>
        <p
          className="mx-auto text-[0.95rem] sm:text-[1.0625rem]"
          style={{
            lineHeight: 1.5,
            color: "var(--color-text-muted)",
            maxWidth: "34rem",
            marginBottom: "var(--space-8)",
          }}
        >
          Puebulo captures the real question being asked, streams private
          coaching while you answer, and scores the session the moment it
          ends — so you walk out knowing exactly what to fix.
        </p>
        <div
          className="flex justify-center flex-wrap gap-2 mb-8 sm:mb-12"
        >
          <Link href="/sign-in" className="btn btn-primary btn-lg">
            Sign in to start
          </Link>
          <Link href="#how" className="btn btn-secondary btn-lg">
            See how it works
          </Link>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

/** The static product mockup card that anchors the hero — three
 *  vertical lanes that map 1:1 to the product's three highlights:
 *  question captured / live commentary / instant feedback. Wrapped
 *  in a fake browser chrome. Pure presentation, no live data hooks.
 *  The semantic-success token in the Instant Feedback verdict chip
 *  is the same value PastView's ScoreCard uses, so this preview
 *  matches the real debrief surface, not a marketing-only mock. */
function HeroVisual() {
  return (
    <div
      className="mx-auto border border-border"
      style={{
        maxWidth: "1040px",
        borderRadius: "var(--radius-xl)",
        background: "var(--color-surface)",
        padding: "var(--space-3)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div
        className="overflow-hidden border border-border"
        style={{
          background: "var(--color-bg)",
          borderRadius: "12px",
        }}
      >
        {/* Fake browser chrome — three traffic-light dots + a URL pill */}
        <div
          className="flex items-center gap-1.5 px-4"
          style={{
            height: "32px",
            background: "var(--color-surface-2)",
            borderBottom: "1px solid var(--color-border)",
          }}
          aria-hidden="true"
        >
          <span className="w-[9px] h-[9px] rounded-full" style={{ background: "var(--color-border-strong)" }} />
          <span className="w-[9px] h-[9px] rounded-full" style={{ background: "var(--color-border-strong)" }} />
          <span className="w-[9px] h-[9px] rounded-full" style={{ background: "var(--color-border-strong)" }} />
          <div
            className="ml-3 px-2.5 py-[3px] rounded-[5px]"
            style={{
              fontSize: "0.6875rem",
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-subtle)",
              background: "var(--color-bg)",
            }}
          >
            app.puebulo.com / live-session
          </div>
        </div>

        {/* Coaching grid. Desktop: three columns separated by 1px
            hairlines so the panels read as one continuous dashboard.
            Mobile (<md / 768px): stacks vertically — three "lanes"
            squeezed side-by-side at phone widths is unreadable, so
            we drop to a single column with horizontal hairlines
            between rows. The grid-cols utility takes precedence over
            the inline style on the relevant breakpoint. */}
        <div
          className="grid grid-cols-1 md:[grid-template-columns:1.1fr_1.4fr_1fr]"
          style={{
            minHeight: "360px",
            gap: "1px",
            background: "var(--color-border)",
          }}
        >
          {/* Column 1: question captured — mirrors highlight #1.
              The interviewer rambles, restates, and asks a clarifier;
              Puebulo distills the actual question. We show the cleaned
              question pill plus a "Filtered from" preview of the raw
              utterance so prospects can see the work the model is
              doing for them. */}
          <div
            className="flex flex-col"
            style={{ background: "var(--color-bg)", padding: "var(--space-6)", gap: "var(--space-3)" }}
          >
            <ColLabel>Question Captured</ColLabel>
            <div
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface)",
                borderLeft: "3px solid var(--color-text)",
                fontSize: "0.8125rem",
                lineHeight: 1.5,
                color: "var(--color-text)",
                fontWeight: 500,
              }}
            >
              &ldquo;Walk me through a time you had to push back on a senior stakeholder.&rdquo;
            </div>
            <div style={{ marginTop: "var(--space-3)" }}>
              <ColLabel>Filtered from</ColLabel>
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                lineHeight: 1.5,
                color: "var(--color-text-subtle)",
                fontStyle: "italic",
                paddingLeft: "var(--space-3)",
                borderLeft: "2px solid var(--color-border)",
              }}
            >
              &ldquo;So, um, yeah — I&apos;d love to hear, you know, maybe a
              story where, like, you had to push back? On someone senior?&rdquo;
            </div>
          </div>

          {/* Column 2: live commentary, with a try-this inline box */}
          <div
            className="flex flex-col"
            style={{ background: "var(--color-surface)", padding: "var(--space-6)", gap: "var(--space-3)" }}
          >
            <ColLabel>Live Commentary</ColLabel>
            <div
              className="flex-1"
              style={{
                fontSize: "0.75rem",
                lineHeight: 1.6,
                color: "var(--color-text-muted)",
              }}
            >
              <p style={{ marginBottom: "var(--space-2)" }}>
                Good context to open. They want{" "}
                <span
                  style={{
                    background: "linear-gradient(180deg, transparent 60%, var(--color-surface-2) 60%)",
                    color: "var(--color-text)",
                    fontWeight: 500,
                  }}
                >
                  judgment under pressure
                </span>
                , not just the outcome.
              </p>
              <p style={{ marginBottom: "var(--space-2)" }}>
                You&apos;re 40 seconds in and still on setup. Move to the actual decision.
              </p>
              <div
                style={{
                  marginTop: "var(--space-3)",
                  padding: "var(--space-3)",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.75rem",
                }}
              >
                <span
                  className="block"
                  style={{
                    fontSize: "0.625rem",
                    fontWeight: 600,
                    letterSpacing: "0.05em",
                    color: "var(--color-text)",
                    textTransform: "uppercase",
                    marginBottom: "4px",
                  }}
                >
                  Try this instead
                </span>
                &ldquo;I told her the data showed a 30% regression risk, and proposed a one-week delay with a clear rollback plan.&rdquo;
              </div>
            </div>
          </div>

          {/* Column 3: instant feedback — mirrors highlight #3, the
              debrief surface that lands the moment a session ends.
              Verdict chip + mono score (matches PastView's ScoreCard
              token usage), one concrete top-improvement, and a short
              strengths list. The semantic-success rgba fill is the
              same value the real ScoreCard uses, so this is a direct
              preview, not a marketing-only mock. */}
          <div
            className="flex flex-col"
            style={{ background: "var(--color-bg)", padding: "var(--space-6)", gap: "var(--space-3)" }}
          >
            <ColLabel>Instant Feedback</ColLabel>
            <div className="flex items-center gap-2">
              <span
                style={{
                  fontSize: "0.625rem",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "3px 8px",
                  borderRadius: "999px",
                  background: "rgba(31, 122, 77, 0.12)",
                  color: "var(--color-success)",
                }}
              >
                Strong Pass
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  color: "var(--color-text)",
                  letterSpacing: "-0.01em",
                }}
              >
                87 / 100
              </span>
            </div>

            <div style={{ marginTop: "var(--space-2)" }}>
              <div
                style={{
                  fontSize: "0.625rem",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "var(--color-text-subtle)",
                  marginBottom: "4px",
                }}
              >
                Top improvement
              </div>
              <p
                style={{
                  fontSize: "0.75rem",
                  lineHeight: 1.5,
                  color: "var(--color-text-muted)",
                }}
              >
                Tighten the opening — 40s on context before the actual
                decision. Aim for ~15s of setup, then move to the call.
              </p>
            </div>

            <div style={{ marginTop: "var(--space-2)" }}>
              <div
                style={{
                  fontSize: "0.625rem",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "var(--color-text-subtle)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Strengths
              </div>
              <ul
                style={{
                  fontSize: "0.75rem",
                  lineHeight: 1.5,
                  color: "var(--color-text-muted)",
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <li style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <CheckIcon />
                  <span>Quantified the risk (30% regression) instead of hand-waving.</span>
                </li>
                <li style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <CheckIcon />
                  <span>Proposed a rollback plan, not just a complaint.</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ColLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.6875rem",
        fontWeight: 500,
        letterSpacing: "0.08em",
        color: "var(--color-text-subtle)",
        textTransform: "uppercase",
        marginBottom: "var(--space-2)",
      }}
    >
      {children}
    </div>
  );
}

/** Inline check icon used in the Instant Feedback column's
 *  strengths list. SVG (not Unicode) so the glyph never falls
 *  back to a question mark or `;` if the system font lacks it. */
function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: "var(--color-success)",
        flexShrink: 0,
        marginTop: "3px",
      }}
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* ============================================================
   Social proof — single line of company names. Static placeholder;
   if/when there's real data to back this up, replace the spans
   with logos. Reads as muted/aspirational like the marketing
   source.
   ============================================================ */
function SocialProof() {
  return (
    <section
      className="text-center border-y border-border py-8 sm:py-12"
    >
      <div className="container mx-auto px-4 sm:px-6 max-w-[1120px]">
        <p
          style={{
            fontSize: "0.6875rem",
            color: "var(--color-text-subtle)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: "var(--space-6)",
          }}
        >
          Trusted by candidates interviewing at
        </p>
        {/* Wider vertical+horizontal gap stack on mobile so the brand
            chips don't crowd; tightens up on desktop. */}
        <div
          className="flex justify-center items-center flex-wrap gap-x-6 gap-y-3 sm:gap-x-12"
          style={{
            color: "var(--color-text-subtle)",
            fontWeight: 600,
            fontSize: "0.9375rem",
            letterSpacing: "-0.01em",
            opacity: 0.7,
          }}
        >
          <span>Stripe</span>
          <span>Anthropic</span>
          <span>Citadel</span>
          <span>McKinsey</span>
          <span>Jane Street</span>
          <span>Google</span>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Features — 6-card grid. Each card has an icon, h3, and a short
   benefit description. Icons are inline SVGs (Lucide-shaped) at
   stroke-width 1.5 per the design rule.
   ============================================================ */
function Features() {
  const items: Array<{ title: string; body: string; icon: React.ReactNode }> = [
    // The first three cards mirror the hero visual's three columns —
    // Question Captured / Live Commentary / Instant Feedback — so the
    // marketing narrative reinforces the same three highlights twice
    // (once visually, once in copy). Order matters: keep these three
    // first.
    {
      title: "Capture the real question",
      body:
        "Filters filler, restatements, and clarifiers. You always know exactly which question is on the table.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ),
    },
    {
      title: "Live commentary while you answer",
      body:
        "Streaming AI feedback shows what's landing and what's missing — and offers a phrasing you can borrow mid-sentence.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      ),
    },
    {
      title: "Instant feedback when it ends",
      body:
        "End the session and get a verdict, a numeric score, the top thing to fix, and what already worked — in seconds, not days.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      ),
    },
    {
      title: "Recorded debrief, exportable",
      body:
        "Every session is saved with per-question commentary, full transcript, and a screen recording — exportable as PDF.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      ),
    },
    {
      title: "Reverse Q&A mode",
      body:
        "When it's your turn to ask questions, Puebulo surfaces thoughtful follow-ups based on the role and interviewer.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 11H1l8-8 8 8h-8v10" />
          <path d="M22 12h-7" />
        </svg>
      ),
    },
    {
      title: "Knows your story",
      body:
        "Paste the JD, your resume, and the interviewer's profile. Suggestions reference your actual background.",
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
    },
  ];

  return (
    <section
      id="features"
      className="py-12 sm:py-24"
    >
      <div className="container mx-auto px-4 sm:px-6 max-w-[1120px]">
        <SectionHeader
          eyebrow="Features"
          title="Built for the moments that decide the outcome."
          subtitle="Real-time understanding, real-time guidance, and a debrief you can actually learn from."
        />
        {/* 1 col on phones, 2 on tablets, 3 on desktop. The 6-card
            list reads naturally at every step. */}
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <FeatureCard key={it.title} {...it} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
}) {
  // Hover treatment matches the marketing-source `.feature-card:hover`:
  // border darkens to border-strong + slight 2px upward lift. Implemented
  // via Tailwind hover utilities + a feature-card class for the tokens
  // CSS-vars can't reach (the radius/padding/etc.). Pure CSS so the
  // page stays a server component.
  return (
    <div
      className="border border-border bg-bg transition-[border-color,transform] duration-200 hover:border-border-strong hover:-translate-y-0.5"
      style={{
        padding: "var(--space-6)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          background: "var(--color-surface)",
          marginBottom: "var(--space-4)",
          color: "var(--color-text)",
        }}
      >
        {icon}
      </div>
      <h3 style={{ marginBottom: "var(--space-2)" }}>{title}</h3>
      <p
        style={{
          fontSize: "0.875rem",
          lineHeight: 1.55,
          color: "var(--color-text-muted)",
        }}
      >
        {body}
      </p>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div
      className="text-center mx-auto"
      style={{ maxWidth: "580px", marginBottom: "var(--space-12)" }}
    >
      <span
        className="block eyebrow"
        style={{ marginBottom: "var(--space-3)" }}
      >
        {eyebrow}
      </span>
      <h2>{title}</h2>
      {subtitle && (
        <p
          style={{
            marginTop: "var(--space-3)",
            fontSize: "0.9375rem",
            color: "var(--color-text-muted)",
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

/* ============================================================
   How it works — 3-step grid with mono numerals in circles.
   The hairline connector between steps mimics the marketing
   source's `.steps-grid::before` rule.
   ============================================================ */
function HowItWorks() {
  return (
    <section
      id="how"
      className="border-y border-border py-12 sm:py-24"
      style={{
        background: "var(--color-surface)",
      }}
    >
      <div className="container mx-auto px-4 sm:px-6 max-w-[1120px]">
        <SectionHeader
          eyebrow="How it works"
          title="Three steps from the calendar invite to the debrief."
        />
        {/* 1 col mobile (3 stacked steps with vertical spacing),
            3 cols on md+ (with the visual connector hairline). */}
        <div
          className="grid relative mx-auto grid-cols-1 md:grid-cols-3 gap-8 md:gap-12"
          style={{
            maxWidth: "880px",
          }}
        >
          <Step number="01" title="Paste & start">
            Drop in the job description, your resume, and the interviewer&apos;s profile.
          </Step>
          <Step number="02" title="Share two tabs">
            Share the interview tab for audio, and the Puebulo tab so it can record the panel.
          </Step>
          <Step number="03" title="Coach live, review later">
            Read the live panel during the call. End the session for an instant debrief.
          </Step>
        </div>
      </div>
    </section>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative" style={{ zIndex: 1 }}>
      <div
        className="flex items-center justify-center"
        style={{
          width: "40px",
          height: "40px",
          borderRadius: "50%",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
          fontWeight: 500,
          color: "var(--color-text)",
          marginBottom: "var(--space-4)",
        }}
      >
        {number}
      </div>
      <h3 style={{ marginBottom: "var(--space-2)" }}>{title}</h3>
      <p
        style={{
          fontSize: "0.875rem",
          color: "var(--color-text-muted)",
          lineHeight: 1.55,
        }}
      >
        {children}
      </p>
    </div>
  );
}

/* ============================================================
   Footer CTA — final push to sign up. Sits above the global
   footer.
   ============================================================ */
function FooterCta() {
  return (
    <section
      className="text-center border-t border-border py-12 sm:py-24"
      style={{
        background: "var(--color-surface)",
      }}
    >
      <div
        className="container-prose mx-auto px-4 sm:px-6"
        style={{ maxWidth: "680px" }}
      >
        <h2
          className="mx-auto text-[1.5rem] sm:text-inherit"
          style={{
            marginBottom: "var(--space-3)",
            maxWidth: "18ch",
          }}
        >
          Your next interview deserves a copilot.
        </h2>
        <p
          className="mx-auto"
          style={{
            fontSize: "0.9375rem",
            color: "var(--color-text-muted)",
            marginBottom: "var(--space-6)",
            maxWidth: "28rem",
          }}
        >
          Sign in to start your first session.
        </p>
        <Link href="/sign-in" className="btn btn-primary btn-lg">
          Sign in
        </Link>
      </div>
    </section>
  );
}
