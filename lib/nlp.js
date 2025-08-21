// lib/nlp.js
import { ENV } from "./env.js";
import { isISODate } from "./date.js";

const MAX_PTO_SPAN_DAYS = Number(process.env.MAX_PTO_SPAN_DAYS || "30");

export async function parsePTORequest(text, todayISO) {
  const prompt = `Extract PTO (paid time off) details from: "${text}"

Return a STRICT JSON object with keys:
- start: date in YYYY-MM-DD
- end: date in YYYY-MM-DD
- reason: short string

Rules:
- If only one date is present, set start=end.
- Use today's date (${todayISO}) to resolve relative phrases like "tomorrow" or "next Monday".
- Do NOT include any extra keys or text; only valid JSON.`;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ENV.OPENROUTER_MODEL,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Parser returned empty result");

  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("Parser returned invalid JSON"); }

  const { start, end } = parsed;
  if (!isISODate(start) || !isISODate(end)) throw new Error("Invalid date format from parser");

  // Basic hygiene
  parsed.reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Personal";
  // Span guard (rough; business days handled elsewhere)
  const startD = new Date(`${start}T00:00:00Z`);
  const endD = new Date(`${end}T00:00:00Z`);
  const spanDays = Math.floor((endD - startD) / (24 * 3600 * 1000)) + 1;
  if (spanDays > MAX_PTO_SPAN_DAYS) throw new Error("Date range too long; please provide a shorter range");

  return parsed;
}
