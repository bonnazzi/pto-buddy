// pages/api/index.js
export const config = { api: { bodyParser: false } };

import { ENV } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import { verifySlackSignature } from "../../lib/security.js";
import {
  handleDirectMessage,
  handleConfirmPTO,
  handleCancelPTO,
  handleApprovePTO,
  handleDenyPTO,
} from "../../lib/handlers.js";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function parseForm(bodyStr) {
  const params = new URLSearchParams(bodyStr);
  const result = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(404).end("Not found");
    return;
  }

  const rawBody = await readRawBody(req);
  const contentType = req.headers["content-type"] || "";
  const signature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];

  // URL Verification shortcut (Slack sends JSON)
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(rawBody);
      if (payload.type === "url_verification" && payload.challenge) {
        res.status(200).setHeader("Content-Type", "text/plain").end(payload.challenge);
        return;
      }
    } catch { /* ignore */ }
  }

  // Security: verify Slack signature
  const valid = verifySlackSignature({
    rawBody, signature, timestamp, signingSecret: ENV.SLACK_SIGNING_SECRET,
  });
  if (!valid) {
    res.status(401).end("Unauthorized");
    return;
  }

  // Immediate ACK to Slack (avoid 3s timeout)
  res.status(200).end("");

  // Process asynchronously (idempotent operations mitigate Slack retries)
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = parseForm(rawBody);

      // Interactivity payload
      if (form.payload) {
        const payload = JSON.parse(form.payload);
        const actionId = payload.actions?.[0]?.action_id;

        logger.info("Interactive payload", { actionId });

        if (actionId === "confirm_pto") {
          await handleConfirmPTO(payload);
        } else if (actionId === "cancel_pto") {
          await handleCancelPTO(payload);
        } else if (actionId === "approve_pto") {
          await handleApprovePTO(payload);
        } else if (actionId === "deny_pto") {
          await handleDenyPTO(payload);
        }
      }
    } else if (contentType.includes("application/json")) {
      const body = JSON.parse(rawBody);

      if (body.type === "event_callback") {
        const event = body.event;
        logger.info("Event callback", { type: event?.type });

        if (event?.type === "message" && !event.bot_id && event.channel_type === "im") {
          await handleDirectMessage(event);
        }
      }
    }
  } catch (err) {
    logger.error("Async processing error", { error: err.message, stack: err.stack });
  }
}
