// Azeli PMS: interactive demo (runs entirely in the browser).
(() => {
  "use strict";
  const KEY = "hk-pms-demo-v1";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ugx = (n) => "UGX " + Math.round(n || 0).toLocaleString("en-US");
  const num = (n) => Math.round(n || 0).toLocaleString("en-US");
  const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(Math.round(n || 0));
  const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (+f(x) || 0), 0);
  const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const nightsBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
  const fdate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const fdateLong = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  let seq = 1000;
  const uid = (p) => `${p}${++seq}`;

  const METHODS = { cash: "Cash", card: "Card", momo: "Mobile money", room: "Charge to room", invoice: "Company account" };
  const METHOD_ACCT = { cash: "Cash", card: "Card clearing", momo: "Mobile money", room: "Guest ledger", invoice: "Accounts receivable" };
  const DEPT_REV = { Rooms: "Revenue – Rooms", "Food & Beverage": "Revenue – Food & Beverage", Amenities: "Revenue – Amenities", Events: "Revenue – Events" };
  const ACCT_TYPE = {
    "Cash": "Asset", "Card clearing": "Asset", "Mobile money": "Asset", "Guest ledger": "Asset", "Accounts receivable": "Asset",
    "Inventory": "Asset", "Fixed assets": "Asset", "Accounts payable": "Liability", "Statutory payables": "Liability", "Event deposits": "Liability", "Equity": "Equity",
    "Revenue – Rooms": "Revenue", "Revenue – Food & Beverage": "Revenue", "Revenue – Amenities": "Revenue", "Revenue – Events": "Revenue",
    "Cost of sales": "Expense", "Departmental supplies": "Expense", "Payroll expense": "Expense", "Repairs & maintenance": "Expense",
  };

  /* ================= STATE ================= */
  let S;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable: demo still works for this visit */ } };
  const load = () => { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };

  const rt = (code) => S.roomTypes.find((t) => t.code === code);
  const resById = (id) => S.reservations.find((r) => r.id === id);
  const inHouse = () => S.reservations.filter((r) => r.status === "In-house");
  const resInRoom = (no) => S.reservations.find((r) => r.status === "In-house" && r.room === no);
  const balance = (r) => sum(r.folio, (x) => x.amount) - sum(r.payments, (x) => x.amount);
  const stockById = (id) => S.stock.find((s) => s.id === id);
  const staffById = (id) => S.staff.find((s) => s.id === id);

  function journal(date, ref, desc, lines) {
    const clean = lines.filter((l) => Math.round(l.dr || 0) || Math.round(l.cr || 0));
    if (clean.length) S.journal.push({ id: uid("J"), date, ref, desc, lines: clean });
  }

  // Revenue posting used by every module (rooms, POS, amenities, events)
  function postSale({ date = S.date, dept, outlet = dept, desc, amount, method, resId = null, ref = uid("S") }) {
    S.sales.push({ id: ref, date, dept, outlet, desc, amount, method, resId });
    if (method === "room") {
      const r = resById(resId);
      r.folio.push({ id: uid("F"), date, desc, dept: outlet, amount });
    }
    journal(date, ref, `${outlet}: ${desc}`, [{ acct: METHOD_ACCT[method], dr: amount }, { acct: DEPT_REV[dept], cr: amount }]);
  }
  function postPayment(r, method, amount, date = S.date, note = "Payment") {
    r.payments.push({ id: uid("P"), date, method, amount, note });
    journal(date, r.id, `${note}: ${r.guest}`, [{ acct: METHOD_ACCT[method], dr: amount }, { acct: "Guest ledger", cr: amount }]);
  }
  // Deduct stock and record its cost. kind: "sale" -> Cost of sales; "dept" -> Departmental supplies
  function consume(lines, ref, desc, kind = "sale", date = S.date) {
    let cost = 0;
    lines.forEach(([id, qty]) => { const s = stockById(id); if (!s) return; s.qty = Math.max(0, +(s.qty - qty).toFixed(3)); cost += qty * s.cost; });
    const acct = kind === "sale" ? "Cost of sales" : "Departmental supplies";
    journal(date, ref, desc, [{ acct, dr: cost }, { acct: "Inventory", cr: cost }]);
    return cost;
  }

  /* ================= SEED ================= */
  function seed() {
    const D = window.SEED;
    seq = 1000;
    S = {
      v: 1, date: D.startDate, property: D.property,
      roomTypes: D.roomTypes, rooms: D.rooms.map((r) => ({ ...r, hk: D.roomStatus[r.no] || "vc" })),
      reservations: [], sales: [], journal: [], purchases: [],
      menu: D.menu, outlets: D.outlets, stock: D.stock.map((s) => ({ ...s })), amenities: D.amenities,
      requisitions: [], departments: D.departments,
      staff: D.staff.map((s) => ({ ...s })), leave: D.leave.map((l) => ({ ...l, from: addDays(D.startDate, l.from), to: addDays(D.startDate, l.to) })), payrollRuns: [],
      functionRooms: D.functionRooms, eventPackages: D.eventPackages, events: [],
      assets: D.assets.map((a) => ({ ...a, nextService: addDays(D.startDate, a.service) })), workOrders: [],
      channels: D.channels.map((c) => ({ ...c, connected: true, lastSync: D.startDate + " 06:00" })),
      schedules: D.schedules.map((s) => ({ ...s })),
      seq: 0,
    };
    const stockValue = sum(S.stock, (s) => s.qty * s.cost);
    const fixed = sum(S.assets, (a) => a.cost);
    journal(addDays(S.date, -30), "OPEN", "Opening balances", [
      { acct: "Cash", dr: 18500000 }, { acct: "Mobile money", dr: 4200000 }, { acct: "Inventory", dr: stockValue }, { acct: "Fixed assets", dr: fixed },
      { acct: "Equity", cr: 18500000 + 4200000 + stockValue + fixed },
    ]);

    D.reservations.forEach(([guest, phone, type, off, nights, room, source]) => {
      const arr = addDays(S.date, off), dep = addDays(arr, nights);
      const r = { id: uid("R"), guest, phone, type, arr, dep, adults: 2, source, rate: rt(type).rate, room, status: off < 0 ? "In-house" : "Reserved", folio: [], payments: [] };
      S.reservations.push(r);
      if (r.status === "In-house") {
        for (let d = arr; d < S.date; d = addDays(d, 1)) postSale({ date: d, dept: "Rooms", outlet: "Rooms", desc: `Room ${room} night charge`, amount: r.rate, method: "room", resId: r.id });
        if (source === "Website" || source === "Expedia") postPayment(r, "card", r.rate, arr, "Deposit (paid online)");
      }
    });
    // a little F&B history on folios and walk-in sales
    const hist = [["201", "m2", 2, "Restaurant"], ["301", "m4", 2, "Restaurant"], ["301", "m8", 3, "Bar"], ["203", "m7", 4, "Bar"], ["104", "m1", 2, "Room Service"], ["208", "m3", 1, "Restaurant"], ["303", "m9", 2, "Bar"]];
    hist.forEach(([room, mid, q, outlet], i) => {
      const r = resInRoom(room), m = S.menu.find((x) => x.id === mid);
      const date = addDays(S.date, -1 - (i % 2));
      const ref = uid("POS");
      postSale({ date, dept: "Food & Beverage", outlet, desc: `${q} × ${m.name}`, amount: q * m.price, method: "room", resId: r.id, ref });
      consume(m.recipe.map(([id, qty]) => [id, qty * q]), ref, `Recipe stock: ${m.name}`, "sale", date);
    });
    [["m7", 6, "cash"], ["m2", 3, "momo"], ["m12", 5, "card"]].forEach(([mid, q, method]) => {
      const m = S.menu.find((x) => x.id === mid); const ref = uid("POS"); const date = addDays(S.date, -1);
      postSale({ date, dept: "Food & Beverage", outlet: m.outlet, desc: `${q} × ${m.name}`, amount: q * m.price, method, ref });
      consume(m.recipe.map(([id, qty]) => [id, qty * q]), ref, `Recipe stock: ${m.name}`, "sale", date);
    });
    postSale({ date: addDays(S.date, -1), dept: "Amenities", outlet: "Spa", desc: "Spa massage (60 min)", amount: 120000, method: "room", resId: resInRoom("302").id });

    S.requisitions = [
      { id: uid("RQ"), date: addDays(S.date, -1), dept: "Kitchen", by: "Charles Mutebi", lines: [["s_beef", 10], ["s_veg", 8]], note: "Weekend menu prep", status: "Pending" },
      { id: uid("RQ"), date: S.date, dept: "Housekeeping", by: "Esther Apio", lines: [["s_soap", 40], ["s_toilet", 30]], note: "Floor 2 restock", status: "Approved" },
      { id: uid("RQ"), date: addDays(S.date, -2), dept: "Bar", by: "Brenda Tusiime", lines: [["s_lager", 24]], note: "", status: "Issued" },
    ];
    S.events = D.events.map((e) => {
      const pkg = S.eventPackages.find((p) => p.id === e.pkg); const total = pkg.pp * e.pax;
      const ev = { id: uid("EV"), name: e.name, client: e.client, date: addDays(S.date, e.offset), room: e.room, pax: e.pax, pkg: e.pkg, total, deposit: Math.round(total * e.depositPct / 100), status: e.status, billed: false };
      if (ev.deposit) journal(addDays(S.date, -7), ev.id, `Event deposit: ${ev.client}`, [{ acct: "Cash", dr: ev.deposit }, { acct: "Event deposits", cr: ev.deposit }]);
      return ev;
    });
    S.workOrders = D.workOrders.map((w) => ({ ...w, id: uid("WO"), opened: addDays(S.date, -1) }));
    S.seq = seq;
  }

  /* ================= ROUTING / LAYOUT ================= */
  const NAV = [
    ["Operations", [["dashboard", "Dashboard"], ["frontdesk", "Front desk"], ["reservations", "Reservations"], ["booking", "Booking engine"], ["channels", "Channel manager"]]],
    ["Food, sales & events", [["pos", "Restaurant / POS"], ["amenities", "Amenity sales"], ["events", "Events & banqueting"]]],
    ["Back office", [["inventory", "Inventory"], ["requisitions", "Requisitions"], ["hr", "Human resources"], ["accounting", "Accounting"], ["assets", "Assets"]]],
    ["Insights", [["reports", "Reports"]]],
  ];
  const route = () => (location.hash.replace("#", "") || "dashboard").split("?")[0];
  const VIEWS = {};
  const ui = { tab: {}, cart: [], outlet: "Restaurant", be: null };

  function renderNav() {
    const pend = S.requisitions.filter((r) => r.status === "Pending").length;
    const low = S.stock.filter((s) => s.qty <= s.reorder).length;
    const badges = { requisitions: pend, inventory: low };
    $("#side-nav").innerHTML = NAV.map(([g, items]) => `<div class="grp">${g}</div>` + items.map(([id, label]) =>
      `<a href="#${id}" class="${route() === id ? "on" : ""}">${label}${badges[id] ? `<span class="badge">${badges[id]}</span>` : ""}</a>`).join("")).join("");
    $("#biz-date").textContent = "Business date: " + fdateLong(S.date);
  }
  function render() {
    const v = VIEWS[route()] ? route() : "dashboard";
    renderNav();
    $("#view").innerHTML = VIEWS[v]();
    document.body.classList.remove("nav-open");
  }
  function commit(msg) { S.seq = seq; save(); render(); if (msg) toast(msg); }

  function toast(html) {
    const t = document.createElement("div"); t.className = "toast"; t.innerHTML = html;
    $("#toasts").appendChild(t); setTimeout(() => t.remove(), 4200);
  }
  let modalSubmit = null;
  function modal(title, body, onSubmit) {
    $("#modal-title").textContent = title; $("#modal-body").innerHTML = body; modalSubmit = onSubmit || null;
    $("#modal").hidden = false;
    const f = $("#modal-body input, #modal-body select, #modal-body button"); if (f) f.focus();
  }
  const closeModal = () => { $("#modal").hidden = true; modalSubmit = null; document.body.classList.remove("printing-modal"); };

  const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;
  const statusPill = (s) => pill(s, { "In-house": "ink", Reserved: "info", "Checked out": "", Cancelled: "bad", "No-show": "bad", Pending: "warn", Approved: "info", Issued: "ok", Rejected: "bad", Confirmed: "ok", Tentative: "warn", Completed: "ok", Open: "warn", "In progress": "info" }[s] || "");
  const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  const roomOpts = () => inHouse().sort((a, b) => a.room.localeCompare(b.room)).map((r) => [r.id, `Room ${r.room}: ${r.guest}`]);
  const methodOpts = (withRoom = true, withInvoice = false) => Object.entries(METHODS).filter(([k]) => (withRoom || k !== "room") && (withInvoice || k !== "invoice"));
  const table = (head, rows, empty = "Nothing here yet.") => `<div class="tbl-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith("#") ? "num" : ""}">${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${head.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
  const tabs = (key, list) => { const cur = ui.tab[key] || list[0][0]; return `<div class="tabs" role="tablist">${list.map(([v, l]) => `<button type="button" role="tab" aria-selected="${v === cur}" class="${v === cur ? "on" : ""}" data-action="tab" data-key="${key}" data-val="${v}">${esc(l)}</button>`).join("")}</div>`; };
  const curTab = (key, def) => ui.tab[key] || def;

  /* ================= METRICS ================= */
  function availability(type, date) {
    const rooms = S.rooms.filter((r) => r.type === type && r.hk !== "ooo").length;
    const used = S.reservations.filter((r) => r.type === type && (r.status === "Reserved" || r.status === "In-house") && r.arr <= date && date < r.dep).length;
    return Math.max(0, rooms - used);
  }
  function dayStats(date = S.date) {
    const sales = S.sales.filter((s) => s.date === date);
    const byDept = (d) => sum(sales.filter((s) => s.dept === d), (s) => s.amount);
    const sellable = S.rooms.filter((r) => r.hk !== "ooo").length;
    const occ = date === S.date ? inHouse().length : sales.filter((s) => s.dept === "Rooms").length;
    const roomRev = byDept("Rooms");
    return { sales, sellable, occ, occPct: sellable ? occ / sellable : 0, roomRev, fb: byDept("Food & Beverage"), amen: byDept("Amenities"), events: byDept("Events"), total: sum(sales, (s) => s.amount) };
  }
  const arrivalsToday = () => S.reservations.filter((r) => r.arr === S.date && r.status === "Reserved");
  const departuresToday = () => S.reservations.filter((r) => r.dep === S.date && r.status === "In-house");
  const roomClass = (room) => {
    if (room.hk === "ooo") return "ooo";
    const r = resInRoom(room.no);
    if (r) return r.dep === S.date ? "dep" : "occ";
    if (arrivalsToday().some((a) => a.room === room.no)) return "arr";
    return room.hk;
  };

  /* ================= VIEWS ================= */
  VIEWS.dashboard = () => {
    const st = dayStats(), last = dayStats(addDays(S.date, -1));
    const adr = last.occ ? last.roomRev / last.occ : 0;
    const pend = S.requisitions.filter((r) => r.status === "Pending");
    const low = S.stock.filter((s) => s.qty <= s.reorder);
    const dirty = S.rooms.filter((r) => r.hk === "dirty" && !resInRoom(r.no));
    const due = S.assets.filter((a) => a.nextService <= addDays(S.date, 7));
    const deptRev = [["Rooms", last.roomRev], ["Food & Beverage", last.fb], ["Amenities", last.amen], ["Events", last.events]];
    const max = Math.max(1, ...deptRev.map((d) => d[1]));
    const next = S.events.filter((e) => e.date >= S.date && e.status !== "Cancelled").sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
    return `
      <div class="page-head"><div><h1 class="page">Good morning</h1><p class="sub">Everything happening at ${esc(S.property)} today.</p></div>
        <div class="row-actions"><a class="btn btn-gold" href="#reservations" data-action="new-res">+ New reservation</a><a class="btn btn-ghost" href="#pos">Open POS</a></div></div>
      <div class="grid g4">
        <div class="card kpi"><span>Occupancy tonight</span><b>${Math.round(st.occPct * 100)}%</b><small>${st.occ} of ${st.sellable} sellable rooms</small></div>
        <div class="card kpi"><span>Arrivals</span><b>${arrivalsToday().length}</b><small>${departuresToday().length} departures today</small></div>
        <div class="card kpi"><span>Revenue today</span><b>${compact(st.total)}</b><small>UGX, all departments</small></div>
        <div class="card kpi"><span>ADR (yesterday)</span><b>${compact(adr)}</b><small>UGX average daily rate</small></div>
      </div>
      <div class="grid g3 mt">
        <div class="card"><h2 class="sec">Arrivals today</h2>${table(["Guest", ""], arrivalsToday().map((r) => `<tr><td><b>${esc(r.guest)}</b><br><small style="color:var(--muted)">${esc(rt(r.type).name)} · ${esc(r.source)}</small></td><td style="text-align:right"><button class="btn btn-sm btn-gold" data-action="checkin" data-id="${r.id}">Check in</button></td></tr>`), "All arrivals checked in.")}</div>
        <div class="card"><h2 class="sec">Departures today</h2>${table(["Room", "Guest", "#Balance", ""], departuresToday().map((r) => `<tr><td>${r.room}</td><td>${esc(r.guest)}</td><td class="num">${num(balance(r))}</td><td><button class="btn btn-sm" data-action="checkout" data-id="${r.id}">Check out</button></td></tr>`), "No more departures.")}</div>
        <div class="card"><h2 class="sec">Needs attention</h2>
          <ul style="margin:0;padding-left:18px;display:grid;gap:8px">
            <li><a href="#requisitions">${pend.length} requisition${pend.length === 1 ? "" : "s"} awaiting approval</a></li>
            <li><a href="#inventory">${low.length} stock item${low.length === 1 ? "" : "s"} at or below re-order level</a></li>
            <li><a href="#frontdesk">${dirty.length} vacant room${dirty.length === 1 ? "" : "s"} to clean</a></li>
            <li><a href="#assets">${due.length} asset${due.length === 1 ? "" : "s"} due for service this week</a></li>
            <li><a href="#hr">${S.leave.filter((l) => l.status === "Pending").length} leave request(s) pending</a></li>
          </ul></div>
      </div>
      <div class="grid g2 mt">
        <div class="card"><h2 class="sec">Revenue by department (yesterday)</h2><div class="bars">${deptRev.map(([d, v]) => `<div class="bar"><span>${d}</span><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><b>${num(v)}</b></div>`).join("")}</div></div>
        <div class="card"><h2 class="sec">Upcoming events</h2>${table(["Date", "Event", "#Pax"], next.map((e) => `<tr><td>${fdate(e.date)}</td><td>${esc(e.name)}<br><small style="color:var(--muted)">${esc(S.functionRooms.find((f) => f.id === e.room).name)}</small></td><td class="num">${e.pax}</td></tr>`), "No upcoming events.")}</div>
      </div>`;
  };

  VIEWS.frontdesk = () => {
    const floors = [...new Set(S.rooms.map((r) => r.no[0]))];
    return `
      <div class="page-head"><div><h1 class="page">Front desk</h1><p class="sub">Live room board. Click any room to check in, post charges, view the bill or update housekeeping.</p></div>
        <div class="row-actions"><button class="btn btn-gold" data-action="walkin">+ Walk-in</button></div></div>
      <div class="legend"><span><i style="background:var(--ink)"></i>Occupied</span><span><i style="background:#f6d2c2"></i>Departing today</span><span><i style="background:#d6e4f5"></i>Arriving (room assigned)</span><span><i style="background:#e1f0e7"></i>Vacant clean</span><span><i style="background:#f5e6b9"></i>Vacant dirty</span><span><i style="background:#dcdcdc"></i>Out of order</span></div>
      ${floors.map((f) => `<div class="card mt"><h2 class="sec">Floor ${f}</h2><div class="rack">${S.rooms.filter((r) => r.no[0] === f).map((room) => {
        const r = resInRoom(room.no), c = roomClass(room);
        const label = r ? esc(r.guest) : { vc: "Vacant · clean", dirty: "Vacant · dirty", ooo: "Out of order", arr: "Arriving" }[c] || "";
        return `<button class="room ${c}" data-action="room" data-no="${room.no}"><b>${room.no}</b><small>${esc(rt(room.type).name)}</small><span class="g">${label}</span>${r ? `<small>Until ${fdate(r.dep)}${r.hk === "dirty" ? " · needs service" : ""}</small>` : ""}</button>`;
      }).join("")}</div></div>`).join("")}`;
  };

  VIEWS.reservations = () => {
    const t = curTab("res", "active");
    const list = S.reservations.filter((r) => ({
      active: r.status === "Reserved" || r.status === "In-house", arrivals: r.arr === S.date && r.status === "Reserved", inhouse: r.status === "In-house",
      departures: r.dep === S.date && r.status === "In-house", upcoming: r.arr > S.date && r.status === "Reserved", past: ["Checked out", "Cancelled", "No-show"].includes(r.status),
    }[t])).sort((a, b) => a.arr.localeCompare(b.arr));
    return `
      <div class="page-head"><div><h1 class="page">Reservations</h1><p class="sub">Every booking from the front desk, website and OTAs in one list.</p></div>
        <button class="btn btn-gold" data-action="new-res">+ New reservation</button></div>
      ${tabs("res", [["active", "All active"], ["arrivals", "Arrivals today"], ["inhouse", "In-house"], ["departures", "Departures today"], ["upcoming", "Upcoming"], ["past", "Past & cancelled"]])}
      <div class="card">${table(["Guest", "Room", "Arrive", "Depart", "Source", "Status", "#Balance", ""], list.map((r) => `<tr>
        <td><b>${esc(r.guest)}</b><br><small style="color:var(--muted)">${esc(rt(r.type).name)} · ${esc(r.phone)}</small></td><td>${r.room || "–"}</td><td>${fdate(r.arr)}</td><td>${fdate(r.dep)}</td><td>${esc(r.source)}</td><td>${statusPill(r.status)}</td><td class="num">${num(balance(r))}</td>
        <td><div class="row-actions">${r.status === "Reserved" && r.arr <= S.date ? `<button class="btn btn-sm btn-gold" data-action="checkin" data-id="${r.id}">Check in</button>` : ""}
          ${r.status === "In-house" ? `<button class="btn btn-sm" data-action="checkout" data-id="${r.id}">Check out</button>` : ""}
          <button class="btn btn-sm btn-ghost" data-action="folio" data-id="${r.id}">Bill</button>
          ${r.status === "Reserved" ? `<button class="btn btn-sm btn-ghost" data-action="cancel-res" data-id="${r.id}">Cancel</button>` : ""}</div></td></tr>`))}</div>`;
  };

  VIEWS.booking = () => {
    const q = ui.be || { arr: S.date, dep: addDays(S.date, 2), adults: 2 };
    const n = Math.max(1, nightsBetween(q.arr, q.dep));
    const rows = S.roomTypes.map((t) => {
      let free = Infinity; for (let d = q.arr; d < q.dep; d = addDays(d, 1)) free = Math.min(free, availability(t.code, d));
      return { t, free };
    });
    return `
      <div class="page-head"><div><h1 class="page">Website booking engine</h1><p class="sub">This is what guests see on your website. Bookings land straight in Reservations and update every channel.</p></div></div>
      <div class="be">
        <div class="be-hero"><h2>${esc(S.property)}</h2><p style="margin:0;opacity:.85">Best rate guaranteed when you book direct · Free breakfast</p></div>
        <form class="be-search form" data-form="be-search">
          <label>Check-in<input type="date" name="arr" value="${q.arr}" min="${S.date}" required></label>
          <label>Check-out<input type="date" name="dep" value="${q.dep}" min="${addDays(S.date, 1)}" required></label>
          <label>Guests<select name="adults">${opts([["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], String(q.adults))}</select></label>
          <button class="btn btn-gold" type="submit">Check availability</button>
        </form>
        ${rows.map(({ t, free }) => `<div class="be-room"><div class="be-thumb"></div><div><h3>${esc(t.name)}</h3><p style="margin:0;color:var(--muted)">Free Wi-Fi · Breakfast included · ${free > 0 ? `<b style="color:var(--ok)">${free} left</b>` : `<b style="color:var(--bad)">Sold out</b>`}</p></div>
          <div class="be-price"><small>${n} night${n > 1 ? "s" : ""}</small><b>${ugx(t.rate * n)}</b><button class="btn btn-sm btn-gold" data-action="be-book" data-type="${t.code}" ${free > 0 ? "" : "disabled"}>Book now</button></div></div>`).join("")}
      </div>`;
  };

  VIEWS.channels = () => {
    const days = [...Array(7)].map((_, i) => addDays(S.date, i));
    const ota = S.reservations.filter((r) => ["Booking.com", "Expedia", "Airbnb", "Google Hotels"].includes(r.source));
    return `
      <div class="page-head"><div><h1 class="page">Channel manager</h1><p class="sub">Rates and availability pushed to every connected channel. OTA bookings arrive here automatically.</p></div>
        <div class="row-actions"><button class="btn btn-gold" data-action="push-rates">Push rates &amp; availability</button><button class="btn btn-ghost" data-action="sim-ota">Simulate incoming OTA booking</button></div></div>
      <div class="card">${table(["Channel", "Status", "#Commission", "Bookings (active)", "Last sync"], S.channels.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${c.connected ? pill("Connected", "ok") : pill("Paused", "warn")}</td><td class="num">${c.commission}%</td><td>${S.reservations.filter((r) => (r.source === c.name || (c.name === "Website booking engine" && r.source === "Website")) && ["Reserved", "In-house"].includes(r.status)).length}</td><td>${esc(c.lastSync)} <button class="btn btn-sm btn-ghost" data-action="toggle-channel" data-name="${esc(c.name)}">${c.connected ? "Pause" : "Resume"}</button></td></tr>`))}</div>
      <div class="card mt"><h2 class="sec">Availability &amp; rates, next 7 days</h2>${table(["Room type", "Rate", ...days.map(fdate)], S.roomTypes.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td><button class="btn btn-sm btn-ghost" data-action="edit-rate" data-type="${t.code}">${num(t.rate)}</button></td>${days.map((d) => { const a = availability(t.code, d); return `<td>${a ? a : pill("Full", "bad")}</td>`; }).join("")}</tr>`))}
        <p class="note">Click a rate to change it. The new rate is sent to every connected channel and the booking engine.</p></div>
      <div class="card mt"><h2 class="sec">Recent OTA reservations</h2>${table(["Guest", "Channel", "Arrive", "Nights", "Status"], ota.slice(-8).reverse().map((r) => `<tr><td>${esc(r.guest)}</td><td>${esc(r.source)}</td><td>${fdate(r.arr)}</td><td>${nightsBetween(r.arr, r.dep)}</td><td>${statusPill(r.status)}</td></tr>`))}</div>`;
  };

  VIEWS.pos = () => {
    const outlet = ui.outlet;
    const items = S.menu.filter((m) => outlet === "Room Service" ? m.outlet === "Restaurant" || m.id === "m10" || m.id === "m12" : m.outlet === outlet);
    const total = sum(ui.cart, (l) => l.qty * S.menu.find((m) => m.id === l.id).price);
    const today = S.sales.filter((s) => s.date === S.date && s.dept === "Food & Beverage").slice().reverse();
    return `
      <div class="page-head"><div><h1 class="page">Restaurant / POS</h1><p class="sub">Take orders, send them to the kitchen or bar, and settle by cash, card, mobile money or charge to the guest's room.</p></div></div>
      <div class="tabs">${S.outlets.map((o) => `<button class="${o === outlet ? "on" : ""}" data-action="outlet" data-val="${o}">${o}</button>`).join("")}</div>
      <div class="pos">
        <div class="items">${items.map((m) => `<button class="item" data-action="add-item" data-id="${m.id}"><b>${esc(m.name)}</b><span>${num(m.price)}</span></button>`).join("")}</div>
        <div class="card cart"><h2 class="sec">Current order · ${esc(outlet)}</h2>
          ${ui.cart.length ? ui.cart.map((l) => { const m = S.menu.find((x) => x.id === l.id); return `<div class="cart-line"><span>${esc(m.name)}</span><span class="qty"><button data-action="qty" data-id="${l.id}" data-d="-1" aria-label="Less">−</button>${l.qty}<button data-action="qty" data-id="${l.id}" data-d="1" aria-label="More">+</button></span><b>${num(l.qty * m.price)}</b></div>`; }).join("") : `<p class="empty">Tap items to start an order.</p>`}
          <div class="cart-total"><span>Total</span><span>${ugx(total)}</span></div>
          <div class="pay-btns">
            <button class="btn btn-gold" data-action="pay" data-m="room" ${total ? "" : "disabled"}>Charge to room</button>
            <button class="btn" data-action="pay" data-m="cash" ${total ? "" : "disabled"}>Cash</button>
            <button class="btn" data-action="pay" data-m="card" ${total ? "" : "disabled"}>Card</button>
            <button class="btn" data-action="pay" data-m="momo" ${total ? "" : "disabled"}>Mobile money</button>
          </div>
          <p class="note" style="margin-top:12px">Paying sends the order ticket to the ${outlet === "Bar" ? "bar" : "kitchen"}, deducts ingredients from stock and posts the sale to accounting.</p>
        </div>
      </div>
      <div class="card mt"><h2 class="sec">Today's F&amp;B sales</h2>${table(["Outlet", "Order", "Settled by", "#Amount"], today.map((s) => `<tr><td>${esc(s.outlet)}</td><td>${esc(s.desc)}</td><td>${esc(METHODS[s.method])}${s.resId ? ` · Room ${resById(s.resId).room}` : ""}</td><td class="num">${num(s.amount)}</td></tr>`), "No sales yet today.")}</div>`;
  };

  VIEWS.amenities = () => {
    const today = S.sales.filter((s) => s.dept === "Amenities").slice().reverse().slice(0, 12);
    return `
      <div class="page-head"><div><h1 class="page">Amenity &amp; add-on sales</h1><p class="sub">Sell spa treatments, transfers, laundry, tours and passes to in-house guests or walk-in customers.</p></div></div>
      <div class="grid g3">${S.amenities.map((a) => `<div class="card"><b style="font-size:1rem">${esc(a.name)}</b><p style="margin:6px 0 12px;color:var(--gold-d);font-weight:700">${ugx(a.price)}</p><button class="btn btn-gold btn-sm" data-action="sell-amenity" data-id="${a.id}">Sell</button></div>`).join("")}</div>
      <div class="card mt"><h2 class="sec">Recent amenity sales</h2>${table(["Date", "Item", "Settled by", "#Amount"], today.map((s) => `<tr><td>${fdate(s.date)}</td><td>${esc(s.desc)}</td><td>${esc(METHODS[s.method])}${s.resId ? ` · Room ${resById(s.resId).room}` : ""}</td><td class="num">${num(s.amount)}</td></tr>`))}</div>`;
  };

  VIEWS.events = () => {
    const list = S.events.slice().sort((a, b) => a.date.localeCompare(b.date));
    return `
      <div class="page-head"><div><h1 class="page">Events &amp; banqueting</h1><p class="sub">Function rooms, quotations, deposits and banquet event orders (BEOs).</p></div><button class="btn btn-gold" data-action="new-event">+ New event</button></div>
      <div class="grid g3">${S.functionRooms.map((f) => { const nx = list.find((e) => e.room === f.id && e.date >= S.date && e.status !== "Cancelled"); return `<div class="card"><b style="font-size:1rem">${esc(f.name)}</b><p style="margin:4px 0 0;color:var(--muted)">Up to ${f.capacity} guests</p><p style="margin:8px 0 0">${nx ? `Next: <b>${fdate(nx.date)}</b>, ${esc(nx.name)}` : "No upcoming bookings"}</p></div>`; }).join("")}</div>
      <div class="card mt">${table(["Date", "Event", "Room", "#Pax", "#Total", "#Deposit", "Status", ""], list.map((e) => `<tr><td>${fdate(e.date)}</td><td><b>${esc(e.name)}</b><br><small style="color:var(--muted)">${esc(e.client)} · ${esc(S.eventPackages.find((p) => p.id === e.pkg).name)}</small></td><td>${esc(S.functionRooms.find((f) => f.id === e.room).name)}</td><td class="num">${e.pax}</td><td class="num">${num(e.total)}</td><td class="num">${num(e.deposit)}</td><td>${statusPill(e.status)}</td>
        <td><div class="row-actions"><button class="btn btn-sm btn-ghost" data-action="beo" data-id="${e.id}">BEO</button>${e.status !== "Completed" && e.status !== "Cancelled" ? `${e.total > e.deposit ? `<button class="btn btn-sm btn-ghost" data-action="event-deposit" data-id="${e.id}">Take payment</button>` : pill("Paid in full", "ok")}<button class="btn btn-sm" data-action="event-bill" data-id="${e.id}">Complete &amp; bill</button>` : ""}</div></td></tr>`))}</div>`;
  };

  VIEWS.inventory = () => {
    const t = curTab("inv", "All stores");
    const stores = ["All stores", ...new Set(S.stock.map((s) => s.store))];
    const list = S.stock.filter((s) => t === "All stores" || s.store === t);
    return `
      <div class="page-head"><div><h1 class="page">Inventory</h1><p class="sub">Stock in every store, valued at cost. POS sales deduct ingredients automatically by recipe.</p></div>
        <div class="row-actions"><button class="btn btn-gold" data-action="receive">Receive stock (GRN)</button><a class="btn btn-ghost" href="#requisitions">Requisitions</a></div></div>
      ${tabs("inv", stores.map((s) => [s, s]))}
      <div class="card">${table(["Item", "Store", "#In stock", "#Re-order at", "#Unit cost", "#Value", "Status"], list.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.store)}</td><td class="num">${Number.isInteger(s.qty) ? num(s.qty) : s.qty.toFixed(2)} ${esc(s.unit)}</td><td class="num">${num(s.reorder)}</td><td class="num">${num(s.cost)}</td><td class="num">${num(s.qty * s.cost)}</td><td>${s.qty <= s.reorder ? pill("Re-order", "bad") : pill("OK", "ok")}</td></tr>`).concat([`<tr class="total"><td colspan="5">Total stock value</td><td class="num">${num(sum(list, (s) => s.qty * s.cost))}</td><td></td></tr>`]))}</div>
      <div class="card mt"><h2 class="sec">Recent goods received</h2>${table(["Date", "Item", "#Qty", "Supplier", "#Cost"], S.purchases.slice().reverse().slice(0, 8).map((p) => `<tr><td>${fdate(p.date)}</td><td>${esc(stockById(p.item).name)}</td><td class="num">${p.qty}</td><td>${esc(p.supplier)}</td><td class="num">${num(p.qty * p.cost)}</td></tr>`), "No deliveries recorded yet. Use “Receive stock”.")}</div>`;
  };

  VIEWS.requisitions = () => {
    const list = S.requisitions.slice().reverse();
    const desc = (q) => q.lines.map(([id, n]) => `${n} ${esc(stockById(id).unit)} ${esc(stockById(id).name)}`).join(", ");
    return `
      <div class="page-head"><div><h1 class="page">Departmental requisitions</h1><p class="sub">Departments request stock; the head of department approves; the store issues it. Every step is tracked and costed to the department.</p></div><button class="btn btn-gold" data-action="new-req">+ New requisition</button></div>
      <div class="card">${table(["Date", "Department", "Requested by", "Items", "Status", ""], list.map((q) => `<tr><td>${fdate(q.date)}</td><td>${esc(q.dept)}</td><td>${esc(q.by)}</td><td>${desc(q)}${q.note ? `<br><small style="color:var(--muted)">${esc(q.note)}</small>` : ""}</td><td>${statusPill(q.status)}</td>
        <td><div class="row-actions">${q.status === "Pending" ? `<button class="btn btn-sm btn-ok" data-action="req" data-op="approve" data-id="${q.id}">Approve</button><button class="btn btn-sm btn-bad" data-action="req" data-op="reject" data-id="${q.id}">Reject</button>` : ""}${q.status === "Approved" ? `<button class="btn btn-sm" data-action="req" data-op="issue" data-id="${q.id}">Issue from store</button>` : ""}</div></td></tr>`))}</div>`;
  };

  const paye = (g) => { // Uganda monthly PAYE (resident individual), simplified
    let t = 0;
    if (g > 410000) t = 25000 + 0.3 * (g - 410000); else if (g > 335000) t = 10000 + 0.2 * (g - 335000); else if (g > 235000) t = 0.1 * (g - 235000);
    if (g > 10000000) t += 0.1 * (g - 10000000);
    return Math.round(t);
  };
  VIEWS.hr = () => {
    const t = curTab("hr", "staff");
    const body = {
      staff: () => `<div class="card">${table(["Name", "Department", "Role", "Today's shift", "On leave"], S.staff.map((e) => { const onLeave = S.leave.some((l) => l.staff === e.id && l.status === "Approved" && l.from <= S.date && S.date <= l.to); return `<tr><td><b>${esc(e.name)}</b></td><td>${esc(e.dept)}</td><td>${esc(e.role)}</td><td><select data-action="shift" data-id="${e.id}" aria-label="Shift for ${esc(e.name)}">${opts(["Morning", "Evening", "Night", "Off"].map((s) => [s, s]), e.shift)}</select></td><td>${onLeave ? pill("On leave", "warn") : ""}</td></tr>`; }))}</div>`,
      roster: () => `<div class="grid g4">${["Morning", "Evening", "Night", "Off"].map((s) => `<div class="card"><h2 class="sec">${s}</h2>${S.staff.filter((e) => e.shift === s).map((e) => `<div style="padding:4px 0;border-bottom:1px dashed var(--line)"><b>${esc(e.name)}</b><br><small style="color:var(--muted)">${esc(e.role)}</small></div>`).join("") || `<p class="empty">Nobody</p>`}</div>`).join("")}</div>`,
      leave: () => `<div class="card">${table(["Staff", "Type", "From", "To", "Status", ""], S.leave.map((l) => `<tr><td>${esc(staffById(l.staff).name)}</td><td>${esc(l.type)}</td><td>${fdate(l.from)}</td><td>${fdate(l.to)}</td><td>${statusPill(l.status)}</td><td>${l.status === "Pending" ? `<div class="row-actions"><button class="btn btn-sm btn-ok" data-action="leave" data-op="Approved" data-id="${l.id}">Approve</button><button class="btn btn-sm btn-bad" data-action="leave" data-op="Rejected" data-id="${l.id}">Decline</button></div>` : ""}</td></tr>`))}</div>`,
      payroll: () => {
        const rows = S.staff.map((e) => { const p = paye(e.salary), n5 = Math.round(e.salary * 0.05), n10 = Math.round(e.salary * 0.1); return { e, p, n5, n10, net: e.salary - p - n5 }; });
        const month = S.date.slice(0, 7), done = S.payrollRuns.includes(month);
        return `<div class="card">${table(["Name", "#Gross", "#PAYE", "#NSSF 5%", "#Net pay", "#Employer NSSF 10%"], rows.map((r) => `<tr><td>${esc(r.e.name)}<br><small style="color:var(--muted)">${esc(r.e.role)}</small></td><td class="num">${num(r.e.salary)}</td><td class="num">${num(r.p)}</td><td class="num">${num(r.n5)}</td><td class="num">${num(r.net)}</td><td class="num">${num(r.n10)}</td></tr>`).concat([`<tr class="total"><td>Total</td><td class="num">${num(sum(rows, (r) => r.e.salary))}</td><td class="num">${num(sum(rows, (r) => r.p))}</td><td class="num">${num(sum(rows, (r) => r.n5))}</td><td class="num">${num(sum(rows, (r) => r.net))}</td><td class="num">${num(sum(rows, (r) => r.n10))}</td></tr>`]))}
          <div class="row-actions" style="margin-top:12px;align-items:center"><button class="btn btn-gold" data-action="run-payroll" ${done ? "disabled" : ""}>${done ? "Payroll posted for this month" : "Approve & post payroll"}</button><span class="note">Deductions are estimates for the demo, based on monthly PAYE bands and NSSF rates. Confirm current rates with URA and NSSF before live use.</span></div></div>`;
      },
    }[t]();
    return `<div class="page-head"><div><h1 class="page">Human resources</h1><p class="sub">Staff records, duty rosters, leave and payroll.</p></div></div>
      ${tabs("hr", [["staff", "Staff"], ["roster", "Today's roster"], ["leave", "Leave requests"], ["payroll", "Payroll"]])}${body}`;
  };

  function balances() {
    const b = {};
    S.journal.forEach((j) => j.lines.forEach((l) => { b[l.acct] = (b[l.acct] || 0) + (l.dr || 0) - (l.cr || 0); }));
    return b;
  }
  VIEWS.accounting = () => {
    const t = curTab("acc", "pl");
    const b = balances();
    const accts = Object.keys(ACCT_TYPE).filter((a) => b[a]);
    const body = {
      pl: () => {
        const rev = Object.values(DEPT_REV).map((a) => [a.replace("Revenue – ", ""), -(b[a] || 0)]);
        const totalRev = sum(rev, (r) => r[1]);
        const exp = ["Cost of sales", "Departmental supplies", "Payroll expense", "Repairs & maintenance"].map((a) => [a, b[a] || 0]);
        const totalExp = sum(exp, (r) => r[1]);
        const vat = totalRev * 18 / 118;
        return `<div class="grid g2"><div class="card"><h2 class="sec">Profit &amp; loss (period to date)</h2>${table(["Line", "#UGX"], [
          `<tr><td colspan="2"><b>Revenue</b></td></tr>`, ...rev.map(([l, v]) => `<tr><td>&nbsp;&nbsp;${esc(l)}</td><td class="num">${num(v)}</td></tr>`), `<tr class="total"><td>Total revenue (VAT-inclusive)</td><td class="num">${num(totalRev)}</td></tr>`,
          `<tr><td>&nbsp;&nbsp;of which VAT at 18%</td><td class="num">(${num(vat)})</td></tr>`,
          `<tr><td colspan="2"><b>Expenses</b></td></tr>`, ...exp.map(([l, v]) => `<tr><td>&nbsp;&nbsp;${esc(l)}</td><td class="num">${num(v)}</td></tr>`), `<tr class="total"><td>Total expenses</td><td class="num">${num(totalExp)}</td></tr>`,
          `<tr class="total"><td>Net profit (after VAT)</td><td class="num">${num(totalRev - vat - totalExp)}</td></tr>`])}</div>
          <div class="card"><h2 class="sec">Cash &amp; receivables</h2>${table(["Account", "#Balance"], ["Cash", "Card clearing", "Mobile money", "Guest ledger", "Accounts receivable", "Accounts payable", "Event deposits", "Statutory payables"].map((a) => `<tr><td>${a}</td><td class="num">${num(Math.abs(b[a] || 0))}</td></tr>`))}
          <p class="note">Every sale, payment, stock movement and payroll run posts here automatically. No double entry by staff.</p></div></div>`;
      },
      tb: () => { const dr = sum(accts, (a) => Math.max(0, b[a])), cr = sum(accts, (a) => Math.max(0, -b[a])); return `<div class="card"><h2 class="sec">Trial balance</h2>${table(["Account", "Type", "#Debit", "#Credit"], accts.map((a) => `<tr><td>${esc(a)}</td><td>${ACCT_TYPE[a]}</td><td class="num">${b[a] > 0 ? num(b[a]) : ""}</td><td class="num">${b[a] < 0 ? num(-b[a]) : ""}</td></tr>`).concat([`<tr class="total"><td colspan="2">Totals ${Math.round(dr) === Math.round(cr) ? pill("Balanced", "ok") : pill("Out of balance", "bad")}</td><td class="num">${num(dr)}</td><td class="num">${num(cr)}</td></tr>`]))}</div>`; },
      journal: () => `<div class="card"><h2 class="sec">General journal (latest 40)</h2>${table(["Date", "Ref", "Description", "Account", "#Debit", "#Credit"], S.journal.slice().reverse().slice(0, 40).flatMap((j) => j.lines.map((l, i) => `<tr><td>${i ? "" : fdate(j.date)}</td><td>${i ? "" : esc(j.ref)}</td><td>${i ? "" : esc(j.desc)}</td><td>${esc(l.acct)}</td><td class="num">${l.dr ? num(l.dr) : ""}</td><td class="num">${l.cr ? num(l.cr) : ""}</td></tr>`)))}</div>`,
      ledger: () => { const rows = S.reservations.filter((r) => r.status === "In-house" || (r.status === "Checked out" && balance(r) !== 0)); return `<div class="card"><h2 class="sec">Guest ledger (open bills)</h2>${table(["Room", "Guest", "#Charges", "#Paid", "#Balance", ""], rows.map((r) => `<tr><td>${r.room}</td><td>${esc(r.guest)}</td><td class="num">${num(sum(r.folio, (x) => x.amount))}</td><td class="num">${num(sum(r.payments, (x) => x.amount))}</td><td class="num">${num(balance(r))}</td><td><button class="btn btn-sm btn-ghost" data-action="folio" data-id="${r.id}">Bill</button></td></tr>`))}</div>`; },
    }[t]();
    return `<div class="page-head"><div><h1 class="page">Accounting</h1><p class="sub">Double-entry books fed automatically by every department.</p></div></div>
      ${tabs("acc", [["pl", "Profit & loss"], ["tb", "Trial balance"], ["journal", "Journal"], ["ledger", "Guest ledger"]])}${body}`;
  };

  VIEWS.assets = () => {
    const yrs = (a) => Math.max(0, nightsBetween(a.bought, S.date) / 365.25);
    const nbv = (a) => Math.max(0, a.cost - (a.cost / a.life) * yrs(a));
    return `
      <div class="page-head"><div><h1 class="page">Assets &amp; maintenance</h1><p class="sub">Asset register with straight-line depreciation, service schedules and work orders.</p></div><button class="btn btn-gold" data-action="new-wo">+ New work order</button></div>
      <div class="card">${table(["Asset", "Location", "#Cost", "#Book value", "Next service", ""], S.assets.map((a) => { const due = a.nextService <= S.date ? pill("Overdue", "bad") : a.nextService <= addDays(S.date, 7) ? pill("Due this week", "warn") : ""; return `<tr><td><b>${esc(a.name)}</b><br><small style="color:var(--muted)">${esc(a.category)} · bought ${fdate(a.bought)}</small></td><td>${esc(a.location)}</td><td class="num">${num(a.cost)}</td><td class="num">${num(nbv(a))}</td><td>${fdate(a.nextService)} ${due}</td><td><button class="btn btn-sm btn-ghost" data-action="serviced" data-id="${a.id}">Mark serviced</button></td></tr>`; }).concat([`<tr class="total"><td colspan="2">Totals</td><td class="num">${num(sum(S.assets, (a) => a.cost))}</td><td class="num">${num(sum(S.assets, nbv))}</td><td colspan="2"></td></tr>`]))}</div>
      <div class="card mt"><h2 class="sec">Work orders</h2>${table(["Opened", "Asset", "Issue", "Priority", "Status", ""], S.workOrders.slice().reverse().map((w) => `<tr><td>${fdate(w.opened)}</td><td>${esc(S.assets.find((a) => a.id === w.asset).name)}</td><td>${esc(w.title)}</td><td>${pill(w.priority, w.priority === "High" ? "bad" : w.priority === "Medium" ? "warn" : "")}</td><td>${statusPill(w.status)}</td><td>${w.status !== "Completed" ? `<button class="btn btn-sm" data-action="wo-next" data-id="${w.id}">${w.status === "Open" ? "Start" : "Complete"}</button>` : ""}</td></tr>`))}</div>`;
  };

  VIEWS.reports = () => {
    const t = curTab("rep", "manager");
    const d = addDays(S.date, -1), st = dayStats(d), today = dayStats();
    const adr = st.occ ? st.roomRev / st.occ : 0, revpar = st.sellable ? st.roomRev / st.sellable : 0;
    const pays = {}; S.journal.filter((j) => j.date === d).forEach((j) => j.lines.forEach((l) => { if (["Cash", "Card clearing", "Mobile money"].includes(l.acct) && l.dr) pays[l.acct] = (pays[l.acct] || 0) + l.dr; }));
    const body = {
      manager: () => `<div class="card" id="report-card"><h2 class="sec">Daily manager's report · ${fdateLong(d)}</h2>
        <div class="grid g4">${[["Occupancy", Math.round(st.occPct * 100) + "%"], ["ADR", num(adr)], ["RevPAR", num(revpar)], ["Total revenue", num(st.total)]].map(([l, v]) => `<div class="kpi"><span>${l}</span><b>${v}</b></div>`).join("")}</div>
        <div class="grid g2 mt"><div>${table(["Department", "#Revenue (UGX)"], [["Rooms", st.roomRev], ["Food & beverage", st.fb], ["Amenities", st.amen], ["Events", st.events]].map(([a, v]) => `<tr><td>${a}</td><td class="num">${num(v)}</td></tr>`).concat([`<tr class="total"><td>Total</td><td class="num">${num(st.total)}</td></tr>`]))}</div>
        <div>${table(["Collections", "#UGX"], Object.entries(pays).map(([a, v]) => `<tr><td>${a.replace(" clearing", "")}</td><td class="num">${num(v)}</td></tr>`), "No collections")}
        ${table(["Today", "#"], [["Arrivals", arrivalsToday().length], ["Departures", departuresToday().length], ["In-house", inHouse().length], ["Rooms out of order", S.rooms.filter((r) => r.hk === "ooo").length], ["Stock items to re-order", S.stock.filter((s) => s.qty <= s.reorder).length]].map(([a, v]) => `<tr><td>${a}</td><td class="num">${v}</td></tr>`))}</div></div></div>`,
      fo: () => `<div class="card"><h2 class="sec">Front office · ${fdateLong(S.date)}</h2>${table(["Source", "#Active bookings", "#Room nights"], [...new Set(S.reservations.map((r) => r.source))].map((src) => { const l = S.reservations.filter((r) => r.source === src && ["Reserved", "In-house"].includes(r.status)); return `<tr><td>${esc(src)}</td><td class="num">${l.length}</td><td class="num">${sum(l, (r) => nightsBetween(r.arr, r.dep))}</td></tr>`; }))}</div>`,
      fb: () => { const fb = S.sales.filter((s) => s.dept === "Food & Beverage"); const by = {}; fb.forEach((s) => { by[s.outlet] = (by[s.outlet] || 0) + s.amount; }); return `<div class="card"><h2 class="sec">Food &amp; beverage, period to date</h2>${table(["Outlet", "#Sales (UGX)"], Object.entries(by).map(([o, v]) => `<tr><td>${esc(o)}</td><td class="num">${num(v)}</td></tr>`))}<p class="note">Food cost to date: ${ugx(balances()["Cost of sales"] || 0)} (${Math.round(((balances()["Cost of sales"] || 0) / Math.max(1, sum(fb, (s) => s.amount))) * 100)}% of F&amp;B sales).</p></div>`; },
      stock: () => `<div class="card"><h2 class="sec">Stock &amp; requisitions</h2>${table(["Item", "#In stock", "#Re-order at"], S.stock.filter((s) => s.qty <= s.reorder).map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.qty} ${esc(s.unit)}</td><td class="num">${s.reorder}</td></tr>`), "All stock above re-order levels.")}<p class="note">${S.requisitions.filter((r) => r.status === "Pending").length} pending and ${S.requisitions.filter((r) => r.status === "Approved").length} approved-but-not-issued requisitions.</p></div>`,
      auto: () => `<div class="card"><h2 class="sec">Automatic report emails</h2>${table(["Report", "Sent to", "Schedule", "On"], S.schedules.map((s, i) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.to)}</td><td>${esc(s.when)}</td><td><input type="checkbox" data-action="sched" data-i="${i}" ${s.on ? "checked" : ""} aria-label="Send ${esc(s.name)} automatically"></td></tr>`))}<p class="note">In the live system these reports are generated and emailed automatically. In the demo, switching one on or off is just saved.</p></div>`,
    }[t]();
    return `<div class="page-head"><div><h1 class="page">Reports</h1><p class="sub">Department reports generated automatically from live data.</p></div><button class="btn btn-ghost no-print" data-action="print">Print / save PDF</button></div>
      ${tabs("rep", [["manager", "Daily manager's report"], ["fo", "Front office"], ["fb", "Food & beverage"], ["stock", "Stock"], ["auto", "Automatic emails"]])}${body}`;
  };

  /* ================= MODAL FORMS ================= */
  const freeRooms = (type) => S.rooms.filter((r) => r.type === type && r.hk !== "ooo" && !resInRoom(r.no));

  function newResForm(pre = {}) {
    modal("New reservation", `<form class="form" data-form="res">
      <label>Guest name<input name="guest" required value="${esc(pre.guest || "")}"></label>
      <div class="two"><label>Phone<input name="phone" value="${esc(pre.phone || "")}" placeholder="+256 …"></label><label>Source<select name="source">${opts(["Direct", "Walk-in", "Website", "Booking.com", "Expedia", "Airbnb", "Corporate"].map((s) => [s, s]), pre.source || "Direct")}</select></label></div>
      <div class="two"><label>Arrival<input type="date" name="arr" value="${pre.arr || S.date}" min="${S.date}" required></label><label>Departure<input type="date" name="dep" value="${pre.dep || addDays(S.date, 1)}" min="${addDays(S.date, 1)}" required></label></div>
      <div class="two"><label>Room type<select name="type">${opts(S.roomTypes.map((t) => [t.code, `${t.name} · ${num(t.rate)}`]), pre.type || "DLX")}</select></label><label>Adults<input type="number" name="adults" min="1" max="6" value="2"></label></div>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Save reservation</button></div></form>`,
      (f) => {
        if (f.dep <= f.arr) return "Departure must be after arrival.";
        for (let d = f.arr; d < f.dep; d = addDays(d, 1)) if (!availability(f.type, d)) return `No ${rt(f.type).name} available on ${fdate(d)}.`;
        const r = { id: uid("R"), guest: f.guest.trim(), phone: f.phone, type: f.type, arr: f.arr, dep: f.dep, adults: +f.adults, source: f.source, rate: rt(f.type).rate, room: null, status: "Reserved", folio: [], payments: [] };
        S.reservations.push(r);
        if (pre.after) pre.after(r);
        return { msg: `Reservation saved for <b>${esc(r.guest)}</b>.` };
      });
  }

  function checkinForm(r) {
    const rooms = freeRooms(r.type);
    const clean = rooms.filter((x) => x.hk === "vc");
    modal(`Check in · ${r.guest}`, `<form class="form" data-form="checkin">
      <dl class="kv"><dt>Stay</dt><dd>${fdate(r.arr)} → ${fdate(r.dep)} (${nightsBetween(r.arr, r.dep)} nights)</dd><dt>Room type</dt><dd>${esc(rt(r.type).name)} · ${ugx(r.rate)} / night</dd><dt>Source</dt><dd>${esc(r.source)}</dd></dl>
      <label>Assign room<select name="room" required>${rooms.length ? opts(rooms.map((x) => [x.no, `Room ${x.no}${x.hk === "dirty" ? " (not yet cleaned)" : ""}`]), (clean[0] || rooms[0]).no) : `<option value="">No rooms of this type free</option>`}</select></label>
      <label>ID / passport number<input name="idno" placeholder="Captured for the guest register"></label>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold" ${rooms.length ? "" : "disabled"}>Check in</button></div></form>`,
      (f) => { if (!f.room) return "Choose a room."; r.room = f.room; r.status = "In-house"; r.idno = f.idno; return { msg: `<b>${esc(r.guest)}</b> checked in to room ${f.room}.` }; });
  }

  function folioView(r) {
    const bal = balance(r);
    modal(`Bill · ${r.guest}`, `
      <dl class="kv"><dt>Room</dt><dd>${r.room || "Not assigned"} · ${esc(rt(r.type).name)}</dd><dt>Stay</dt><dd>${fdate(r.arr)} → ${fdate(r.dep)}</dd><dt>Status</dt><dd>${statusPill(r.status)}</dd></dl>
      ${table(["Date", "Description", "Outlet", "#Amount"], r.folio.map((x) => `<tr><td>${fdate(x.date)}</td><td>${esc(x.desc)}</td><td>${esc(x.dept)}</td><td class="num">${num(x.amount)}</td></tr>`).concat(r.payments.map((p) => `<tr><td>${fdate(p.date)}</td><td>${esc(p.note)}</td><td>${esc(METHODS[p.method])}</td><td class="num">(${num(p.amount)})</td></tr>`)).concat([`<tr class="total"><td colspan="3">Balance due</td><td class="num">${ugx(bal)}</td></tr>`]), "No charges yet.")}
      <div class="form no-print" style="margin-top:14px"><div class="actions" style="justify-content:flex-start">
        ${r.status === "In-house" ? `<button class="btn btn-ghost" data-action="post-charge" data-id="${r.id}">Post charge</button>` : ""}
        ${bal > 0 ? `<button class="btn btn-ghost" data-action="take-payment" data-id="${r.id}">Take payment</button>` : ""}
        ${r.status === "In-house" ? `<button class="btn" data-action="checkout" data-id="${r.id}">Check out</button>` : ""}
        <button class="btn btn-ghost" data-action="print-modal">Print invoice</button></div></div>`);
  }

  function paymentForm(r, then) {
    const bal = balance(r);
    modal(`Take payment · ${r.guest}`, `<form class="form" data-form="pay">
      <div class="two"><label>Amount (UGX)<input type="number" name="amount" min="1" value="${Math.max(0, bal)}" required></label><label>Method<select name="method">${opts(methodOpts(false, true), "card")}</select></label></div>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Record payment</button></div></form>`,
      (f) => {
        const amt = Math.round(+f.amount); if (!(amt > 0)) return "Enter an amount.";
        if (f.method === "invoice") { // move balance to company (city ledger) account
          r.payments.push({ id: uid("P"), date: S.date, method: "invoice", amount: amt, note: "Transferred to company account" });
          journal(S.date, r.id, `To company account: ${r.guest}`, [{ acct: "Accounts receivable", dr: amt }, { acct: "Guest ledger", cr: amt }]);
        } else postPayment(r, f.method, amt);
        if (then) then();
        return { msg: `Payment of <b>${ugx(amt)}</b> recorded.` };
      });
  }

  function checkoutFlow(r) {
    const bal = balance(r);
    const done = () => { r.status = "Checked out"; const room = S.rooms.find((x) => x.no === r.room); if (room) room.hk = "dirty"; };
    if (bal <= 0) { done(); commit(`<b>${esc(r.guest)}</b> checked out. Room ${r.room} sent to housekeeping.`); return; }
    paymentForm(r, () => { if (balance(r) <= 0) done(); });
    $("#modal-title").textContent = `Check out · ${r.guest} (balance ${ugx(bal)})`;
  }

  function postChargeForm(r) {
    modal(`Post charge · Room ${r.room}`, `<form class="form" data-form="charge">
      <label>Description<input name="desc" required placeholder="e.g. Minibar, Laundry, Damages"></label>
      <div class="two"><label>Department<select name="dept">${opts([["Food & Beverage", "Food & beverage"], ["Amenities", "Amenities"], ["Rooms", "Rooms"]], "Amenities")}</select></label><label>Amount (UGX)<input type="number" name="amount" min="1" required></label></div>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Post to bill</button></div></form>`,
      (f) => { const amt = Math.round(+f.amount); if (!(amt > 0)) return "Enter an amount."; postSale({ dept: f.dept, outlet: f.dept === "Rooms" ? "Front Office" : f.dept, desc: f.desc, amount: amt, method: "room", resId: r.id }); return { msg: `${ugx(amt)} posted to room ${r.room}.` }; });
  }

  function roomModal(no) {
    const room = S.rooms.find((x) => x.no === no), r = resInRoom(no);
    const hkBtns = ["vc", "dirty", "ooo"].filter((h) => h !== room.hk).map((h) => `<button class="btn btn-ghost" data-action="hk" data-no="${no}" data-hk="${h}">Mark ${{ vc: "clean", dirty: "dirty", ooo: "out of order" }[h]}</button>`).join("");
    const arrivals = arrivalsToday().filter((a) => a.type === room.type);
    modal(`Room ${no} · ${rt(room.type).name}`, r ? `
      <dl class="kv"><dt>Guest</dt><dd>${esc(r.guest)}</dd><dt>Phone</dt><dd>${esc(r.phone)}</dd><dt>Stay</dt><dd>${fdate(r.arr)} → ${fdate(r.dep)}</dd><dt>Balance</dt><dd>${ugx(balance(r))}</dd><dt>Housekeeping</dt><dd>${room.hk === "dirty" ? "Needs service" : "Serviced"}</dd></dl>
      <div class="row-actions"><button class="btn btn-ghost" data-action="folio" data-id="${r.id}">View bill</button><button class="btn btn-ghost" data-action="post-charge" data-id="${r.id}">Post charge</button><button class="btn" data-action="checkout" data-id="${r.id}">Check out</button>${hkBtns}</div>` : `
      <dl class="kv"><dt>Status</dt><dd>${{ vc: "Vacant · clean", dirty: "Vacant · dirty", ooo: "Out of order" }[room.hk]}</dd><dt>Rate</dt><dd>${ugx(rt(room.type).rate)} / night</dd></dl>
      ${arrivals.length && room.hk !== "ooo" ? `<p class="note">Arriving today for this room type: ${arrivals.map((a) => `<button class="btn btn-sm btn-gold" data-action="checkin-to" data-id="${a.id}" data-no="${no}">Check in ${esc(a.guest)}</button>`).join(" ")}</p>` : ""}
      <div class="row-actions">${room.hk !== "ooo" ? `<button class="btn btn-gold" data-action="walkin" data-type="${room.type}" data-no="${no}">Walk-in to this room</button>` : ""}${hkBtns}</div>`);
  }

  function sellForm({ title, amount, dept, outlet, desc, onDone }) {
    const rooms = roomOpts();
    modal(title, `<form class="form" data-form="sell">
      <dl class="kv"><dt>Total</dt><dd>${ugx(amount)}</dd></dl>
      <label>Settle by<select name="method">${opts(methodOpts(rooms.length > 0), rooms.length ? "room" : "cash")}</select></label>
      <label>Guest room (for charge to room)<select name="res">${opts(rooms, "")}</select></label>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Complete sale</button></div></form>`,
      (f) => {
        const ref = uid(dept === "Food & Beverage" ? "POS" : "AM");
        postSale({ dept, outlet, desc, amount, method: f.method, resId: f.method === "room" ? f.res : null, ref });
        if (onDone) onDone(ref);
        return { msg: f.method === "room" ? `<b>${ugx(amount)}</b> charged to room ${resById(f.res).room}.` : `<b>${ugx(amount)}</b> paid by ${METHODS[f.method].toLowerCase()}.` };
      });
  }

  /* ================= ACTIONS ================= */
  const A = {
    "toggle-nav": () => document.body.classList.toggle("nav-open"),
    "close-modal": closeModal,
    "reset-demo": () => { if (confirm("Reset the demo to its original sample data?")) { seed(); ui.cart = []; ui.be = null; ui.tab = {}; closeModal(); commit("Demo data reset."); } },
    tab: (d) => { ui.tab[d.key] = d.val; render(); },
    "new-res": (d, e) => { e.preventDefault(); newResForm(); },
    checkin: (d) => checkinForm(resById(d.id)),
    "checkin-to": (d) => { checkinForm(resById(d.id)); const sel = $("#modal-body select[name=room]"); if (sel) sel.value = d.no; },
    checkout: (d) => checkoutFlow(resById(d.id)),
    folio: (d) => folioView(resById(d.id)),
    "cancel-res": (d) => { const r = resById(d.id); if (confirm(`Cancel the reservation for ${r.guest}?`)) { r.status = "Cancelled"; commit("Reservation cancelled. Availability released to all channels."); } },
    "post-charge": (d) => postChargeForm(resById(d.id)),
    "take-payment": (d) => paymentForm(resById(d.id)),
    room: (d) => roomModal(d.no),
    hk: (d) => { S.rooms.find((x) => x.no === d.no).hk = d.hk; closeModal(); commit(`Room ${d.no} updated.`); },
    walkin: (d) => newResForm({ source: "Walk-in", type: d.type || "STD", after: (r) => { const room = d.no || (freeRooms(r.type).find((x) => x.hk === "vc") || freeRooms(r.type)[0] || {}).no; if (room && r.arr === S.date) { r.room = room; r.status = "In-house"; } } }),
    "print-modal": () => { document.body.classList.add("printing-modal"); window.print(); document.body.classList.remove("printing-modal"); },
    print: () => window.print(),

    "be-book": (d) => {
      const q = ui.be || { arr: S.date, dep: addDays(S.date, 2), adults: 2 }; const t = rt(d.type); const n = nightsBetween(q.arr, q.dep);
      modal(`Book ${t.name}`, `<form class="form" data-form="be-book">
        <dl class="kv"><dt>Dates</dt><dd>${fdate(q.arr)} → ${fdate(q.dep)} · ${n} night${n > 1 ? "s" : ""}</dd><dt>Total</dt><dd>${ugx(t.rate * n)}</dd></dl>
        <label>Full name<input name="guest" required></label><div class="two"><label>Phone<input name="phone" placeholder="+256 …"></label><label>Email<input type="email" name="email"></label></div>
        <label>Pay now<select name="pay">${opts([["none", "Pay at the hotel"], ["card", "Pay first night now by card"], ["momo", "Pay first night now by mobile money"]], "card")}</select></label>
        <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Confirm booking</button></div></form>`,
        (f) => {
          const r = { id: uid("R"), guest: f.guest.trim(), phone: f.phone, type: t.code, arr: q.arr, dep: q.dep, adults: +q.adults, source: "Website", rate: t.rate, room: null, status: "Reserved", folio: [], payments: [] };
          S.reservations.push(r);
          if (f.pay !== "none") postPayment(r, f.pay, t.rate, S.date, "Deposit (paid online)");
          return { msg: `Website booking confirmed for <b>${esc(r.guest)}</b>. All channels updated.` };
        });
    },
    "push-rates": () => { const now = S.date + " " + new Date().toTimeString().slice(0, 5); S.channels.forEach((c) => { if (c.connected) c.lastSync = now; }); commit("Rates &amp; availability sent to all connected channels."); },
    "toggle-channel": (d) => { const c = S.channels.find((x) => x.name === d.name); c.connected = !c.connected; commit(`${esc(c.name)} ${c.connected ? "resumed" : "paused"}.`); },
    "edit-rate": (d) => { const t = rt(d.type); modal(`Rate · ${t.name}`, `<form class="form" data-form="rate"><label>Nightly rate (UGX)<input type="number" name="rate" min="1" value="${t.rate}" required></label><div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Save &amp; push to channels</button></div></form>`, (f) => { t.rate = Math.round(+f.rate); S.channels.forEach((c) => { if (c.connected) c.lastSync = S.date + " " + new Date().toTimeString().slice(0, 5); }); return { msg: `${esc(t.name)} now ${ugx(t.rate)}. Sent to all channels.` }; }); },
    "sim-ota": () => {
      const live = S.channels.filter((c) => c.connected && c.name !== "Website booking engine");
      if (!live.length) return toast("Connect at least one OTA first.");
      const ch = live[Math.floor(Math.random() * live.length)];
      const names = ["Anna Kowalski", "Tom Baker", "Mercy Nabirye", "Luca Rossi", "Zainab Mohamed", "Eric Mwesigwa", "Chloé Martin"];
      const arr = addDays(S.date, 1 + Math.floor(Math.random() * 6)), n = 1 + Math.floor(Math.random() * 3), dep = addDays(arr, n);
      const type = S.roomTypes.find((t) => { for (let d = arr; d < dep; d = addDays(d, 1)) if (!availability(t.code, d)) return false; return true; });
      if (!type) return toast("No availability for the simulated dates.");
      S.reservations.push({ id: uid("R"), guest: names[Math.floor(Math.random() * names.length)], phone: "", type: type.code, arr, dep, adults: 2, source: ch.name, rate: type.rate, room: null, status: "Reserved", folio: [], payments: [] });
      commit(`New <b>${esc(ch.name)}</b> booking: ${esc(type.name)}, ${fdate(arr)} for ${n} night${n > 1 ? "s" : ""}. Availability updated on every channel.`);
    },

    outlet: (d) => { ui.outlet = d.val; render(); },
    "add-item": (d) => { const l = ui.cart.find((x) => x.id === d.id); if (l) l.qty++; else ui.cart.push({ id: d.id, qty: 1 }); render(); },
    qty: (d) => { const l = ui.cart.find((x) => x.id === d.id); l.qty += +d.d; ui.cart = ui.cart.filter((x) => x.qty > 0); render(); },
    pay: (d) => {
      const lines = ui.cart.map((l) => ({ ...l, m: S.menu.find((m) => m.id === l.id) }));
      const amount = sum(lines, (l) => l.qty * l.m.price), desc = lines.map((l) => `${l.qty} × ${l.m.name}`).join(", "), outlet = ui.outlet;
      const finish = (ref) => { consume(lines.flatMap((l) => l.m.recipe.map(([id, q]) => [id, q * l.qty])), ref, `Recipe stock: ${outlet} order`); ui.cart = []; };
      if (d.m === "room") return sellForm({ title: `Charge to room · ${outlet}`, amount, dept: "Food & Beverage", outlet, desc, onDone: finish });
      const ref = uid("POS"); postSale({ dept: "Food & Beverage", outlet, desc, amount, method: d.m, ref }); finish(ref);
      commit(`<b>${ugx(amount)}</b> paid by ${METHODS[d.m].toLowerCase()}. Ticket sent to the ${outlet === "Bar" ? "bar" : "kitchen"}.`);
    },
    "sell-amenity": (d) => { const a = S.amenities.find((x) => x.id === d.id); sellForm({ title: `Sell · ${a.name}`, amount: a.price, dept: "Amenities", outlet: a.name.split(" (")[0], desc: a.name }); },

    "new-event": () => modal("New event", `<form class="form" data-form="event">
      <label>Event name<input name="name" required></label><label>Client / company<input name="client" required></label>
      <div class="two"><label>Date<input type="date" name="date" min="${S.date}" value="${addDays(S.date, 7)}" required></label><label>Function room<select name="room">${opts(S.functionRooms.map((f) => [f.id, `${f.name} (max ${f.capacity})`]))}</select></label></div>
      <div class="two"><label>Package<select name="pkg">${opts(S.eventPackages.map((p) => [p.id, `${p.name} · ${num(p.pp)} pp`]))}</select></label><label>Guests (pax)<input type="number" name="pax" min="1" value="50" required></label></div>
      <label>Status<select name="status">${opts([["Tentative", "Tentative"], ["Confirmed", "Confirmed"]], "Tentative")}</select></label>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Save &amp; create quotation</button></div></form>`,
      (f) => {
        const fr = S.functionRooms.find((x) => x.id === f.room); if (+f.pax > fr.capacity) return `${fr.name} holds up to ${fr.capacity} guests.`;
        if (S.events.some((e) => e.room === f.room && e.date === f.date && e.status !== "Cancelled")) return `${fr.name} is already booked on ${fdate(f.date)}.`;
        const p = S.eventPackages.find((x) => x.id === f.pkg);
        S.events.push({ id: uid("EV"), name: f.name, client: f.client, date: f.date, room: f.room, pax: +f.pax, pkg: f.pkg, total: p.pp * +f.pax, deposit: 0, status: f.status, billed: false });
        return { msg: `Event saved. Quotation total ${ugx(p.pp * +f.pax)}.` };
      }),
    "event-deposit": (d) => { const e = S.events.find((x) => x.id === d.id); const due = e.total - e.deposit; modal(`Payment · ${e.name}`, `<form class="form" data-form="evpay"><dl class="kv"><dt>Total</dt><dd>${ugx(e.total)}</dd><dt>Paid so far</dt><dd>${ugx(e.deposit)}</dd></dl><div class="two"><label>Amount<input type="number" name="amount" min="1" max="${due}" value="${Math.round(due / 2)}" required></label><label>Method<select name="method">${opts(methodOpts(false))}</select></label></div><div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Record payment</button></div></form>`, (f) => { const amt = Math.min(due, Math.round(+f.amount)); if (!(amt > 0)) return "Enter an amount."; e.deposit += amt; if (e.status === "Tentative") e.status = "Confirmed"; journal(S.date, e.id, `Event deposit: ${e.client}`, [{ acct: METHOD_ACCT[f.method], dr: amt }, { acct: "Event deposits", cr: amt }]); return { msg: `${ugx(amt)} received from ${esc(e.client)}.` }; }); },
    "event-bill": (d) => { const e = S.events.find((x) => x.id === d.id); if (!confirm(`Complete "${e.name}" and post ${ugx(e.total)} revenue? Any unpaid balance goes to the client's company account.`)) return; const ref = e.id; S.sales.push({ id: uid("S"), date: S.date, dept: "Events", outlet: "Events", desc: e.name, amount: e.total, method: "invoice" }); journal(S.date, ref, `Event billed: ${e.name}`, [{ acct: "Event deposits", dr: e.deposit }, { acct: "Accounts receivable", dr: e.total - e.deposit }, { acct: "Revenue – Events", cr: e.total }]); e.status = "Completed"; e.billed = true; commit(`Event billed. ${ugx(e.total - e.deposit)} invoiced to ${esc(e.client)}.`); },
    beo: (d) => { const e = S.events.find((x) => x.id === d.id), p = S.eventPackages.find((x) => x.id === e.pkg), fr = S.functionRooms.find((x) => x.id === e.room); modal(`BEO · ${e.name}`, `<dl class="kv"><dt>Client</dt><dd>${esc(e.client)}</dd><dt>Date</dt><dd>${fdateLong(e.date)}</dd><dt>Venue</dt><dd>${esc(fr.name)}</dd><dt>Guests</dt><dd>${e.pax}</dd><dt>Package</dt><dd>${esc(p.name)} @ ${ugx(p.pp)} pp</dd><dt>Total</dt><dd>${ugx(e.total)} (paid ${ugx(e.deposit)})</dd></dl>
      ${table(["Department", "Instructions"], [["Kitchen", `${e.pax} covers, ${p.name.toLowerCase()} menu. Confirm dietary needs 48h before.`], ["Restaurant / service", `Set ${fr.name} for ${e.pax}. Service staff ratio 1:15.`], ["Bar", "Welcome drinks on arrival, soft drinks throughout."], ["Housekeeping", `Clean and set ${fr.name} by 07:00 on the day.`], ["Maintenance", "Projector, PA system and generator on standby."], ["Front office", "Signage in lobby; guest list at reception."]].map(([a, b]) => `<tr><td><b>${a}</b></td><td>${esc(b)}</td></tr>`))}
      <div class="actions no-print" style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-ghost" data-action="print-modal">Print BEO</button></div>`); },

    receive: () => modal("Receive stock (goods received note)", `<form class="form" data-form="grn">
      <label>Item<select name="item">${opts(S.stock.map((s) => [s.id, `${s.name} (${s.store}) · ${s.qty} ${s.unit} in stock`]))}</select></label>
      <div class="two"><label>Quantity<input type="number" name="qty" min="0.01" step="0.01" required></label><label>Unit cost (UGX)<input type="number" name="cost" min="1" placeholder="Leave blank for current cost"></label></div>
      <label>Supplier<input name="supplier" value="Kampala Fresh Supplies Ltd" required></label>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Receive</button></div></form>`,
      (f) => { const s = stockById(f.item), q = +f.qty, c = f.cost ? Math.round(+f.cost) : s.cost; if (!(q > 0)) return "Enter a quantity."; s.cost = Math.round((s.qty * s.cost + q * c) / (s.qty + q)); s.qty = +(s.qty + q).toFixed(3); S.purchases.push({ date: S.date, item: s.id, qty: q, cost: c, supplier: f.supplier }); journal(S.date, uid("GRN"), `Goods received: ${s.name} from ${f.supplier}`, [{ acct: "Inventory", dr: q * c }, { acct: "Accounts payable", cr: q * c }]); return { msg: `${q} ${esc(s.unit)} of ${esc(s.name)} received.` }; }),
    "new-req": () => modal("New requisition", `<form class="form" data-form="req">
      <div class="two"><label>Department<select name="dept">${opts(S.departments.map((x) => [x, x]))}</select></label><label>Requested by<input name="by" required value="Agnes Nalubega"></label></div>
      <div class="two"><label>Item<select name="item">${opts(S.stock.map((s) => [s.id, `${s.name} (${s.unit})`]))}</select></label><label>Quantity<input type="number" name="qty" min="0.1" step="0.1" required></label></div>
      <label>Note<input name="note" placeholder="Optional"></label>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Submit for approval</button></div></form>`,
      (f) => { S.requisitions.push({ id: uid("RQ"), date: S.date, dept: f.dept, by: f.by, lines: [[f.item, +f.qty]], note: f.note, status: "Pending" }); return { msg: "Requisition sent to the head of department for approval." }; }),
    req: (d) => {
      const q = S.requisitions.find((x) => x.id === d.id);
      if (d.op === "approve") { q.status = "Approved"; return commit("Requisition approved. The store can now issue it."); }
      if (d.op === "reject") { q.status = "Rejected"; return commit("Requisition rejected."); }
      const short = q.lines.find(([id, n]) => stockById(id).qty < n);
      if (short) return toast(`Not enough ${esc(stockById(short[0]).name)} in stock. Receive stock first.`);
      const cost = consume(q.lines, q.id, `Issued to ${q.dept}`, q.dept === "Kitchen" || q.dept === "Bar" ? "sale" : "dept");
      q.status = "Issued"; commit(`Issued to ${esc(q.dept)}. ${ugx(cost)} charged to the department.`);
    },

    leave: (d) => { const l = S.leave.find((x) => x.id === d.id); l.status = d.op; commit(`Leave ${d.op.toLowerCase()} for ${esc(staffById(l.staff).name)}.`); },
    "run-payroll": () => {
      const month = S.date.slice(0, 7); if (S.payrollRuns.includes(month)) return;
      const gross = sum(S.staff, (e) => e.salary), employer = Math.round(gross * 0.1), p = sum(S.staff, (e) => paye(e.salary)), n5 = Math.round(gross * 0.05), net = gross - p - n5;
      journal(S.date, "PAY-" + month, `Payroll ${month}`, [{ acct: "Payroll expense", dr: gross + employer }, { acct: "Cash", cr: net }, { acct: "Statutory payables", cr: p + n5 + employer }]);
      S.payrollRuns.push(month); commit(`Payroll posted: ${ugx(net)} net pay, ${ugx(p + n5 + employer)} due to URA &amp; NSSF.`);
    },

    "new-wo": () => modal("New work order", `<form class="form" data-form="wo">
      <label>Asset<select name="asset">${opts(S.assets.map((a) => [a.id, a.name]))}</select></label><label>Issue<input name="title" required placeholder="What needs fixing?"></label>
      <div class="two"><label>Priority<select name="priority">${opts([["High", "High"], ["Medium", "Medium"], ["Low", "Low"]], "Medium")}</select></label><label>Reported by department<select name="dept">${opts(S.departments.map((x) => [x, x]), "Maintenance")}</select></label></div>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Cancel</button><button class="btn btn-gold">Create work order</button></div></form>`,
      (f) => { S.workOrders.push({ id: uid("WO"), asset: f.asset, title: f.title, priority: f.priority, dept: f.dept, status: "Open", opened: S.date }); return { msg: "Work order created and sent to maintenance." }; }),
    "wo-next": (d) => { const w = S.workOrders.find((x) => x.id === d.id); w.status = w.status === "Open" ? "In progress" : "Completed"; commit(`Work order ${w.status.toLowerCase()}.`); },
    serviced: (d) => { const a = S.assets.find((x) => x.id === d.id); a.nextService = addDays(S.date, 90); commit(`${esc(a.name)} serviced. Next service ${fdate(a.nextService)}.`); },

    "night-audit": () => {
      if (!confirm(`Run the night audit for ${fdateLong(S.date)}?\n\nThis posts tonight's room charges to every in-house guest, marks unarrived bookings as no-shows and moves to the next business day.`)) return;
      const ih = inHouse(); ih.forEach((r) => postSale({ dept: "Rooms", outlet: "Rooms", desc: `Room ${r.room} night charge`, amount: r.rate, method: "room", resId: r.id }));
      const ns = S.reservations.filter((r) => r.status === "Reserved" && r.arr <= S.date); ns.forEach((r) => { r.status = "No-show"; });
      ih.forEach((r) => { const room = S.rooms.find((x) => x.no === r.room); if (room) room.hk = "dirty"; });
      const closed = S.date; S.date = addDays(S.date, 1);
      commit(`Night audit complete for ${fdate(closed)}: ${ih.length} room charges posted${ns.length ? `, ${ns.length} no-show(s)` : ""}. Daily reports generated.`);
    },
  };

  const FORMS = {
    "be-search": (f) => { if (f.dep <= f.arr) return toast("Check-out must be after check-in."); ui.be = { arr: f.arr, dep: f.dep, adults: f.adults }; render(); },
  };

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "checkbox")) return;
    if (el.dataset.action === "sched") return;
    const fn = A[el.dataset.action]; if (!fn) return;
    fn(el.dataset, e);
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.action === "shift") { staffById(el.dataset.id).shift = el.value; commit(`Shift updated for ${esc(staffById(el.dataset.id).name)}.`); }
    if (el.dataset.action === "sched") { S.schedules[+el.dataset.i].on = el.checked; commit(`${esc(S.schedules[+el.dataset.i].name)} ${el.checked ? "will be emailed automatically" : "switched off"}.`); }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]"); if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (FORMS[form.dataset.form]) return FORMS[form.dataset.form](data);
    if (!modalSubmit) return;
    const res = modalSubmit(data);
    if (typeof res === "string") { let n = form.querySelector(".form-err"); if (!n) { n = document.createElement("p"); n.className = "note form-err"; n.style.color = "var(--bad)"; form.prepend(n); } n.textContent = res; return; }
    closeModal(); commit(res && res.msg);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  window.addEventListener("hashchange", () => { closeModal(); render(); $("#view").focus({ preventScroll: true }); window.scrollTo(0, 0); });

  S = load();
  if (!S || S.v !== 1) seed(); else seq = S.seq || 5000;
  save(); render();
  window.__pms = { get state() { return S; }, balances };
})();
