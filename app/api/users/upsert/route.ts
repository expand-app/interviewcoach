import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";

export const runtime = "nodejs";

interface Body {
  email?: string;
  name?: string;
}

/**
 * Called by LoginView after the client-side credential check passes.
 * Inserts a row in `users` if this email is new, or returns the
 * existing row's id. The client stashes the returned userId and
 * sends it in `x-user-id` on every subsequent API call.
 */
export async function POST(req: Request) {
  if (!isDbConfigured()) {
    // Local dev without a DB. Returning 503 lets the client fall
    // back to its localStorage-only path without silently corrupting
    // server state.
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim() || email || "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const r = await query<{ id: string; email: string; name: string }>(
    `INSERT INTO users (email, name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, email, name`,
    [email, name]
  );
  const row = r.rows[0];
  return NextResponse.json({ userId: row.id, email: row.email, name: row.name });
}
