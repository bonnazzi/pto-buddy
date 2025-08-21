// lib/slackClient.js
import { WebClient } from "@slack/web-api";
import { ENV } from "./env.js";

export const slack = new WebClient(ENV.SLACK_BOT_TOKEN);
