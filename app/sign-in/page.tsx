/**
 * /sign-in — public auth route.
 *
 * Hosts the LoginView centered card (brand mark + name/email form).
 * On successful sign-in, LoginView pushes the router to /app where
 * the protected coaching surface lives. Already-signed-in users
 * visiting /sign-in get bounced straight to /app.
 *
 * This route is the link target for every "Sign in" CTA on the
 * marketing site.
 */
import { LoginView } from "@/components/LoginView";

export default function SignInPage() {
  return <LoginView />;
}
