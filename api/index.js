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
      range: "Teams!A2:E1000"  // Extended to include Role column
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
      managerId: row[3], // Manager's Slack ID
      role: row[4] || 'Employee'  // Role (default to Employee if not set)
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

async function checkReportAccess(requesterId, scope = 'self') {
  const requesterInfo = await getUserInfo(requesterId);
  
  if (!requesterInfo) {
    return { allowed: false, reason: 'User not found in system' };
  }
  
  // Admin can see everything
  if (requesterInfo.role === 'Admin') {
    return { allowed: true, level: 'all', requesterInfo };
  }
  
  // Manager can see self and direct reports
  if (requesterInfo.role === 'Manager') {
    if (scope === 'self' || scope === 'team') {
      return { allowed: true, level: 'team', requesterInfo };
    }
    if (scope === 'all') {
      return { allowed: false, reason: 'Managers can only view their team data' };
    }
  }
  
  // Employee can only see self
  if (requesterInfo.role === 'Employee') {
    if (scope === 'self') {
      return { allowed: true, level: 'self', requesterInfo };
    }
    return { allowed: false, reason: 'Employees can only view their own data' };
  }
  
  return { allowed: false, reason: 'Invalid role' };
}

async function getTeamMembers(managerId) {
  log.info("Getting team members for manager", { managerId });
  
  try {
    const client = await auth.getClient();
    const result = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Teams!A2:E1000"
    });
    
    const rows = result.data.values || [];
    const teamMembers = rows
      .filter(r => r[3] === managerId)  // Manager ID is in column D
      .map(r => ({
        name: r[0],
        userId: r[1],
        team: r[2],
        role: r[4] || 'Employee'
      }));
    
    log.info("Team members retrieved", { 
      managerId, 
      teamCount: teamMembers.length 
    });
    
    return teamMembers;
  } catch (error) {
    log.error("Failed to get team members", {
      managerId,
      error: error.message
    });
    return [];
  }
}

async function getAllRequests(filterUserId = null, filterStatus = null) {
  log.info("Getting requests from Google Sheets", { filterUserId, filterStatus });
  
  try {
    const client = await auth.getClient();
    const result = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Requests!A2:G1000"
    });
    
    let requests = result.data.values || [];
    
    // Parse into objects
    requests = requests.map(r => ({
      timestamp: r[0],
      userId: r[1],
      start: r[2],
      end: r[3],
      reason: r[4],
      status: r[5],
      managerId: r[6]
    }));
    
    // Apply filters
    if (filterUserId) {
      if (Array.isArray(filterUserId)) {
        requests = requests.filter(r => filterUserId.includes(r.userId));
      } else {
        requests = requests.filter(r => r.userId === filterUserId);
      }
    }
    
    if (filterStatus) {
      requests = requests.filter(r => r.status === filterStatus);
    }
    
    log.info("Requests retrieved", { 
      totalCount: requests.length,
      filtered: !!filterUserId || !!filterStatus
    });
    
    return requests;
  } catch (error) {
    log.error("Failed to get requests", {
      error: error.message
    });
    return [];
  }
}

async function generateReport(userId, reportType, params = {}) {
  log.info("Generating report", { userId, reportType, params });
  
  const access = await checkReportAccess(userId, params.scope || 'self');
  
  if (!access.allowed) {
    return {
      success: false,
      message: `❌ Access Denied: ${access.reason}`
    };
  }
  
  const userInfo = access.requesterInfo;
  let reportData = {};
  
  switch (reportType) {
    case 'balance':
      if (access.level === 'all') {
        // Admin: get all balances
        const allUsers = await getAllUsers();
        const balances = await Promise.all(
          allUsers.map(async (u) => ({
            ...u,
            balance: await getBalance(u.userId)
          }))
        );
        reportData = { type: 'all_balances', data: balances };
      } else if (access.level === 'team') {
        // Manager: get team balances
        const teamMembers = await getTeamMembers(userId);
        const balances = await Promise.all(
          teamMembers.map(async (u) => ({
            ...u,
            balance: await getBalance(u.userId)
          }))
        );
        // Include manager's own balance
        balances.unshift({
          ...userInfo,
          balance: await getBalance(userId)
        });
        reportData = { type: 'team_balances', data: balances };
      } else {
        // Employee: get own balance
        const balance = await getBalance(userId);
        reportData = { type: 'personal_balance', data: { ...userInfo, balance } };
      }
      break;
      
    case 'requests':
      if (access.level === 'all') {
        // Admin: get all requests
        const requests = await getAllRequests(null, params.status);
        reportData = { type: 'all_requests', data: requests };
      } else if (access.level === 'team') {
        // Manager: get team requests
        const teamMembers = await getTeamMembers(userId);
        const teamIds = [userId, ...teamMembers.map(m => m.userId)];
        const requests = await getAllRequests(teamIds, params.status);
        reportData = { type: 'team_requests', data: requests };
      } else {
        // Employee: get own requests
        const requests = await getAllRequests(userId, params.status);
        reportData = { type: 'personal_requests', data: requests };
      }
      break;
      
    case 'upcoming':
      const today = new Date();
      const endDate = new Date();
      endDate.setDate(today.getDate() + (params.days || 7));
      
      let requests;
      if (access.level === 'all') {
        requests = await getAllRequests(null, 'approved');
      } else if (access.level === 'team') {
        const teamMembers = await getTeamMembers(userId);
        const teamIds = [userId, ...teamMembers.map(m => m.userId)];
        requests = await getAllRequests(teamIds, 'approved');
      } else {
        requests = await getAllRequests(userId, 'approved');
      }
      
      // Filter to upcoming dates
      const upcoming = requests.filter(r => {
        const start = new Date(r.start);
        const end = new Date(r.end);
        return (start <= endDate && end >= today);
      });
      
      reportData = { type: 'upcoming_pto', data: upcoming };
      break;
  }
  
  return {
    success: true,
    access: access.level,
    reportData
  };
}

async function getAllUsers() {
  log.info("Getting all users from Teams sheet");
  
  try {
    const client = await auth.getClient();
    const result = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Teams!A2:E1000"
    });
    
    const rows = result.data.values || [];
    const users = rows.map(r => ({
      name: r[0],
      userId: r[1],
      team: r[2],
      managerId: r[3],
      role: r[4] || 'Employee'
    }));
    
    log.info("All users retrieved", { userCount: users.length });
    return users;
  } catch (error) {
    log.error("Failed to get all users", { error: error.message });
    return [];
  }
}

async function parseReportQuery(text) {
  log.info("Parsing report query with OpenRouter", { inputText: text });
  
  const prompt = `Extract report request info from: "${text}". 
Identify the report type and parameters.
Types: balance, requests, upcoming, summary
Scope: self, team, all
Status: pending, approved, denied, all

Return JSON like:
{
  "type": "balance|requests|upcoming|summary",
  "scope": "self|team|all",
  "status": "pending|approved|denied|all",
  "days": 7,
  "format": "simple|detailed"
}

Examples:
"my balance" -> {"type":"balance","scope":"self"}
"team requests" -> {"type":"requests","scope":"team","status":"all"}
"pending approvals" -> {"type":"requests","scope":"team","status":"pending"}
"who's out next week" -> {"type":"upcoming","scope":"team","days":7}
"all employee balances" -> {"type":"balance","scope":"all"}`;
  
  const requestBody = {
    model: "openai/gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }]
  };
  
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content.trim());
    
    log.info("Report query parsed successfully", { parsed });
    return parsed;
  } catch (error) {
    log.error("Failed to parse report query", { error: error.message });
    // Default fallback
    return {
      type: 'balance',
      scope: 'self',
      status: 'all',
      format: 'simple'
    };
  }
}

async function formatReportWithLLM(reportData, format = 'simple') {
  log.info("Formatting report with LLM", { 
    reportType: reportData.type,
    dataCount: reportData.data?.length || 1
  });
  
  let prompt = `Format this PTO data into a clear, readable Slack message with appropriate emojis and formatting.\n\nData: ${JSON.stringify(reportData)}\n\n`;
  
  if (format === 'simple') {
    prompt += "Keep it concise with key information only. Use bullet points and bold for emphasis.";
  } else {
    prompt += "Provide a detailed report with insights and summaries. Include totals and patterns if relevant.";
  }
  
  const requestBody = {
    model: "openai/gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }]
  };
  
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await res.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    log.error("Failed to format report with LLM", { error: error.message });
    // Fallback to simple formatting
    return formatReportFallback(reportData);
  }
}

function formatReportFallback(reportData) {
  let message = "📊 *PTO Report*\n\n";
  
  switch (reportData.type) {
    case 'personal_balance':
      const b = reportData.data.balance;
      message += `*Your PTO Balance:*\n`;
      message += `• Annual allowance: ${b.allowance} days\n`;
      message += `• Used: ${b.taken} days\n`;
      message += `• Remaining: ${b.remaining} days\n`;
      break;
      
    case 'team_balances':
    case 'all_balances':
      message += `*PTO Balances:*\n`;
      reportData.data.forEach(user => {
        message += `\n*${user.name}* (${user.team})\n`;
        message += `• Remaining: ${user.balance.remaining}/${user.balance.allowance} days\n`;
      });
      break;
      
    case 'personal_requests':
    case 'team_requests':
    case 'all_requests':
      message += `*PTO Requests:*\n`;
      if (reportData.data.length === 0) {
        message += "No requests found.\n";
      } else {
        reportData.data.forEach(req => {
          message += `\n• ${req.start} to ${req.end}\n`;
          message += `  User: <@${req.userId}> | Status: ${req.status}\n`;
        });
      }
      break;
      
    case 'upcoming_pto':
      message += `*Upcoming PTO:*\n`;
      if (reportData.data.length === 0) {
        message += "No one is scheduled out.\n";
      } else {
        reportData.data.forEach(req => {
          message += `\n• <@${req.userId}>: ${req.start} to ${req.end}\n`;
          message += `  Reason: ${req.reason}\n`;
        });
      }
      break;
  }
  
  return message;
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
    
    // Calculate days taken (simplified - counting weekdays would be better)
    const startDate = new Date(start);
    const endDate = new Date(end);
    const daysTaken = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
    
    log.info("Days calculated for PTO", { start, end, daysTaken });
    
    // Get current balance
    const balanceResult = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId,
      range: "Balances!A2:C1000"
    });
    
    const rows = balanceResult.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === userId);
    
    if (rowIndex === -1) {
      log.error("User not found in Balances sheet for update", { userId });
      throw new Error(`User ${userId} not found in Balances sheet`);
    }
    
    const currentTaken = Number(rows[rowIndex][2]) || 0;
    const newTaken = currentTaken + daysTaken;
    
    // Update the taken_so_far column (C)
    const updateRange = `Balances!C${rowIndex + 2}`; // +2 because we start from row 2
    
    log.info("Updating balance in sheet", { 
      userId,
      updateRange,
      currentTaken,
      daysTaken,
      newTaken
    });
    
    const updateResult = await sheets.spreadsheets.values.update({
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
      newBalance: newTaken,
      updatedCells: updateResult.data.updatedCells,
      updatedRange: updateResult.data.updatedRange
    });
    
    return { daysTaken, previousBalance: currentTaken, newBalance: newTaken };
    
  } catch (error) {
    log.error("Failed to update balance", {
      userId,
      error: error.message,
      stack: error.stack
    });
    // Don't throw - we want the approval to succeed even if balance update fails
    // The error is logged and can be fixed manually
    return null;
  }
}

async function parsePto(text) {
  log.info("Parsing PTO request with OpenRouter", { inputText: text });
  
  const prompt = `Extract PTO info from: "${text}". 
Return JSON like {"start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"..."}.
If only one date, use it for both start and end.
If no specific dates are mentioned, use tomorrow as start and 3 days later as end.
Today's date is ${new Date().toISOString().split('T')[0]}.
Always return actual dates, never placeholders like "YYYY-MM-DD".`;
  
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
    
    // Validate the parsed dates
    if (parsedContent.start === "YYYY-MM-DD" || parsedContent.end === "YYYY-MM-DD") {
      log.warn("LLM returned placeholder dates, using defaults", { parsedContent });
      
      // Default to next Monday for a week if no dates specified
      const today = new Date();
      const daysUntilMonday = (8 - today.getDay()) % 7 || 7;
      const nextMonday = new Date(today);
      nextMonday.setDate(today.getDate() + daysUntilMonday);
      const nextFriday = new Date(nextMonday);
      nextFriday.setDate(nextMonday.getDate() + 4);
      
      parsedContent.start = nextMonday.toISOString().split('T')[0];
      parsedContent.end = nextFriday.toISOString().split('T')[0];
      parsedContent.reason = parsedContent.reason || "vacation";
    }
    
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
        text: body.text,
        hasPayload: !!body.payload
      });
      
      // Check if this is an interactive component (has payload)
      if (body.payload) {
        log.info("Processing interactive payload");
        const payload = JSON.parse(body.payload);
        log.debug("Parsed interactive payload", {
          type: payload.type,
          actions: payload.actions?.map(a => a.action_id)
        });
        
        // Handle block actions (button clicks)
        if (payload.type === "block_actions") {
          const actionId = payload.actions?.[0]?.action_id;
          const actionValue = JSON.parse(payload.actions[0].value);
          
          log.info(`Processing ${actionId} action from interactive payload`);
          
          if (actionId === "approve") {
            const { user, start, end } = actionValue;
            const approver = payload.user.id;
            
            log.info("PTO approval action received", {
              approver,
              approverName: payload.user.name,
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
                channel: payload.channel.id, 
                ts: payload.message.ts, 
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
            
            res.statusCode = 200;
            res.end("");
            return;
            
          } else if (actionId === "deny") {
            const { user, start, end } = actionValue;
            const denier = payload.user.id;
            
            log.info("PTO denial action received", {
              denier,
              denierName: payload.user.name,
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
                channel: payload.channel.id, 
                ts: payload.message.ts, 
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
            
            res.statusCode = 200;
            res.end("");
            return;
          }
        }
        
        // Return 200 for any other interactive payloads
        res.statusCode = 200;
        res.end("");
        return;
      }
      
      // Handle slash commands
      if (body.command === "/pto" || body.command === "/pto-report") {
        log.info(`Processing ${body.command} command directly`);
        
        if (body.command === "/pto-report") {
          // Handle report command
          const userId = body.user_id;
          const queryText = body.text || "my balance";
          
          log.info("PTO report command received", {
            userId,
            userName: body.user_name,
            queryText
          });
          
          try {
            // Parse the report query
            const query = await parseReportQuery(queryText);
            log.info("Report query parsed", { userId, query });
            
            // Generate the report
            const report = await generateReport(userId, query.type, query);
            
            if (!report.success) {
              await app.client.chat.postMessage({
                channel: userId,
                text: report.message
              });
              res.statusCode = 200;
              res.end("");
              return;
            }
            
            // Format the report
            const formattedReport = await formatReportWithLLM(
              report.reportData,
              query.format || 'simple'
            );
            
            // Send the report
            await app.client.chat.postMessage({
              channel: userId,
              text: formattedReport
            });
            
            log.info("Report sent successfully", {
              userId,
              reportType: query.type,
              accessLevel: report.access
            });
            
          } catch (error) {
            log.error("Error processing report command", {
              userId,
              queryText,
              error: error.message,
              stack: error.stack
            });
            
            await app.client.chat.postMessage({
              channel: userId,
              text: "❌ Sorry, there was an error generating your report. Please try again."
            });
          }
          
          res.statusCode = 200;
          res.end("");
          return;
        }
        
        // Original /pto command handling
        if (body.command === "/pto") {
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
            
            // Check if dates seem reasonable
            const requestStartDate = new Date(parsed.start);
            const requestEndDate = new Date(parsed.end);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (requestStartDate < today) {
              log.warn("Start date is in the past", { start: parsed.start });
              await app.client.chat.postMessage({
                channel: userId,
                text: `⚠️ The start date (${parsed.start}) appears to be in the past. Please submit a new request with future dates.\n\nExample: \`/pto next Monday to Friday for vacation\``
              });
              res.statusCode = 200;
              res.end("");
              return;
            }
            
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
            const daysRequested = Math.ceil((requestEndDate - requestStartDate) / (1000 * 60 * 60 * 24)) + 1;
            
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
            // First, try to open a conversation with the manager
            let managerChannel;
            try {
              const conversation = await app.client.conversations.open({
                users: userInfo.managerId
              });
              managerChannel = conversation.channel.id;
              log.info("Opened DM channel with manager", { 
                managerId: userInfo.managerId, 
                channelId: managerChannel 
              });
            } catch (error) {
              log.error("Failed to open DM with manager", {
                managerId: userInfo.managerId,
                error: error.message
              });
              
              // Notify the requester of the issue
              await app.client.chat.postMessage({
                channel: userId,
                text: `⚠️ I couldn't send the approval request to your manager (<@${userInfo.managerId}>). Please contact them directly or notify IT support.\n\nManager ID: ${userInfo.managerId}`
              });
              
              // Try to notify HR as backup
              const hrId = process.env.HR_SLACK_ID;
              if (hrId) {
                try {
                  const hrConversation = await app.client.conversations.open({
                    users: hrId
                  });
                  await app.client.chat.postMessage({
                    channel: hrConversation.channel.id,
                    text: `⚠️ *Manager Unreachable - Manual Approval Needed*\n\n*Employee:* ${userInfo.name} (<@${userId}>)\n*Manager:* <@${userInfo.managerId}>\n*Dates:* ${parsed.start} to ${parsed.end} (${daysRequested} days)\n*Reason:* ${parsed.reason}\n\nCouldn't send to manager's DM. Please handle manually.`
                  });
                  log.info("HR notified as backup for unreachable manager");
                } catch (hrError) {
                  log.error("Failed to notify HR as backup", { error: hrError.message });
                }
              }
              
              res.statusCode = 200;
              res.end("");
              return;
            }
            
            const managerMessage = {
              channel: managerChannel,
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
              managerId: userInfo.managerId,
              managerChannel 
            });
            
            // Also notify HR for visibility (optional)
            const hrId = process.env.HR_SLACK_ID;
            if (hrId && hrId !== userInfo.managerId) {
              try {
                const hrConversation = await app.client.conversations.open({
                  users: hrId
                });
                await app.client.chat.postMessage({
                  channel: hrConversation.channel.id,
                  text: `📊 *FYI - New PTO Request*\n\n*Employee:* ${userInfo.name} (<@${userId}>)\n*Team:* ${userInfo.team}\n*Manager:* <@${userInfo.managerId}>\n*Dates:* ${parsed.start} to ${parsed.end} (${daysRequested} days)\n*Reason:* ${parsed.reason}\n\n_Manager has been notified for approval._`
                });
                log.info("HR notified of PTO request", { hrId });
              } catch (hrError) {
                log.warn("Failed to notify HR", { error: hrError.message });
              }
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
        
        // Handle message events (for "yes" confirmation if needed)
        if (body.event?.type === "message" && !body.event?.subtype) {
          const message = body.event;
          log.debug("Message event received", {
            user: message.user,
            text: message.text,
            channel: message.channel
          });
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
