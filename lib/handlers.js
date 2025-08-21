// lib/handlers.js
import { slack } from "./slackClient.js";
import { logger } from "./logger.js";
import { ENV } from "./env.js";
import { calculateBusinessDays } from "./date.js";
import { parsePTORequest } from "./nlp.js";
import {
  getUserPTOHistory,
  ensureRequestRow,
  updateRequestStatusById,
  getRequestById,
} from "./sheets.js";

function getManagerId(/* userId */) {
  // Simple default manager; replace with lookup if needed.
  return ENV.HR_SLACK_ID || "U07T2QXUZPL";
}

async function getSlackUserInfo(userId) {
  try {
    const res = await slack.users.info({ user: userId });
    const u = res.user || {};
    return {
      id: userId,
      name: u.real_name || u.name || "Unknown",
      email: u.profile?.email || "",
    };
  } catch (err) {
    logger.error("Failed to get Slack user", { userId, error: err.message });
    return { id: userId, name: "Unknown", email: "" };
  }
}

export async function handleDirectMessage(event) {
  const userId = event.user;
  const text = event.text || "";
  logger.info("DM received", { userId });

  try {
    const userInfo = await getSlackUserInfo(userId);
    const todayISO = new Date().toISOString().split("T")[0];
    const pto = await parsePTORequest(text, todayISO);
    const businessDays = calculateBusinessDays(pto.start, pto.end);

    const history = await getUserPTOHistory(userId, ENV.PTO_ANNUAL_ALLOWANCE);
    if (businessDays > history.daysRemaining) {
      await slack.chat.postMessage({
        channel: event.channel,
        text: `❌ You're requesting ${businessDays} days but only have ${history.daysRemaining} remaining this year.`,
      });
      return;
    }

    await slack.chat.postMessage({
      channel: event.channel,
      text: "Please confirm your PTO request",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*Please confirm your PTO request:*\n` +
              `📅 *Dates:* ${pto.start} → ${pto.end}\n` +
              `📊 *Business days:* ${businessDays}\n` +
              `📝 *Reason:* ${pto.reason}\n` +
              `💰 *Balance after approval:* ${history.daysRemaining - businessDays}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "confirm_pto",
              style: "primary",
              text: { type: "plain_text", text: "✅ Confirm Request" },
              value: JSON.stringify({
                userId,
                userName: userInfo.name,
                start: pto.start,
                end: pto.end,
                businessDays,
                reason: pto.reason,
                history, // contains daysRemaining, lastRequestDate, etc.
              }),
            },
            {
              type: "button",
              action_id: "cancel_pto",
              style: "danger",
              text: { type: "plain_text", text: "❌ Cancel" },
              value: "{}",
            },
          ],
        },
      ],
    });
  } catch (err) {
    logger.error("Error processing PTO DM", { error: err.message });
    await slack.chat.postMessage({
      channel: event.channel,
      text:
        `❌ I couldn't understand your request.\n` +
        `Try: "I need next Monday to Friday off for vacation" or "tomorrow for a doctor appointment".`,
    });
  }
}

export async function handleConfirmPTO(body) {
  const action = body.actions?.[0];
  if (!action) return;
  const payload = JSON.parse(action.value);

  const managerId = getManagerId(payload.userId);
  const managerInfo = await getSlackUserInfo(managerId);

  // Generate idempotent request_id
  const requestId = crypto.randomUUID();

  // Insert row (idempotent)
  await ensureRequestRow({
    requestId,
    timestamp: new Date().toISOString(),
    userId: payload.userId,
    userName: payload.userName,
    start: payload.start,
    end: payload.end,
    businessDays: payload.businessDays,
    reason: payload.reason,
    status: "pending",
    managerId,
    managerName: managerInfo.name,
  });

  const daysSinceLast =
    payload.history.lastRequestDate
      ? Math.floor(
          (Date.now() - new Date(payload.history.lastRequestDate).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null;

  // Notify manager
  await slack.chat.postMessage({
    channel: managerId,
    text: `New PTO request from ${payload.userName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*New PTO Request*\n` +
            `👤 *Employee:* ${payload.userName} (<@${payload.userId}>)\n` +
            `📅 *Dates:* ${payload.start} → ${payload.end}\n` +
            `📊 *Business days:* ${payload.businessDays}\n` +
            `📝 *Reason:* ${payload.reason}\n\n` +
            `*Context*\n` +
            `• Current balance: ${payload.history.daysRemaining}\n` +
            `• After approval: ${payload.history.daysRemaining - payload.businessDays}\n` +
            `• Days since last request: ${daysSinceLast ?? "N/A"}\n` +
            `• Avg requests/month: ${payload.history.avgRequestsPerMonth}\n` +
            `• Total days used this year: ${payload.history.totalDaysUsed}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "approve_pto",
            style: "primary",
            text: { type: "plain_text", text: "✅ Approve" },
            value: JSON.stringify({ requestId }),
          },
          {
            type: "button",
            action_id: "deny_pto",
            style: "danger",
            text: { type: "plain_text", text: "❌ Deny" },
            value: JSON.stringify({ requestId }),
          },
        ],
      },
    ],
  });

  // Update the employee's message (clear blocks)
  await slack.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text:
      "✅ Your PTO request has been submitted for approval. You'll be notified once your manager reviews it.",
    blocks: [],
  });
}

export async function handleCancelPTO(body) {
  await slack.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: "❌ PTO request cancelled.",
    blocks: [],
  });
}

async function authorizeManager(requestId, actorId, channelId) {
  const req = await getRequestById(requestId);
  if (!req) return { ok: false, reason: "Request not found" };
  const expected = req.data.managerId;
  if (actorId !== expected) return { ok: false, expected };
  return { ok: true, req };
}

export async function handleApprovePTO(body) {
  const actorId = body.user.id;
  const { requestId } = JSON.parse(body.actions?.[0]?.value || "{}");

  const authz = await authorizeManager(requestId, actorId, body.channel?.id);
  if (!authz.ok) {
    await slack.chat.postEphemeral({
      channel: body.channel.id,
      user: actorId,
      text: "You are not authorized to approve this request.",
    });
    return;
  }

  const ok = await updateRequestStatusById(requestId, "approved", actorId);
  if (!ok) {
    await slack.chat.postMessage({
      channel: actorId,
      text: "❌ Error approving request. Please check the Google Sheet.",
    });
    return;
  }

  const row = (await getRequestById(requestId))?.data;
  await slack.chat.postMessage({
    channel: row.userId,
    text:
      `✅ Your PTO was approved!\n` +
      `📅 *Dates:* ${row.start} → ${row.end}\n` +
      `📊 *Business days:* ${row.businessDays}\n` +
      `✅ *Approved by:* <@${actorId}>. Enjoy! 🎉`,
  });

  await slack.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `✅ PTO request for ${row.userName} has been approved.`,
    blocks: [],
  });
}

export async function handleDenyPTO(body) {
  const actorId = body.user.id;
  const { requestId } = JSON.parse(body.actions?.[0]?.value || "{}");

  const authz = await authorizeManager(requestId, actorId, body.channel?.id);
  if (!authz.ok) {
    await slack.chat.postEphemeral({
      channel: body.channel.id,
      user: actorId,
      text: "You are not authorized to deny this request.",
    });
    return;
  }

  const ok = await updateRequestStatusById(requestId, "denied", actorId);
  if (!ok) {
    await slack.chat.postMessage({
      channel: actorId,
      text: "❌ Error denying request. Please check the Google Sheet.",
    });
    return;
  }

  const row = (await getRequestById(requestId))?.data;
  await slack.chat.postMessage({
    channel: row.userId,
    text:
      `❌ Your PTO request was denied.\n` +
      `📅 *Dates:* ${row.start} → ${row.end}\n` +
      `❌ *Denied by:* <@${actorId}>.\n` +
      `Please speak with your manager if you have questions.`,
  });

  await slack.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `❌ PTO request for ${row.userName} has been denied.`,
    blocks: [],
  });
}
