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
  },
  warn: (message, data = {}) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, JSON.stringify(data, null, 2));
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

log.info("Initializing custom Vercel receiver");
const receiver = new VercelReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: "DEBUG"
});

// Initialize the receiver with the app
receiver.init(app);

log.info("Slack App initialized successfully");

// --- Google Sheets setup ---
log.info("Setting up Google Sheets client");
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GCP_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const spreadsheetId = process.env.SPREADSHEET_ID;
log.info("Google Sheets setup complete", { spreadsheetId });

// --- Helpers ---
async function getUserInfo(userId) {
  log.info("Getting user info from Teams tab", { userId, spreadsheetId });
  
  try {
    const client = await auth.getClient();
    log.debug("Google Auth client obtained for user info");
    
    const requestParams = {
      auth: client,
      spreadsheetId,
      range: "Teams!A2:D1000"
    };
    
    const result = await sheets.spreadsheets.values.get(requestParams);
    log.info("Teams sheet response received", {
      userId,
      rowCount: result.data.values?.length || 0
    });
    
    // ID is in column B (index 1)
    const row = result.data.values?.find(r => r[1] === userId);
    
    if (!row) {
      log.warn("User not found in Teams sheet", { userId });
      return null;
    }
    
    const userInfo = {
      name: row[0],      // Team member name
      userId: row[1],    // Slack ID
      team: row[2],      // Team name
      managerId: row[3]  // Manager's Slack ID
    };
    
    log.info("User info retrieved successfully", { userId, userInfo });
    return userInfo;
    
  } catch (error) {
    log.error("Failed to get user info from Teams sheet", {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function getBalance(userId) {
  log.info("Getting balance from Google Sheets", { userId, spreadsheetId });
  
  try {
    const client = await auth.getClient();
    log.debug("Google Auth client obtained successfully");
    
    const requestParams = {
      auth: client,
      spreadsheetId,
      range: "Balances!A2:C1000"
    };
    log.debug("Sheets API request params", requestParams);
    
    const result = await sheets.spreadsheets.values.get(requestParams);
    log.info("Google Sheets response received", {
      userId,
      rowCount: result.data.values?.length || 0,
      range: result.data.range
    });
    
    const row = result.data.values?.find(r => r[0] === userId);
    
    if (!row) {
      log.warn("User not found in balance sheet", { userId });
      return { allowance: 0, taken: 0, remaining: 0 };
    }
    
    const [ , allowance, taken ] = row.map(Number);
    const balance = { allowance, taken, remaining: allowance - taken };
    log.info("Balance retrieved successfully", { userId, balance });
    
    return balance;
  } catch (error) {
    log.error("Failed to get balance from Google Sheets", {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function logRequest(obj) {
  log.info("Logging PTO request to Google Sheets", obj);
  
  try {
    const client = await auth.getClient();
    log.debug("Google Auth client obtained for request logging");
    
    const requestData = {
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
    };
    
    log.debug("Sheets append request data", requestData);
    
    const result = await sheets.spreadsheets.values.append(requestData);
    
    log.info("PTO request logged successfully", {
      user: obj.user,
      updatedRange: result.data.updates?.updatedRange,
      updatedRows: result.data.updates?.updatedRows,
      updatedColumns: result.data.updates?.updatedColumns
    });
    
    return result;
  } catch (error) {
    log.error("Failed to log request to Google Sheets", {
      requestData: obj,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function updateRequestStatus(userId, start, end, status) {
  log.info("Updating request status in Google Sheets", { userId, start, end, status });
  
  try {
    const client = await auth.getClient();
    
    // First, get all requests to find the matching one
    const getResult = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Requests!A2:G1000"
    });
    
    const rows = getResult.data.values || [];
    const rowIndex = rows.findIndex(r => 
      r[1] === userId && 
      r[2] === start && 
      r[3] === end && 
      r[5] === "pending"
    );
    
    if (rowIndex === -1) {
      log.warn("No matching pending request found", { userId, start, end });
      return;
    }
    
    // Update the status column (F) for the found row
    const updateRange = `Requests!F${rowIndex + 2}`; // +2 because we start from row 2
    
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[status]]
      }
    });
    
    log.info("Request status updated successfully", { userId, status, range: updateRange });
    
    // If approved, update the balance
    if (status === "approved") {
      await updateBalance(userId, start, end);
    }
    
  } catch (error) {
    log.error("Failed to update request status", {
      userId,
      status,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function updateBalance(userId, start, end) {
  log.info("Updating user balance after approval", { userId, start, end });
  
  try {
    const client = await auth.getClient();
    
    // Calculate days taken (simplified - you might want more complex logic)
    const startDate = new Date(start);
    const endDate = new Date(end);
    const daysTaken = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    
    // Get current balance
    const balanceResult = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Balances!A2:C1000"
    });
    
    const rows = balanceResult.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === userId);
    
    if (rowIndex === -1) {
      log.warn("User not found in Balances sheet", { userId });
      return;
    }
    
    const currentTaken = Number(rows[rowIndex][2]) || 0;
    const newTaken = currentTaken + daysTaken;
    
    // Update the taken_so_far column (C)
    const updateRange = `Balances!C${rowIndex + 2}`;
    
    await sheets.spreadsheets.values.update({
      auth: client,
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[newTaken]]
      }
    });
    
    log.info("Balance updated successfully", { 
      userId, 
      daysTaken, 
      previousBalance: currentTaken,
      newBalance: newTaken 
    });
    
  } catch (error) {
    log.error("Failed to update balance", {
      userId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function parsePto(text) {
  log.info("Parsing PTO request with OpenRouter", { inputText: text });
  
  const prompt = `Extract PTO info from: "${text}". Return JSON like {"start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"..."} (if one date, use for both).`;
  
  const requestBody = {
    model: "openai/gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }]
  };
  
  log.debug("OpenRouter API request", {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: requestBody.model,
    promptLength: prompt.length
  });
  
  try {
    const startTime = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    const responseTime = Date.now() - startTime;
    log.info("OpenRouter API response received", {
      status: res.status,
      statusText: res.statusText,
      responseTimeMs: responseTime
    });
    
    if (!res.ok) {
      const errorText = await res.text();
      log.error("OpenRouter API error response", {
        status: res.status,
        errorText
      });
      throw new Error(`OpenRouter API error: ${res.status} - ${errorText}`);
    }
    
    const data = await res.json();
    log.debug("OpenRouter raw response", data);
    
    const parsedContent = JSON.parse(data.choices[0].message.content.trim());
    log.info("PTO parsing successful", {
      inputText: text,
      parsedResult: parsedContent
    });
    
    return parsedContent;
  } catch (error) {
    log.error("Failed to parse PTO request", {
      inputText: text,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// --- Slack Commands & Listeners ---
app.command("/pto", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const commandText = body.text;
  
  log.info("PTO command received", {
    userId,
    userName: body.user_name,
    commandText,
    channelId: body.channel_id,
    teamId: body.team_id
  });
  
  try {
    const parsed = await parsePto(commandText);
    log.info("PTO text parsed successfully", { userId, parsed });
    
    const bal = await getBalance(userId);
    log.info("User balance retrieved", { userId, balance: bal });
    
    if (bal.remaining <= 0) {
      log.warn("User has insufficient PTO balance", { userId, balance: bal });
      
      await client.chat.postMessage({
        channel: userId,
        text: `You're out of PTO (used ${bal.taken}/${bal.allowance}).`
      });
      log.info("Insufficient balance message sent to user", { userId });
      return;
    }
    
    const confirmationMessage = {
      channel: userId,
      text: `Requesting ${parsed.start} → ${parsed.end} for *${parsed.reason}*.\nReply "yes" to confirm.`,
      metadata: { event_type: "awaiting_confirmation", event_payload: { ...parsed } }
    };
    
    log.debug("Sending confirmation message", confirmationMessage);
    
    await client.chat.postMessage(confirmationMessage);
    log.info("Confirmation request sent to user", {
      userId,
      ptoRequest: parsed
    });
  } catch (error) {
    log.error("Error processing PTO command", {
      userId,
      commandText,
      error: error.message,
      stack: error.stack
    });
    
    await client.chat.postMessage({
      channel: userId,
      text: "Sorry, there was an error processing your request. Please try again."
    });
  }
});

app.message(/^yes$/i, async ({ message, client }) => {
  log.debug("Message received", {
    user: message.user,
    text: message.text,
    hasMetadata: !!message.metadata,
    metadata: message.metadata
  });
  
  if (!message.metadata || message.metadata.event_type !== "awaiting_confirmation") {
    log.debug("Message ignored - not a confirmation", {
      user: message.user,
      metadataType: message.metadata?.event_type
    });
    return;
  }
  
  const { start, end, reason } = message.metadata.event_payload;
  const user = message.user;
  const manager = process.env.HR_SLACK_ID;
  
  log.info("PTO confirmation received", {
    user,
    start,
    end,
    reason,
    manager
  });
  
  try {
    await logRequest({ user, start, end, reason, manager });
    log.info("Request logged to sheets successfully", { user });
    
    const managerMessage = {
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
    };
    
    log.debug("Sending approval request to manager", {
      manager,
      requestDetails: { user, start, end, reason }
    });
    
    await client.chat.postMessage(managerMessage);
    log.info("Approval request sent to manager", { user, manager });
    
    await client.chat.postMessage({ channel: user, text: "Request sent for approval. 🎉" });
    log.info("Confirmation sent to user", { user });
  } catch (error) {
    log.error("Error processing PTO confirmation", {
      user,
      error: error.message,
      stack: error.stack
    });
    
    await client.chat.postMessage({
      channel: user,
      text: "Sorry, there was an error submitting your request. Please try again."
    });
  }
});

app.action("approve", async ({ ack, body, client }) => {
  await ack();
  const actionValue = JSON.parse(body.actions[0].value);
  const { user, start, end } = actionValue;
  const approver = body.user.id;
  
  log.info("PTO approval action received", {
    approver,
    approverName: body.user.name,
    user,
    start,
    end
  });
  
  try {
    await client.chat.postMessage({ 
      channel: user, 
      text: `✅ Approved! Enjoy ${start} → ${end}` 
    });
    log.info("Approval notification sent to user", { user });
    
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      text: "Approved ✔️", 
      blocks: [] 
    });
    log.info("Manager message updated with approval", {
      approver,
      user,
      channelId: body.channel.id
    });
  } catch (error) {
    log.error("Error processing approval", {
      approver,
      user,
      error: error.message,
      stack: error.stack
    });
  }
});

app.action("deny", async ({ ack, body, client }) => {
  await ack();
  const actionValue = JSON.parse(body.actions[0].value);
  const { user } = actionValue;
  const denier = body.user.id;
  
  log.info("PTO denial action received", {
    denier,
    denierName: body.user.name,
    user
  });
  
  try {
    await client.chat.postMessage({ 
      channel: user, 
      text: `❌ Sorry, your PTO request was denied.` 
    });
    log.info("Denial notification sent to user", { user });
    
    await client.chat.update({ 
      channel: body.channel.id, 
      ts: body.message.ts, 
      text: "Denied ✖️", 
      blocks: [] 
    });
    log.info("Manager message updated with denial", {
      denier,
      user,
      channelId: body.channel.id
    });
  } catch (error) {
    log.error("Error processing denial", {
      denier,
      user,
      error: error.message,
      stack: error.stack
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
    log.warn("Non-POST request received", {
      method: req.method,
      url: req.url
    });
    res.statusCode = 404;
    return res.end("Not found");
  }
  
  // Read the raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString();
  
  log.debug("Request body received", {
    bodyLength: rawBody.length,
    bodyPreview: rawBody.substring(0, 200)
  });
  
  // Check for Slack URL verification (special case)
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(rawBody);
      if (payload.type === "url_verification" && payload.challenge) {
        log.info("Slack URL verification challenge received", {
          challenge: payload.challenge
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        return res.end(payload.challenge);
      }
    } catch (e) {
      log.debug("Not a URL verification request", { error: e.message });
    }
  }
  
  // Verify Slack signature
  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];
  
  if (!signature || !timestamp) {
    log.error("Missing Slack signature or timestamp", {
      hasSignature: !!signature,
      hasTimestamp: !!timestamp
    });
    res.statusCode = 400;
    return res.end("Bad request");
  }
  
  const isValid = await receiver.verifySignature(rawBody, signature, timestamp);
  if (!isValid) {
    log.error("Invalid Slack signature");
    res.statusCode = 401;
    return res.end("Unauthorized");
  }
  
  log.info("Slack signature verified successfully");
  
  try {
    // Parse the request based on content type
    let body;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = receiver.parseUrlEncoded(rawBody);
      log.debug("Parsed URL-encoded body", {
        command: body.command,
        userId: body.user_id,
        text: body.text
      });
      
      // Handle slash commands
      if (body.command === "/pto") {
        log.info("Processing /pto command directly");
        
        // Create the context object that Bolt expects
        const context = {
          ack: async () => {
            log.debug("Command acknowledged");
            return Promise.resolve();
          },
          body: body,
          client: app.client,
          command: body
        };
        
        // Get the registered command handler
        const commandHandlers = app._listeners?.slash_command || [];
        const ptoHandler = commandHandlers.find(h => h.commandName === "/pto");
        
        if (ptoHandler) {
          log.info("Found PTO handler, executing");
          await ptoHandler.listener(context);
        } else {
          // Fallback: execute the handler directly
          log.info("Executing PTO handler directly");
          const userId = body.user_id;
          const commandText = body.text;
          
          log.info("PTO command received (direct)", {
            userId,
            userName: body.user_name,
            commandText,
            channelId: body.channel_id,
            teamId: body.team_id
          });
          
          try {
            // Parse the PTO request
            const parsed = await parsePto(commandText);
            log.info("PTO text parsed successfully", { userId, parsed });
            
            // Get user info from Teams sheet
            const userInfo = await getUserInfo(userId);
            if (!userInfo) {
              log.error("User not found in Teams sheet", { userId });
              await app.client.chat.postMessage({
                channel: userId,
                text: "❌ Sorry, I couldn't find your information in the system. Please contact HR to be added to the Teams sheet."
              });
              res.statusCode = 200;
              res.end("");
              return;
            }
            
            // Get user's balance
            const bal = await getBalance(userId);
            log.info("User balance retrieved", { userId, balance: bal });
            
            // Check if user has sufficient balance
            if (bal.remaining <= 0) {
              log.warn("User has insufficient PTO balance", { userId, balance: bal });
              
              await app.client.chat.postMessage({
                channel: userId,
                text: `❌ Sorry, you don't have enough PTO balance.\n\n*Your balance:*\n• Annual allowance: ${bal.allowance} days\n• Already taken: ${bal.taken} days\n• Remaining: ${bal.remaining} days`
              });
              res.statusCode = 200;
              res.end("");
              return;
            }
            
            // Calculate days requested
            const startDate = new Date(parsed.start);
            const endDate = new Date(parsed.end);
            const daysRequested = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
            
            if (daysRequested > bal.remaining) {
              log.warn("User requesting more days than available", { 
                userId, 
                daysRequested, 
                remaining: bal.remaining 
              });
              
              await app.client.chat.postMessage({
                channel: userId,
                text: `❌ You're requesting ${daysRequested} days but only have ${bal.remaining} days remaining.\n\n*Your balance:*\n• Annual allowance: ${bal.allowance} days\n• Already taken: ${bal.taken} days\n• Remaining: ${bal.remaining} days`
              });
              res.statusCode = 200;
              res.end("");
              return;
            }
            
            // Log the request to Google Sheets
            await logRequest({ 
              user: userId, 
              start: parsed.start, 
              end: parsed.end, 
              reason: parsed.reason, 
              manager: userInfo.managerId 
            });
            log.info("Request logged to sheets successfully", { userId });
            
            // Send confirmation to the requester
            await app.client.chat.postMessage({
              channel: userId,
              text: `✅ *PTO Request Submitted!*\n\n*Details:*\n• Dates: ${parsed.start} to ${parsed.end} (${daysRequested} days)\n• Reason: ${parsed.reason}\n• Team: ${userInfo.team}\n• Manager: <@${userInfo.managerId}>\n\n*Your balance after approval:*\n• Current remaining: ${bal.remaining} days\n• After this request: ${bal.remaining - daysRequested} days\n\nYour request has been sent to your manager for approval. You'll be notified once they take action.`
            });
            log.info("Confirmation message sent to requester", { userId });
            
            // Send approval request to manager
            const managerMessage = {
              channel: userInfo.managerId,
              text: `📋 *New PTO Request*`,
              blocks: [
                { 
                  type: "section",
                  text: { 
                    type: "mrkdwn", 
                    text: `📋 *New PTO Request*\n\n*Employee:* ${userInfo.name} (<@${userId}>)\n*Team:* ${userInfo.team}\n*Dates:* ${parsed.start} to ${parsed.end} (${daysRequested} days)\n*Reason:* ${parsed.reason}\n\n*Employee's Balance:*\n• Current remaining: ${bal.remaining} days\n• After approval: ${bal.remaining - daysRequested} days` 
                  } 
                },
                {
                  type: "actions",
                  elements: [
                    { 
                      type: "button", 
                      style: "primary", 
                      text: { type: "plain_text", text: "✅ Approve" },
                      value: JSON.stringify({ user: userId, start: parsed.start, end: parsed.end }), 
                      action_id: "approve" 
                    },
                    { 
                      type: "button", 
                      style: "danger", 
                      text: { type: "plain_text", text: "❌ Deny" },
                      value: JSON.stringify({ user: userId, start: parsed.start, end: parsed.end }), 
                      action_id: "deny" 
                    }
                  ]
                }
              ]
            };
            
            await app.client.chat.postMessage(managerMessage);
            log.info("Approval request sent to manager", { 
              userId, 
              managerId: userInfo.managerId 
            });
            
            // Also notify HR for visibility (optional)
            const hrId = process.env.HR_SLACK_ID;
            if (hrId && hrId !== userInfo.managerId) {
              await app.client.chat.postMessage({
                channel: hrId,
                text: `📊 *FYI - New PTO Request*\n\n*Employee:* ${userInfo.name} (<@${userId}>)\n*Team:* ${userInfo.team}\n*Manager:* <@${userInfo.managerId}>\n*Dates:* ${parsed.start} to ${parsed.end} (${daysRequested} days)\n*Reason:* ${parsed.reason}\n\n_Manager has been notified for approval._`
              });
              log.info("HR notified of PTO request", { hrId });
            }
            
          } catch (error) {
            log.error("Error processing PTO command", {
              userId,
              commandText,
              error: error.message,
              stack: error.stack
            });
            
            await app.client.chat.postMessage({
              channel: userId,
              text: "❌ Sorry, there was an error processing your request. Please try again or contact IT support."
            });
          }
        }
        
        // Return immediate 200 OK to Slack
        res.statusCode = 200;
        res.end("");
        return;
      }
    } else if (contentType.includes("application/json")) {
      body = JSON.parse(rawBody);
      log.debug("Parsed JSON body", { type: body.type });
      
      // Handle event callbacks (messages)
      if (body.type === "event_callback") {
        log.info("Processing event callback", {
          eventType: body.event?.type,
          eventSubtype: body.event?.subtype,
          userId: body.event?.user,
          text: body.event?.text
        });
        
        // Handle message events (for "yes" confirmation)
        if (body.event?.type === "message" && !body.event?.subtype) {
          const message = body.event;
          
          // Check if message is "yes" and has metadata
          if (message.text && /^yes$/i.test(message.text)) {
            log.info("Potential 'yes' confirmation received", {
              user: message.user,
              channel: message.channel,
              hasMetadata: !!message.metadata
            });
            
            // Check for confirmation metadata
            if (message.metadata?.event_type === "awaiting_confirmation") {
              const { start, end, reason } = message.metadata.event_payload;
              const user = message.user;
              const manager = process.env.HR_SLACK_ID;
              
              log.info("PTO confirmation received via event", {
                user,
                start,
                end,
                reason,
                manager
              });
              
              try {
                await logRequest({ user, start, end, reason, manager });
                log.info("Request logged to sheets successfully", { user });
                
                const managerMessage = {
                  channel: manager,
                  text: `PTO request from <@${user}>`,
                  blocks: [
                    { 
                      type: "section",
                      text: { 
                        type: "mrkdwn", 
                        text: `*PTO Request*\nUser: <@${user}>\n${start} → ${end}\nReason: ${reason}` 
                      } 
                    },
                    {
                      type: "actions",
                      elements: [
                        { 
                          type: "button", 
                          style: "primary", 
                          text: { type: "plain_text", text: "Approve" },
                          value: JSON.stringify({ user, start, end }), 
                          action_id: "approve" 
                        },
                        { 
                          type: "button", 
                          style: "danger", 
                          text: { type: "plain_text", text: "Deny" },
                          value: JSON.stringify({ user }), 
                          action_id: "deny" 
                        }
                      ]
                    }
                  ]
                };
                
                await app.client.chat.postMessage(managerMessage);
                log.info("Approval request sent to manager", { user, manager });
                
                await app.client.chat.postMessage({ 
                  channel: user, 
                  text: "Request sent for approval. 🎉" 
                });
                log.info("Confirmation sent to user", { user });
              } catch (error) {
                log.error("Error processing PTO confirmation from event", {
                  user,
                  error: error.message,
                  stack: error.stack
                });
              }
            }
          }
        }
        
        res.statusCode = 200;
        res.end("");
        return;
      }
      
      // Handle interactive components (buttons)
      if (body.type === "interactive_message" || body.type === "block_actions") {
        log.info("Processing interactive component", {
          actionType: body.type,
          actions: body.actions?.map(a => a.action_id)
        });
        
        const actionId = body.actions?.[0]?.action_id;
        if (actionId === "approve" || actionId === "deny") {
          log.info(`Processing ${actionId} action directly`);
          
          const actionValue = JSON.parse(body.actions[0].value);
          
          if (actionId === "approve") {
            const { user, start, end } = actionValue;
            const approver = body.user.id;
            
            log.info("PTO approval action received (direct)", {
              approver,
              approverName: body.user.name,
              user,
              start,
              end
            });
            
            try {
              // Update the request status in Google Sheets
              await updateRequestStatus(user, start, end, "approved");
              log.info("Request status updated to approved in Sheets", { user });
              
              // Calculate days for the message
              const startDate = new Date(start);
              const endDate = new Date(end);
              const daysApproved = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
              
              // Notify the employee
              await app.client.chat.postMessage({ 
                channel: user, 
                text: `🎉 *Great news! Your PTO request has been approved!*\n\n*Approved dates:* ${start} to ${end} (${daysApproved} days)\n*Approved by:* <@${approver}>\n\nEnjoy your time off! Your PTO balance has been updated.` 
              });
              log.info("Approval notification sent to user", { user });
              
              // Update the manager's message
              await app.client.chat.update({ 
                channel: body.channel.id, 
                ts: body.message.ts, 
                text: `✅ *PTO Request Approved*\n\nApproved by <@${approver}> at ${new Date().toLocaleString()}`, 
                blocks: [] 
              });
              log.info("Manager message updated with approval");
              
              // Notify HR if different from approver
              const hrId = process.env.HR_SLACK_ID;
              if (hrId && hrId !== approver) {
                await app.client.chat.postMessage({
                  channel: hrId,
                  text: `✅ *PTO Approved*\n\n*Employee:* <@${user}>\n*Dates:* ${start} to ${end} (${daysApproved} days)\n*Approved by:* <@${approver}>\n*Time:* ${new Date().toLocaleString()}\n\n_Employee's balance has been updated automatically._`
                });
                log.info("HR notified of approval", { hrId });
              }
            } catch (error) {
              log.error("Error processing approval", {
                error: error.message,
                stack: error.stack
              });
              
              await app.client.chat.postMessage({
                channel: approver,
                text: "⚠️ The approval was processed but there was an error updating the records. Please contact IT support."
              });
            }
          } else if (actionId === "deny") {
            const { user, start, end } = actionValue;
            const denier = body.user.id;
            
            log.info("PTO denial action received (direct)", {
              denier,
              denierName: body.user.name,
              user
            });
            
            try {
              // Update the request status in Google Sheets
              await updateRequestStatus(user, start, end, "denied");
              log.info("Request status updated to denied in Sheets", { user });
              
              // Notify the employee
              await app.client.chat.postMessage({ 
                channel: user, 
                text: `❌ *Your PTO request has been denied*\n\n*Requested dates:* ${start} to ${end}\n*Denied by:* <@${denier}>\n\nPlease speak with your manager if you have questions about this decision.` 
              });
              log.info("Denial notification sent to user", { user });
              
              // Update the manager's message
              await app.client.chat.update({ 
                channel: body.channel.id, 
                ts: body.message.ts, 
                text: `❌ *PTO Request Denied*\n\nDenied by <@${denier}> at ${new Date().toLocaleString()}`, 
                blocks: [] 
              });
              log.info("Manager message updated with denial");
              
              // Notify HR if different from denier
              const hrId = process.env.HR_SLACK_ID;
              if (hrId && hrId !== denier) {
                await app.client.chat.postMessage({
                  channel: hrId,
                  text: `❌ *PTO Denied*\n\n*Employee:* <@${user}>\n*Dates:* ${start} to ${end}\n*Denied by:* <@${denier}>\n*Time:* ${new Date().toLocaleString()}`
                });
                log.info("HR notified of denial", { hrId });
              }
            } catch (error) {
              log.error("Error processing denial", {
                error: error.message,
                stack: error.stack
              });
              
              await app.client.chat.postMessage({
                channel: denier,
                text: "⚠️ The denial was processed but there was an error updating the records. Please contact IT support."
              });
            }
          }
        }
        
        res.statusCode = 200;
        res.end("");
        return;
      }
    }
    
    // For any unhandled request types
    log.warn("Unhandled request type", {
      contentType,
      bodyType: body?.type,
      command: body?.command
    });
    
    res.statusCode = 200;
    res.end("");
    
  } catch (error) {
    log.error("Error processing request", {
      error: error.message,
      stack: error.stack
    });
    
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal server error");
    }
  }
}
