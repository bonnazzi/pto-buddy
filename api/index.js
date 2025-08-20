export const config = { api: { bodyParser: false } };

// --- Imports ---
import boltPkg from "@slack/bolt";
const { App, AwsLambdaReceiver } = boltPkg;

import gapiPkg from "googleapis";
const { google } = gapiPkg;

import fetch from "node-fetch";
import dotenv from "dotenv";
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

// --- AWS Lambda Receiver for Vercel (works with serverless) ---
log.info("Initializing AwsLambdaReceiver for serverless environment");
const awsLambdaReceiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: awsLambdaReceiver
});
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
  
  // Convert Vercel request to AWS Lambda format for Bolt
  const lambdaEvent = {
    body: rawBody,
    headers: req.headers,
    isBase64Encoded: false,
    httpMethod: req.method,
    path: req.url
  };
  
  log.debug("Lambda event created for Bolt", {
    httpMethod: lambdaEvent.httpMethod,
    path: lambdaEvent.path,
    hasBody: !!lambdaEvent.body,
    headers: Object.keys(lambdaEvent.headers)
  });
  
  try {
    // Process through Bolt's AWS Lambda receiver
    const response = await awsLambdaReceiver.start(lambdaEvent);
    
    log.info("Bolt processing complete", {
      statusCode: response.statusCode,
      hasBody: !!response.body
    });
    
    // Send Bolt's response back through Vercel
    res.statusCode = response.statusCode;
    
    if (response.headers) {
      Object.entries(response.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }
    
    res.end(response.body || "");
    
  } catch (error) {
    log.error("Error processing request through Bolt", {
      error: error.message,
      stack: error.stack
    });
    
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal server error");
    }
  }
}
