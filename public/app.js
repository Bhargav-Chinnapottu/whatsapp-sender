/**
 * WhatsApp Contact Sender — frontend
 *
 * Wires the 4-step UI to the backend API:
 *   1. Upload Excel  -> POST /api/upload           (preview contacts)
 *   2. Compose       -> (local only)
 *   3. Connect       -> POST /api/connect + SSE /api/events (status + QR)
 *   4. Send          -> POST /api/send + SSE progress
 *
 * Live updates (status, qr, progress) arrive over a Server-Sent Events
 * stream at /api/events.
 */

"use strict";

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------
const fileInput = document.getElementById("fileInput");
const uploadStatus = document.getElementById("uploadStatus");
const previewWrap = document.getElementById("previewWrap");

// Step 1 mode toggle + manual entry
const modeExcelBtn = document.getElementById("modeExcelBtn");
const modeManualBtn = document.getElementById("modeManualBtn");
const excelMode = document.getElementById("excelMode");
const manualMode = document.getElementById("manualMode");
const manualInput = document.getElementById("manualInput");
const manualParseBtn = document.getElementById("manualParseBtn");
const manualStatus = document.getElementById("manualStatus");
const countTotal = document.getElementById("countTotal");
const countValid = document.getElementById("countValid");
const countInvalid = document.getElementById("countInvalid");
const previewTableBody = document.querySelector("#previewTable tbody");

const messageInput = document.getElementById("messageInput");
const minDelayInput = document.getElementById("minDelay");
const maxDelayInput = document.getElementById("maxDelay");

const connectBtn = document.getElementById("connectBtn");
const waStatus = document.getElementById("waStatus");
const qrWrap = document.getElementById("qrWrap");
const qrImg = document.getElementById("qrImg");

const sendBtn = document.getElementById("sendBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const logList = document.getElementById("log");

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let contacts = []; // parsed contacts from the uploaded file
let waState = "disconnected";
let sending = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a line to the activity log. kind = "ok" | "fail" | "info". */
function log(message, kind = "info") {
  const li = document.createElement("li");
  li.className = kind;
  const time = new Date().toLocaleTimeString();
  li.textContent = `[${time}] ${message}`;
  logList.appendChild(li);
  // Keep the newest entry in view.
  li.scrollIntoView({ block: "nearest" });
}

/** Only valid contacts (those with a usable WhatsApp id) can be messaged. */
function validContacts() {
  return contacts.filter((c) => c.valid);
}

/** Enable the Send button only when connected, not already sending, and
 *  there is at least one valid contact plus a non-empty message. */
function refreshSendButton() {
  const ready =
    waState === "ready" &&
    !sending &&
    validContacts().length > 0 &&
    messageInput.value.trim().length > 0;
  sendBtn.disabled = !ready;
}

/** Human-readable label + CSS modifier for a given connection state. */
function describeState(state, error) {
  switch (state) {
    case "initializing":
      return { text: "Starting WhatsApp session…", cls: "" };
    case "qr":
      return { text: "Scan the QR code with your phone.", cls: "" };
    case "authenticated":
      return { text: "Authenticated, loading…", cls: "" };
    case "ready":
      return { text: "Connected and ready.", cls: "ready" };
    case "disconnected":
    default:
      return { text: error ? `Not connected — ${error}` : "Not connected", cls: error ? "error" : "" };
  }
}

function applyState(state, error) {
  waState = state;
  const { text, cls } = describeState(state, error);
  waStatus.textContent = text;
  waStatus.className = `wa-status ${cls}`.trim();

  // The QR image is only relevant while we are waiting for a scan.
  if (state !== "qr") {
    qrWrap.hidden = true;
    qrImg.removeAttribute("src");
  }

  connectBtn.disabled = state === "initializing" || state === "qr" ||
    state === "authenticated" || state === "ready";

  refreshSendButton();
}

// ---------------------------------------------------------------------------
// Step 1: Upload + preview
// ---------------------------------------------------------------------------
fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  uploadStatus.textContent = `Parsing "${file.name}"…`;
  previewWrap.hidden = true;

  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed.");

    contacts = Array.isArray(data.contacts) ? data.contacts : [];
    renderPreview(data);
    uploadStatus.textContent = `Loaded ${data.total} row(s) from "${file.name}".`;
    log(`Uploaded "${file.name}" — ${data.valid}/${data.total} valid.`, "info");
  } catch (err) {
    contacts = [];
    previewWrap.hidden = true;
    uploadStatus.textContent = `Error: ${err.message}`;
    log(`Upload error: ${err.message}`, "fail");
  }
  refreshSendButton();
});

function renderPreview(data) {
  const total = data.total || 0;
  const valid = data.valid || 0;
  const invalid = total - valid;

  countTotal.textContent = `${total} total`;
  countValid.textContent = `${valid} valid`;
  countInvalid.textContent = `${invalid} invalid`;
  countInvalid.hidden = invalid === 0;

  previewTableBody.innerHTML = "";
  contacts.forEach((c, i) => {
    const tr = document.createElement("tr");
    if (!c.valid) tr.className = "row-invalid";
    tr.appendChild(cell(String(i + 1)));
    tr.appendChild(cell(c.name));
    tr.appendChild(cell(c.phone));
    tr.appendChild(cell(c.valid ? "✓ valid" : "✗ invalid"));
    previewTableBody.appendChild(tr);
  });

  previewWrap.hidden = total === 0;
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// ---------------------------------------------------------------------------
// Step 1b: Mode toggle (Excel vs manual) + manual entry
// ---------------------------------------------------------------------------
function setMode(mode) {
  const manual = mode === "manual";
  excelMode.hidden = manual;
  manualMode.hidden = !manual;

  modeExcelBtn.classList.toggle("active", !manual);
  modeManualBtn.classList.toggle("active", manual);
  modeExcelBtn.setAttribute("aria-selected", String(!manual));
  modeManualBtn.setAttribute("aria-selected", String(manual));

  // Switching mode clears the current contact list to avoid mixing sources.
  contacts = [];
  previewWrap.hidden = true;
  uploadStatus.textContent = "";
  manualStatus.textContent = "";
  if (!manual) fileInput.value = "";
  refreshSendButton();
}

modeExcelBtn.addEventListener("click", () => setMode("excel"));
modeManualBtn.addEventListener("click", () => setMode("manual"));

manualParseBtn.addEventListener("click", async () => {
  const text = manualInput.value.trim();
  if (!text) {
    manualStatus.textContent = "Enter at least one contact.";
    previewWrap.hidden = true;
    contacts = [];
    refreshSendButton();
    return;
  }

  manualStatus.textContent = "Checking numbers…";
  try {
    const res = await fetch("/api/parse-manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not parse contacts.");

    contacts = Array.isArray(data.contacts) ? data.contacts : [];
    renderPreview(data);
    manualStatus.textContent = `Added ${data.total} contact(s) — ${data.valid} valid.`;
    log(`Manually added ${data.valid}/${data.total} valid contact(s).`, "info");
  } catch (err) {
    contacts = [];
    previewWrap.hidden = true;
    manualStatus.textContent = `Error: ${err.message}`;
    log(`Manual entry error: ${err.message}`, "fail");
  }
  refreshSendButton();
});

// ---------------------------------------------------------------------------
// Step 2: Compose (re-evaluate Send availability as the user types)
// ---------------------------------------------------------------------------
messageInput.addEventListener("input", refreshSendButton);

// ---------------------------------------------------------------------------
// Step 3: Connect + live status via SSE
// ---------------------------------------------------------------------------
connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  log("Connecting to WhatsApp…", "info");
  try {
    const res = await fetch("/api/connect", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start session.");
    applyState(data.state);
  } catch (err) {
    log(`Connect error: ${err.message}`, "fail");
    applyState("disconnected", err.message);
  }
});

function startEventStream() {
  const es = new EventSource("/api/events");

  es.addEventListener("status", (e) => {
    const data = safeParse(e.data);
    if (!data) return;
    applyState(data.state, data.error);
    if (data.error) log(data.error, "fail");
  });

  es.addEventListener("qr", (e) => {
    const data = safeParse(e.data);
    if (!data || !data.dataUrl) return;
    qrImg.src = data.dataUrl;
    qrWrap.hidden = false;
  });

  es.addEventListener("sendStart", (e) => {
    const data = safeParse(e.data) || {};
    sending = true;
    progressWrap.hidden = false;
    setProgress(0, data.total || 0);
    progressText.textContent = `Starting — 0 / ${data.total || 0}`;
    log(`Sending to ${data.total || 0} contact(s)…`, "info");
    refreshSendButton();
  });

  es.addEventListener("progress", (e) => {
    const data = safeParse(e.data);
    if (!data) return;
    setProgress(data.index, data.total);
    progressText.textContent =
      `${data.index} / ${data.total} — sent: ${data.sent}, failed: ${data.failed}`;
    if (data.status === "sent") {
      log(`✓ Sent to ${data.name}`, "ok");
    } else {
      log(`✗ Failed for ${data.name}: ${data.error || "unknown error"}`, "fail");
    }
  });

  es.addEventListener("waiting", (e) => {
    const data = safeParse(e.data) || {};
    if (data.ms) log(`Waiting ${(data.ms / 1000).toFixed(1)}s before next message…`, "info");
  });

  es.addEventListener("sendDone", (e) => {
    const data = safeParse(e.data) || {};
    sending = false;
    progressText.textContent =
      `Done — sent: ${data.sent}, failed: ${data.failed}, total: ${data.total}`;
    log(`Finished. Sent ${data.sent}, failed ${data.failed}.`, data.failed ? "fail" : "ok");
    refreshSendButton();
  });

  es.onerror = () => {
    // EventSource auto-reconnects; just note the hiccup.
    log("Event stream disconnected, retrying…", "info");
  };
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 4: Send
// ---------------------------------------------------------------------------
sendBtn.addEventListener("click", async () => {
  const message = messageInput.value.trim();
  const toSend = validContacts();
  if (!message || toSend.length === 0) return;

  const minDelay = Math.max(0, Number(minDelayInput.value) || 0) * 1000;
  const maxDelay = Math.max(minDelay, (Number(maxDelayInput.value) || 0) * 1000);

  const ok = window.confirm(
    `Send this message to ${toSend.length} contact(s)?\n\n` +
    `This uses an unofficial WhatsApp automation — only message people who expect to hear from you.`
  );
  if (!ok) return;

  sendBtn.disabled = true;
  logList.innerHTML = "";

  const payload = {
    message,
    contacts: toSend.map((c) => ({ name: c.name, waId: c.waId })),
    minDelay,
    maxDelay,
  };

  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Send failed.");
    // Progress now streams over SSE (sendStart/progress/sendDone).
  } catch (err) {
    log(`Send error: ${err.message}`, "fail");
    refreshSendButton();
  }
});

function setProgress(index, total) {
  const pct = total > 0 ? Math.round((index / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startEventStream();
applyState("disconnected");
refreshSendButton();
