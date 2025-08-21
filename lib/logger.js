// lib/logger.js
function redact(obj) {
  try {
    const s = JSON.stringify(obj);
    return s
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted-email>")
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "<redacted-token>");
  } catch {
    return "<unserializable>";
  }
}

function log(level, message, data) {
  const ts = new Date().toISOString();
  if (data === undefined) {
    console[level](`[${level.toUpperCase()}] ${ts} - ${message}`);
  } else {
    console[level](
      `[${level.toUpperCase()}] ${ts} - ${message} ${redact(data)}`
    );
  }
}

export const logger = {
  info: (m, d) => log("log", m, d),
  warn: (m, d) => log("warn", m, d),
  error: (m, d) => log("error", m, d),
  debug: (m, d) => log("log", m, d),
};
