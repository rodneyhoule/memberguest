(function () {
  "use strict";

  const CFG = window.MMG_CONFIG || {};
  const SUPABASE_URL = (CFG.supabaseUrl || "").replace(/\/+$/, "");
  const SUPABASE_KEY = CFG.supabaseKey || "";
  const DEMO = !SUPABASE_URL || !SUPABASE_KEY;

  const state = {
    config: null,
    shiftById: {},      // shiftId -> { shift, role, day }
    filled: {},         // shiftId -> ["Suzi S.", ...]
    picked: new Set(),  // shiftIds picked in this visit
    mine: new Set(),    // shiftIds this browser already signed up for
    day: null
  };

  const $ = (sel) => document.querySelector(sel);

  // ---------- Backend ----------

  // Real backend: Supabase database functions (see supabase/schema.sql),
  // called through the REST API with the public key.
  async function rpc(fn, args) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify(args || {})
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.message) || "Something went wrong.");
    return body;
  }

  const remoteApi = {
    async list() {
      return { ok: true, filled: await rpc("list_filled") };
    },
    async call(p) {
      try {
        if (p.action === "signup") {
          const r = await rpc("signup", {
            p_first: p.firstName, p_last: p.lastName, p_email: p.email, p_phone: p.phone,
            p_agreed: p.agreed, p_shift_ids: p.shiftIds
          });
          return Object.assign({ ok: true }, r);
        }
        if (p.action === "mine") {
          const r = await rpc("my_shifts", { p_token: p.token });
          return r ? Object.assign({ ok: true }, r) : { ok: false, error: "We couldn't find that sign-up link." };
        }
        if (p.action === "cancel") {
          await rpc("cancel_shift", { p_token: p.token, p_shift_id: p.shiftId });
          return { ok: true };
        }
        if (p.action === "find") {
          return { ok: true, token: await rpc("find_link", { p_contact: p.contact }) };
        }
        return { ok: false, error: "Unknown action" };
      } catch (ex) {
        return { ok: false, error: ex.message };
      }
    }
  };

  // Demo backend: same responses as the real one, stored in localStorage.
  const demoApi = (function () {
    const KEY = "mmg-demo-signups";
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
    const save = (rows) => { try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) { /* ignore */ } };
    const display = (r) => r.firstName + " " + r.lastName.charAt(0) + ".";
    const newToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    return {
      async list() {
        const filled = {};
        load().filter((r) => r.status === "Active").forEach((r) => {
          (filled[r.shiftId] = filled[r.shiftId] || []).push(display(r));
        });
        return { ok: true, filled };
      },
      async call(p) {
        const rows = load();
        const active = rows.filter((r) => r.status === "Active");
        if (p.action === "signup") {
          const email = p.email.trim().toLowerCase();
          const existing = rows.find((r) => r.email === email);
          const token = existing ? existing.token : newToken();
          const added = [], full = [], already = [];
          p.shiftIds.forEach((id) => {
            const info = state.shiftById[id];
            const taken = active.filter((r) => r.shiftId === id);
            if (taken.some((r) => r.email === email)) already.push(id);
            else if (taken.length >= info.shift.slots) full.push(id);
            else {
              const row = { shiftId: id, firstName: p.firstName, lastName: p.lastName, email, phone: p.phone, token, status: "Active" };
              rows.push(row); active.push(row); added.push(id);
            }
          });
          save(rows);
          return { ok: true, token, added, full, already };
        }
        if (p.action === "mine") {
          const own = active.filter((r) => r.token === p.token);
          const any = rows.find((r) => r.token === p.token);
          if (!any) return { ok: false, error: "We couldn't find that sign-up link." };
          return { ok: true, firstName: any.firstName, shiftIds: own.map((r) => r.shiftId) };
        }
        if (p.action === "cancel") {
          const row = rows.find((r) => r.token === p.token && r.shiftId === p.shiftId && r.status === "Active");
          if (row) row.status = "Cancelled";
          save(rows);
          return { ok: true };
        }
        if (p.action === "find") {
          const last10 = (s) => s.replace(/\D/g, "").slice(-10);
          const row = p.contact.includes("@")
            ? rows.find((r) => r.email === p.contact.trim().toLowerCase())
            : rows.find((r) => last10(r.phone) === last10(p.contact));
          return { ok: true, token: row ? row.token : null };
        }
        return { ok: false, error: "Unknown action" };
      }
    };
  })();

  const api = DEMO ? demoApi : remoteApi;

  // ---------- Helpers ----------

  function fmtTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = ((h + 11) % 12) + 1;
    return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
  }
  const fmtRange = (s) => fmtTime(s.start) + " – " + fmtTime(s.end);
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

  function dayLabel(dayId) {
    const d = state.config.days.find((x) => x.id === dayId);
    return d.label + (d.date ? ", " + d.date : "");
  }

  function manageUrl(token) {
    return location.origin + location.pathname + "?manage=" + encodeURIComponent(token);
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    });
    children.flat().forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(c)));
    return node;
  }

  function show(view) {
    ["browse", "form", "done", "manage", "find"].forEach((v) => { $("#view-" + v).hidden = v !== view; });
    updateCart();
    window.scrollTo(0, 0);
  }

  function rememberMine(ids) {
    ids.forEach((id) => state.mine.add(id));
    try { localStorage.setItem("mmg-mine", JSON.stringify([...state.mine])); } catch (e) { /* ignore */ }
  }

  // Overlapping pairs among the given shifts (same day, times intersect).
  function overlaps(ids) {
    const list = ids.map((id) => state.shiftById[id]);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.role.day === b.role.day &&
            toMin(a.shift.start) < toMin(b.shift.end) && toMin(b.shift.start) < toMin(a.shift.end)) {
          out.push([a, b]);
        }
      }
    }
    return out;
  }

  function shiftItem(id, extra) {
    const { shift, role } = state.shiftById[id];
    return el("li", {},
      el("div", {},
        el("span", { class: "what" }, role.name),
        el("span", { class: "when" }, dayLabel(role.day) + " · " + fmtRange(shift) + " · Meet at " + role.location)),
      extra || "");
  }

  // ---------- Browse ----------

  function renderTabs() {
    const nav = $("#day-tabs");
    nav.replaceChildren(...state.config.days.map((d) => {
      const open = state.config.roles.filter((r) => r.day === d.id)
        .flatMap((r) => r.shifts)
        .reduce((n, s) => n + Math.max(0, s.slots - (state.filled[s.id] || []).length), 0);
      return el("button", {
        class: "day-tab", role: "tab", type: "button", "aria-selected": String(d.id === state.day),
        onclick: () => { state.day = d.id; renderTabs(); renderRoles(); }
      }, d.label, el("small", {}, (d.date ? d.date + " · " : "") + open + " open"));
    }));
  }

  function renderRoles() {
    const roles = state.config.roles.filter((r) => r.day === state.day);
    $("#roles").replaceChildren(...roles.map((role) =>
      el("article", { class: "role" },
        el("h3", {}, role.name),
        el("p", { class: "where" }, "Meet at: " + role.location),
        role.shifts.map((shift) => {
          const names = state.filled[shift.id] || [];
          const open = Math.max(0, shift.slots - names.length);
          const seats = names.map((n) => el("span", { class: "seat taken" }, n));
          if (state.mine.has(shift.id)) {
            // Replace one taken name with a "you" marker so it's obvious.
            seats.pop();
            seats.unshift(el("span", { class: "seat mine" }, "✓ You"));
          }
          const picked = state.picked.has(shift.id);
          if (!state.mine.has(shift.id)) {
            for (let i = 0; i < open; i++) {
              if (i === 0) {
                seats.push(el("button", {
                  type: "button", class: "seat" + (picked ? " picked" : ""), "aria-pressed": String(picked),
                  onclick: () => togglePick(shift.id)
                }, picked ? "✓ Picked" : "+ Pick"));
              } else {
                seats.push(el("span", { class: "seat taken", style: "border-style:dashed" }, "Open"));
              }
            }
          }
          return el("div", { class: "shift" },
            el("div", { class: "shift-time" }, fmtRange(shift),
              el("span", { class: "open-count" }, open === 0 ? "Full" : open + " of " + shift.slots + " open")),
            el("div", { class: "seats" }, seats));
        }))));
  }

  function togglePick(id) {
    if (state.picked.has(id)) state.picked.delete(id); else state.picked.add(id);
    renderRoles();
    updateCart();
  }

  function updateCart() {
    const n = state.picked.size;
    $("#cart").hidden = n === 0 || $("#view-browse").hidden;
    $("#cart-count").textContent = n + (n === 1 ? " shift picked" : " shifts picked");
  }

  // ---------- Sign-up form ----------

  function openForm() {
    const ids = [...state.picked];
    $("#picked-list").replaceChildren(...ids.map((id) => shiftItem(id,
      el("button", { type: "button", class: "btn danger", onclick: () => { state.picked.delete(id); renderRoles(); state.picked.size ? openForm() : show("browse"); } }, "Remove"))));
    const clashes = overlaps(ids);
    const warn = $("#overlap-warning");
    warn.hidden = clashes.length === 0;
    warn.textContent = clashes.length
      ? "Heads up: these shifts overlap — " + clashes.map(([a, b]) =>
          a.role.name + " (" + fmtRange(a.shift) + ") and " + b.role.name + " (" + fmtRange(b.shift) + ")").join("; ") +
        ". That's fine if it's a hand-off, otherwise remove one."
      : "";
    $("#form-error").hidden = true;
    show("form");
  }

  async function submitForm(e) {
    e.preventDefault();
    const f = e.target;
    const data = {
      firstName: f.firstName.value.trim(),
      lastName: f.lastName.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
      agreed: f.agreed.checked
    };
    const err = $("#form-error");
    const problem =
      !data.firstName || !data.lastName ? "Please enter your first and last name." :
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? "Please enter a valid email address." :
      data.phone.replace(/\D/g, "").length < 10 ? "Please enter a 10-digit phone number." :
      !data.agreed ? "Please check the box to confirm you understand this is a member-run site." : "";
    if (problem) { err.textContent = problem; err.hidden = false; return; }

    const btn = $("#btn-submit");
    btn.disabled = true; btn.textContent = "Signing you up…";
    try {
      const res = await api.call(Object.assign({ action: "signup", shiftIds: [...state.picked] }, data));
      if (!res.ok) throw new Error(res.error || "Something went wrong.");
      rememberMine(res.added.concat(res.already));
      try { localStorage.setItem("mmg-token", res.token); } catch (e2) { /* ignore */ }
      state.picked.clear();
      await refresh();
      showDone(res);
    } catch (ex) {
      err.textContent = (ex.message || "Something went wrong.") + " Please try again, or contact the Volunteer Coordinator.";
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Sign me up";
    }
  }

  function showDone(res) {
    const got = res.added.concat(res.already);
    $("#done-title").textContent = got.length ? "You're signed up — thank you!" : "Those spots just filled up";
    $("#done-list").replaceChildren(...got.map((id) => shiftItem(id)));
    const full = $("#done-full");
    full.hidden = res.full.length === 0;
    full.textContent = res.full.length
      ? "Sorry — someone took the last spot before you on: " +
        res.full.map((id) => state.shiftById[id].role.name + " " + fmtRange(state.shiftById[id].shift)).join("; ") +
        ". Please pick another shift."
      : "";
    const url = manageUrl(res.token);
    const a = $("#done-link");
    a.href = url; a.textContent = url;
    show("done");
  }

  // ---------- Manage ----------

  async function openManage(token) {
    show("manage");
    const list = $("#manage-list");
    list.replaceChildren(el("li", {}, "Loading…"));
    const res = await api.call({ action: "mine", token });
    if (!res.ok) {
      $("#manage-title").textContent = "My shifts";
      list.replaceChildren(el("li", {}, res.error || "We couldn't find that sign-up link."));
      return;
    }
    $("#manage-title").textContent = res.firstName + "'s shifts";
    rememberMine(res.shiftIds);
    try { localStorage.setItem("mmg-token", token); } catch (e) { /* ignore */ }
    if (!res.shiftIds.length) { list.replaceChildren(el("li", {}, "You have no shifts right now.")); return; }
    list.replaceChildren(...res.shiftIds.filter((id) => state.shiftById[id]).map((id) => shiftItem(id,
      el("button", {
        type: "button", class: "btn danger",
        onclick: async (ev) => {
          const { role, shift } = state.shiftById[id];
          if (!confirm("Cancel " + role.name + ", " + dayLabel(role.day) + " " + fmtRange(shift) + "?")) return;
          ev.target.disabled = true;
          await api.call({ action: "cancel", token, shiftId: id });
          state.mine.delete(id);
          try { localStorage.setItem("mmg-mine", JSON.stringify([...state.mine])); } catch (e) { /* ignore */ }
          await refresh();
          openManage(token);
        }
      }, "Cancel"))));
  }

  async function submitFind(e) {
    e.preventDefault();
    const contact = e.target.contact.value.trim();
    const err = $("#find-error");
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    if (contact.includes("@")
        ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
        : contact.replace(/\D/g, "").length < 10) {
      return fail("Please enter your email address or 10-digit cell phone number.");
    }
    err.hidden = true;
    const res = await api.call({ action: "find", contact });
    if (!res.ok) return fail(res.error + " Please try again.");
    if (!res.token) return fail("We couldn't find a sign-up with that " + (contact.includes("@") ? "email." : "phone number."));
    history.replaceState(null, "", "?manage=" + encodeURIComponent(res.token));
    openManage(res.token);
  }

  // ---------- Startup ----------

  async function refresh() {
    const res = await api.list();
    state.filled = (res && res.filled) || {};
    renderTabs();
    renderRoles();
  }

  function renderStatic() {
    const c = state.config;
    document.title = c.event.title + " — " + c.event.subtitle;
    $("#event-title").textContent = c.event.title;
    $("#event-subtitle").textContent = c.event.subtitle;
    $("#event-dates").textContent = c.event.dates;
    document.querySelectorAll("[data-disclaimer]").forEach((n) => { n.textContent = c.disclaimer; });
    $("#agreement-text").textContent = c.agreement;
    const contacts = c.contacts.filter((p) => p.name);
    $("#contacts").replaceChildren(...(contacts.length ? [
      el("h2", {}, "Questions?"),
      ...contacts.map((p) => el("p", {}, el("strong", {}, p.role + ": "), p.name,
        p.phone ? el("span", {}, " · ", el("a", { href: "tel:" + p.phone.replace(/[^\d+]/g, "") }, p.phone)) : "",
        p.email ? el("span", {}, " · ", el("a", { href: "mailto:" + p.email }, p.email)) : ""))
    ] : []));
  }

  async function init() {
    $("#demo-banner").hidden = !DEMO;
    try {
      state.config = await (await fetch("shifts.json", { cache: "no-cache" })).json();
    } catch (e) {
      $("#roles").textContent = "Sorry, the shift list couldn't be loaded. Please refresh the page.";
      return;
    }
    state.config.roles.forEach((role) => role.shifts.forEach((shift) => {
      state.shiftById[shift.id] = { shift, role };
    }));
    state.day = state.config.days[0].id;
    try { JSON.parse(localStorage.getItem("mmg-mine") || "[]").forEach((id) => state.mine.add(id)); } catch (e) { /* ignore */ }

    renderStatic();

    document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      history.replaceState(null, "", location.pathname);
      show(b.dataset.go);
    }));
    $("#btn-continue").addEventListener("click", openForm);
    $("#signup-form").addEventListener("submit", submitForm);
    $("#find-form").addEventListener("submit", submitFind);
    $("#btn-find").addEventListener("click", () => {
      let token = null;
      try { token = localStorage.getItem("mmg-token"); } catch (e) { /* ignore */ }
      if (token) openManage(token); else show("find");
    });
    $("#btn-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#done-link").href); $("#btn-copy").textContent = "Copied!"; }
      catch (e) { $("#btn-copy").textContent = "Press and hold the link to copy"; }
    });

    try {
      await refresh();
    } catch (e) {
      $("#roles").textContent = "Sorry, we couldn't reach the sign-up sheet. Please refresh, or contact the Volunteer Coordinator.";
    }

    const token = new URLSearchParams(location.search).get("manage");
    if (token) openManage(token); else show("browse");
  }

  init();
})();
