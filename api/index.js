/* ---------- api/index.js ---------- */
/* 1️⃣  Let Slack send the raw body (needed for signature verification) */
export const config = { api: { bodyParser: false } };

/* 2️⃣  Imports — use the CommonJS-friendly pattern */
import boltPkg from "@slack/bolt";
const { App } = boltPkg;

import gapiPkg from "googleapis";
const { google } = gapiPkg;

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

/* 3️⃣  Bolt app initialisation */
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,          // xoxb-…
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  appToken: process.env.APP_TOKEN || "unused"  // any string if socketMode=false
});

/* 4️⃣  Google Sheets set-up */
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GCP_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const spreadsheetId = process.env.SPREADSHEET_ID;

/* Helpers */
async function getBalance(userId) {
  const client = await auth.getClient();
  const result = await sheets.spreadsheets.values.get({
    auth: client,
    spreadsheetId,
    range: "Balances!A2:C1000"
  });
  const row = result.data.values?.find(r => r[0] === userId);
  if (!row) return { allowance: 0, taken: 0, remaining: 0 };
  const [ , allowance, taken ] = row.map(Number);
  return { allowance, taken, remaining: allowance - taken };
}

async function logRequest(obj) {
  const client = await auth.getClient();
  await sheets.spreadsheets.values.append({
    auth: client,
    spreadsheetId,
    range: "Requests!A2:G2",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        obj.user,
        obj.start,
        obj.end,
        obj.reason,
        "pending",
        obj.manager
      ]]
    }
  });
}

/* Very simple natural-language parser via OpenRouter */
async function parsePto(text) {
  const prompt = `Extract PTO info from: "${text}". Return JSON like {"start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"..."} (if one date, use for both).`;
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
  return JSON.parse(data.choices[0].message.content.trim());
}

/* 5  /leave slash command */
app.command("/leave", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const parsed = await parsePto(body.text);

  const bal = await getBalance(userId);
  if (bal.remaining <= 0) {
    await client.chat.postMessage({
      channel: userId,
      text: `You’re out of PTO (used ${bal.taken}/${bal.allowance}).`
    });
    return;
  }

  await client.chat.postMessage({
    channel: userId,
    text: `Requesting ${parsed.start} → ${parsed.end} for *${parsed.reason}*.\nReply “yes” to confirm.`,
    metadata: { event_type: "awaiting_confirmation", event_payload: { ...parsed } }
  });
});

/* 6️⃣  Confirmation listener */
app.message(/^yes$/i, async ({ message, client }) => {
  if (!message.metadata || message.metadata.event_type !== "awaiting_confirmation") return;
  const { start, end, reason } = message.metadata.event_payload;
  const user = message.user;
  const manager = process.env.HR_SLACK_ID;

  await logRequest({ user, start, end, reason, manager });

  await client.chat.postMessage({
    channel: manager,
    text: `PTO request from <@${user}>`,
    blocks: [
      { type: "section",
        text: { type: "mrkdwn", text: `*PTO Request*\nUser: <@${user}>\n${start} → ${end}\nReason: ${reason}` } },
      { type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" },
            value: JSON.stringify({ user, start, end }), action_id: "approve" },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" },
            value: JSON.stringify({ user }), action_id: "deny" }
        ] }
    ]
  });

  await client.chat.postMessage({ channel: user, text: "Request sent for approval. 🎉" });
});

/* 7️⃣  Approve / Deny buttons */
app.action("approve", async ({ ack, body, client }) => {
  await ack();
  const { user, start, end } = JSON.parse(body.actions[0].value);
  await client.chat.postMessage({ channel: user, text: `✅ Approved! Enjoy ${start} → ${end}` });
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: "Approved ✔️", blocks: [] });
});
app.action("deny", async ({ ack, body, client }) => {
  await ack();
  const { user } = JSON.parse(body.actions[0].value);
  await client.chat.postMessage({ channel: user, text: `❌ Sorry, your PTO request was denied.` });
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: "Denied ✖️", blocks: [] });
});

export default function handler(req, res) {
  app.receiver.requestListener(req, res);   // pass the request straight to Bolt
}

