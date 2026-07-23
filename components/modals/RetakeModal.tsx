"use client";

import { useState, useEffect } from "react";
import { ModalShell } from "./ModalShell";
import { Button, Field, Textarea } from "@/components/ui";
import { useTranslations } from "@/lib/i18n";
import type { Session } from "@/types/session";
import type { RetakePlan } from "@/app/api/retake/plan/route";

interface Props {
  open: boolean;
  /** Fully-loaded original session (page awaits loadPastSession before
   *  opening — the sidebar list item has no questions). */
  parent: Session | null;
  onCancel: () => void;
  /** Plan generated + user confirmed — page starts the mock call. */
  onStart: (args: { plan: RetakePlan; resume: string }) => void;
}

/**
 * Pre-start modal for the Retake (AI mock interview) flow.
 *
 * The JD and interviewer context carry over from the original session
 * unchanged (read-only here). The resume is editable — re-practicing
 * with an updated resume is a core use case. "Generate & start" runs
 * /api/retake/plan (one Sonnet call, ~5-10s) and only hands off to
 * the call view once a structurally valid plan exists.
 */
export function RetakeModal({ open, parent, onCancel, onStart }: Props) {
  const t = useTranslations();
  const [resume, setResume] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [jdExpanded, setJdExpanded] = useState(false);
  // Two-step flow: Generate (slow, 5-10s Sonnet call) → separate
  // "Start interview" click. The second click is NOT just UX — the
  // browser's autoplay policy requires a FRESH user gesture right
  // before the AudioContexts + mic/camera acquisition happen, or the
  // whole audio graph can come up suspended (silent mic, silent TTS).
  const [plan, setPlan] = useState<RetakePlan | null>(null);

  useEffect(() => {
    if (open) {
      setResume(parent?.resume ?? "");
      setGenerating(false);
      setError("");
      setJdExpanded(false);
      setPlan(null);
    }
  }, [open, parent]);

  const leadCount =
    parent?.questions.filter(
      (q) => !q.parentQuestionId && q.kind !== "candidate"
    ).length ?? 0;
  const canStart = !!parent && leadCount > 0 && !generating;

  const handleGenerate = async () => {
    if (!parent) return;
    setGenerating(true);
    setError("");
    try {
      const r = await fetch("/api/retake/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jd: parent.jd,
          resume: resume.trim(),
          interviewerProfileSummary: parent.interviewerProfileSummary,
          originalQuestions: parent.questions.map((q) => ({
            id: q.id,
            text: q.text,
            parentQuestionId: q.parentQuestionId,
            kind: q.kind,
            answerText: q.answerText,
          })),
        }),
      });
      const data = (await r.json()) as { plan?: RetakePlan; error?: string };
      if (!r.ok || !data.plan) {
        throw new Error(data.error || `plan generation failed (${r.status})`);
      }
      // Hold the plan; the user's NEXT click ("Start interview")
      // hands off — that click is the fresh gesture the audio
      // pipeline needs.
      setPlan(data.plan);
      setGenerating(false);
    } catch (e) {
      setError(
        e instanceof Error && /failed \(4\d\d\)/.test(e.message)
          ? e.message
          : t(
              "Couldn't generate the interview — try again.",
              "生成面试失败——请重试。"
            )
      );
      setGenerating(false);
    }
  };

  return (
    <ModalShell open={open} onClose={generating ? () => {} : onCancel} variant="wide">
      <div className="px-8 py-6">
        <h2
          className="text-text mb-2"
          style={{
            fontSize: "1.25rem",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.25,
          }}
        >
          {t("Retake this interview", "重练这场面试")}
        </h2>
        <p
          className="text-text-muted leading-relaxed mb-5"
          style={{ fontSize: "0.8125rem" }}
        >
          {t(
            "An AI interviewer will run a mock interview mirroring the structure of",
            "AI 面试官将模拟这场面试的结构与题型:"
          )}{" "}
          <span className="font-medium text-text">
            {parent?.title ?? "…"}
          </span>
          {t(
            " — similar questions, new wording. Coaching runs silently; you'll see comments and your score after the call.",
            " ——相似的问题、全新的措辞。教练全程静默,通话结束后可查看点评与评分。"
          )}
        </p>

        {/* JD carried over, read-only + collapsible. */}
        <div className="rounded-md border border-border bg-surface mb-4 px-3 py-2.5">
          <button
            className="w-full flex items-center justify-between text-left"
            onClick={() => setJdExpanded((v) => !v)}
          >
            <span
              className="font-medium text-text"
              style={{ fontSize: "0.8125rem" }}
            >
              {t("Job Description (unchanged)", "职位描述(沿用原面试)")}
            </span>
            <span className="text-text-subtle text-[11px]">
              {jdExpanded ? t("Hide", "收起") : t("Show", "展开")}
            </span>
          </button>
          {jdExpanded && (
            <p
              className="text-text-muted mt-2 whitespace-pre-wrap max-h-40 overflow-y-auto"
              style={{ fontSize: "0.75rem", lineHeight: 1.5 }}
            >
              {parent?.jd}
            </p>
          )}
        </div>

        <Field label={t("Your Resume", "你的简历")} optional>
          <Textarea
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder={t(
              "Update your resume if it changed — prefilled from the original session.",
              "简历有更新可在此修改——已预填原面试使用的版本。"
            )}
            style={{ minHeight: "96px" }}
            disabled={generating}
          />
        </Field>

        <p
          className="text-text-subtle leading-snug mt-3 mb-4"
          style={{ fontSize: "0.75rem" }}
        >
          {t(
            `The mock interview mirrors ${leadCount} question${leadCount === 1 ? "" : "s"} from the original. On start, the browser will ask for microphone and camera access.`,
            `模拟面试将参照原面试的 ${leadCount} 道主问题。开始后浏览器会请求麦克风与摄像头权限。`
          )}{" "}
          <span style={{ color: "var(--color-text)", fontWeight: 500 }}>
            {t(
              "Tip: use headphones — you can interrupt and talk over the interviewer naturally, just like a real call.",
              "建议戴耳机——这样你可以像真实通话一样随时打断面试官、自然抢话。"
            )}
          </span>
        </p>

        {error && (
          <p
            className="mb-3 leading-snug"
            style={{ fontSize: "0.8125rem", color: "var(--color-error)" }}
          >
            {error}
          </p>
        )}
        {!parent ? (
          <p
            className="mb-3 text-text-subtle leading-snug"
            style={{ fontSize: "0.8125rem" }}
          >
            {t("Loading session…", "加载会话中…")}
          </p>
        ) : leadCount === 0 ? (
          <p
            className="mb-3 leading-snug"
            style={{ fontSize: "0.8125rem", color: "var(--color-error)" }}
          >
            {t(
              "This session has no recorded questions to mirror.",
              "这场会话没有可参照的问题记录。"
            )}
          </p>
        ) : null}

        {plan && (
          <p
            className="mb-3 leading-snug"
            style={{ fontSize: "0.8125rem", color: "var(--color-text)" }}
          >
            {t(
              `Interview ready — ${plan.slots.length} questions prepared. Click Start when you are.`,
              `面试已就绪——已准备 ${plan.slots.length} 道问题。准备好了就点开始。`
            )}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button onClick={onCancel} disabled={generating}>
            {t("Cancel", "取消")}
          </Button>
          {plan ? (
            <Button
              variant="primary"
              onClick={() => onStart({ plan, resume: resume.trim() })}
            >
              {t("Start interview", "开始面试")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canStart}
              onClick={handleGenerate}
            >
              {generating
                ? t("Generating interview…", "正在生成面试…")
                : error
                  ? t("Retry", "重试")
                  : t("Generate interview", "生成面试")}
            </Button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
