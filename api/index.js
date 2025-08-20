export const config = { api: { bodyParser: false } }; // ⭐️ Needed for Slack

import pkg from "@slack/bolt";
const { App } = pkg;

import googleapisPkg from "googleapis";
const { google } = googleapisPkg;

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// 1️⃣  Slack app setup
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,            // we’ll use HTTPS requests
  appToken: process.env.APP_TOKEN // not used here but Bolt wants it
});

// 2  Google Sheets auth
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GCP_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const spreadsheetId = process.env.SPREADSHEET_ID;

// 3  Helper: read user balance
async function getBalance(userId) {
  const client = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: "Balances!A2:C1000"
  });
  const row = res.data.values?.find(r => r[0] === userId);
  if (!row) return { remaining: 0, taken: 0, allowance: 0 };
  const allowance = Number(row[1]);
  const taken = Number(row[2]);
  return { remaining: allowance - taken, taken, allowance };
}

// 4  Helper: append request
async function logRequest({ user, start, end, reason, manager }) {
  const client = await auth.getClient();
  await sheets.spreadsheets.values.append({
    auth: client,
    spreadsheetId,
    range: "Requests!A2:G2",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[new Date().toISOString(), user, start, end, reason, "pending", manager]]
    }
  });
}

// 5  Helper: call LLM via OpenRouter
async function parsePTO(text) {
  const prompt = `Extract PTO info from: "${text}".\nReturn JSON like {"start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"..."}.\nIf only one date, use it for both start and end.`;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const content = JSON.parse(data.choices[0].message.content.trim());
  return content;
}

// 6  Slash command
app.command("/leave", async ({ ack, body, client, say }) => {
  await ack();
  const userId = body.user_id;
  const parsed = await parsePTO(body.text);

  const bal = await getBalance(userId);
  if (bal.remaining <= 0) {
    await say(`<@${userId}> you’re out of PTO (used ${bal.taken}/${bal.allowance}).`);
    return;
  }

  // Ask confirmation
  await client.chat.postMessage({
    channel: userId,
    text: `You’re requesting ${parsed.start} → ${parsed.end} for *${parsed.reason}*. Type “yes” to confirm.`,
    metadata: { event_type: "awaiting_confirmation", event_payload: parsed }
  });
});

// 7  Listen for “yes” confirmation in DM
app.message(/^yes$/i, async ({ message, client, context }) => {
  if (!message.metadata || message.metadata.event_type !== "awaiting_confirmation") return;
  const { start, end, reason } = message.metadata.event_payload;
  const user = message.user;

  // For simplicity, assume manager = HR admin’s Slack ID (env var)
  const manager = process.env.HR_SLACK_ID;

  await logRequest({ user, start, end, reason, manager });

  // Send approval buttons
  await client.chat.postMessage({
    channel: manager,
    text: `PTO request from <@${user}>`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*PTO Request*\nUser: <@${user}>\n${start} → ${end}\nReason: ${reason}` } },
      {
        type: "actions",
        block_id: "approval_block",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", value: JSON.stringify({ user, start, end }), action_id: "approve" },
          { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", value: JSON.stringify({ user }), action_id: "deny" }
        ]
      }
    ]
  });

  await client.chat.postMessage({ channel: user, text: "Your request was sent for approval. 🎉" });
});

// 8  Handle button clicks
app.action("approve", async ({ body, ack, client }) => {
  await ack();
  const { user, start, end } = JSON.parse(body.actions[0].value);
  await client.chat.postMessage({ channel: user, text: `✅ Approved! Enjoy your time off from ${start} to ${end}` });
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts,
    text: "Approved ✔️", blocks: []
  });
});
app.action("deny", async ({ body, ack, client }) => {
  await ack();
  const { user } = JSON.parse(body.actions[0].value);
  await client.chat.postMessage({ channel: user, text: `❌ Sorry, your PTO request was denied.` });
  await client.chat.update({
    channel: body.channel.id, ts: body.message.ts,
    text: "Denied ✖️", blocks: []
  });
});

// 9️⃣  Start Bolt (Vercel’s handler)
export default async function handler(req, res) {
  await app.start();
  await app.receiver.requestListener(req, res);
}
