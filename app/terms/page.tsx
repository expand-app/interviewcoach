import {
  LegalLayout,
  HighlightBox,
  LegalLink,
} from "@/components/marketing/LegalLayout";

/**
 * /terms — terms of service. Body copy lifted from the marketing-
 * source index.html.
 */
export const metadata = {
  title: "Terms of Service — puebulo",
  description: "Puebulo's terms of service.",
};

export default function TermsPage() {
  return (
    <LegalLayout
      title="Terms of Service"
      updated="April 29, 2026"
      toc={[
        { href: "#t-summary", label: "The short version" },
        { href: "#who-can-use", label: "Who can use Puebulo" },
        { href: "#your-account", label: "Your account" },
        { href: "#acceptable-use", label: "Acceptable use" },
        { href: "#your-content", label: "Your content" },
        { href: "#payment", label: "Payment and subscriptions" },
        { href: "#termination", label: "Termination" },
        { href: "#warranty", label: "Warranty disclaimer" },
        { href: "#liability", label: "Limitation of liability" },
        { href: "#t-changes", label: "Changes to these terms" },
        { href: "#t-contact", label: "Contact" },
      ]}
      alsoSee={
        <>
          <LegalLink href="/privacy">Privacy Policy</LegalLink>{" "}
          · <LegalLink href="/">Back to home</LegalLink>
        </>
      }
    >
      <h2 id="t-summary">The short version</h2>
      <HighlightBox>
        <p>
          Puebulo helps you with interviews — but you&apos;re responsible for
          how you use it. Don&apos;t break laws, don&apos;t impersonate others,
          and understand that AI suggestions are just suggestions, not
          guarantees of any outcome. We can update these terms; if we do,
          we&apos;ll let you know. By using Puebulo, you agree to what&apos;s
          below.
        </p>
      </HighlightBox>
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to
        and use of Puebulo (&ldquo;the Service&rdquo;), provided by Puebulo Inc.
        (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;). By creating an
        account or using the Service, you agree to these Terms.
      </p>

      <h2 id="who-can-use">Who can use Puebulo</h2>
      <p>
        You must be at least 18 years old, or the age of legal majority in
        your jurisdiction, to use Puebulo. If you&apos;re using the Service
        on behalf of an organization, you represent that you have authority
        to bind that organization to these Terms.
      </p>
      <p>
        You may not use Puebulo if you&apos;ve been previously banned, or if
        doing so would violate applicable laws in your country.
      </p>

      <h2 id="your-account">Your account</h2>
      <p>
        You&apos;re responsible for keeping your account credentials secure.
        We recommend a strong, unique password and enabling two-factor
        authentication where available. Notify us immediately if you suspect
        unauthorized access to your account.
      </p>
      <p>
        You&apos;re responsible for all activity that happens under your
        account, even if performed by someone else using your credentials.
      </p>

      <h2 id="acceptable-use">Acceptable use</h2>
      <p>When using Puebulo, you agree not to:</p>
      <ul>
        <li>Use the Service to harass, defraud, or deceive any person</li>
        <li>Impersonate another person or misrepresent your identity</li>
        <li>
          Reverse-engineer, decompile, or attempt to extract source code from
          the Service
        </li>
        <li>
          Use automated tools (bots, scrapers, etc.) to access the Service
          without our written permission
        </li>
        <li>Attempt to interfere with the Service&apos;s operation or security</li>
        <li>Use the Service to violate any applicable law or regulation</li>
        <li>Resell, sublicense, or otherwise commercialize access to the Service</li>
      </ul>
      <h3>About using Puebulo in real interviews</h3>
      <p>
        Puebulo is a coaching tool. Whether to disclose your use of Puebulo
        to an interviewer is your decision and may depend on the company&apos;s
        policies, the role, or applicable law. You&apos;re solely responsible
        for any consequences arising from your use of the Service in any
        specific interview context.
      </p>

      <h2 id="your-content">Your content</h2>
      <p>
        You retain all rights to the content you provide to Puebulo —
        including job descriptions, resumes, and any other materials you
        paste in. By using the Service, you grant us a limited license to
        process this content solely for the purpose of providing the Service
        to you.
      </p>
      <p>
        As described in our <LegalLink href="/privacy">Privacy Policy</LegalLink>,
        audio, video, and full transcripts stay on your local device. We do
        not claim ownership of any of your content.
      </p>

      <h2 id="payment">Payment and subscriptions</h2>
      <p>
        Some features of Puebulo may require a paid subscription. If you
        subscribe, you agree to pay the fees specified at the time of
        purchase, in the currency shown.
      </p>
      <h3>Billing</h3>
      <p>
        Subscriptions renew automatically at the end of each billing period
        unless cancelled. You can cancel anytime from your account settings;
        the cancellation takes effect at the end of the current billing
        period.
      </p>
      <h3>Refunds</h3>
      <p>
        We offer refunds within 14 days of initial purchase if you&apos;re
        not satisfied. After that, refunds are at our discretion.
      </p>
      <h3>Price changes</h3>
      <p>
        If we change the price of a subscription, we&apos;ll notify you at
        least 30 days in advance. The new price applies starting from your
        next billing period.
      </p>

      <h2 id="termination">Termination</h2>
      <p>
        You can stop using Puebulo and delete your account at any time. We
        may suspend or terminate your access if you violate these Terms or
        if your use poses a risk to the Service or other users.
      </p>
      <p>
        On termination, your account and associated metadata will be deleted
        within 30 days, except where we&apos;re required to retain certain
        information for legal or accounting purposes.
      </p>

      <h2 id="warranty">Warranty disclaimer</h2>
      <p>
        Puebulo is provided &ldquo;as is,&rdquo; without warranties of any
        kind. We do not guarantee that:
      </p>
      <ul>
        <li>
          The Service will be uninterrupted, error-free, or free of harmful
          components
        </li>
        <li>
          The AI-generated coaching will be accurate, complete, or
          appropriate for any particular interview
        </li>
        <li>
          Use of the Service will result in any specific outcome (including,
          but not limited to, receiving a job offer)
        </li>
      </ul>
      <p>
        AI suggestions are tools to help you think. They are not professional
        advice and should not be treated as guaranteed-correct guidance.
      </p>

      <h2 id="liability">Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Puebulo Inc. and its
        affiliates are not liable for any indirect, incidental, special,
        consequential, or punitive damages — including lost profits, lost
        opportunities, or lost data — arising from your use of the Service.
      </p>
      <p>
        Our total liability for any claim related to the Service will not
        exceed the amount you paid us in the 12 months preceding the claim,
        or USD $100, whichever is greater.
      </p>

      <h2 id="t-changes">Changes to these terms</h2>
      <p>
        We may update these Terms from time to time. If we make material
        changes, we&apos;ll notify you by email and post a notice in the app
        at least 14 days before the changes take effect. Continued use of
        the Service after the changes take effect means you accept the
        updated Terms.
      </p>

      <h2 id="t-contact">Contact</h2>
      <p>
        Questions about these Terms? Email us at{" "}
        <a href="mailto:legal@puebulo.com">legal@puebulo.com</a>.
      </p>
    </LegalLayout>
  );
}
