"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { Button, Field, Input, BrandMark } from "@/components/ui";
import { MarketingHeader } from "@/components/marketing/MarketingHeader";
import {
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signInUser,
  verifyEmailAndCreateAccount,
} from "@/lib/client-api";

/**
 * /sign-in — local-only auth screen styled to match the marketing
 * source's `.auth-page` + `.auth-card` design exactly.
 *
 * Behavior summary:
 *   - The actual auth is local-only: name + email get stored in the
 *     Zustand `user` slice (persisted to localStorage). There's no
 *     backend, so the password field is presentational only — we
 *     accept any non-empty value to mimic the marketing form's
 *     shape but never store or compare it.
 *   - Two tabs: Sign in / Register. They use the same store call
 *     under the hood; Register just adds an Invitation code field
 *     to mirror the marketing source's "invite-only beta" framing.
 *   - "Continue with Google" is a visual stub — clicking it does
 *     nothing real. It's there so the page reads as "production
 *     quality" rather than "internal tool", matching the brand
 *     promise of the marketing landing.
 *   - Marketing header at the top so the user can click the
 *     puebulo logo or the nav links to escape back to /, /privacy,
 *     etc. — without it, the auth page feels like a dead-end.
 *
 * Visual design lifted directly from the marketing source's
 * .auth-page layout, .auth-tabs, .auth-form, .field, .divider, and
 * .auth-switch / .auth-legal patterns.
 */
/** Three top-level views: sign-in form, register flow, forgot-password
 *  flow. Forgot-password is its own "tab" rather than a sub-state of
 *  Sign in because the form layout is meaningfully different (email
 *  only at first, then code + new password) and we want a clean Back
 *  link to bounce the user back to Sign in. */
type Tab = "signin" | "register" | "forgot";
/** Two-step register flow:
 *   - "fill"   — invite code + email + password form. Submit triggers
 *                the server to email a 6-digit code.
 *   - "verify" — 6-digit code input. Submit creates the user atomically
 *                and signs them in.
 *  Stays on "fill" if the user is on the Sign in tab. */
type RegisterStep = "fill" | "verify";
/** Two-step forgot-password flow:
 *   - "email"  — enter email, server sends 6-digit code.
 *   - "reset"  — enter 6-digit code + new password, server rotates
 *                the password_hash and returns the user row for
 *                auto-sign-in. */
type ForgotStep = "email" | "reset";

export function LoginView() {
  const router = useRouter();
  const signIn = useStore((s) => s.signIn);
  const setUserId = useStore((s) => s.setUserId);

  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  // First / Last name fields — required (firstName) on registration.
  // Drive both the user.name in the DB and the email greeting. Stored
  // separately so we can use firstName-only ("Hi Wilson,") in the
  // email but persist the full "Wilson Lee" on the user row for the
  // sidebar / avatar / billing surfaces later.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // submitting blocks double-clicks while bcrypt verifies on the
  // server (~50-100ms) plus the network round-trip. Without this,
  // a user smashing Enter could fire two parallel sign-ins and end
  // up with mismatched store state from racing responses.
  const [submitting, setSubmitting] = useState(false);

  // Register-flow-only state. registerStep gates which form renders;
  // verificationCode is the 6-digit input the user receives via email;
  // pendingEmail is the (server-normalized lowercase) email the code
  // was sent to — used in the "We sent a code to ___" copy so the user
  // sees exactly what we sent it to (catches typos at the gate, not
  // at the verify step where they're stuck).
  const [registerStep, setRegisterStep] = useState<RegisterStep>("fill");
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  // Forgot-password-flow state. forgotStep gates the two sub-forms;
  // resetCode + newPassword are the inputs at step 2. Reuses
  // `pendingEmail` (with the register flow) since at any moment only
  // one flow is active — no chance of stale cross-talk.
  const [forgotStep, setForgotStep] = useState<ForgotStep>("email");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // Helper to fully reset the Register form back to step 1. Called
  // when the user clicks "Use a different email" or switches tabs.
  const resetRegister = () => {
    setRegisterStep("fill");
    setVerificationCode("");
    setPendingEmail("");
    setError(null);
    setResendNotice(null);
  };

  /** Reset the Forgot flow back to the "enter email" step. Called
   *  from the back-to-sign-in button and from "Use a different
   *  email" inside the reset step. */
  const resetForgot = () => {
    setForgotStep("email");
    setResetCode("");
    setNewPassword("");
    setPendingEmail("");
    setError(null);
    setResendNotice(null);
  };

  const onSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 1) {
      setError("Please enter your password.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await signInUser(trimmedEmail, password);
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // Server already validated + returned the user row. Push to /app
    // immediately so the redirect feels instant; userId is attached
    // synchronously here (unlike the legacy fire-and-forget upsert
    // path) so /api/sessions calls work from the very first request.
    signIn({ name: result.name, email: result.email, userId: result.userId });
    setUserId(result.userId);
    router.push("/app");
  };

  // Step 1 of register: send the verification email.
  const onSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmedEmail = email.trim();
    const trimmedCode = inviteCode.trim();
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (trimmedFirst.length === 0) {
      setError("Please enter your first name.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (trimmedCode.length === 0) {
      setError("Invitation code is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResendNotice(null);
    const result = await requestEmailVerification({
      email: trimmedEmail,
      password,
      inviteCode: trimmedCode,
      firstName: trimmedFirst,
      lastName: trimmedLast || undefined,
    });
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // Stash the canonical email + advance to step 2. We DON'T clear
    // password/inviteCode in case the user backs out of step 2 — they
    // can retry without retyping. The pending verification on the
    // server already has the bcrypt hash of the password they just
    // typed, so clearing it client-side wouldn't help anyway.
    setPendingEmail(result.email);
    setRegisterStep("verify");
  };

  // Step 2 of register: submit the 6-digit code.
  const onVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const normalized = verificationCode.replace(/\D/g, "");
    if (normalized.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await verifyEmailAndCreateAccount({
      email: pendingEmail,
      code: normalized,
    });
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    signIn({ name: result.name, email: result.email, userId: result.userId });
    setUserId(result.userId);
    router.push("/app");
  };

  // Resend a fresh code without leaving the verify step. Server
  // enforces a 60s rate limit on this — we surface that as the
  // resendNotice (e.g. "Please wait a moment...").
  const onResendCode = async () => {
    if (resending) return;
    const trimmedEmail = email.trim();
    const trimmedCode = inviteCode.trim();
    setResending(true);
    setError(null);
    setResendNotice(null);
    const result = await requestEmailVerification({
      email: trimmedEmail,
      password,
      inviteCode: trimmedCode,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
    });
    setResending(false);
    if ("error" in result) {
      // Resend errors get surfaced on the inline notice line, not as
      // the big red error box — the verify form is still valid, the
      // user just needs to wait.
      setResendNotice(result.error);
      return;
    }
    setPendingEmail(result.email);
    setVerificationCode("");
    setResendNotice("A new code has been sent.");
  };

  // === Forgot-password handlers ===

  /** Step 1: ask the server to email a reset code. */
  const onSendResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResendNotice(null);
    const result = await requestPasswordReset({ email: trimmedEmail });
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setPendingEmail(result.email);
    setForgotStep("reset");
  };

  /** Step 2: submit the 6-digit code + a new password. On success the
   *  server has rotated the password_hash and returned the user row;
   *  we sign them in immediately and bounce to /app, identical to a
   *  successful sign-in. */
  const onResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const normalized = resetCode.replace(/\D/g, "");
    if (normalized.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await resetPassword({
      email: pendingEmail,
      code: normalized,
      newPassword,
    });
    setSubmitting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    signIn({ name: result.name, email: result.email, userId: result.userId });
    setUserId(result.userId);
    router.push("/app");
  };

  /** Resend the reset code from inside the reset step. */
  const onResendResetCode = async () => {
    if (resending) return;
    const trimmedEmail = email.trim();
    setResending(true);
    setError(null);
    setResendNotice(null);
    const result = await requestPasswordReset({ email: trimmedEmail });
    setResending(false);
    if ("error" in result) {
      setResendNotice(result.error);
      return;
    }
    setPendingEmail(result.email);
    setResetCode("");
    setResendNotice("A new code has been sent.");
  };

  return (
    <>
      <MarketingHeader />
      <div
        className="flex items-start justify-center"
        style={{
          minHeight: "calc(100vh - 60px)",
          background: "var(--color-surface)",
        }}
        // Mobile: tighter outer padding so the card breathes against
        // narrow viewports without 64px of dead vertical space at the
        // top + bottom + 24px on each side. Desktop keeps the
        // generous spacing that anchors the card visually.
      >
        <div
          className="w-full bg-bg border border-border my-8 sm:my-16 mx-3 sm:mx-6 px-5 sm:px-8 py-8 sm:py-12"
          style={{
            maxWidth: "480px",
            borderRadius: "var(--radius-xl)",
          }}
        >
          {/* Centered brand mark — clickable, links home. Matches the
              marketing-source `.auth-brand` pattern. The header above
              also gives the user a way home, but a centered brand on
              the card itself is the more obvious affordance. */}
          <div className="flex justify-center mb-8">
            <Link href="/" aria-label="Puebulo home">
              <BrandMark size={44} />
            </Link>
          </div>

          {/* Tab switcher. Two-pill segmented control inside a
              surface-tinted track. Both tabs are now active —
              registration is invite-only (server validates the code)
              but otherwise self-serve.

              HIDDEN during the forgot-password sub-flow: that's a
              dedicated path with its own back-link, and showing the
              Sign in / Register tabs above it would imply the forgot
              flow is its own permanent surface, which it isn't. */}
          {tab !== "forgot" && (
            <div
              className="flex gap-2 p-1 mb-8"
              style={{
                background: "var(--color-surface)",
                borderRadius: "var(--radius-md)",
              }}
              role="tablist"
            >
              <TabButton active={tab === "signin"} onClick={() => { setTab("signin"); resetRegister(); }}>
                Sign in
              </TabButton>
              <TabButton active={tab === "register"} onClick={() => { setTab("register"); setError(null); }}>
                Register
              </TabButton>
            </div>
          )}

          {tab === "forgot" ? (
            forgotStep === "email" ? (
              // === Forgot step 1: enter email ===
              <form onSubmit={onSendResetCode}>
                <FormHeading>Reset your password.</FormHeading>
                <FormSubtitle>
                  Enter the email for your account. We&apos;ll send a
                  6-digit code to confirm it&apos;s you.
                </FormSubtitle>

                <Field label="Email" htmlFor="forgot-email">
                  <Input
                    id="forgot-email"
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                    required
                  />
                </Field>

                {error && <ErrorBox>{error}</ErrorBox>}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="w-full mt-2"
                  disabled={submitting}
                >
                  {submitting ? "Sending code…" : "Send reset code"}
                </Button>

                <SwitchRow>
                  Remembered it?{" "}
                  <button
                    type="button"
                    onClick={() => { setTab("signin"); resetForgot(); }}
                    className="font-medium underline underline-offset-[3px]"
                    style={{
                      color: "var(--color-text)",
                      textDecorationColor: "var(--color-border-strong)",
                    }}
                  >
                    Back to sign in
                  </button>
                </SwitchRow>
              </form>
            ) : (
              // === Forgot step 2: enter code + new password ===
              <form onSubmit={onResetPassword}>
                <FormHeading>Check your email.</FormHeading>
                <FormSubtitle>
                  We sent a 6-digit code to <strong>{pendingEmail}</strong>.
                  Enter it below along with a new password.
                </FormSubtitle>

                <Field label="Verification code" htmlFor="forgot-code">
                  <Input
                    id="forgot-code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={resetCode}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                      setResetCode(digits);
                      setError(null);
                      setResendNotice(null);
                    }}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    autoFocus
                    required
                    style={{
                      fontSize: "1.25rem",
                      letterSpacing: "0.4em",
                      fontFamily: "var(--font-mono)",
                      textAlign: "center",
                    }}
                  />
                </Field>

                <Field
                  label="New password"
                  htmlFor="forgot-newpw"
                  help={<span>At least 8 characters.</span>}
                >
                  <Input
                    id="forgot-newpw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </Field>

                {error && <ErrorBox>{error}</ErrorBox>}
                {resendNotice && (
                  <div
                    className="mb-4 text-xs rounded-md px-2.5 py-2"
                    style={{
                      color: "var(--color-text-muted)",
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    {resendNotice}
                  </div>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="w-full mt-2"
                  disabled={
                    submitting ||
                    resetCode.length !== 6 ||
                    newPassword.length < 8
                  }
                >
                  {submitting ? "Resetting…" : "Reset password"}
                </Button>

                <div
                  className="text-center mt-5"
                  style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)" }}
                >
                  Didn&apos;t receive it?{" "}
                  <button
                    type="button"
                    onClick={onResendResetCode}
                    disabled={resending}
                    className="font-medium underline underline-offset-[3px]"
                    style={{
                      color: resending ? "var(--color-text-subtle)" : "var(--color-text)",
                      textDecorationColor: "var(--color-border-strong)",
                      background: "transparent",
                      border: "none",
                      cursor: resending ? "default" : "pointer",
                      padding: 0,
                      fontFamily: "inherit",
                    }}
                  >
                    {resending ? "Resending…" : "Resend code"}
                  </button>
                </div>

                <SwitchRow>
                  Wrong email?{" "}
                  <button
                    type="button"
                    onClick={resetForgot}
                    className="font-medium underline underline-offset-[3px]"
                    style={{
                      color: "var(--color-text)",
                      textDecorationColor: "var(--color-border-strong)",
                    }}
                  >
                    Use a different one
                  </button>
                </SwitchRow>
              </form>
            )
          ) : tab === "signin" ? (
            <form onSubmit={onSignInSubmit}>
              <FormHeading>Welcome back.</FormHeading>
              <FormSubtitle>
                Sign in with your email and password.
              </FormSubtitle>

              <Field label="Email" htmlFor="signin-email">
                <Input
                  id="signin-email"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null); }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                  required
                />
              </Field>

              <Field
                label="Password"
                htmlFor="signin-password"
              >
                <Input
                  id="signin-password"
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  autoComplete="current-password"
                  required
                />
              </Field>

              {/* Forgot password link — right-aligned below the
                  password field, sits as a small text link rather
                  than a tab so the primary Sign in flow stays the
                  visual focus. Clicking it pivots into the dedicated
                  forgot-password sub-flow (email → 6-digit code →
                  new password → auto sign-in). */}
              <div className="flex justify-end" style={{ marginTop: -8, marginBottom: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setTab("forgot");
                    resetForgot();
                  }}
                  className="font-medium hover:text-text"
                  style={{
                    fontSize: "0.8125rem",
                    color: "var(--color-text-muted)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Forgot password?
                </button>
              </div>

              {error && <ErrorBox>{error}</ErrorBox>}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full mt-2"
                disabled={submitting}
              >
                {submitting ? "Signing in…" : "Sign in"}
              </Button>

              <Divider>or</Divider>

              <GoogleButton />

              <SwitchRow>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => { setTab("register"); setError(null); }}
                  className="font-medium underline underline-offset-[3px]"
                  style={{
                    color: "var(--color-text)",
                    textDecorationColor: "var(--color-border-strong)",
                  }}
                >
                  Register
                </button>
              </SwitchRow>
            </form>
          ) : registerStep === "fill" ? (
            <form onSubmit={onSendCode}>
              <FormHeading>Create your account.</FormHeading>
              <FormSubtitle>
                Registration is invite-only during beta. We&apos;ll email you
                a 6-digit code to confirm.
              </FormSubtitle>

              <Field label="Invitation code" htmlFor="register-invite">
                <Input
                  id="register-invite"
                  type="text"
                  value={inviteCode}
                  onChange={(e) => { setInviteCode(e.target.value); setError(null); }}
                  placeholder="puebulo-xxxxxxxx"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>

              {/* First / Last name row. First name drives the email
                  greeting + sidebar identity, so it's required; last
                  name is optional. Side-by-side on wider widths so
                  the form doesn't grow unnecessarily tall. min-w-0 on
                  each cell so they collapse cleanly on narrow phones.
                  Each child Field already carries `mb-3`, so the row
                  itself has no extra bottom margin — the Field's own
                  margin separates the row from the Email field below
                  with the same 12px gap as every other inter-field
                  gap on the form. */}
              <div className="flex gap-3">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="First name" htmlFor="register-first">
                    <Input
                      id="register-first"
                      type="text"
                      value={firstName}
                      onChange={(e) => { setFirstName(e.target.value); setError(null); }}
                      placeholder="Wilson"
                      autoComplete="given-name"
                      maxLength={40}
                      required
                    />
                  </Field>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="Last name" htmlFor="register-last">
                    <Input
                      id="register-last"
                      type="text"
                      value={lastName}
                      onChange={(e) => { setLastName(e.target.value); setError(null); }}
                      placeholder="Lee"
                      autoComplete="family-name"
                      maxLength={40}
                    />
                  </Field>
                </div>
              </div>

              <Field label="Email" htmlFor="register-email">
                <Input
                  id="register-email"
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(null); }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </Field>

              <Field
                label="Password"
                htmlFor="register-password"
                help={<span>At least 8 characters.</span>}
              >
                <Input
                  id="register-password"
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </Field>

              {error && <ErrorBox>{error}</ErrorBox>}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full mt-2"
                disabled={submitting}
              >
                {submitting ? "Sending code…" : "Send verification code"}
              </Button>

              {/* Legal disclaimer — links to /terms and /privacy.
                  Same wording as the marketing-source register form. */}
              <div
                className="text-center mt-6"
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-text-subtle)",
                  lineHeight: 1.6,
                }}
              >
                By creating an account, you agree to our{" "}
                <Link
                  href="/terms"
                  className="underline underline-offset-[2px]"
                  style={{
                    color: "var(--color-text-muted)",
                    textDecorationColor: "var(--color-border-strong)",
                  }}
                >
                  Terms
                </Link>{" "}
                and{" "}
                <Link
                  href="/privacy"
                  className="underline underline-offset-[2px]"
                  style={{
                    color: "var(--color-text-muted)",
                    textDecorationColor: "var(--color-border-strong)",
                  }}
                >
                  Privacy Policy
                </Link>.
              </div>

              <SwitchRow>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => { setTab("signin"); resetRegister(); }}
                  className="font-medium underline underline-offset-[3px]"
                  style={{
                    color: "var(--color-text)",
                    textDecorationColor: "var(--color-border-strong)",
                  }}
                >
                  Sign in
                </button>
              </SwitchRow>
            </form>
          ) : (
            // === Step 2: enter the 6-digit code emailed to the user ===
            // Uses inputMode="numeric" + pattern so iOS / Android pop
            // the digit keypad. autoComplete="one-time-code" lets
            // iOS auto-fill from the SMS/email banner shortcut on
            // supported clients (some macOS Mail integrations, plus
            // password managers that watch for OTP fields).
            <form onSubmit={onVerifyCode}>
              <FormHeading>Check your email.</FormHeading>
              <FormSubtitle>
                We sent a 6-digit code to <strong>{pendingEmail}</strong>. Enter
                it below to finish creating your account.
              </FormSubtitle>

              <Field label="Verification code" htmlFor="register-code">
                <Input
                  id="register-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(e) => {
                    // Strip non-digits live so users pasting "1 2 3 4 5 6"
                    // or "123-456" don't have to clean it up.
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                    setVerificationCode(digits);
                    setError(null);
                    setResendNotice(null);
                  }}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  autoFocus
                  required
                  style={{
                    fontSize: "1.25rem",
                    letterSpacing: "0.4em",
                    fontFamily: "var(--font-mono)",
                    textAlign: "center",
                  }}
                />
              </Field>

              {error && <ErrorBox>{error}</ErrorBox>}
              {resendNotice && (
                <div
                  className="mb-4 text-xs rounded-md px-2.5 py-2"
                  style={{
                    color: "var(--color-text-muted)",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  {resendNotice}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full mt-2"
                disabled={submitting || verificationCode.length !== 6}
              >
                {submitting ? "Verifying…" : "Verify & create account"}
              </Button>

              <div
                className="text-center mt-5"
                style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)" }}
              >
                Didn&apos;t receive it?{" "}
                <button
                  type="button"
                  onClick={onResendCode}
                  disabled={resending}
                  className="font-medium underline underline-offset-[3px]"
                  style={{
                    color: resending ? "var(--color-text-subtle)" : "var(--color-text)",
                    textDecorationColor: "var(--color-border-strong)",
                    background: "transparent",
                    border: "none",
                    cursor: resending ? "default" : "pointer",
                    padding: 0,
                    fontFamily: "inherit",
                  }}
                >
                  {resending ? "Resending…" : "Resend code"}
                </button>
              </div>

              <SwitchRow>
                Wrong email?{" "}
                <button
                  type="button"
                  onClick={resetRegister}
                  className="font-medium underline underline-offset-[3px]"
                  style={{
                    color: "var(--color-text)",
                    textDecorationColor: "var(--color-border-strong)",
                  }}
                >
                  Use a different one
                </button>
              </SwitchRow>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Internal helpers — small JSX fragments the form uses repeatedly,
   pulled out for readability.
   ============================================================ */

function TabButton({
  active,
  onClick,
  children,
  disabled = false,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** When true, the tab is shown but unclickable + dimmed. Used for
   *  Register until the real backend lands — the form code is still
   *  in place, just gated behind this flag. */
  disabled?: boolean;
  /** Native title attr — surfaces the "Coming soon" hint on hover. */
  title?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
      className="flex-1 text-center text-[14px] font-medium transition-colors"
      style={{
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--color-bg)" : "transparent",
        color: disabled
          ? "var(--color-text-subtle)"
          : active
          ? "var(--color-text)"
          : "var(--color-text-muted)",
        boxShadow: active ? "0 1px 2px rgba(10,10,10,0.06)" : undefined,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function FormHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-center text-text"
      style={{ fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.02em", marginBottom: "var(--space-2)" }}
    >
      {children}
    </h2>
  );
}

function FormSubtitle({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-center text-text-muted"
      style={{ fontSize: "0.875rem", marginBottom: "var(--space-8)" }}
    >
      {children}
    </p>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-4 text-xs rounded-md px-2.5 py-2"
      style={{
        color: "var(--color-error)",
        background: "rgba(178, 58, 58, 0.06)",
        border: "1px solid rgba(178, 58, 58, 0.2)",
      }}
    >
      {children}
    </div>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--space-3)",
        margin: "var(--space-6) 0",
        fontSize: "0.75rem",
        color: "var(--color-text-subtle)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}
    >
      <span className="flex-1" style={{ height: "1px", background: "var(--color-border)" }} />
      <span>{children}</span>
      <span className="flex-1" style={{ height: "1px", background: "var(--color-border)" }} />
    </div>
  );
}

/** "Continue with Google" — disabled visual stub. The design stays
 *  in place for when real OAuth lands; until then the button is
 *  greyed out + non-clickable + carries a "Coming soon" badge,
 *  matching the Register tab's disabled treatment. Same visual
 *  language tells the user "this is intentionally not yet
 *  available", not "this is broken".
 *
 *  When OAuth is wired up, swap the disabled flag off and re-enable
 *  the onClick handler — visual style returns to normal automatically. */
function GoogleButton() {
  const disabled = true;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? "Google sign-in is coming soon" : undefined}
      className="w-full inline-flex items-center justify-center gap-2 transition-colors"
      style={{
        padding: "11px",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
        borderRadius: "var(--radius-md)",
        fontSize: "0.9375rem",
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "inherit",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
      Continue with Google
      <span
        className="text-[9.5px] font-medium uppercase tracking-wider px-1 py-px rounded ml-1"
        style={{
          color: "var(--color-text-subtle)",
          background: "var(--color-surface-2)",
          letterSpacing: "0.06em",
        }}
      >
        Soon
      </span>
    </button>
  );
}

function SwitchRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-center"
      style={{
        marginTop: "var(--space-6)",
        paddingTop: "var(--space-6)",
        borderTop: "1px solid var(--color-border)",
        fontSize: "0.875rem",
        color: "var(--color-text-muted)",
      }}
    >
      {children}
    </div>
  );
}
