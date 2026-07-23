import {
  LegalLayout,
  HighlightBox,
  LegalLink,
} from "@/components/marketing/LegalLayout";

/**
 * /privacy — privacy policy. Body copy is lifted directly from the
 * marketing-source index.html so the public-facing legal text stays
 * one source of truth across the html prototype and the production
 * Next app.
 *
 * Server component — pure static content, no client interactivity
 * beyond MarketingHeader's <Link>s.
 */
export const metadata = {
  title: "Privacy Policy — puebulo",
  description:
    "How puebulo handles your data. Audio, video, and full transcripts stay on your machine. We don't sell your data.",
};

export default function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      updated="April 29, 2026"
      toc={[
        { href: "#summary", label: "The short version" },
        { href: "#what-we-collect", label: "What we collect" },
        { href: "#what-we-dont", label: "What we don't collect" },
        { href: "#third-parties", label: "Third-party services" },
        { href: "#your-rights", label: "Your rights" },
        { href: "#changes", label: "Changes to this policy" },
        { href: "#contact", label: "Contact" },
      ]}
      alsoSee={
        <>
          <LegalLink href="/terms">Terms of Service</LegalLink>{" "}
          · <LegalLink href="/">Back to home</LegalLink>
        </>
      }
    >
      <h2 id="summary">The short version</h2>
      <HighlightBox>
        <p>
          Puebulo is built so your interview never leaves your machine.
          Audio, video, and full transcripts stay locally on your computer.
          We send short text snippets to AI providers so they can generate
          coaching — that&apos;s it. We don&apos;t store your sessions on our
          servers. We don&apos;t sell your data. Ever.
        </p>
      </HighlightBox>
      <p>
        This policy explains, in detail, what we collect, what we don&apos;t,
        and how the parts that do leave your machine are handled. If anything
        below contradicts the short version, the short version is what we
        actually do.
      </p>

      <h2 id="what-we-collect">What we collect</h2>
      <h3>Account information</h3>
      <p>
        When you sign up, we collect your email address and a hashed password.
        If you sign in with Google, we receive your email and basic profile
        information from Google. We use this to authenticate you and send
        essential service emails.
      </p>
      <h3>Session metadata</h3>
      <p>
        When you start a session, we record metadata such as session start
        time, duration, and the role/company you entered. This helps you see
        your session history and helps us understand product usage in
        aggregate.
      </p>
      <h3>Text snippets sent to AI</h3>
      <p>
        To generate live coaching, Puebulo sends short text snippets to AI
        providers — typically the current question on the table, your last
        few sentences, and the JD/resume context you pasted. These snippets
        are processed and returned in real time. We do not store them on
        our servers.
      </p>
      <h3>Usage analytics</h3>
      <p>
        We collect anonymized analytics about feature usage — which pages
        were visited, which buttons were clicked, error rates. We do not
        track individuals across the web and we do not use third-party
        advertising trackers.
      </p>

      <h2 id="what-we-dont">What we don&apos;t collect</h2>
      <p>
        To be specific about what stays on your device and never reaches
        our servers:
      </p>
      <ul>
        <li>
          <strong>Audio recordings</strong> — your microphone and tab audio
          are processed in your browser and sent to the transcription
          provider. We never store the audio.
        </li>
        <li>
          <strong>Video recordings</strong> — the screen recording of your
          coaching panel is saved to your local storage only. Nothing is
          uploaded.
        </li>
        <li>
          <strong>Full transcripts</strong> — we don&apos;t keep a copy of the
          full session transcript. Only the short snippets needed for live
          AI coaching leave the browser, and they are not retained after the
          session ends.
        </li>
        <li>
          <strong>Interviewer information</strong> — beyond what you paste
          in to give the AI context, we don&apos;t gather any data about your
          interviewer.
        </li>
      </ul>

      <h2 id="third-parties">Third-party services</h2>
      <p>
        Puebulo relies on a small number of third-party services to function.
        Each is contractually bound to handle your data appropriately.
      </p>
      <h3>AI providers</h3>
      <p>
        We send text snippets to AI providers (such as Anthropic) to
        generate coaching. These providers process the data to return a
        response and do not retain it for training under our enterprise
        agreements.
      </p>
      <h3>Transcription</h3>
      <p>
        Audio is streamed to a transcription provider (Deepgram) for
        real-time speech-to-text. The audio is processed in transit and not
        stored long-term.
      </p>
      <h3>Authentication &amp; infrastructure</h3>
      <p>
        We use standard cloud infrastructure (AWS) for hosting our
        application servers and standard authentication providers for
        sign-in. These services do not see your interview content.
      </p>

      <h2 id="your-rights">Your rights</h2>
      <p>
        Depending on where you live, you may have the following rights
        regarding your personal data:
      </p>
      <ul>
        <li>
          <strong>Access</strong> — request a copy of the account data we
          hold about you.
        </li>
        <li>
          <strong>Correction</strong> — update or correct your account
          information at any time.
        </li>
        <li>
          <strong>Deletion</strong> — request that we delete your account and
          associated metadata.
        </li>
        <li>
          <strong>Portability</strong> — export your session metadata in a
          machine-readable format.
        </li>
        <li>
          <strong>Objection</strong> — object to specific uses of your data.
        </li>
      </ul>
      <p>
        To exercise any of these rights, contact us at the address below.
        We respond within 30 days.
      </p>

      <h2 id="changes">Changes to this policy</h2>
      <p>
        If we make material changes to this policy, we&apos;ll notify you by
        email and post a prominent notice in the app at least 14 days before
        the changes take effect. The &ldquo;last updated&rdquo; date at the top of this
        page always reflects the current version.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Questions about this policy or about how we handle your data?
        Email us at{" "}
        <a href="mailto:privacy@puebulo.com">privacy@puebulo.com</a>.
      </p>
    </LegalLayout>
  );
}
