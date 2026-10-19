/**
 * WhatsApp Contact Sender — backend
 *
 * Flow:
 *   1. User uploads an Excel file (.xlsx/.xls) with columns Name + Phone.
 *   2. Server parses it into a contact list and returns it for preview.
 *   3. User opens WhatsApp Web session; server streams a QR code to scan.
 *   4. Once authenticated, user triggers a send; server messages each contact
 *      with a configurable randomized delay and streams live progress.
 *
 * NOTE: whatsapp-web.js automates WhatsApp Web and is unofficial. Bulk sending
 * can get a number banned. This tool adds delays and a per-run cap to reduce
 * risk, but use responsibly and only message people who expect to hear from you.
 */

const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const qrcode = require("qrcode");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------
// When APP_PASSWORD is set, protect the whole app with HTTP Basic Auth. This
// matters when the server is exposed publicly: without it, anyone who reaches
// the URL could send WhatsApp messages through your linked account.
// If APP_PASSWORD is unset (e.g. local use), the gate is disabled.
const APP_USER = process.env.APP_USER || "admin";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function timingSafeEqual(a, b) {
  const crypto = require("crypto");
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      // Compare both fields in a timing-safe way.
      const okUser = timingSafeEqual(user, APP_USER);
      const okPass = timingSafeEqual(pass, APP_PASSWORD);
      if (okUser && okPass) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="WhatsApp Sender", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  });
  console.log("Access control: enabled (HTTP Basic Auth).");
} else {
  console.log("Access control: DISABLED (set APP_PASSWORD to require login).");
}

app.use(express.static(path.join(__dirname, "public")));

// Keep uploaded files in memory; they are small (~100 rows).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let waClient = null;
let waState = "disconnected"; // disconnected | initializing | qr | authenticated | ready
let lastQrDataUrl = null;

// Server-Sent Events subscribers for live status/progress updates.
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a phone value into WhatsApp's chat id form: "<digits>@c.us".
 * Strips spaces, dashes, parens and a leading "+". Does NOT guess country
 * codes — the number should already include one.
 */
function toWhatsAppId(rawPhone) {
  if (rawPhone === undefined || rawPhone === null) return null;
  let digits = String(rawPhone).trim();
  // Excel may read numbers in scientific notation; coerce if needed.
  if (/e\+?\d+/i.test(digits)) {
    const n = Number(digits);
    if (!Number.isNaN(n)) digits = n.toFixed(0);
  }
  digits = digits.replace(/[^\d]/g, ""); // keep digits only

  // All numbers are Indian (country code 91). Normalize to full E.164 form:
  //   - strip a leading "0" trunk prefix (e.g. 098765... -> 98765...)
  //   - prepend "91" when the number is a bare 10-digit mobile
  //   - leave already-prefixed "91XXXXXXXXXX" numbers as-is
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
  }
  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  // A valid Indian mobile in international form is 91 + 10 digits = 12 digits,
  // and Indian mobile numbers start with 6-9.
  if (!/^91[6-9]\d{9}$/.test(digits)) return null;
  return `${digits}@c.us`;
}

/** Find a column value by trying several case-insensitive header names. */
function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const match = keys.find((k) => k.trim().toLowerCase() === cand);
    if (match !== undefined) return row[match];
  }
  return undefined;
}

function parseContacts(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

  const contacts = [];
  for (const row of rows) {
    const name = pick(row, ["name", "leadname", "lead name", "lead", "nombre", "fullname", "full name", "contact"]);
    const phone = pick(row, ["phone", "phone number", "number", "mobile", "cell", "telephone", "tel", "whatsapp"]);
    const waId = toWhatsAppId(phone);
    contacts.push({
      name: name !== undefined && name !== "" ? String(name).trim() : "(no name)",
      phone: phone !== undefined ? String(phone).trim() : "",
      waId,
      valid: Boolean(waId),
    });
  }
  return contacts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace {name} (and {Name}) placeholders in the message template. */
function personalize(template, name) {
  return template.replace(/\{\s*name\s*\}/gi, name || "");
}

// ---------------------------------------------------------------------------
// WhatsApp client lifecycle
// ---------------------------------------------------------------------------
function initWhatsApp() {
  if (waClient) return; // already initializing/ready

  waState = "initializing";
  broadcast("status", { state: waState });

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wwebjs_auth") }),
    // whatsapp-web.js 1.34+ tracks a current WhatsApp Web build by default,
    // which fixes the older "stuck at authenticated, never ready" stall.
    // Give the initial client load/sync more time before giving up.
    authTimeoutMs: 120000,
    puppeteer: {
      headless: true,
      // In Docker we use the distro's Chromium (set via PUPPETEER_EXECUTABLE_PATH)
      // instead of the bundled one, which avoids missing-shared-library issues.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  waClient.on("qr", async (qr) => {
    waState = "qr";
    try {
      lastQrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 300 });
    } catch (e) {
      lastQrDataUrl = null;
    }
    broadcast("status", { state: waState });
    broadcast("qr", { dataUrl: lastQrDataUrl });
  });

  // Fired after auth while WhatsApp Web syncs chats. Surfaces progress so the
  // UI shows the client is working rather than appearing stuck.
  waClient.on("loading_screen", (percent, message) => {
    console.log(`[wa] loading ${percent}% — ${message}`);
    broadcast("status", { state: waState, loading: { percent: Number(percent) || 0, message } });
  });

  waClient.on("authenticated", () => {
    waState = "authenticated";
    lastQrDataUrl = null;
    broadcast("status", { state: waState });
  });

  waClient.on("ready", () => {
    waState = "ready";
    broadcast("status", { state: waState });
  });

  waClient.on("auth_failure", (msg) => {
    waState = "disconnected";
    broadcast("status", { state: waState, error: `Auth failure: ${msg}` });
  });

  waClient.on("disconnected", (reason) => {
    waState = "disconnected";
    lastQrDataUrl = null;
    broadcast("status", { state: waState, error: `Disconnected: ${reason}` });
    // Allow a fresh init next time.
    waClient = null;
  });

  waClient.initialize().catch((err) => {
    waState = "disconnected";
    waClient = null;
    broadcast("status", { state: waState, error: `Init error: ${err.message}` });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// SSE stream for status / qr / progress events.
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  sseClients.add(res);
  // Send current snapshot immediately.
  res.write(`event: status\ndata: ${JSON.stringify({ state: waState })}\n\n`);
  if (lastQrDataUrl) {
    res.write(`event: qr\ndata: ${JSON.stringify({ dataUrl: lastQrDataUrl })}\n\n`);
  }

  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Parse an uploaded Excel file into a contact list.
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }
  try {
    const contacts = parseContacts(req.file.buffer);
    const validCount = contacts.filter((c) => c.valid).length;
    res.json({ contacts, total: contacts.length, valid: validCount });
  } catch (e) {
    res.status(400).json({ error: `Could not parse file: ${e.message}` });
  }
});

/**
 * Parse manually-entered contacts into the same shape as /api/upload.
 * Accepts either:
 *   - { entries: [{ name, phone }, ...] }  (preferred)
 *   - { text: "Name, 9876543210\n9876543211\n..." }  (one contact per line)
 * Each line/entry may be "name, number" or just "number".
 */
app.post("/api/parse-manual", (req, res) => {
  const body = req.body || {};
  let rawEntries = [];

  if (Array.isArray(body.entries)) {
    rawEntries = body.entries.map((e) => ({
      name: e && e.name !== undefined ? e.name : "",
      phone: e && e.phone !== undefined ? e.phone : "",
    }));
  } else if (typeof body.text === "string") {
    rawEntries = body.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        // Split on the first comma/tab/semicolon: "name <sep> number".
        const m = line.split(/[,\t;]/);
        if (m.length >= 2) {
          // Last field is the phone; everything before is the name.
          const phone = m[m.length - 1].trim();
          const name = m.slice(0, m.length - 1).join(" ").trim();
          return { name, phone };
        }
        // Single token — treat as a phone number with no name.
        return { name: "", phone: line };
      });
  } else {
    return res.status(400).json({ error: "Provide 'entries' array or 'text' string." });
  }

  const contacts = rawEntries.map((e) => {
    const waId = toWhatsAppId(e.phone);
    return {
      name: e.name !== undefined && String(e.name).trim() !== "" ? String(e.name).trim() : "(no name)",
      phone: e.phone !== undefined ? String(e.phone).trim() : "",
      waId,
      valid: Boolean(waId),
    };
  });

  const validCount = contacts.filter((c) => c.valid).length;
  res.json({ contacts, total: contacts.length, valid: validCount });
});

// Start (or restart) the WhatsApp session to get a QR code.
app.post("/api/connect", (req, res) => {
  initWhatsApp();
  res.json({ state: waState });
});

app.get("/api/status", (req, res) => {
  res.json({ state: waState, hasQr: Boolean(lastQrDataUrl) });
});

// Send messages. Body: { message, contacts:[{name,waId}], minDelay, maxDelay }
let sending = false;
app.post("/api/send", async (req, res) => {
  if (waState !== "ready") {
    return res.status(409).json({ error: "WhatsApp is not connected yet. Scan the QR code first." });
  }
  if (sending) {
    return res.status(409).json({ error: "A send is already in progress." });
  }

  const { message, contacts, minDelay, maxDelay } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message text is required." });
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: "No contacts to send to." });
  }

  const minMs = Math.max(0, Number(minDelay) || 3000);
  const maxMs = Math.max(minMs, Number(maxDelay) || 8000);

  // Respond immediately; progress is streamed over SSE.
  res.json({ started: true, count: contacts.length });

  sending = true;
  let sent = 0;
  let failed = 0;
  broadcast("sendStart", { total: contacts.length });

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    const label = c.name || c.waId;
    try {
      if (!c.waId) throw new Error("invalid phone number");

      // Verify the number is actually on WhatsApp before sending.
      const numberId = await waClient.getNumberId(c.waId.replace("@c.us", ""));
      if (!numberId) throw new Error("not registered on WhatsApp");

      const text = personalize(message, c.name);
      await waClient.sendMessage(numberId._serialized, text);
      sent++;
      broadcast("progress", {
        index: i + 1,
        total: contacts.length,
        name: label,
        status: "sent",
        sent,
        failed,
      });
    } catch (err) {
      failed++;
      broadcast("progress", {
        index: i + 1,
        total: contacts.length,
        name: label,
        status: "failed",
        error: err.message,
        sent,
        failed,
      });
    }

    // Randomized delay between messages (skip after the last one).
    if (i < contacts.length - 1) {
      const wait = Math.floor(minMs + Math.random() * (maxMs - minMs));
      broadcast("waiting", { ms: wait });
      await sleep(wait);
    }
  }

  sending = false;
  broadcast("sendDone", { sent, failed, total: contacts.length });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Contact Sender running at http://localhost:${PORT}`);
});
