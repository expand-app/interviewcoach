-- Phase 2 schema for puebulo / interview-coach.
--
-- Mirrors types/session.ts. One row per Session, child rows for
-- Questions / Comments / Utterances / SessionEvents. The Score blob
-- is kept as JSONB on the session row because it has nested
-- Improvement objects and is read/written atomically anyway.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so the migration runner
-- can safely call this on every app boot.

-- =====================================================================
-- users — real auth identity, gated by invitation code at registration.
-- password_hash is bcrypt; nullable so the legacy admin row inserted
-- before bcrypt landed keeps loading. The /api/auth/sign-in endpoint
-- lazy-bootstraps the admin's hash on first sign-in after deploy by
-- comparing against the env-configured ADMIN_PASSWORD.
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent column add for environments that ran the pre-auth schema.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- =====================================================================
-- invitation_codes — admin-issued single-use codes that the register
-- endpoint requires before creating a user row. Codes are not tied to
-- a specific email (the same code can be handed to anyone), but each
-- code can only be redeemed once. After redemption, used_at and
-- used_by point at the user that consumed it — useful for the admin
-- audit view.
-- =====================================================================
CREATE TABLE IF NOT EXISTS invitation_codes (
  code        TEXT PRIMARY KEY,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ,
  used_by     UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invitation_codes_used
  ON invitation_codes(used_at);

-- =====================================================================
-- email_verifications — pending registrations awaiting email-code
-- confirmation. Created by /api/auth/request-verification, consumed
-- by /api/auth/verify-email. The user's password is bcrypt-hashed at
-- request-time so a leaked DB never exposes plaintext, even for
-- registrations the user never completed.
--
-- code_hash is bcrypt(verification code) so a DB read can't reveal
-- live codes. attempts is incremented on each wrong submission; >=5
-- wipes the row and forces a fresh request. expires_at is request_time
-- + 10 min — short enough that abandoned registrations don't accrue.
--
-- One row per email max — a fresh request from the same email
-- overwrites the previous pending row (resets code, attempts, ttl).
-- The invite_code FK isn't enforced (TEXT, not REFERENCES) on purpose:
-- if a code gets deleted server-side, we still want the verify path
-- to fail with "code expired" rather than throwing a constraint
-- error mid-transaction.
-- =====================================================================
CREATE TABLE IF NOT EXISTS email_verifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  code_hash     TEXT NOT NULL,
  invite_code   TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires
  ON email_verifications(expires_at);

-- Add a name column to email_verifications retroactively (legacy
-- environments that ran the schema before we required it). The
-- migration is idempotent — if the column already exists, the ADD
-- COLUMN IF NOT EXISTS short-circuits.
ALTER TABLE email_verifications
  ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';

-- =====================================================================
-- password_resets — pending password resets awaiting email-code
-- confirmation. Created by /api/auth/request-password-reset, consumed
-- by /api/auth/reset-password. Mirrors the email_verifications
-- shape (one row per email, bcrypt-hashed code, 10-min TTL, 5-attempt
-- cap). DOES NOT carry a password_hash — the new password is supplied
-- on the verify-and-reset request, hashed inline, written to users.
-- Why split from email_verifications: that table assumes invite_code
-- and a stored password_hash; password reset has neither, and putting
-- both flows in one table would mean optional columns + a kind
-- discriminator. Cleaner to keep them separate and let each flow's
-- schema match its semantics.
-- =====================================================================
CREATE TABLE IF NOT EXISTS password_resets (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires
  ON password_resets(expires_at);

-- =====================================================================
-- sessions — one row per saved interview session.
-- id stays TEXT (sess-${Date.now()}) so existing client code keeps
-- working without ID translation.
-- speaker_roles is the {dgSpeaker: role} map snapshotted at endLive,
-- needed so PastView can re-resolve utterance roles without re-running
-- speaker identification.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id                            TEXT PRIMARY KEY,
  user_id                       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                         TEXT NOT NULL,
  jd                            TEXT NOT NULL,
  resume                        TEXT NOT NULL DEFAULT '',
  started_at                    TIMESTAMPTZ NOT NULL,
  duration_seconds              INTEGER NOT NULL,
  audio_s3_key                  TEXT,
  video_s3_key                  TEXT,
  jd_summary                    TEXT,
  resume_summary                TEXT,
  interviewer_profile           TEXT,
  interviewer_profile_summary   TEXT,
  speaker_roles                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  score                         JSONB,
  score_error                   TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_started
  ON sessions(user_id, started_at DESC);

-- Phase 3 follow-up: pre-transcoded MOV (h264 + AAC) for instant
-- download. Populated by the server-side background ffmpeg job that
-- runs right after a WebM upload completes. NULL = not transcoded
-- yet OR transcode failed; the Download button falls back to the
-- on-demand /api/uploads/download path in that case (slow but
-- always works).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS video_mov_s3_key TEXT;

-- Backfill score_error for orphan sessions whose score never ran
-- (early closing-prompt race / network blip / page closed
-- pre-scoring). Without this, PastView shows a "Scoring this
-- session…" spinner forever — no code path ever fires the score
-- call again for these rows. Two passes:
--   (1) Empty sessions (duration<10s OR no questions captured) —
--       these will never produce a useful score even on retry.
--   (2) Sessions with content but missing score AND scoreError —
--       these CAN be re-scored; tell the user to click Re-score.
-- Idempotent: WHERE clause excludes rows already marked, so future
-- migration runs touch nothing. New sessions never satisfy this
-- because endLive's pre-flight guard sets score_error explicitly
-- when applicable.
UPDATE sessions
   SET score_error = 'Empty session — no content captured during recording.'
 WHERE score IS NULL
   AND score_error IS NULL
   AND (duration_seconds < 10
        OR id NOT IN (SELECT DISTINCT session_id FROM questions));

UPDATE sessions
   SET score_error = 'Scoring did not complete on this session. Click Re-score to try again.'
 WHERE score IS NULL
   AND score_error IS NULL;

-- =====================================================================
-- questions — Lead and Probe questions, ordered by `position`.
-- parent_question_id NULL = Lead, set = Probe under that Lead.
--
-- kind:
--   'interviewer' (default, omitted on legacy rows) — the standard
--                 case: interviewer asks, candidate answers. answer_text
--                 holds the candidate's response.
--   'candidate'  — REVERSE Q&A: this is a question the CANDIDATE asked
--                 the interviewer (during the "any questions for me?"
--                 phase). answer_text is unused (the interviewer's
--                 verbal answer isn't structured/persisted today).
--                 parent_question_id is always NULL for candidate kind.
--                 Comments under a candidate question carry the AI's
--                 cand-q-cmt commentary on the QUALITY of the question.
-- =====================================================================
CREATE TABLE IF NOT EXISTS questions (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_question_id  TEXT REFERENCES questions(id) ON DELETE CASCADE,
  text                TEXT NOT NULL,
  asked_at_seconds    REAL NOT NULL,
  answer_text         TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'interviewer'
);
CREATE INDEX IF NOT EXISTS idx_questions_session
  ON questions(session_id, position);

-- Idempotent column add for environments that ran the pre-kind schema.
-- Existing rows default to 'interviewer' which is the only kind that
-- existed before this migration.
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'interviewer';

-- =====================================================================
-- comments — AI commentary attached to a question.
-- kind values:
--   'answer'    (default) — Q-A commentary fired while candidate is
--                           answering an interviewer question.
--   'listening' — listening hint fired during interviewer monologue,
--                 attached post-hoc to the first Lead that follows.
--   'cand-q-cmt' — commentary on the QUALITY of a candidate's reverse-
--                 Q&A question. Attached to questions.kind='candidate'.
--                 The text body grades the question; expanded_suggestion
--                 is unused for this kind (no "Try saying X" since the
--                 candidate ALREADY asked something).
-- =====================================================================
CREATE TABLE IF NOT EXISTS comments (
  id                    TEXT PRIMARY KEY,
  question_id           TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text                  TEXT NOT NULL,
  expanded_suggestion   TEXT,
  at_seconds            REAL NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'answer',
  context_text          TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_question
  ON comments(question_id, at_seconds);

-- Idempotent column add — context_text is only populated for
-- listening hints (kind='listening') as of 2026-05. Captures the EXACT
-- interviewer monologue snapshot the AI saw at hint-generation time,
-- so PastView's "Interviewer mentioned …" label is grounded in what
-- the model actually reacted to rather than a guessed time window.
-- Time-window heuristics catch the TAIL of the monologue ("Okay.
-- Yeah.") which is usually filler; the snapshot covers the substantive
-- chunk that triggered the hint.
ALTER TABLE comments
  ADD COLUMN IF NOT EXISTS context_text TEXT;

-- =====================================================================
-- utterances — full transcript log (NOT the rolling 30-entry UI
-- window). Persisted so PastView's Review Panel can show the same
-- captions/log a live session showed. Role is resolved at render
-- time via sessions.speaker_roles[dg_speaker].
-- =====================================================================
CREATE TABLE IF NOT EXISTS utterances (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  dg_speaker  INTEGER,
  text        TEXT NOT NULL,
  at_seconds  REAL NOT NULL,
  duration    REAL,
  position    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utterances_session
  ON utterances(session_id, at_seconds);

-- =====================================================================
-- session_events — debug log events that drive LiveDebugPanel /
-- PastDebugPanel. Schema matches the lib/debug-log.ts wire format
-- (source / event / data) plus a session-relative at_ms.
-- BIGSERIAL because a long session can rack up tens of thousands of
-- events.
-- =====================================================================
CREATE TABLE IF NOT EXISTS session_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- BIGINT (not INTEGER) so post-session server-side events can use
  -- wall-clock Date.now() values (~1.7 trillion = beyond int4 range).
  -- Live-session events stay session-relative (small ms offsets) and
  -- fit fine. Convention: events with at_ms < 1e10 are
  -- session-relative; >= 1e10 are wall-clock UTC ms.
  at_ms       BIGINT NOT NULL,
  source      TEXT NOT NULL,
  event       TEXT NOT NULL,
  data        JSONB
);
-- Idempotent retro-fix for existing installs created before the
-- BIGINT widening landed (when at_ms was INTEGER). NOOP on databases
-- that were created fresh against the BIGINT schema above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'session_events'
      AND column_name = 'at_ms'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE session_events ALTER COLUMN at_ms TYPE BIGINT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id, at_ms);

-- =====================================================================
-- session_shares — admin-minted public share tokens for cross-system
-- session import. The token is unguessable (192 bits of entropy via
-- generateShareToken) so it acts as both URL handle AND auth — the
-- public /api/share/[token] endpoint requires no other credentials.
--
-- Idempotent share creation: the admin POST endpoint returns the
-- existing live row if one already exists, rather than minting a
-- second token for the same session. The partial unique index below
-- enforces that at the DB level (one active token per session at most).
--
-- Revocation is soft (revoked_at timestamp set, row kept) so /api/share
-- can return a meaningful 410 instead of an opaque 404, and so admins
-- can audit who minted what when. ON DELETE CASCADE on session_id +
-- created_by means deleting a session or user cleans up its shares.
-- =====================================================================
CREATE TABLE IF NOT EXISTS session_shares (
  token       TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
-- One active (non-revoked) token per session. Lets the share-creation
-- endpoint do an idempotent SELECT-then-INSERT without race conditions
-- (the unique constraint catches concurrent inserts and falls back to
-- returning the existing row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_shares_session_active
  ON session_shares(session_id) WHERE revoked_at IS NULL;
