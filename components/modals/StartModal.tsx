"use client";

import { useState, useEffect } from "react";
import { ModalShell } from "./ModalShell";
import { useTranslations } from "@/lib/i18n";

interface Props {
  open: boolean;
  onCancel: () => void;
  onStart: (jd: string, resume: string) => void;
}

export function StartModal({ open, onCancel, onStart }: Props) {
  const t = useTranslations();
  const [jd, setJd] = useState("");
  const [resume, setResume] = useState("");

  // Reset when opened
  useEffect(() => {
    if (open) {
      setJd("");
      setResume("");
    }
  }, [open]);

  return (
    <ModalShell open={open} onClose={onCancel} variant="wide">
      <div className="p-7 px-8">
        <h2 className="text-[22px] font-bold tracking-tight mb-1 text-ink">
          {t("Start a new session", "开始新的面试")}
        </h2>
        <p className="text-[13.5px] text-ink-light mb-5 leading-relaxed">
          {t(
            "Paste the job description below. Adding the candidate's resume helps AI judge how well answers fit the person's background.",
            "粘贴岗位 JD。附上候选人简历能帮 AI 判断答案是否符合这个人的实际背景。"
          )}
        </p>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[13px] font-semibold text-ink">
              {t("Job Description", "岗位描述 (JD)")}
            </label>
            <span className="text-[11px] font-medium tracking-wider uppercase py-0.5 px-1.5 rounded bg-accent-bg text-accent">
              {t("Required", "必填")}
            </span>
          </div>
          <textarea
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder={t(
              "Paste the full JD here — role, responsibilities, required skills, company context, etc.",
              "粘贴完整 JD —— 岗位、职责、技能要求、公司背景等"
            )}
            className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20 focus:ring-offset-0 resize-y min-h-[140px] leading-relaxed"
          />
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[13px] font-semibold text-ink">
              {t("Candidate Resume", "候选人简历")}
            </label>
            <span className="text-[11px] font-medium tracking-wider uppercase py-0.5 px-1.5 rounded bg-paper-hover text-ink-lighter">
              {t("Optional", "可选")}
            </span>
          </div>
          <textarea
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder={t(
              "Paste the candidate's resume — past roles, projects, education, etc. This helps AI calibrate answers against their actual experience.",
              "粘贴候选人简历 —— 过往岗位、项目、学历等。AI 会用它来对照候选人的实际经历,判断答案是否靠谱。"
            )}
            className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20 focus:ring-offset-0 resize-y min-h-[110px] leading-relaxed"
          />
          <div className="text-xs text-ink-lighter mt-1">
            {t(
              "AI won't just check what they say — it will cross-check against what they've actually done.",
              "AI 不只看他们怎么说,还会对照他们真正做过什么。"
            )}
          </div>
        </div>

        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover"
          >
            {t("Cancel", "取消")}
          </button>
          <button
            onClick={() => jd.trim() && onStart(jd.trim(), resume.trim())}
            disabled={!jd.trim()}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent text-white border border-accent hover:bg-[#1a73d1] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("Start listening →", "开始监听 →")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
