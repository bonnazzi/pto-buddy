// lib/sheets.js
import { google } from "googleapis";
import { ENV } from "./env.js";
import { logger } from "./logger.js";

const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: ENV.GCP_JSON,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const spreadsheetId = ENV.SPREADSHEET_ID;

// Sheet columns:
// A timestamp | B user_id | C user_name | D start | E end | F business_days
// G reason    | H status  | I manager_id| J manager_name | K request_id
// L decision_ts | M approver_id

const RANGE_DATA = "PTO_Requests!A2:M10000";
const APPEND_RANGE = "PTO_Requests!A2:M2";

function toRow(obj) {
  return [
    obj.timestamp,
    obj.userId,
    obj.userName,
    obj.start,
    obj.end,
    obj.businessDays,
    obj.reason,
    obj.status,
    obj.managerId,
    obj.managerName,
    obj.requestId,
    obj.decisionTs || "",
    obj.approverId || "",
  ];
}

function fromRow(r) {
  return {
    timestamp: r[0],
    userId: r[1],
    userName: r[2],
    start: r[3],
    end: r[4],
    businessDays: Number(r[5] || 0),
    reason: r[6] || "",
    status: r[7] || "",
    managerId: r[8] || "",
    managerName: r[9] || "",
    requestId: r[10] || "",
    decisionTs: r[11] || "",
    approverId: r[12] || "",
  };
}

export async function getUserPTOHistory(userId, allowanceDays) {
  const client = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    auth: client, spreadsheetId, range: RANGE_DATA,
  });
  const rows = (res.data.values || []).map(fromRow);

  const now = new Date();
  const year = now.getUTCFullYear();
  const approvedAll = rows.filter(r => r.userId === userId && r.status === "approved");

  const approvedThisYear = approvedAll.filter(r => {
    const ts = new Date(r.timestamp);
    return ts.getUTCFullYear() === year;
  });

  const totalDaysUsed = approvedThisYear.reduce((sum, r) => sum + (Number(r.businessDays) || 0), 0);

  // Average requests per month over last 12 months
  const oneYearAgo = new Date(Date.UTC(year - 1, now.getUTCMonth(), now.getUTCDate()));
  const recent = approvedAll.filter(r => new Date(r.timestamp) > oneYearAgo);
  const avgPerMonth = Number((recent.length / 12).toFixed(1));

  const lastReq = approvedAll.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  return {
    totalRequests: approvedAll.length,
    lastRequestDate: lastReq ? lastReq.timestamp : null,
    totalDaysUsed,
    avgRequestsPerMonth: avgPerMonth,
    daysRemaining: Math.max(0, allowanceDays - totalDaysUsed),
  };
}

export async function getRequestById(requestId) {
  if (!requestId) return null;
  const client = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    auth: client, spreadsheetId, range: RANGE_DATA,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => r[10] === requestId);
  if (idx === -1) return null;
  return { rowIndex: idx + 2, data: fromRow(rows[idx]) }; // +2 because data starts at row 2
}

export async function ensureRequestRow(rowObj) {
  const existing = await getRequestById(rowObj.requestId);
  if (existing) {
    logger.info("Request already exists, skipping append", { requestId: rowObj.requestId });
    return existing;
  }
  const client = await auth.getClient();
  await sheets.spreadsheets.values.append({
    auth: client,
    spreadsheetId,
    range: APPEND_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [toRow(rowObj)] },
  });
  return await getRequestById(rowObj.requestId);
}

export async function updateRequestStatusById(requestId, newStatus, approverId) {
  const found = await getRequestById(requestId);
  if (!found) return false;

  const { rowIndex } = found;
  const decisionTs = new Date().toISOString();
  const client = await auth.getClient();

  // Update H (status), L (decision_ts), M (approver_id)
  await sheets.spreadsheets.values.batchUpdate({
    auth: client,
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `PTO_Requests!H${rowIndex}`, values: [[newStatus]] },
        { range: `PTO_Requests!L${rowIndex}`, values: [[decisionTs]] },
        { range: `PTO_Requests!M${rowIndex}`, values: [[approverId]] },
      ],
    },
  });

  return true;
}
