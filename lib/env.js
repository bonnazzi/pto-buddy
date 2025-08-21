// lib/env.js
export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const ENV = {
  SLACK_SIGNING_SECRET: requireEnv("SLACK_SIGNING_SECRET"),
  SLACK_BOT_TOKEN: requireEnv("SLACK_BOT_TOKEN"),
  HR_SLACK_ID: process.env.HR_SLACK_ID || "",
  GCP_JSON: JSON.parse(requireEnv("GCP_JSON")),
  SPREADSHEET_ID: requireEnv("SPREADSHEET_ID"),
  PTO_ANNUAL_ALLOWANCE: Number(process.env.PTO_ANNUAL_ALLOWANCE || "25"),
  OPENROUTER_API_KEY: requireEnv("OPENROUTER_API_KEY"),
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || "openai/gpt-3.5-turbo",
  NODE_ENV: process.env.NODE_ENV || "development",
};
