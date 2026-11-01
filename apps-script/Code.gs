/**
 * Member/Guest volunteer sign-up backend.
 *
 * Lives in a Google Sheet (Extensions > Apps Script) and is deployed as a web app.
 * The GitHub Pages site reads open slots with GET ?action=list and sends
 * sign-ups / cancellations with POST (JSON body sent as text/plain).
 *
 * Setup: see README.md. Set SITE_URL below to the GitHub Pages address.
 */

// The public sign-up page, e.g. "https://yourname.github.io/memberguest/"
const SITE_URL = "https://rodneyhoule.github.io/memberguest/";
const SIGNUPS_SHEET = "Signups";
const ROSTER_SHEET = "Roster";
const FROM_NAME = "Member/Guest Volunteers";
const DISCLAIMER = "This volunteer sign-up page is run by members of the tournament committee. " +
  "It is not an official Awbrey Glen Golf Club website and is not operated or endorsed by the club.";

const HEADERS = ["Timestamp", "Shift ID", "Day", "Role", "Time", "Meet At", "First Name", "Last Name",
  "Email", "Phone", "Token", "Agreed At", "Status"];
const COL = HEADERS.reduce(function (m, h, i) { m[h] = i; return m; }, {});

// ---------- Web app entry points ----------

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "list";
  if (action === "list") return json_(listFilled_());
  return json_({ ok: false, error: "Unknown action" });
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "Bad request" });
  }
  try {
    switch (p.action) {
      case "signup": return json_(signup_(p));
      case "mine":   return json_(mine_(p.token));
      case "cancel": return json_(cancel_(p.token, p.shiftId));
      case "resend": return json_(resend_(p.email));
      default:       return json_({ ok: false, error: "Unknown action" });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: "Something went wrong on our end." });
  }
}

// ---------- Actions ----------

function listFilled_() {
  const filled = {};
  activeRows_().forEach(function (r) {
    const id = r[COL["Shift ID"]];
    (filled[id] = filled[id] || []).push(r[COL["First Name"]] + " " + String(r[COL["Last Name"]]).charAt(0) + ".");
  });
  return { ok: true, filled: filled };
}

function signup_(p) {
  const firstName = clean_(p.firstName, 40);
  const lastName = clean_(p.lastName, 40);
  const email = clean_(p.email, 100).toLowerCase();
  const phone = clean_(p.phone, 20);
  if (!firstName || !lastName) return { ok: false, error: "Please enter your first and last name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Please enter a valid email address." };
  if (phone.replace(/\D/g, "").length < 10) return { ok: false, error: "Please enter a 10-digit phone number." };
  if (p.agreed !== true) return { ok: false, error: "Please confirm you understand this is a member-run site." };
  if (!Array.isArray(p.shiftIds) || p.shiftIds.length === 0 || p.shiftIds.length > 20) {
    return { ok: false, error: "Please pick at least one shift." };
  }

  const shifts = shiftIndex_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_();
    const all = allRows_();
    const prior = all.filter(function (r) { return r[COL["Email"]] === email; })[0];
    const token = prior ? prior[COL["Token"]] : Utilities.getUuid().replace(/-/g, "");
    const active = all.filter(function (r) { return r[COL["Status"]] === "Active"; });
    const now = new Date();
    const added = [], full = [], already = [];

    p.shiftIds.forEach(function (id) {
      const info = shifts[id];
      if (!info) return;
      const taken = active.filter(function (r) { return r[COL["Shift ID"]] === id; });
      if (taken.some(function (r) { return r[COL["Email"]] === email; })) { already.push(id); return; }
      if (taken.length >= info.shift.slots) { full.push(id); return; }
      const row = [now, id, info.dayLabel, info.role.name, info.time, info.role.location,
        firstName, lastName, email, phone, token, now, "Active"];
      sheet.appendRow(row);
      active.push(row);
      added.push(id);
    });
    SpreadsheetApp.flush();

    if (added.length) sendConfirmation_(email, firstName, token, added, shifts);
    return { ok: true, token: token, added: added, full: full, already: already };
  } finally {
    lock.releaseLock();
  }
}

function mine_(token) {
  token = String(token || "");
  if (!token) return { ok: false, error: "Missing link." };
  const rows = allRows_().filter(function (r) { return r[COL["Token"]] === token; });
  if (!rows.length) return { ok: false, error: "We couldn't find that sign-up link." };
  return {
    ok: true,
    firstName: rows[0][COL["First Name"]],
    shiftIds: rows.filter(function (r) { return r[COL["Status"]] === "Active"; })
                  .map(function (r) { return r[COL["Shift ID"]]; })
  };
}

function cancel_(token, shiftId) {
  token = String(token || "");
  if (!token) return { ok: false, error: "Missing link." };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      if (r[COL["Token"]] === token && r[COL["Shift ID"]] === shiftId && r[COL["Status"]] === "Active") {
        sheet.getRange(i + 1, COL["Status"] + 1).setValue("Cancelled");
      }
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function resend_(email) {
  email = clean_(email, 100).toLowerCase();
  const row = allRows_().filter(function (r) { return r[COL["Email"]] === email; })[0];
  if (row) {
    MailApp.sendEmail({
      to: email,
      name: FROM_NAME,
      subject: "Your Member/Guest volunteer link",
      body: "Hi " + row[COL["First Name"]] + ",\n\n" +
        "Here's your link to see or change your volunteer shifts:\n" + manageUrl_(row[COL["Token"]]) +
        "\n\n— " + DISCLAIMER
    });
  }
  // Always the same answer, so the page doesn't reveal who has signed up.
  return { ok: true };
}

function sendConfirmation_(email, firstName, token, ids, shifts) {
  const lines = ids.map(function (id) {
    const s = shifts[id];
    return "  • " + s.role.name + " — " + s.dayLabel + ", " + s.time + " (meet at " + s.role.location + ")";
  });
  MailApp.sendEmail({
    to: email,
    name: FROM_NAME,
    subject: "You're signed up to volunteer — thank you!",
    body: "Hi " + firstName + ",\n\nThanks for volunteering! You're signed up for:\n\n" + lines.join("\n") +
      "\n\nTo see, add to or cancel your shifts, use this link:\n" + manageUrl_(token) +
      "\n\n— " + DISCLAIMER
  });
}

// ---------- Coordinator tools (Sheet menu) ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Volunteers")
    .addItem("Build printable roster", "buildRoster")
    .addToUi();
}

/** Writes a "Roster" tab in the same layout as the printed volunteer list. */
function buildRoster() {
  const config = loadConfig_();
  const active = activeRows_();
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(ROSTER_SHEET) || ss.insertSheet(ROSTER_SHEET);
  sheet.clear();

  const maxSlots = config.roles.reduce(function (m, r) {
    return Math.max(m, r.shifts.reduce(function (n, s) { return Math.max(n, s.slots); }, 0));
  }, 0);
  const header = ["Day", "Role", "Meet At", "Shift Time"];
  for (let i = 1; i <= maxSlots; i++) header.push("Volunteer #" + i);
  const out = [header];

  config.days.forEach(function (day) {
    config.roles.filter(function (r) { return r.day === day.id; }).forEach(function (role) {
      role.shifts.forEach(function (shift) {
        const names = active.filter(function (r) { return r[COL["Shift ID"]] === shift.id; })
          .map(function (r) { return r[COL["First Name"]] + " " + r[COL["Last Name"]] + "\n" + r[COL["Phone"]]; });
        const row = [day.label + (day.date ? ", " + day.date : ""), role.name, role.location, timeRange_(shift)];
        for (let i = 0; i < maxSlots; i++) row.push(i < shift.slots ? (names[i] || "OPEN") : "");
        out.push(row);
      });
    });
  });

  sheet.getRange(1, 1, out.length, header.length).setValues(out).setVerticalAlignment("top").setWrap(true);
  sheet.getRange(1, 1, 1, header.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  ss.setActiveSheet(sheet);
}

// ---------- Helpers ----------

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SIGNUPS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SIGNUPS_SHEET);
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function allRows_() {
  return sheet_().getDataRange().getValues().slice(1);
}

function activeRows_() {
  return allRows_().filter(function (r) { return r[COL["Status"]] === "Active"; });
}

/** shifts.json is fetched from the live site so it's the single source of truth. */
function loadConfig_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("config");
  if (hit) return JSON.parse(hit);
  const text = UrlFetchApp.fetch(SITE_URL + "shifts.json").getContentText();
  cache.put("config", text, 600);
  return JSON.parse(text);
}

function shiftIndex_() {
  const config = loadConfig_();
  const index = {};
  config.roles.forEach(function (role) {
    const day = config.days.filter(function (d) { return d.id === role.day; })[0];
    role.shifts.forEach(function (shift) {
      index[shift.id] = {
        shift: shift, role: role, time: timeRange_(shift),
        dayLabel: day.label + (day.date ? ", " + day.date : "")
      };
    });
  });
  return index;
}

function timeRange_(shift) {
  return fmtTime_(shift.start) + " – " + fmtTime_(shift.end);
}

function fmtTime_(hhmm) {
  const parts = hhmm.split(":").map(Number);
  const h12 = ((parts[0] + 11) % 12) + 1;
  return h12 + ":" + ("0" + parts[1]).slice(-2) + (parts[0] >= 12 ? " pm" : " am");
}

function manageUrl_(token) {
  return SITE_URL + "?manage=" + encodeURIComponent(token);
}

function clean_(value, max) {
  // Strip characters that would make a Sheets cell a formula.
  return String(value || "").trim().replace(/^[=+\-@]+/, "").slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
