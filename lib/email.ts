/**
 * Outgoing transactional email — verification codes today, password
 * resets / receipts later. Uses AWS SES via the EB instance role's
 * IAM credentials (no access keys baked into env), same pattern as
 * lib/storage.ts uses for S3.
 *
 * Two operating modes:
 *
 *   (1) Configured — SES_FROM_EMAIL env var is set:
 *       Real send via SES. Verified domain / out-of-sandbox status
 *       is the operator's responsibility (set up in AWS console).
 *
 *   (2) Unconfigured — SES_FROM_EMAIL env var is missing:
 *       Logs the verification code to the server console (CloudWatch
 *       Logs in production) and returns success. This lets us deploy
 *       the registration flow before SES domain verification clears,
 *       and lets developers run the whole flow locally without ever
 *       touching AWS. The verify endpoint still works — operators just
 *       grab the code from logs and paste it into the UI.
 *
 * The mode is implicit (env-driven, no flag) so the same code path
 * runs in dev and prod; no risk of accidentally shipping a "skip
 * verification" code path because it doesn't exist.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

let sesClient: SESClient | null = null;

function getClient(): SESClient {
  if (!sesClient) {
    sesClient = new SESClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return sesClient;
}

function isConfigured(): boolean {
  return Boolean(process.env.SES_FROM_EMAIL?.trim());
}

/** Sender shaped as "Puebulo <hello@mail.puebulo.com>". The
 *  display-name part keeps inbox previews clean (otherwise Gmail
 *  shows "hello" as the sender). */
function fromHeader(): string {
  const addr = process.env.SES_FROM_EMAIL?.trim() || "";
  return `Puebulo <${addr}>`;
}

interface SendVerificationArgs {
  to: string;
  code: string;
  /** Optional friendly name for the recipient — drops into the
   *  greeting line. Falls back to "there" so the line still scans. */
  name?: string;
}

/**
 * Sends a 6-digit verification code (registration flow) to the email.
 * Returns true on successful send (or successful log in the
 * unconfigured path). Returns false only when SES rejected the send —
 * caller should surface a generic "couldn't send code, try again"
 * error and NOT leak which provider failed.
 */
export async function sendVerificationEmail(
  args: SendVerificationArgs
): Promise<boolean> {
  return sendCodeEmail({
    kind: "verification",
    to: args.to,
    code: args.code,
    name: args.name,
  });
}

/** Sends a 6-digit code for the password-reset flow. Same shape as
 *  sendVerificationEmail; differs only in subject + body copy so the
 *  recipient understands which action they're confirming. */
export async function sendPasswordResetEmail(
  args: SendVerificationArgs
): Promise<boolean> {
  return sendCodeEmail({
    kind: "password-reset",
    to: args.to,
    code: args.code,
    name: args.name,
  });
}

/** Internal renderer + sender shared by all 6-digit-code emails.
 *  Picks subject + lead copy based on `kind`; everything else
 *  (header, code block, footer disclaimer) is identical across
 *  flows. Centralizing this keeps brand-mark / styling drift from
 *  accumulating across templates. */
async function sendCodeEmail(args: {
  kind: "verification" | "password-reset";
  to: string;
  code: string;
  name?: string;
}): Promise<boolean> {
  const { kind, to, code, name } = args;

  // === Unconfigured path ===
  // Log to stdout (captured by CloudWatch in EB) so the operator can
  // grab the code without touching the DB. Matches the dev-fallback
  // pattern used throughout the codebase (storage.ts, etc.).
  if (!isConfigured()) {
    console.log(
      `[email:dev] ${kind} email skipped (SES_FROM_EMAIL not set). ` +
        `Code for ${to}: ${code}`
    );
    return true;
  }

  const greeting = name ? `Hi ${name},` : "Hi there,";

  // Per-kind copy. We deliberately keep the LEAD line short and
  // parallel across both flows ("Your X code is:") so the visual
  // template renders identically — same number of lines, same vertical
  // rhythm, same eye-flow to the code box. Subject + finish + ignore
  // lines carry the purpose-specific context so a recipient who
  // skim-reads the body still understands which action this code
  // confirms.
  const isReset = kind === "password-reset";
  const subject = isReset
    ? `Your Puebulo password reset code: ${code}`
    : `Your Puebulo verification code: ${code}`;
  const leadHtml = isReset
    ? "Your password reset code is:"
    : "Your verification code is:";
  const finishHtml = isReset
    ? "Enter it on the password reset page to set a new password."
    : "Enter it on the registration page to finish creating your account.";
  const ignoreHtml = isReset
    ? "If you didn't request a password reset, you can safely ignore this email — your password will stay the same."
    : "If you didn't request this, you can safely ignore this email — no account will be created without the code.";
  const textLead = isReset
    ? `Your Puebulo password reset code is: ${code}`
    : `Your Puebulo verification code is: ${code}`;
  const textFinish = isReset
    ? "This code expires in 10 minutes. Enter it on the password reset page to set a new password."
    : "This code expires in 10 minutes. Enter it on the registration page to finish creating your account.";
  const textIgnore = isReset
    ? "If you didn't request a password reset, you can safely ignore this email — your password will stay the same."
    : "If you didn't request this, you can safely ignore this email — no account will be created without the code.";

  // Plain-text body. Kept short and direct; no marketing copy. Spam
  // filters reward transactional brevity.
  const textBody = [
    greeting,
    "",
    textLead,
    "",
    textFinish,
    "",
    textIgnore,
    "",
    "— Puebulo",
  ].join("\n");

  // Minimal HTML — single column, system fonts, single hosted PNG
  // logo, no tracking pixel. Inline styles only (most clients strip
  // <style> tags). The logo image is hosted at a public absolute URL
  // (Gmail/Outlook web both strip inline SVG, and Outlook desktop
  // mangles base64 images > ~10KB). The PNG file lives in public/
  // so Next.js serves it under that exact path with HTTPS.
  const logoUrl = "https://www.puebulo.com/puebulo-logo.png";
  const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:480px;margin:40px auto;padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e7e5df;">
    <!-- Brand lockup: logo + wordmark side-by-side. Uses a single-row
         table because email clients (especially Outlook desktop) don't
         reliably honor flexbox / inline-flex for vertical alignment. -->
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="padding-right:10px;vertical-align:middle;">
          <img src="${logoUrl}" width="32" height="32" alt="Puebulo" style="display:block;border:0;outline:none;text-decoration:none;border-radius:6px;" />
        </td>
        <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;font-weight:600;color:#0a0a0a;letter-spacing:-0.02em;">
          puebulo
        </td>
      </tr>
    </table>
    <p style="font-size:15px;line-height:1.55;margin:0 0 16px 0;">${escapeHtml(greeting)}</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 24px 0;">${escapeHtml(leadHtml)}</p>
    <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:600;letter-spacing:6px;background:#f3f2ee;padding:18px 24px;text-align:center;border-radius:8px;margin:0 0 24px 0;">${escapeHtml(code)}</div>
    <p style="font-size:13.5px;line-height:1.55;color:#4a4a4a;margin:0 0 16px 0;">This code expires in <strong>10 minutes</strong>. ${escapeHtml(finishHtml)}</p>
    <p style="font-size:13px;line-height:1.55;color:#888;margin:24px 0 0 0;border-top:1px solid #eeece6;padding-top:16px;">${escapeHtml(ignoreHtml)}</p>
  </div>
  <div style="text-align:center;font-size:12px;color:#a0a0a0;padding:0 0 40px 0;">— Puebulo</div>
</body>
</html>`;

  try {
    const cmd = new SendEmailCommand({
      Source: fromHeader(),
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: textBody, Charset: "UTF-8" },
          Html: { Data: htmlBody, Charset: "UTF-8" },
        },
      },
      // ReplyToAddresses lets the user reply to a real inbox if they
      // need help — without this, replies bounce off the noreply-style
      // sender. Falls back silently when unset.
      ...(process.env.SES_REPLY_TO?.trim()
        ? { ReplyToAddresses: [process.env.SES_REPLY_TO.trim()] }
        : {}),
    });
    await getClient().send(cmd);
    return true;
  } catch (e) {
    // Surfaced via console.error so CloudWatch picks it up. Common
    // causes: domain not verified yet, sandbox mode rejecting the
    // recipient, IAM role missing ses:SendEmail.
    console.error("[email] SES send failed:", e);
    return false;
  }
}

/** Generates a 6-digit numeric verification code as a zero-padded
 *  string. ~1M possibilities × 5-attempt limit = 0.0005% per-request
 *  brute-force success rate; bounded by the 10-min TTL on top.
 *  crypto.getRandomValues is available in Node 19+ (EB Node 20). */
export function generateVerificationCode(): string {
  const buf = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf);
  } else {
    buf[0] = Math.floor(Math.random() * 0xffffffff);
  }
  const n = buf[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** Tiny HTML escape — defensive only. Code/name aren't user-controlled
 *  in a way that lets an attacker inject HTML (code is digits, name
 *  comes from the user's own registration), but defense-in-depth is
 *  cheap. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
