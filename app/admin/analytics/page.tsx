"use client";

/**
 * /admin/analytics — admin overview of registrations, usage, and
 * recordings.
 *
 * Sections (top to bottom):
 *   1. KPI grid — headline numbers (users, sessions, recording time,
 *      score health, invitations)
 *   2. 30-day activity — sessions per day + new users per day, mini
 *      bar charts so the admin spots trends at a glance
 *   3. Recent sessions — last 100 sessions across all users, click
 *      through to the per-session debug page
 *   4. All users — sortable list with usage aggregates + invite code
 *
 * Auth: server enforces admin via x-user-id → email check. The page
 * itself relies on the same hasHydrated gate as /admin/invitations.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { BrandLockup } from "@/components/ui";
import { ModalShell } from "@/components/modals/ModalShell";

interface OverviewKpis {
  totalUsers: number;
  newUsers7d: number;
  newUsers30d: number;
  totalSessions: number;
  sessions7d: number;
  sessions30d: number;
  totalRecordingMinutes: number;
  avgSessionDurationSec: number;
  scoredSessions: number;
  failedScoreSessions: number;
  unscoredSessions: number;
  sessionsWithAudio: number;
  sessionsWithVideo: number;
  pendingInvites: number;
  redeemedInvites: number;
}
interface DailyActivityRow {
  date: string;
  sessions: number;
  newUsers: number;
}
interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  totalSessions: number;
  totalMinutes: number;
  lastSessionAt: string | null;
  inviteCode: string | null;
}
interface SessionRow {
  id: string;
  title: string;
  startedAt: string;
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  scoreState: "scored" | "failed" | "unscored";
  scoreError: string | null;
  questionCount: number;
  user: { id: string; email: string; name: string };
}

export default function AdminAnalyticsPage() {
  const router = useRouter();
  const user = useStore((s) => s.user);
  const userId = user?.userId;

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace("/sign-in");
  }, [hydrated, user, router]);

  const [kpis, setKpis] = useState<OverviewKpis | null>(null);
  const [dailyActivity, setDailyActivity] = useState<DailyActivityRow[]>([]);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Free-text search box above Recent Sessions. Filters client-side
  // across title + user.name + user.email so a single typo-tolerant
  // query catches "Goldman", "wilson@", or "Augury" alike. Empty
  // string = no filter.
  const [sessionSearch, setSessionSearch] = useState("");
  // Include admin's own data in the analytics. Default false (mirrors
  // historical "exclude admin" behavior). When toggled ON the admin's
  // KPI / sessions / users rows are added back into all three lists
  // — useful for verifying behaviors on the admin's own seeded
  // sessions without spinning up a second account.
  const [includeAdmin, setIncludeAdmin] = useState(false);
  // Active tab below the KPI strip. Default to "sessions" — the most
  // common landing destination is "what just got recorded". Stacking
  // all three sections vertically (the previous layout) made the
  // page scroll-heavy without payoff; tabs put each view one click
  // away while keeping the URL clean.
  const [activeTab, setActiveTab] = useState<
    "sessions" | "users" | "activity"
  >("sessions");
  // Daily-activity drill-down modal. Click a row's Sessions or New
  // Users count → opens this modal with the matching list filtered
  // to that single day. Stays null when nothing is open.
  const [dailyDetail, setDailyDetail] = useState<{
    kind: "sessions" | "users";
    date: string;
  } | null>(null);

  useEffect(() => {
    if (!hydrated || !userId) return;
    void loadAll(userId);
    // Re-fire when the admin toggles include/exclude — server reads
    // the includeAdmin query param to decide whether to filter.
  }, [hydrated, userId, includeAdmin]);

  async function loadAll(uid: string) {
    setError(null);
    try {
      // Three parallel fetches — server queries are independent. Total
      // wall time bound by the slowest (sessions detail join).
      const headers = { "x-user-id": uid };
      const q = includeAdmin ? "?includeAdmin=1" : "";
      const [overviewRes, usersRes, sessionsRes] = await Promise.all([
        fetch(`/api/admin/analytics/overview${q}`, {
          headers,
          cache: "no-store",
        }),
        fetch(`/api/admin/analytics/users${q}`, {
          headers,
          cache: "no-store",
        }),
        fetch(`/api/admin/analytics/sessions${q}`, {
          headers,
          cache: "no-store",
        }),
      ]);
      if (overviewRes.status === 403) {
        setError(
          "This page is admin-only. Sign in with the admin account."
        );
        return;
      }
      if (!overviewRes.ok || !usersRes.ok || !sessionsRes.ok) {
        setError("Couldn't load analytics. See browser console for details.");
        return;
      }
      const overviewData = (await overviewRes.json()) as {
        kpis: OverviewKpis;
        dailyActivity: DailyActivityRow[];
      };
      const usersData = (await usersRes.json()) as { users: UserRow[] };
      const sessionsData = (await sessionsRes.json()) as {
        sessions: SessionRow[];
      };
      setKpis(overviewData.kpis);
      setDailyActivity(overviewData.dailyActivity);
      setUsers(usersData.users);
      setSessions(sessionsData.sessions);
    } catch (e) {
      console.warn("[analytics] load failed:", e);
      setError("Network error loading analytics.");
    }
  }

  if (!hydrated) return null;
  if (!user) return null;

  return (
    <>
      {/* Same signed-in app header as /admin/invitations. Logo →
          /app, Back-to-app on the right; no marketing nav, no sign
          in CTA. */}
      <header
        className="sticky top-0 z-50 border-b border-border"
        style={{
          height: "60px",
          background: "rgba(255, 255, 255, 0.8)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="container mx-auto h-full flex items-center justify-between gap-6 px-6 max-w-[1280px]">
          <Link href="/app" aria-label="Back to app">
            <BrandLockup size={26} />
          </Link>
          <Link
            href="/app"
            className="text-sm text-text-muted hover:text-text"
          >
            ← Back to app
          </Link>
        </div>
      </header>
      <div
        style={{
          minHeight: "calc(100vh - 60px)",
          padding: "var(--space-12) var(--space-6) var(--space-16)",
          background: "var(--color-surface)",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          {/* Page heading. The "Invitations →" link that used to sit
              on the right was redundant — the same destination is one
              click away in the sidebar user-menu (Generate Invitation
              Code), and removing the duplicate frees the row to
              breathe as a single-column heading. */}
          <div className="mb-8">
            <h1
              style={{
                fontSize: "1.75rem",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                lineHeight: 1.2,
                marginBottom: 6,
              }}
            >
              Admin Portal
            </h1>
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <p
                className="text-text-muted"
                style={{ fontSize: "0.9375rem", lineHeight: 1.5 }}
              >
                Registration, usage, and per-session debug info.
              </p>
              {/* Include / Exclude admin toggle. Subtle text-style
                  control — fits the section header without competing
                  with KPI cards visually. Re-fires loadAll on flip. */}
              <label
                className="inline-flex items-center gap-2 text-[12.5px] text-text-muted cursor-pointer select-none"
                title="Toggles whether the admin account's own sessions / users data are included in the lists below."
              >
                <input
                  type="checkbox"
                  checked={includeAdmin}
                  onChange={(e) => setIncludeAdmin(e.target.checked)}
                  className="cursor-pointer"
                />
                Include admin account
              </label>
            </div>
          </div>

          {error && (
            <div
              className="mb-6 text-xs rounded-md px-3 py-2"
              style={{
                color: "var(--color-error)",
                background: "rgba(178, 58, 58, 0.06)",
                border: "1px solid rgba(178, 58, 58, 0.2)",
              }}
            >
              {error}
            </div>
          )}

          {/* === KPI grid === */}
          <KpiGrid kpis={kpis} />

          {/* === Tab navigation === */}
          {/* Three tabs: Sessions / Users / Activity. The previous
              layout stacked all three sections vertically, making the
              page scroll forever. Tabs collapse it to one panel
              visible at a time, while keeping each section a single
              click away. Tab styling is the underline-active pattern
              used by Linear / Notion / Stripe Dashboard — minimal
              chrome, lets the data below be the focus. */}
          <div
            className="flex items-end gap-6 border-b border-border"
            style={{ marginBottom: "var(--space-6)" }}
          >
            <TabButton
              active={activeTab === "sessions"}
              onClick={() => setActiveTab("sessions")}
              label="Recent sessions"
              count={sessions?.length}
            />
            <TabButton
              active={activeTab === "users"}
              onClick={() => setActiveTab("users")}
              label="All users"
              count={users?.length}
            />
            <TabButton
              active={activeTab === "activity"}
              onClick={() => setActiveTab("activity")}
              label="Daily activity"
            />
          </div>

          {/* === Active tab panel === */}
          {activeTab === "sessions" && (
            <>
              {/* Search row — own row above the table. Padding /
                  margin tuned so it sits visibly inside the section
                  panel rather than running flush against the tab
                  underline above. */}
              <div
                className="flex items-center gap-3"
                style={{
                  marginBottom: "var(--space-4)",
                }}
              >
                {sessions && (
                  <span
                    className="text-text-subtle"
                    style={{ fontSize: "0.8125rem" }}
                  >
                    {filterSessions(sessions, sessionSearch).length}
                    {sessionSearch ? ` of ${sessions.length}` : ""} sessions
                  </span>
                )}
                <div className="ml-auto" style={{ width: 320, maxWidth: "50%" }}>
                  <input
                    type="search"
                    value={sessionSearch}
                    onChange={(e) => setSessionSearch(e.target.value)}
                    placeholder="Search title, name, or email…"
                    className="border border-border bg-bg w-full"
                    style={{
                      padding: "8px 12px",
                      borderRadius: "var(--radius-md)",
                      fontSize: "0.875rem",
                      fontFamily: "inherit",
                    }}
                  />
                </div>
              </div>
              <SessionsTable
                sessions={
                  sessions === null
                    ? null
                    : filterSessions(sessions, sessionSearch)
                }
                emptyMessage={
                  sessions && sessions.length > 0 && sessionSearch
                    ? `No sessions match "${sessionSearch}".`
                    : undefined
                }
              />
            </>
          )}

          {activeTab === "users" && <UsersTable users={users} />}

          {activeTab === "activity" && (
            <DailyActivityTable
              rows={dailyActivity}
              loading={kpis === null}
              onDrillDown={(kind, date) => setDailyDetail({ kind, date })}
            />
          )}

          {/* === Daily-activity drill-down modal === */}
          {dailyDetail && (
            <DailyDetailModal
              kind={dailyDetail.kind}
              date={dailyDetail.date}
              sessions={sessions || []}
              users={users || []}
              onClose={() => setDailyDetail(null)}
            />
          )}
        </div>
      </div>
    </>
  );
}

/* ============================================================
   KPI grid
   ============================================================ */
function KpiGrid({ kpis }: { kpis: OverviewKpis | null }) {
  // Six cards, designed to land in a single 6-across row at laptop
  // widths (>=1080px container) and break to 3-across / 2-across on
  // smaller screens. Earlier we used minmax(200px, 1fr) which left
  // an awkward 5+1 layout at ~1200px — auto-fit dropped the 6th
  // card to a second row because the math was a hair short. 160px
  // min is the sweet spot: at the page's max-width 1200, the grid
  // computes 6 × ~190px with 5 × 12px gaps and fits cleanly.
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
    marginBottom: "var(--space-8)",
  };

  if (!kpis) {
    return (
      <div style={gridStyle}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  const total = kpis.totalSessions;
  const totalInvites = kpis.redeemedInvites + kpis.pendingInvites;
  const cards: Array<{
    label: string;
    value: string;
    sub?: string;
  }> = [
    {
      label: "Users",
      value: kpis.totalUsers.toString(),
      sub: `+${kpis.newUsers7d} this week · +${kpis.newUsers30d} 30d`,
    },
    {
      label: "Sessions",
      value: kpis.totalSessions.toString(),
      sub: `${kpis.sessions7d} this week · ${kpis.sessions30d} 30d`,
    },
    {
      label: "Recording time",
      value: formatHoursMinutes(kpis.totalRecordingMinutes),
      sub: `avg ${formatDuration(kpis.avgSessionDurationSec)}/session`,
    },
    // Score health: headline = scored/total fraction so the big
    // number reads as "22 of 81 succeeded" instead of a context-less
    // "22". Sub keeps the failed/unscored breakdown for triage.
    {
      label: "Score health",
      value: total > 0 ? `${kpis.scoredSessions} / ${total}` : "0",
      sub: `${kpis.failedScoreSessions} failed · ${kpis.unscoredSessions} unscored`,
    },
    // Recordings: same fraction pattern. Headline tracks video
    // (primary playback medium); sub shows audio + video counts so
    // the admin can spot the audio-only-but-no-video sessions.
    {
      label: "Recordings on S3",
      value:
        total > 0 ? `${kpis.sessionsWithVideo} / ${total}` : "0",
      sub: `audio ${kpis.sessionsWithAudio} · video ${kpis.sessionsWithVideo}`,
    },
    {
      label: "Invitations",
      value:
        totalInvites > 0
          ? `${kpis.redeemedInvites} / ${totalInvites}`
          : "0",
      sub: `${kpis.pendingInvites} unused`,
    },
  ];
  return (
    <div style={gridStyle}>
      {cards.map((c) => (
        <KpiCard key={c.label} label={c.label} value={c.value} sub={c.sub} />
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      className="bg-bg border border-border"
      style={{
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-6)",
      }}
    >
      <div
        className="text-text-subtle"
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.625rem",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="text-text-muted"
          style={{
            fontSize: "0.75rem",
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function KpiCardSkeleton() {
  return (
    <div
      className="bg-bg border border-border"
      style={{
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-6)",
        height: 96,
      }}
    >
      <div
        style={{
          width: 60,
          height: 10,
          background: "var(--color-surface-2)",
          borderRadius: 4,
          marginBottom: 12,
        }}
      />
      <div
        style={{
          width: 100,
          height: 22,
          background: "var(--color-surface-2)",
          borderRadius: 4,
        }}
      />
    </div>
  );
}

/* ============================================================
   Daily activity table — replaces the previous bar chart with a
   straightforward "date | sessions | new users" list. The chart was
   visually pretty but hard to read exact daily counts off; for an
   admin who actually wants to know "how many sessions happened on
   May 3", numbers in a row are far more useful. Sorted most-recent
   first to put the meaningful days at the top.
   ============================================================ */
function DailyActivityTable({
  rows,
  loading,
  onDrillDown,
}: {
  rows: DailyActivityRow[];
  loading: boolean;
  /** Click handler for the Sessions / New users count cells. Only
   *  fires when the count > 0 (zero counts render as plain dim text,
   *  not interactive). */
  onDrillDown: (kind: "sessions" | "users", date: string) => void;
}) {
  if (loading) {
    return (
      <div
        className="bg-bg border border-border"
        style={{
          borderRadius: "var(--radius-lg)",
          height: 240,
          marginBottom: "var(--space-2)",
        }}
      />
    );
  }
  if (rows.length === 0) return null;
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
  const totalNewUsers = rows.reduce((s, r) => s + r.newUsers, 0);
  return (
    <div
      className="bg-bg border border-border"
      style={{
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.875rem",
          }}
        >
          <thead>
            <tr style={{ background: "var(--color-surface)" }}>
              <Th>Date</Th>
              <Th>Sessions</Th>
              <Th>New users</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const isQuiet = d.sessions === 0 && d.newUsers === 0;
              return (
                <tr
                  key={d.date}
                  style={{
                    borderTop: "1px solid var(--color-border)",
                    opacity: isQuiet ? 0.5 : 1,
                  }}
                >
                  <Td>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {fmtFullDate(d.date)}
                    </span>
                  </Td>
                  <Td>
                    <CountCell
                      count={d.sessions}
                      onClick={() => onDrillDown("sessions", d.date)}
                    />
                  </Td>
                  <Td>
                    <CountCell
                      count={d.newUsers}
                      onClick={() => onDrillDown("users", d.date)}
                    />
                  </Td>
                </tr>
              );
            })}
            {/* Footer total row — totals over the visible window. */}
            <tr
              style={{
                borderTop: "1px solid var(--color-border)",
                background: "var(--color-surface)",
              }}
            >
              <Td>
                <span
                  className="text-text-subtle"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  30-day total
                </span>
              </Td>
              <Td>
                <strong>{totalSessions}</strong>
              </Td>
              <Td>
                <strong>{totalNewUsers}</strong>
              </Td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   Daily-detail modal — shown when the user clicks a count cell in
   the Daily activity table. Filters the already-loaded sessions/
   users lists by the clicked date and renders a compact list inside
   ModalShell's xwide variant.

   No new API call: the analytics page already loaded the full
   sessions + users arrays (capped at 100 / 200 respectively, plenty
   for any single day's signup or session volume in the alpha).
   ============================================================ */
function DailyDetailModal({
  kind,
  date,
  sessions,
  users,
  onClose,
}: {
  kind: "sessions" | "users";
  date: string;
  sessions: SessionRow[];
  users: UserRow[];
  onClose: () => void;
}) {
  const matched =
    kind === "sessions"
      ? sessions.filter((s) => s.startedAt.slice(0, 10) === date)
      : users.filter((u) => u.createdAt.slice(0, 10) === date);

  const heading =
    kind === "sessions"
      ? `Sessions on ${fmtFullDate(date)}`
      : `New users on ${fmtFullDate(date)}`;

  return (
    <ModalShell open onClose={onClose} variant="xwide">
      <div style={{ padding: "var(--space-6) var(--space-6)" }}>
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2
              style={{
                fontSize: "1.0625rem",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                marginBottom: 2,
              }}
            >
              {heading}
            </h2>
            <div
              className="text-text-muted"
              style={{ fontSize: "0.8125rem" }}
            >
              {matched.length} {kind === "sessions" ? "session" : "user"}
              {matched.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 6,
              color: "var(--color-text-muted)",
              lineHeight: 1,
              fontSize: 18,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        {matched.length === 0 ? (
          <p
            className="text-text-muted text-sm"
            style={{ padding: "var(--space-6) 0" }}
          >
            Nothing recorded for this day.
          </p>
        ) : kind === "sessions" ? (
          <DailySessionsList
            sessions={matched as SessionRow[]}
            onClose={onClose}
          />
        ) : (
          <DailyUsersList users={matched as UserRow[]} />
        )}
      </div>
    </ModalShell>
  );
}

function DailySessionsList({
  sessions,
  onClose,
}: {
  sessions: SessionRow[];
  /** Modal closes after navigation kicks in (the next page mount
   *  unmounts this anyway, but explicitly closing avoids a brief
   *  flash of the modal still rendered over the new route). */
  onClose: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        // overflow-x:auto so very long emails / titles get a horizontal
        // scrollbar instead of clipping the rightmost "Open" cell.
        // The xwide modal (880px) already fits the typical row, but
        // narrow viewports (max-w-[92vw] caps the modal at 92% of
        // the screen) might still benefit from horizontal scroll.
        overflow: "auto",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.8125rem",
          // tableLayout fixed lets us assign explicit column widths
          // via colgroup so long content (email addresses, titles)
          // truncates instead of expanding the table past its
          // container. Without it, the email column was forcing the
          // table to overflow and clipping the rightmost Open link.
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: 80 }} />
          <col style={{ width: 220 }} />
          <col />
          <col style={{ width: 90 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 70 }} />
        </colgroup>
        <thead>
          <tr style={{ background: "var(--color-surface)" }}>
            <Th>Time</Th>
            <Th>Title</Th>
            <Th>User</Th>
            <Th>Duration</Th>
            <Th>Score</Th>
            <Th>Open</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr
              key={s.id}
              style={{ borderTop: "1px solid var(--color-border)" }}
            >
              <Td>
                <span
                  className="text-text-muted"
                  style={{ whiteSpace: "nowrap" }}
                >
                  {fmtTime(s.startedAt)}
                </span>
              </Td>
              <Td>
                <span
                  title={s.title}
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title || <span className="text-text-subtle">—</span>}
                </span>
              </Td>
              <Td>
                <div
                  style={{
                    lineHeight: 1.3,
                    minWidth: 0,
                    overflow: "hidden",
                  }}
                >
                  <div
                    title={s.user.name}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.user.name}
                  </div>
                  <div
                    title={s.user.email}
                    className="text-text-subtle"
                    style={{
                      fontSize: "0.6875rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.user.email}
                  </div>
                </div>
              </Td>
              <Td>
                <span style={{ whiteSpace: "nowrap" }}>
                  {formatDuration(s.durationSeconds)}
                </span>
              </Td>
              <Td>
                <ScoreBadge state={s.scoreState} />
              </Td>
              <Td>
                <Link
                  href={`/admin/analytics/sessions/${s.id}`}
                  onClick={onClose}
                  className="font-medium underline underline-offset-2"
                  style={{
                    color: "var(--color-text)",
                    textDecorationColor: "var(--color-border-strong)",
                    fontSize: "0.75rem",
                  }}
                >
                  Open
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DailyUsersList({ users }: { users: UserRow[] }) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        overflow: "auto",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.8125rem",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: 140 }} />
          <col />
          <col style={{ width: 80 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 160 }} />
        </colgroup>
        <thead>
          <tr style={{ background: "var(--color-surface)" }}>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Joined</Th>
            <Th>Sessions</Th>
            <Th>Invite</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              style={{ borderTop: "1px solid var(--color-border)" }}
            >
              <Td>
                <span
                  title={u.name}
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.name}
                </span>
              </Td>
              <Td>
                <span
                  title={u.email}
                  className="text-text-muted"
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.email}
                </span>
              </Td>
              <Td>
                <span style={{ whiteSpace: "nowrap" }}>
                  {fmtTime(u.createdAt)}
                </span>
              </Td>
              <Td>{u.totalSessions}</Td>
              <Td>
                <code
                  title={u.inviteCode || ""}
                  className="text-text-subtle"
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6875rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {u.inviteCode || "—"}
                </code>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders a count cell that's clickable when count > 0. Zero counts
 *  render as plain text (no underline / pointer / button). The active
 *  state uses an underline on the number so it visually reads as a
 *  link without taking up extra space — important since the column
 *  is narrow. */
function CountCell({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  if (count === 0) {
    return <span>0</span>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:text-text"
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        color: "var(--color-text)",
        textDecoration: "underline",
        textDecorationColor: "var(--color-border-strong)",
        textUnderlineOffset: 3,
      }}
    >
      {count}
    </button>
  );
}

/** Client-side filter for the Recent sessions table. Case-insensitive
 *  substring match across title, user.name, user.email. The session
 *  id is intentionally NOT searched — it's an opaque hash, the admin
 *  is unlikely to type one. */
function filterSessions(
  sessions: SessionRow[],
  query: string
): SessionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => {
    const hay =
      `${s.title}\n${s.user.name}\n${s.user.email}`.toLowerCase();
    return hay.includes(q);
  });
}

/* ============================================================
   Tab button — underline-active pattern. Inactive tabs use the muted
   text color; active gets the full text color plus a 2px black
   underline that lines up with the row's bottom border.
   ============================================================ */
function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      style={{
        background: "transparent",
        border: "none",
        padding: "10px 0",
        // Negative margin pulls the underline down so it sits ON the
        // parent's border-bottom (rather than 1px above it). Visual
        // result: the active tab "carries" the row's border itself.
        marginBottom: -1,
        borderBottom: active
          ? "2px solid var(--color-text)"
          : "2px solid transparent",
        fontSize: "0.9375rem",
        fontWeight: 500,
        fontFamily: "inherit",
        color: active ? "var(--color-text)" : "var(--color-text-muted)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        transition: "color 120ms ease",
      }}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className="text-text-subtle"
          style={{ fontSize: "0.8125rem", fontWeight: 400 }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ============================================================
   Sessions table
   ============================================================ */
function SessionsTable({
  sessions,
  emptyMessage,
}: {
  sessions: SessionRow[] | null;
  /** Override for the empty state — used to surface "no matches"
   *  when the user has typed a search query that filtered everyone
   *  out, distinct from the truly-no-data state. */
  emptyMessage?: string;
}) {
  return (
    <div
      className="bg-bg border border-border"
      style={{
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      {sessions === null ? (
        <p
          className="text-sm text-text-muted"
          style={{ padding: "var(--space-6) var(--space-6)" }}
        >
          Loading…
        </p>
      ) : sessions.length === 0 ? (
        <p
          className="text-sm text-text-muted"
          style={{ padding: "var(--space-6) var(--space-6)" }}
        >
          {emptyMessage || "No sessions yet."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.875rem",
              minWidth: 880,
            }}
          >
            <thead>
              <tr style={{ background: "var(--color-surface)" }}>
                <Th>Started</Th>
                <Th>Title</Th>
                <Th>User</Th>
                <Th>Duration</Th>
                <Th>Q&apos;s</Th>
                <Th>Recording</Th>
                <Th>Score</Th>
                <Th>Debug</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <Td>
                    <span className="text-text-muted" style={{ whiteSpace: "nowrap" }}>
                      {fmtDateTime(s.startedAt)}
                    </span>
                  </Td>
                  <Td>
                    {/* Native browser tooltip via title attr — hovering
                        a truncated cell surfaces the full title without
                        custom popover infrastructure. Same pattern the
                        modal's session list already uses. */}
                    <span
                      title={s.title}
                      style={{ display: "block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {s.title || <span className="text-text-subtle">—</span>}
                    </span>
                  </Td>
                  <Td>
                    <div style={{ lineHeight: 1.3 }}>
                      <div>{s.user.name}</div>
                      <div className="text-text-subtle" style={{ fontSize: "0.75rem" }}>
                        {s.user.email}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {formatDuration(s.durationSeconds)}
                    </span>
                  </Td>
                  <Td>{s.questionCount}</Td>
                  <Td>
                    <RecordingBadges hasAudio={s.hasAudio} hasVideo={s.hasVideo} />
                  </Td>
                  <Td>
                    <ScoreBadge state={s.scoreState} />
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/analytics/sessions/${s.id}`}
                      className="font-medium underline underline-offset-2"
                      style={{
                        color: "var(--color-text)",
                        textDecorationColor: "var(--color-border-strong)",
                        fontSize: "0.8125rem",
                      }}
                    >
                      Open
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecordingBadges({
  hasAudio,
  hasVideo,
}: {
  hasAudio: boolean;
  hasVideo: boolean;
}) {
  return (
    <div className="flex gap-1">
      <Pill on={hasAudio} label="A" />
      <Pill on={hasVideo} label="V" />
    </div>
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 18,
        borderRadius: 4,
        fontSize: "0.6875rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        color: on ? "var(--color-bg)" : "var(--color-text-subtle)",
        background: on ? "var(--color-text)" : "var(--color-surface-2)",
      }}
    >
      {label}
    </span>
  );
}

function ScoreBadge({ state }: { state: SessionRow["scoreState"] }) {
  const styles: Record<
    SessionRow["scoreState"],
    { bg: string; color: string; text: string }
  > = {
    scored: {
      bg: "rgba(46, 125, 50, 0.1)",
      color: "rgb(46, 125, 50)",
      text: "scored",
    },
    failed: {
      bg: "rgba(178, 58, 58, 0.08)",
      color: "var(--color-error)",
      text: "failed",
    },
    unscored: {
      bg: "var(--color-surface-2)",
      color: "var(--color-text-subtle)",
      text: "—",
    },
  };
  const s = styles[state];
  return (
    <span
      style={{
        fontSize: "0.6875rem",
        fontWeight: 500,
        padding: "2px 8px",
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {s.text}
    </span>
  );
}

/* ============================================================
   Users table
   ============================================================ */
function UsersTable({ users }: { users: UserRow[] | null }) {
  return (
    <div
      className="bg-bg border border-border"
      style={{
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      {users === null ? (
        <p
          className="text-sm text-text-muted"
          style={{ padding: "var(--space-6) var(--space-6)" }}
        >
          Loading…
        </p>
      ) : users.length === 0 ? (
        <p
          className="text-sm text-text-muted"
          style={{ padding: "var(--space-6) var(--space-6)" }}
        >
          No users yet.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.875rem",
              minWidth: 760,
            }}
          >
            <thead>
              <tr style={{ background: "var(--color-surface)" }}>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Joined</Th>
                <Th>Sessions</Th>
                <Th>Time</Th>
                <Th>Last active</Th>
                <Th>Invite</Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <Td>{u.name}</Td>
                  <Td>
                    <span className="text-text-muted">{u.email}</span>
                  </Td>
                  <Td>
                    <span style={{ whiteSpace: "nowrap" }}>{fmtDate(u.createdAt)}</span>
                  </Td>
                  <Td>{u.totalSessions}</Td>
                  <Td>
                    <span style={{ whiteSpace: "nowrap" }}>
                      {formatHoursMinutes(u.totalMinutes)}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-text-muted" style={{ whiteSpace: "nowrap" }}>
                      {u.lastSessionAt ? fmtDateTime(u.lastSessionAt) : "—"}
                    </span>
                  </Td>
                  <Td>
                    <code
                      className="text-text-subtle"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.75rem",
                      }}
                    >
                      {u.inviteCode || "—"}
                    </code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Shared cell helpers
   ============================================================ */
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "11px 16px",
        fontWeight: 600,
        fontSize: "0.6875rem",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--color-text-subtle)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "13px 16px",
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

/* ============================================================
   Formatters
   ============================================================ */
function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
function fmtFullDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
/** HH:MM only — used in the daily-detail modal where the date is
 *  already shown in the heading, so each row only needs the time. */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
function formatDuration(sec: number): string {
  if (!sec) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m`;
}
function formatHoursMinutes(minutes: number): string {
  if (!minutes) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hrs}h ${rem}m`;
}
