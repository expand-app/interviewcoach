"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";

/**
 * Local-only sign-in screen. There's no backend — this page just captures a
 * name + email and stores them in the Zustand `user` slice (persisted to
 * localStorage). Logging out clears the slice and returns here.
 *
 * The layout mirrors the main-app grid so there is no flash/resize when
 * the user signs in and the <Page> component swaps from this view to the
 * full sidebar + main layout.
 */
export function LoginView() {
  const signIn = useStore((s) => s.signIn);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    signIn({ name: trimmedName, email: trimmedEmail });
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-paper-subtle">
      <div className="w-[400px] max-w-[92vw] bg-paper border border-rule-strong rounded-xl shadow-[0_20px_60px_rgba(15,15,15,0.12),0_4px_12px_rgba(15,15,15,0.05)] p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-8 h-8 bg-ink text-paper rounded grid place-items-center font-serif italic font-bold text-sm">
            C
          </div>
          <div className="text-lg font-semibold text-ink tracking-tight">
            Interview Coach
          </div>
        </div>

        <h1 className="text-[22px] font-bold tracking-tight text-ink mb-1">
          Sign in
        </h1>
        <p className="text-[13.5px] text-ink-light mb-6 leading-relaxed">
          Your name and email are stored locally in this browser. No data
          leaves your device at sign-in time.
        </p>

        <form onSubmit={onSubmit}>
          <div className="mb-4">
            <label className="block text-[13px] font-semibold text-ink mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Your name"
              className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20"
              autoFocus
            />
          </div>

          <div className="mb-4">
            <label className="block text-[13px] font-semibold text-ink mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              placeholder="you@example.com"
              className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20"
            />
          </div>

          {error && (
            <div className="mb-4 text-xs text-red-text bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full mt-2 bg-accent hover:bg-[#1a73d1] text-white py-2.5 rounded-md text-sm font-medium transition-colors"
          >
            Continue →
          </button>
        </form>
      </div>
    </div>
  );
}
