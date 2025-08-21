// lib/security.js
import crypto from "crypto";

export function verifySlackSignature({ rawBody, signature, timestamp, signingSecret }) {
  const fiveMinutes = 60 * 5;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Date.now() / 1000 - ts);
  if (age > fiveMinutes) return false;

  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");

  const computed = Buffer.from(`v0=${hmac}`, "utf8");
  const given = Buffer.from(signature || "", "utf8");
  return computed.length === given.length && crypto.timingSafeEqual(computed, given);
}
