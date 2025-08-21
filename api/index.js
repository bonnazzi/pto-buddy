export const config = { api: { bodyParser: false } };

// --- Imports ---
import boltPkg from "@slack/bolt";
const { App } = boltPkg;

import gapiPkg from "googleapis";
const { google } = gapiPkg;

import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

// --- Logging Helper ---
const log = {
  info: (message, data = {}) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, JSON.stringify(data, null, 2));
  },
  error: (message, error = {}) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, {
      message: error.message,
      stack: error.stack,
      ...error
    });
  },
  debug: (message, data = {}) => {
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, JSON.stringify(data, null, 2));
  }
};

// --- Custom Receiver for Vercel ---
class VercelReceiver {
  constructor({ signingSecret }) {
    this.signingSecret = signingSecret;
    this.app = null;
  }
  
  init(app) {
    this.app = app;
  }
  
  async verifySignature(rawBody, signature, timestamp) {
    const hmac = crypto.createHmac("sha256", this.signingSecret);
    hmac.update(`v0:${timestamp}:${rawBody}`);
    const computed = `v0=${hmac.digest("hex")}`;
    return computed === signature;
  }
  
  parseUrlEncoded(body) {
    const params = new URLSearchParams(body);
    const result = {};
    for (const [key, value] of params) {
      result[key] = value;
    }
    return result;
  }
}

// Initialize receiver and app
const receiver = new VercelReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: "DEBUG"
});

receiver.init(app);

// --- Google Sheets setup ---
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GCP_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const spreadsheetId = process.env.SPREADSHEET_ID;

// --- Helper Functions ---

// Calculate business days between two dates (excluding weekends)
function calculateBusinessDays(startDate, endDate) {
  let count = 0;
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday (0) or Saturday (6)
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
}

// Get user info from Slack
async function getUserInfo(userId) {
  try {
    const result = await app.client.users.info({ user: userId });
    return {
      id: userId,
      name: result.user.real_name || result.user.name,
      email: result.user.profile.email
    };
  } catch (error) {
    log.error("Failed to get user info from Slack", { userId, error: error.message });
    return { id: userId, name: "Unknown", email: "" };
  }
}

// Get user's PTO history from the sheet
async function getUserPTOHistory(userId) {
  try {
    const client = await auth.getClient();
    const result = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "PTO_Requests!A2:K1000"
    });
    
    const rows = result.data.values || [];
    const userRequests = rows.filter(r => r[1] === userId && r[7] === "approved");
    
    // Calculate stats
    const totalRequests = userRequests.length;
    let lastRequestDate = null;
    let totalDaysUsed = 0;
    
    if (totalRequests > 0) {
      // Find most recent approved request
      const sortedRequests = userRequests.sort((a, b) => new Date(b[0]) - new Date(a[0]));
      lastRequestDate = sortedRequests[0][0];
      
      // Sum up total days used
      totalDaysUsed = userRequests.reduce((sum, req) => sum + (parseInt(req[5]) || 0), 0);
    }
    
    // Calculate average frequency (requests per month over the last year)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const recentRequests = userRequests.filter(r => new Date(r[0]) > oneYearAgo);
    const avgFrequency = recentRequests.length / 12;
    
    return {
      totalRequests,
      lastRequestDate,
      totalDaysUsed,
      avgRequestsPerMonth: avgFrequency.toFixed(1),
      daysRemaining: 25 - totalDaysUsed // Assuming 25 days annual allowance
    };
  } catch (error) {
    log.error("Failed to get user PTO history", { userId, error: error.message });
    return {
      totalRequests: 0,
      lastRequestDate: null,
      totalDaysUsed: 0,
      avgRequestsPerMonth: 0,
      daysRemaining: 25
    };
  }
}

// Parse PTO request from natural language
async function parsePTORequest(text) {
  const prompt = `Extract PTO request details from: "${text}"
  
Return a JSON object with:
- start: YYYY-MM-DD format
- end: YYYY-MM-DD format  
- reason: brief description

If only one date mentioned, use it for both start and end.
Today's date is ${new Date().toISOString().split('T')[0]}.

Examples:
"next Monday to Friday for vacation" -> parse the actual dates
"December 25-27 for holidays" -> parse the actual dates
"tomorrow for a doctor appointment" -> parse tomorrow's date for both start and end

Return ONLY valid JSON, no other text.`;

  try {
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
    const parsed = JSON.parse(data.choices[0].message.content.trim());
    
    return parsed;
  } catch (error) {
    log.error("Failed to parse PTO request", { text, error: error.message });
    throw new Error("Could not understand the date request. Please try again with specific dates.");
  }
}

// Log request to Google Sheets
async function logRequest(requestData) {
  try {
    const client = await auth.getClient();
    
    const values = [[
      new Date().toISOString(),           // timestamp
      requestData.userId,                  // user_id
      requestData.userName,                 // user_name
      requestData.start,                    // start_date
      requestData.end,                      // end_date
      requestData.businessDays,             // vacation_length
      requestData.reason,                   // reason
      requestData.status,                   // status
      requestData.managerId,                // manager_id
      requestData.managerName               // manager_name
    ]];
    
    const result = await sheets.spreadsheets.values.append({
      auth: client,
      spreadsheetId,
      range: "PTO_Requests!A2:J2",
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    
    log.info("Request logged to Google Sheets", { requestData });
    return result;
  } catch (error) {
    log.error("Failed to log request", { error: error.message });
    throw error;
  }
}

// Update request status in Google Sheets
async function updateRequestStatus(userId, start, end, newStatus, approverId) {
  try {
    const client = await auth.getClient();
    
    // Get all requests
    const result = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "PTO_Requests!A2:J1000"
    });
    
    const rows = result.data.values || [];
    const rowIndex = rows.findIndex(r => 
      r[1] === userId && 
      r[3] === start && 
      r[4] === end && 
      r[7] === "pending"
    );
    
    if (rowIndex === -1) {
      log.error("No matching pending request found", { userId, start, end });
      return false;
    }
    
    // Update status column (H = column 8)
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId,
      range: `PTO_Requests!H${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[newStatus]]
      }
    });
    
    log.info("Request status updated", { userId, start, end, newStatus });
    return true;
  } catch (error) {
    log.error("Failed to update request status", { error: error.message });
    return false;
  }
}

// Get manager ID (simplified - you might want to use a lookup table)
function getManagerId(userId) {
  // For now, use the HR_SLACK_ID as the default manager
  // In production, you'd look this up from a Teams sheet or Slack workspace
  return process.env.HR_SLACK_ID || "U07T2QXUZPL";
}

// --- Main Slack Event Handlers ---

// Handle DM messages to the bot
app.message(async ({ message, client, say }) => {
  // Only respond to DMs, not channel messages
  if (message.channel_type !== 'im') return;
  
  // Don't respond to bot messages
  if (message.bot_id) return;
  
  const userId = message.user;
  const text = message.text;
  
  log.info("DM received", { userId, text });
  
  try {
    // Get user info
    const userInfo = await getUserInfo(userId);
    
    // Parse the PTO request
    const ptoRequest = await parsePTORequest(text);
    
    // Calculate business days
    const businessDays = calculateBusinessDays(ptoRequest.start, ptoRequest.end);
    
    // Get user's PTO history
    const history = await getUserPTOHistory(userId);
    
    // Check if user has enough days
    if (businessDays > history.daysRemaining) {
      await say(`❌ Sorry, you're requesting ${businessDays} days but only have ${history.daysRemaining} days remaining in your balance.`);
      return;
    }
    
    // Send confirmation message
    await say({
      text: `Please confirm your PTO request:`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Please confirm your PTO request:*\n\n` +
                  `📅 *Dates:* ${ptoRequest.start} to ${ptoRequest.end}\n` +
                  `📊 *Business days:* ${businessDays} days (excluding weekends)\n` +
                  `📝 *Reason:* ${ptoRequest.reason}\n` +
                  `💰 *Your balance after approval:* ${history.daysRemaining - businessDays} days remaining`
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Confirm Request"
              },
              style: "primary",
              action_id: "confirm_pto",
              value: JSON.stringify({
                userId,
                userName: userInfo.name,
                start: ptoRequest.start,
                end: ptoRequest.end,
                businessDays,
                reason: ptoRequest.reason,
                history
              })
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Cancel"
              },
              style: "danger",
              action_id: "cancel_pto"
            }
          ]
        }
      ]
    });
    
  } catch (error) {
    log.error("Error processing PTO request", { error: error.message });
    await say(`❌ Sorry, I couldn't understand your request. Please try again with a format like:\n"I need next Monday to Friday off for vacation"`);
  }
});

// Handle PTO confirmation
app.action("confirm_pto", async ({ ack, body, client }) => {
  await ack();
  
  const requestData = JSON.parse(body.actions[0].value);
  const managerId = getManagerId(requestData.userId);
  const managerInfo = await getUserInfo(managerId);
  
  try {
    // Log the request as pending
    await logRequest({
      ...requestData,
      status: "pending",
      managerId: managerId,
      managerName: managerInfo.name
    });
    
    // Calculate context for manager
    const daysSinceLastRequest = requestData.history.lastRequestDate 
      ? Math.floor((new Date() - new Date(requestData.history.lastRequestDate)) / (1000 * 60 * 60 * 24))
      : "N/A (first request)";
    
    // Send to manager for approval
    await client.chat.postMessage({
      channel: managerId,
      text: `New PTO request from ${requestData.userName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*New PTO Request*\n\n` +
                  `👤 *Employee:* ${requestData.userName} (<@${requestData.userId}>)\n` +
                  `📅 *Dates:* ${requestData.start} to ${requestData.end}\n` +
                  `📊 *Business days:* ${requestData.businessDays} days\n` +
                  `📝 *Reason:* ${requestData.reason}\n\n` +
                  `*Context:*\n` +
                  `• Current balance: ${requestData.history.daysRemaining} days\n` +
                  `• After approval: ${requestData.history.daysRemaining - requestData.businessDays} days\n` +
                  `• Days since last request: ${daysSinceLastRequest}\n` +
                  `• Average requests/month: ${requestData.history.avgRequestsPerMonth}\n` +
                  `• Total days used this year: ${requestData.history.totalDaysUsed}`
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Approve"
              },
              style: "primary",
              action_id: "approve_pto",
              value: JSON.stringify({
                userId: requestData.userId,
                userName: requestData.userName,
                start: requestData.start,
                end: requestData.end,
                businessDays: requestData.businessDays
              })
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Deny"
              },
              style: "danger",
              action_id: "deny_pto",
              value: JSON.stringify({
                userId: requestData.userId,
                userName: requestData.userName,
                start: requestData.start,
                end: requestData.end
              })
            }
          ]
        }
      ]
    });
    
    // Update the user's message
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "✅ Your PTO request has been submitted for approval. You'll be notified once your manager reviews it.",
      blocks: []
    });
    
  } catch (error) {
    log.error("Error submitting PTO request", { error: error.message });
    
    await client.chat.postMessage({
      channel: requestData.userId,
      text: "❌ Sorry, there was an error submitting your request. Please try again."
    });
  }
});

// Handle PTO cancellation
app.action("cancel_pto", async ({ ack, body, client }) => {
  await ack();
  
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: "❌ PTO request cancelled.",
    blocks: []
  });
});

// Handle PTO approval
app.action("approve_pto", async ({ ack, body, client }) => {
  await ack();
  
  const requestData = JSON.parse(body.actions[0].value);
  const approverId = body.user.id;
  
  try {
    // Update status in Google Sheets
    const updated = await updateRequestStatus(
      requestData.userId,
      requestData.start,
      requestData.end,
      "approved",
      approverId
    );
    
    if (!updated) {
      throw new Error("Could not find the request to update");
    }
    
    // Notify the employee
    await client.chat.postMessage({
      channel: requestData.userId,
      text: `✅ Good news! Your PTO request has been approved!\n\n` +
            `📅 *Dates:* ${requestData.start} to ${requestData.end}\n` +
            `📊 *Business days:* ${requestData.businessDays} days\n` +
            `✅ *Approved by:* <@${approverId}>\n\n` +
            `Enjoy your time off! 🎉`
    });
    
    // Update the manager's message
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ PTO request for ${requestData.userName} has been approved.`,
      blocks: []
    });
    
  } catch (error) {
    log.error("Error approving PTO request", { error: error.message });
    
    await client.chat.postMessage({
      channel: approverId,
      text: "❌ There was an error processing the approval. Please check the Google Sheet directly."
    });
  }
});

// Handle PTO denial
app.action("deny_pto", async ({ ack, body, client }) => {
  await ack();
  
  const requestData = JSON.parse(body.actions[0].value);
  const denierId = body.user.id;
  
  try {
    // Update status in Google Sheets
    const updated = await updateRequestStatus(
      requestData.userId,
      requestData.start,
      requestData.end,
      "denied",
      denierId
    );
    
    if (!updated) {
      throw new Error("Could not find the request to update");
    }
    
    // Notify the employee
    await client.chat.postMessage({
      channel: requestData.userId,
      text: `❌ Your PTO request has been denied.\n\n` +
            `📅 *Dates:* ${requestData.start} to ${requestData.end}\n` +
            `❌ *Denied by:* <@${denierId}>\n\n` +
            `Please speak with your manager if you have questions.`
    });
    
    // Update the manager's message
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ PTO request for ${requestData.userName} has been denied.`,
      blocks: []
    });
    
  } catch (error) {
    log.error("Error denying PTO request", { error: error.message });
    
    await client.chat.postMessage({
      channel: denierId,
      text: "❌ There was an error processing the denial. Please check the Google Sheet directly."
    });
  }
});

// --- Vercel Handler ---
export default async function handler(req, res) {
  log.info("Vercel handler invoked", {
    method: req.method,
    url: req.url,
    contentType: req.headers["content-type"]
  });
  
  if (req.method !== "POST") {
    res.statusCode = 404;
    return res.end("Not found");
  }
  
  // Read the raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString();
  
  // Check for Slack URL verification
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(rawBody);
      if (payload.type === "url_verification" && payload.challenge) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        return res.end(payload.challenge);
      }
    } catch (e) {
      // Not a verification request
    }
  }
  
  // Verify Slack signature
  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];
  
  if (!signature || !timestamp) {
    res.statusCode = 400;
    return res.end("Bad request");
  }
  
  const isValid = await receiver.verifySignature(rawBody, signature, timestamp);
  if (!isValid) {
    res.statusCode = 401;
    return res.end("Unauthorized");
  }
  
  // Process the request
  try {
    let body;
    
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = receiver.parseUrlEncoded(rawBody);
      
      // Handle interactive payloads (button clicks)
      if (body.payload) {
        const payload = JSON.parse(body.payload);
        const eventName = payload.actions?.[0]?.action_id;
        
        if (eventName) {
          // Emit the event to the app
          await app.processEvent({
            type: "interactive",
            body: payload,
            ack: async () => {},
            client: app.client
          });
        }
      }
    } else if (contentType.includes("application/json")) {
      body = JSON.parse(rawBody);
      
      // Handle events (messages)
      if (body.type === "event_callback") {
        await app.processEvent({
          ...body.event,
          client: app.client
        });
      }
    }
    
    res.statusCode = 200;
    res.end("");
    
  } catch (error) {
    log.error("Error processing request", {
      error: error.message,
      stack: error.stack
    });
    
    res.statusCode = 500;
    res.end("Internal server error");
  }
}
