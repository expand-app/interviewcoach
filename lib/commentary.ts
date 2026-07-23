/**
 * Shared commentary text utilities.
 *
 * The classifier / commentary generators emit commentary text that ends
 * with an English suggested-answer block, separated from the main
 * observation by a `---SAY---` marker. Example:
 *
 *   面试官在 push 你 quantify impact —— 别只说 "成功"，给数字。
 *   ---SAY--- Try: "Revenue went up 18% quarter-over-quarter, driven by
 *   the new ranker."
 *
 * `splitCommentary` extracts the leading observation HTML and the
 * suggested-answer text. Used in:
 *   - LiveView's CommentaryBody (the Live Commentary pane)
 *   - PastView's transcript entry render (per-Q&A commentary block)
 *
 * Streaming-safe: when the marker hasn't arrived yet (model is still
 * mid-output), the whole input is treated as commentary and `suggestion`
 * is empty. The marker is exact-string with optional surrounding
 * whitespace.
 */
export function splitCommentary(text: string): {
  commentary: string;
  suggestion: string;
} {
  if (!text) return { commentary: "", suggestion: "" };
  const marker = /\s*---SAY---\s*/;
  const parts = text.split(marker);
  if (parts.length < 2) return { commentary: text, suggestion: "" };
  const commentary = parts[0].trim();
  // Everything after the marker is the suggested answer. Strip a leading
  // `Try:` / `Try ` prefix if the model included one (it's redundant with
  // the UI label that already says "Try" next to the block).
  let suggestion = parts.slice(1).join(" ").trim();
  suggestion = suggestion.replace(/^Try[:\s]+/i, "");
  return { commentary, suggestion };
}
