(function () {
  "use strict";

  const CFG = window.MMG_CONFIG || {};
  const SUPABASE_URL = (CFG.supabaseUrl || "").replace(/\/+$/, "");
  const SUPABASE_KEY = CFG.supabaseKey || "";
  const DEMO = !SUPABASE_URL || !SUPABASE_KEY;
  const CODE_KEY = "mmg-admin-code";

  const state = {
    config: null,
    shiftById: {},   // shiftId -> { shift, role }
    signups: [],     // active sign-ups with full contact details
    code: "",
    day: null
  };

  const $ = (sel) => document.querySelector(sel);

  // ---------- Backend ----------

  // Real backend: passcode-checked database functions in supabase/schema.sql.
  async function rpc(fn, args) {
    try {
      const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
        body: JSON.stringify(args)
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: (body && body.message) || "Something went wrong." };
      return body;
    } catch (e) {
      return { ok: false, error: "Couldn't reach the database. Check your connection." };
    }
  }

  const remoteApi = {
    roster: () => rpc("admin_roster", { p_code: state.code }),
    move: (id, shiftId) => rpc("admin_move", { p_code: state.code, p_signup_id: id, p_shift_id: shiftId }),
    cancel: (id) => rpc("admin_cancel", { p_code: state.code, p_signup_id: id }),
    add: (p) => rpc("admin_add", {
      p_code: state.code, p_first: p.firstName, p_last: p.lastName,
      p_email: p.email, p_phone: p.phone, p_shift_id: p.shiftId
    })
  };

  // Demo backend: works on the demo sign-ups the public page saves in this browser.
  const demoApi = (function () {
    const KEY = "mmg-demo-signups";
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
    const save = (rows) => { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) { /* ignore */ } };
    const check = () => state.code === "demo" ? null : { ok: false, error: "Wrong passcode." };
    const taken = (rows, shiftId) => rows.filter((r) => r.shiftId === shiftId && r.status === "Active");

    return {
      async roster() {
        return check() || { ok: true, signups: load().map((r, i) => Object.assign({ id: i }, r)).filter((r) => r.status === "Active") };
      },
      async move(id, shiftId) {
        if (check()) return check();
        const rows = load();
        const r = rows[id];
        if (taken(rows, shiftId).some((x) => x.email === r.email)) return { ok: false, error: r.firstName + " is already on that shift." };
        if (taken(rows, shiftId).length >= state.shiftById[shiftId].shift.slots) return { ok: false, error: "That shift is full." };
        r.shiftId = shiftId;
        save(rows);
        return { ok: true };
      },
      async cancel(id) {
        if (check()) return check();
        const rows = load();
        rows[id].status = "Cancelled";
        save(rows);
        return { ok: true };
      },
      async add(p) {
        if (check()) return check();
        const rows = load();
        const email = p.email.trim().toLowerCase();
        if (taken(rows, p.shiftId).some((x) => x.email === email)) return { ok: false, error: p.firstName + " is already on that shift." };
        if (taken(rows, p.shiftId).length >= state.shiftById[p.shiftId].shift.slots) return { ok: false, error: "That shift is full." };
        const prior = rows.find((x) => x.email === email);
        rows.push({
          shiftId: p.shiftId, firstName: p.firstName, lastName: p.lastName, email, phone: p.phone,
          token: prior ? prior.token : Math.random().toString(36).slice(2), status: "Active"
        });
        save(rows);
        return { ok: true };
      }
    };
  })();

  const api = DEMO ? demoApi : remoteApi;

  // ---------- Helpers ----------

  function fmtTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return ((h + 11) % 12) + 1 + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "pm" : "am");
  }
  const fmtRange = (s) => fmtTime(s.start) + " – " + fmtTime(s.end);

  function dayLabel(dayId) {
    const d = state.config.days.find((x) => x.id === dayId);
    return d.label + (d.date ? ", " + d.date : "");
  }

  function shiftLabel(id) {
    const { shift, role } = state.shiftById[id];
    return dayLabel(role.day) + " · " + role.name + " · " + fmtRange(shift);
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    });
    children.flat(Infinity).forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(c)));
    return node;
  }

  const peopleOn = (shiftId) => state.signups.filter((s) => s.shiftId === shiftId);
  const openOn = (shiftId) => state.shiftById[shiftId].shift.slots - peopleOn(shiftId).length;
  const fullName = (s) => s.firstName + " " + s.lastName;
  const telHref = (phone) => "tel:" + phone.replace(/[^\d+]/g, "");

  function showError(sel, msg) {
    const n = $(sel);
    n.textContent = msg || "";
    n.hidden = !msg;
  }

  // ---------- Sign-in ----------

  async function login(code) {
    state.code = code;
    const res = await api.roster();
    if (!res.ok) {
      state.code = "";
      try { sessionStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ }
      return res.error;
    }
    try { sessionStorage.setItem(CODE_KEY, code); } catch (e) { /* ignore */ }
    state.signups = res.signups;
    $("#view-login").hidden = true;
    $("#view-roster").hidden = false;
    render();
    return null;
  }

  async function reload() {
    const res = await api.roster();
    if (!res.ok) { showError("#roster-error", res.error); return; }
    showError("#roster-error", "");
    state.signups = res.signups;
    render();
  }

  // ---------- Roster ----------

  function render() {
    const total = state.config.roles.flatMap((r) => r.shifts).reduce((n, s) => n + s.slots, 0);
    $("#totals").textContent = state.signups.length + " of " + total + " spots filled";

    $("#day-tabs").replaceChildren(...state.config.days.map((d) => {
      const shifts = state.config.roles.filter((r) => r.day === d.id).flatMap((r) => r.shifts);
      const open = shifts.reduce((n, s) => n + Math.max(0, openOn(s.id)), 0);
      return el("button", {
        class: "day-tab", role: "tab", type: "button", "aria-selected": String(d.id === state.day),
        onclick: () => { state.day = d.id; render(); }
      }, d.label, el("small", {}, open + " open"));
    }));

    $("#roles").replaceChildren(...state.config.roles.filter((r) => r.day === state.day).map((role) =>
      el("article", { class: "role" },
        el("h3", {}, role.name),
        el("p", { class: "where" }, "Meet at: " + role.location),
        role.shifts.map((shift) => {
          const people = peopleOn(shift.id);
          const open = openOn(shift.id);
          return el("div", { class: "shift" },
            el("div", { class: "shift-time" }, fmtRange(shift),
              el("span", { class: "open-count" }, open <= 0 ? "Full" : open + " of " + shift.slots + " open")),
            el("ul", { class: "people" },
              people.map((p) => el("li", {},
                el("div", { class: "person" },
                  el("strong", {}, fullName(p)),
                  el("span", { class: "small" },
                    el("a", { href: telHref(p.phone) }, p.phone), " · ",
                    el("a", { href: "mailto:" + p.email }, p.email))),
                el("div", { class: "person-actions" },
                  el("button", { type: "button", class: "btn small-btn", onclick: () => openMove(p) }, "Move"),
                  el("button", { type: "button", class: "btn danger small-btn", onclick: () => cancelPerson(p) }, "Remove")))),
              open > 0 ? el("li", { class: "open-slot" },
                el("span", { class: "small" }, open === 1 ? "1 open spot" : open + " open spots"),
                el("button", { type: "button", class: "btn small-btn", onclick: () => openAdd(shift.id) }, "+ Add")) : ""));
        }))));
  }

  async function cancelPerson(p) {
    if (!confirm("Remove " + fullName(p) + " from " + shiftLabel(p.shiftId) + "?\n\nThey won't be notified, so let them know.")) return;
    const res = await api.cancel(p.id);
    if (!res.ok) { showError("#roster-error", res.error); return; }
    await reload();
  }

  // ---------- Move ----------

  let moving = null;

  function openMove(p) {
    moving = p;
    $("#move-title").textContent = "Move " + fullName(p);
    $("#move-from").textContent = "Now on: " + shiftLabel(p.shiftId);
    const select = $("#move-select");
    const groups = state.config.days.map((d) => {
      const options = state.config.roles.filter((r) => r.day === d.id).flatMap((role) =>
        role.shifts.filter((s) => s.id !== p.shiftId && openOn(s.id) > 0).map((s) =>
          el("option", { value: s.id }, role.name + " · " + fmtRange(s) + " (" + openOn(s.id) + " open)")));
      return options.length ? el("optgroup", { label: dayLabel(d.id) }, options) : null;
    }).filter(Boolean);
    select.replaceChildren(el("option", { value: "" }, "Choose a shift with an open spot…"), ...groups);
    showError("#move-error", "");
    $("#move-dialog").showModal();
  }

  async function submitMove(e) {
    e.preventDefault();
    const shiftId = $("#move-select").value;
    if (!shiftId) { showError("#move-error", "Choose a shift."); return; }
    const btn = $("#move-submit");
    btn.disabled = true;
    const res = await api.move(moving.id, shiftId);
    btn.disabled = false;
    if (!res.ok) { showError("#move-error", res.error); return; }
    $("#move-dialog").close();
    state.day = state.shiftById[shiftId].role.day;
    await reload();
  }

  // ---------- Add ----------

  let addingTo = null;

  function openAdd(shiftId) {
    addingTo = shiftId;
    $("#add-form").reset();
    $("#add-to").textContent = shiftLabel(shiftId);
    showError("#add-error", "");
    $("#add-dialog").showModal();
  }

  async function submitAdd(e) {
    e.preventDefault();
    const f = e.target;
    const p = {
      firstName: f.firstName.value.trim(), lastName: f.lastName.value.trim(),
      email: f.email.value.trim(), phone: f.phone.value.trim(), shiftId: addingTo
    };
    const problem =
      !p.firstName || !p.lastName ? "Enter a first and last name." :
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) ? "Enter a valid email address." :
      p.phone.replace(/\D/g, "").length < 10 ? "Enter a 10-digit phone number." : "";
    if (problem) { showError("#add-error", problem); return; }
    const btn = $("#add-submit");
    btn.disabled = true;
    const res = await api.add(p);
    btn.disabled = false;
    if (!res.ok) { showError("#add-error", res.error); return; }
    $("#add-dialog").close();
    await reload();
  }

  // ---------- Print and CSV ----------

  // Rows in the same order as the printed volunteer list: day, role, shift.
  function rosterRows() {
    return state.config.days.flatMap((d) =>
      state.config.roles.filter((r) => r.day === d.id).flatMap((role) =>
        role.shifts.map((shift) => ({ day: d, role, shift, people: peopleOn(shift.id) }))));
  }

  function openPrint() {
    $("#print-days").replaceChildren(...state.config.days.map((d) =>
      el("label", { class: "choice" },
        el("input", { type: "checkbox", name: "day", value: d.id, checked: true }),
        el("span", {}, dayLabel(d.id)))));
    showError("#print-error", "");
    $("#print-dialog").showModal();
  }

  function submitPrint(e) {
    e.preventDefault();
    const f = e.target;
    const days = [...f.querySelectorAll("input[name=day]:checked")].map((i) => i.value);
    if (!days.length) { showError("#print-error", "Choose at least one day."); return; }
    const opts = { days, phones: f.phones.checked };
    $("#print-roster").replaceChildren(...(f.layout.value === "person" ? printByPerson(opts) : printByShift(opts)));
    $("#print-dialog").close();
    // Let the dialog finish closing before the print preview opens.
    setTimeout(() => window.print(), 50);
  }

  function printHeader(subtitle) {
    const c = state.config;
    return el("header", { class: "print-head" },
      el("div", { class: "print-title" }, c.event.title + (c.event.dates ? " · " + c.event.dates : "")),
      el("h2", {}, subtitle));
  }

  function printFooter() {
    const contacts = state.config.contacts.filter((p) => p.name);
    const printed = "Printed " + new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    return el("footer", { class: "print-foot" },
      contacts.length ? el("div", {}, el("strong", {}, "Important cell phone #'s: "),
        contacts.map((p, i) => [i ? " · " : "", p.role + ": " + p.name + (p.phone ? " " + p.phone : "")])) : "",
      el("div", { class: "small" }, printed));
  }

  // One page per day, one row per shift, like the old printed volunteer list.
  function printByShift(opts) {
    return opts.days.map((dayId) => {
      const roles = state.config.roles.filter((r) => r.day === dayId);
      const maxSlots = Math.max(...roles.flatMap((r) => r.shifts).map((s) => s.slots));
      const head = ["Role", "Meet At", "Shift Time"];
      for (let i = 1; i <= maxSlots; i++) head.push("Volunteer #" + i);
      return el("section", { class: "print-page" },
        printHeader(dayLabel(dayId).toUpperCase()),
        el("table", {},
          el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))),
          roles.map((role) => el("tbody", {}, role.shifts.map((shift, n) => {
            const people = peopleOn(shift.id);
            const cells = [];
            for (let i = 0; i < maxSlots; i++) {
              const p = people[i];
              cells.push(i >= shift.slots ? el("td", { class: "na" }) :
                p ? el("td", {}, fullName(p), opts.phones ? [el("br"), el("span", { class: "phone" }, p.phone)] : "") :
                el("td", { class: "open" }, "OPEN"));
            }
            return el("tr", {},
              n === 0 ? el("td", { rowspan: role.shifts.length, class: "role-cell" }, role.name) : "",
              n === 0 ? el("td", { rowspan: role.shifts.length }, role.location) : "",
              el("td", { class: "nowrap" }, fmtRange(shift)), cells);
          })))),
        printFooter());
    });
  }

  // Alphabetical list of volunteers with all their shifts, for a check-in table.
  function printByPerson(opts) {
    const byPerson = new Map();
    state.signups
      .filter((s) => opts.days.includes(state.shiftById[s.shiftId].role.day))
      .forEach((s) => {
        const key = s.email;
        if (!byPerson.has(key)) byPerson.set(key, { first: s.firstName, last: s.lastName, phone: s.phone, shifts: [] });
        byPerson.get(key).shifts.push(s.shiftId);
      });
    const dayOrder = state.config.days.map((d) => d.id);
    const people = [...byPerson.values()].sort((a, b) =>
      (a.last + " " + a.first).localeCompare(b.last + " " + b.first));
    const dayNames = opts.days.map((d) => state.config.days.find((x) => x.id === d).label).join(", ");
    const head = ["✓", "Name"].concat(opts.phones ? ["Phone"] : [], ["Shifts"]);
    return [el("section", { class: "print-page" },
      printHeader("VOLUNTEERS A–Z · " + dayNames.toUpperCase()),
      people.length ? el("table", { class: "by-person" },
        el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))),
        el("tbody", {}, people.map((p) => el("tr", {},
          el("td", { class: "check" }, "☐"),
          el("td", { class: "nowrap" }, p.last + ", " + p.first),
          opts.phones ? el("td", { class: "nowrap" }, p.phone) : "",
          el("td", {}, p.shifts
            .sort((a, b) => dayOrder.indexOf(state.shiftById[a].role.day) - dayOrder.indexOf(state.shiftById[b].role.day) ||
              state.shiftById[a].shift.start.localeCompare(state.shiftById[b].shift.start))
            .map((id, i) => {
              const { shift, role } = state.shiftById[id];
              return [i ? el("br") : "", state.config.days.find((d) => d.id === role.day).label.slice(0, 3) + " " +
                fmtRange(shift) + " — " + role.name + " (" + role.location + ")"];
            })))))) : el("p", {}, "No volunteers signed up for these days yet."),
      printFooter())];
  }

  function downloadCsv() {
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [["Day", "Role", "Meet At", "Shift Time", "First Name", "Last Name", "Phone", "Email"].map(esc).join(",")];
    rosterRows().forEach((r) => {
      const people = r.people.length ? r.people : [];
      people.forEach((p) => lines.push([dayLabel(r.day.id), r.role.name, r.role.location, fmtRange(r.shift),
        p.firstName, p.lastName, p.phone, p.email].map(esc).join(",")));
      for (let i = people.length; i < r.shift.slots; i++) {
        lines.push([dayLabel(r.day.id), r.role.name, r.role.location, fmtRange(r.shift), "OPEN", "", "", ""].map(esc).join(","));
      }
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "volunteer-roster.csv" });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- Startup ----------

  async function init() {
    $("#demo-banner").hidden = !DEMO;
    state.config = await (await fetch("shifts.json", { cache: "no-cache" })).json();
    state.config.roles.forEach((role) => role.shifts.forEach((shift) => { state.shiftById[shift.id] = { shift, role }; }));
    state.day = state.config.days[0].id;
    $("#event-title").textContent = state.config.event.title;
    $("#event-dates").textContent = state.config.event.dates;

    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = e.target.code.value;
      if (!code) { showError("#login-error", "Enter the admin passcode."); return; }
      showError("#login-error", await login(code));
    });
    $("#btn-refresh").addEventListener("click", reload);
    $("#btn-csv").addEventListener("click", downloadCsv);
    $("#btn-print").addEventListener("click", openPrint);
    $("#print-form").addEventListener("submit", submitPrint);
    $("#btn-logout").addEventListener("click", () => {
      try { sessionStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ }
      location.reload();
    });
    $("#move-form").addEventListener("submit", submitMove);
    $("#add-form").addEventListener("submit", submitAdd);
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

    let saved = null;
    try { saved = sessionStorage.getItem(CODE_KEY); } catch (e) { /* ignore */ }
    if (saved) await login(saved);
  }

  init();
})();
