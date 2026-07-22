/* =====================================================================
   VENDOR QUOTATION COMPARISON — SCRIPT
   Flow:
     1. Bootstrap    — init the Zoho widget SDK, then fetch records
     2. Helpers      — read Creator values (lookups, numbers, places)
     3. Normalise    — turn a raw record into a clean quotation object
     4. UI state     — loader / empty state / filter dropdowns
     5. Render       — chips, KPI tiles, bar chart, route flow, table
     6. Events       — dropdown changes + Refresh button
   Data shape (report "DuplicateVQ"):
     - Travel_Ticket_Options = OUTBOUND flight rows
     - SubForm2              = RETURN flight rows (blank row on one-way)
     - Airline_Name lookup + Source/Destination/total_amount on main record
===================================================================== */

/* =====================================================================
   1. BOOTSTRAP
===================================================================== */
// Logged-in user + role. A user is a "finance" user when their HOD_Email in the
// Department report matches the login and their Department_Name is Finance & Accounts.
var loggedInUser = null;
var isFinanceUser = false;
var FINANCE_DEPT = "Finance & Accounts";

// normalise a department/email for comparison: lowercase, collapse spaces,
// treat "&" and "and" the same ("Finance & Accounts" == "finance and accounts")
function norm(s) {
  return val(s).toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
}

ZOHO.CREATOR.UTIL.getInitParams().then(function (response) {
  console.log("ATRM initParams:", response);
  // login email can arrive under a few different keys depending on SDK/version
  loggedInUser = norm(response.loginUser || response.loginEmailId || response.loginEmail || response.userEmail || "");
  getDepartment(); // work out the user's role (Finance & Accounts or not)
  GetRecords();    // load the quotations
});

// Look the logged-in user up in the Department report to decide if they are Finance & Accounts.
// Runs alongside GetRecords; if the role resolves after the table is drawn, we redraw it.
function getDepartment() {
  var config = {
    app_name: "air-travel-request-management",
    report_name: "DuplicateDepartment",
    max_records: 1000,
    field_config: "all",
  };
  ZOHO.CREATOR.DATA.getRecords(config).then(function (response) {
    var rows = response.data || [];

    var me = rows.filter(function (d) { return norm(d.HOD_Email) === loggedInUser; })[0];
    isFinanceUser = !!me && norm(me.Department_Name) === norm(FINANCE_DEPT);
    console.log("ATRM role check → loginUser:", loggedInUser,
      "| matched dept:", me ? val(me.Department_Name) : "(no HOD_Email match)",
      "| isFinanceUser:", isFinanceUser);
    render(); // role now known — redraw so Approve buttons reflect it
  }).catch(function (err) {
    console.warn("ATRM widget: department lookup failed", err);
    isFinanceUser = false; // fail closed — no finance powers if the lookup fails
  });
}

function GetRecords() {
  showLoader();
  var config = {
    app_name: "air-travel-request-management",
    report_name: "DuplicateVQ",
    max_records: 1000,
    field_config: "all", // required — without it subform rows are omitted
  };
  ZOHO.CREATOR.DATA.getRecords(config).then(function (response) {
    console.log(response.data);
    finish(response.data || []);
  }).catch(function (err) {
    console.warn("ATRM widget: fetch failed", err);
    showEmpty("Couldn't load records",
      "The report \"" + config.report_name + "\" returned no data or the request failed. " +
      "Check the report link name and widget permissions, then hit Refresh.");
  });
}

/* Client is Zimbabwe — quotations are in US dollars */
var CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/* =====================================================================
   2. HELPERS — reading values out of Creator records
===================================================================== */

// Creator returns plain strings OR lookup objects ({ID, zc_display_value}) — handle both
function val(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return v.zc_display_value || v.display_value || v.value || v.ID || "";
  return String(v).trim();
}

// "98.00" -> 98 ; anything unparsable -> 0
function num(v) {
  var s = val(v).replace(/[^0-9.\-]/g, "");
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// escape user data before putting it in HTML
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// "Noida, India" -> {city:"Noida", country:"India"} ; "NoidaIndia" -> {city:"NoidaIndia", country:""}
function splitPlace(s) {
  s = val(s);
  var i = s.indexOf(",");
  if (i < 0) return { city: s, country: "" };
  return { city: s.slice(0, i).trim(), country: s.slice(i + 1).trim() };
}

/* =====================================================================
   3. NORMALISE — raw record -> clean quotation object
===================================================================== */

// Travel_Ticket_Options = outbound rows, SubForm2 = return rows.
// Each row carries its own From/At — >1 row in a direction means a connecting ("via") flight.
function legsFrom(arr, dir) {
  return (Array.isArray(arr) ? arr : []).map(function (r) {
    return {
      dir: dir, // "out" | "ret"
      from: splitPlace(r.From),   // segment origin
      at: splitPlace(r.At),       // segment destination
      flightNo: val(r.Flight_Number),
      dep: val(r.Departure_Date),
      journey: val(r.Journey_Time1),
      fare: num(r.Fare)
    };
    // keep only real rows (one-way records carry a blank SubForm2 row)
  }).filter(function (l) { return l.from.city || l.at.city || l.flightNo || l.dep || l.fare; });
}

// group a quote's legs into travel directions (outbound, then return), order preserved
function directions(q) {
  var out = q.legs.filter(function (l) { return l.dir === "out"; });
  var ret = q.legs.filter(function (l) { return l.dir === "ret"; });
  var arr = [];
  if (out.length) arr.push({ dir: "out", segs: out });
  if (ret.length) arr.push({ dir: "ret", segs: ret });
  return arr;
}

// overall from/to + intermediate "via" cities for a set of segments
function dirSummary(segs) {
  return {
    from: segs[0].from,
    to: segs[segs.length - 1].at,
    via: segs.slice(0, -1).map(function (s) { return s.at.city; }).filter(Boolean)
  };
}

function normalise(rec) {
  var tr = rec.travel_request || {};
  var legs = legsFrom(rec.Travel_Ticket_Options, "out").concat(legsFrom(rec.SubForm2, "ret"));

  // overall request route: prefer the main record, else derive from the outbound segments
  var source = splitPlace(rec.Source);
  var destination = splitPlace(rec.Destination);
  var outSegs = legs.filter(function (l) { return l.dir === "out"; });
  if (!source.city && outSegs.length) source = outSegs[0].from;
  if (!destination.city && outSegs.length) destination = outSegs[outSegs.length - 1].at;

  return {
    id: val(rec.ID),
    requestId: tr.Travel_Request_ID || val(rec.travel_request) || "(no travel request)",
    vendor: val(rec.Service_Provider_Name) || "Unknown vendor",
    vendorId: val(rec.Vendor_ID),
    quotationId: val(rec.Quotation_ID),
    email: val(rec.Vendor_Email),
    status: val(rec.quote_status),
    travelType: val(rec.Travel_Type),
    travelDate: val(rec.Travel_Date),
    returnDate: val(rec.Return_Date),
    airline: val(rec.Airline_Name),
    cabinBaggage: val(rec.Travel_Cabin_Baggage),
    checkinBaggage: val(rec.Travel_Check_in_Baggage),
    remarks: val(rec.Remarks),
    source: source,
    destination: destination,
    isLowest: val(rec.is_lowest).toLowerCase() === "true",
    legs: legs,
    total: num(rec.total_amount)
  };
}

/* =====================================================================
   4. UI STATE
===================================================================== */
var allQuotes = [];

function finish(records) {
  allQuotes = (records || []).map(normalise);
  if (!allQuotes.length) {
    showEmpty("No quotations yet", "Once vendors submit quotations against a travel request, they will appear here for comparison.");
    return;
  }
  buildRequestCards();
  buildStatusSelect();
  render();
  document.getElementById("stateCard").style.display = "none";
  document.getElementById("content").style.display = "block";
}

function showLoader() {
  document.getElementById("content").style.display = "none";
  var sc = document.getElementById("stateCard");
  sc.style.display = "block";
  sc.innerHTML = '<div class="loader"><div class="spin"></div><p>Loading vendor quotations&hellip;</p></div>';
}

function showEmpty(title, msg) {
  document.getElementById("content").style.display = "none";
  var sc = document.getElementById("stateCard");
  sc.style.display = "block";
  sc.innerHTML =
    '<div class="state">' +
    '<div class="s-icon"><svg viewBox="0 0 24 24"><path d="M21.5 15.5v-2l-8.5-5V3.25a1.5 1.5 0 0 0-3 0V8.5l-8.5 5v2l8.5-2.5v5.25L7.5 20v1.5l4.5-1 4.5 1V20L14 18.25V13l7.5 2.5z"/></svg></div>' +
    "<h3>" + esc(title) + "</h3><p>" + esc(msg) + "</p></div>";
}

// currently selected travel request (drives the whole view)
var selectedRequest = null;

// one summary per travel request, keeping only requests that still have an
// Open/Submitted quote (the ones awaiting action)
function requestSummaries() {
  var map = {}, order = [];
  allQuotes.forEach(function (q) {
    if (!map[q.requestId]) { map[q.requestId] = []; order.push(q.requestId); }
    map[q.requestId].push(q);
  });
  return order.map(function (id) {
    var g = map[id];
    return {
      id: id,
      first: g[0],
      count: g.length,
      openCount: g.filter(function (q) { return isFresh(q.status); }).length,
      lowest: Math.min.apply(null, g.map(function (q) { return q.total; }))
    };
  }).filter(function (s) { return s.openCount > 0; });
}

// horizontal strip of selectable travel-request cards (replaces the old dropdown)
function buildRequestCards() {
  var el = document.getElementById("reqCards");
  var summaries = requestSummaries();

  if (!summaries.length) {
    el.innerHTML = '<div class="req-empty">No travel requests are awaiting action right now.</div>';
    selectedRequest = null;
    return;
  }

  // keep the previous selection if it's still open, otherwise pick the first
  var ids = summaries.map(function (s) { return s.id; });
  if (ids.indexOf(selectedRequest) < 0) selectedRequest = ids[0];

  el.innerHTML = summaries.map(function (s) {
    var src = s.first.source.city || "—";
    var dst = s.first.destination.city || "—";
    return '<button type="button" class="req-card' + (s.id === selectedRequest ? " active" : "") + '" data-req="' + esc(s.id) + '">' +
      '<div class="rc-top"><span class="rc-id">' + esc(s.id) + '</span>' +
      '<span class="rc-open">' + s.openCount + ' open</span></div>' +
      '<div class="rc-route">' + esc(src) + '<span class="rc-arrow">&rarr;</span>' + esc(dst) + '</div>' +
      '<div class="rc-meta">' + esc(s.first.travelType || "—") + ' &middot; ' + esc(s.first.travelDate || "—") + '</div>' +
      '<div class="rc-foot"><span class="rc-cnt">' + s.count + ' quote' + (s.count !== 1 ? "s" : "") + '</span>' +
      '<span class="rc-low"><small>Lowest</small>' + CURRENCY.format(s.lowest) + '</span></div>' +
      '</button>';
  }).join("");
}

// dropdown of unique quote statuses
function buildStatusSelect() {
  var sel = document.getElementById("selStatus");
  var seen = {}, opts = [];
  allQuotes.forEach(function (q) {
    var s = q.status || "";
    if (s && !seen[s]) { seen[s] = true; opts.push(s); }
  });
  sel.innerHTML = '<option value="">All statuses</option>' +
    opts.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("");
}

// quotations for the selected travel request + status, cheapest first
function currentQuotes() {
  var st = document.getElementById("selStatus").value;
  return allQuotes.filter(function (q) {
    return q.requestId === selectedRequest && (!st || q.status === st);
  }).sort(function (a, b) { return a.total - b.total; });
}

// best = record flagged is_lowest by the app, else the cheapest total
function bestOf(quotes) {
  if (!quotes.length) return null;
  for (var i = 0; i < quotes.length; i++) if (quotes[i].isLowest) return quotes[i];
  return quotes[0]; // already sorted by total asc
}

// map a quote_status to a pill colour (green / yellow / red)
// statuses: Submitted / Approved / Rejected / Open / Approval Pending by Finance Team
function statusClass(s) {
  var t = (s || "").toLowerCase();
  if (/pend|wait|review|received/.test(t)) return "s-warn"; // "Approval Pending..." checked before "approv"
  if (/approv|accept|confirm|select/.test(t)) return "s-good";
  if (/reject|declin|cancel|expir/.test(t)) return "s-bad";
  if (/open|submit/.test(t)) return "s-warn";
  return "";
}

/* =====================================================================
   MODAL — custom confirm / alert (replaces window.confirm / window.alert)
   openModal() returns a Promise resolving to the clicked button's value.
===================================================================== */
var MODAL_ICONS = {
  brand: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>'
};

function openModal(opts) {
  var overlay = document.getElementById("modal");
  var tone = opts.icon || "brand";
  document.getElementById("modalIcon").className = "modal-icon " + tone;
  document.getElementById("modalIcon").innerHTML = MODAL_ICONS[tone] || MODAL_ICONS.brand;
  document.getElementById("modalTitle").textContent = opts.title || "";
  document.getElementById("modalBody").textContent = opts.body || "";

  var actions = document.getElementById("modalActions");
  actions.innerHTML = "";

  return new Promise(function (resolve) {
    function close(value) {
      overlay.classList.remove("show");
      overlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("mousedown", onOverlay);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === "Escape") close(opts.dismissValue !== undefined ? opts.dismissValue : false);
      if (e.key === "Enter") close(opts.buttons[opts.buttons.length - 1].value);
    }
    function onOverlay(e) {
      if (e.target === overlay) close(opts.dismissValue !== undefined ? opts.dismissValue : false);
    }

    (opts.buttons || []).forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "modal-btn " + (b.cls || "primary");
      btn.textContent = b.label;
      btn.addEventListener("click", function () { close(b.value); });
      actions.appendChild(btn);
    });

    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.add("show");
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", onOverlay);
    // focus the primary (last) button for quick keyboard confirm
    var last = actions.querySelector(".modal-btn:last-child");
    if (last) last.focus();
  });
}

// confirm dialog -> resolves true/false
function showConfirm(opts) {
  return openModal({
    icon: opts.icon || "brand",
    title: opts.title,
    body: opts.body,
    dismissValue: false,
    buttons: [
      { label: opts.cancelText || "Cancel", cls: "ghost", value: false },
      { label: opts.confirmText || "Confirm", cls: "primary", value: true }
    ]
  });
}

// alert dialog -> resolves when dismissed
function showAlert(opts) {
  return openModal({
    icon: opts.icon || "error",
    title: opts.title,
    body: opts.body,
    dismissValue: true,
    buttons: [{ label: opts.okText || "OK", cls: "primary", value: true }]
  });
}

/* =====================================================================
   APPROVAL — Approve button rules & record updates
   Button visibility by role:
   - Finance & Accounts : Approve shows on Open/Submitted AND
                          "Approval Pending by Finance Team" rows.
   - Travel Desk (any non-finance) : Approve shows only until the request's
                          first approval is submitted — i.e. while every quote
                          is still Open/Submitted. Once one goes to pending
                          (or approved/rejected), their buttons disappear.
   - Nobody once the request already has an Approved quote.

   Actions:
   - LOWEST quote            -> Approved, all others Rejected.
   - NON-lowest, travel desk -> Approval Pending by Finance Team, others Open.
   - NON-lowest / pending, finance -> final approval: Approved, others Rejected.
===================================================================== */

// quote already sent to finance — only a finance user can finalise it
function isFinancePending(status) {
  return (status || "").toLowerCase() === "approval pending by finance team";
}

// a "fresh" quote no one has acted on yet
function isFresh(status) {
  var t = (status || "").toLowerCase();
  return t === "open" || t === "submitted";
}

// has the request's first approval already been submitted? (anything left the fresh state)
function requestActedOn(requestId) {
  return groupOf(requestId).some(function (q) { return !isFresh(q.status); });
}

// Should this row show an Approve button for the current user?
function canApprove(q) {
  if (groupHasApproved(q.requestId)) return false;   // request already decided
  if (isFinanceUser) {
    // finance can approve fresh rows or finalise a pending one
    return isFresh(q.status) || isFinancePending(q.status);
  }
  // travel desk: only before the first approval is submitted for this request
  return isFresh(q.status) && !requestActedOn(q.requestId);
}

// all quotations of the same travel request (ignores the status filter on purpose)
function groupOf(requestId) {
  return allQuotes.filter(function (q) { return q.requestId === requestId; });
}

function groupHasApproved(requestId) {
  return groupOf(requestId).some(function (q) {
    return (q.status || "").toLowerCase() === "approved";
  });
}

// one record update against the same report
function updateStatus(id, status) {
  return ZOHO.CREATOR.DATA.updateRecordById({
    app_name: "air-travel-request-management",
    report_name: "DuplicateVQ",
    id: id,
    payload: { data: { quote_status: status } }
  });
}

function approveQuote(id) {
  var q = null;
  for (var i = 0; i < allQuotes.length; i++) if (allQuotes[i].id === id) { q = allQuotes[i]; break; }
  if (!q || !canApprove(q)) return;

  var group = groupOf(q.requestId);
  var others = group.filter(function (g) { return g.id !== q.id; });
  var minTotal = Math.min.apply(null, group.map(function (g) { return g.total; }));
  // Final approval when it's the lowest quote, or a finance user is approving
  // (finance can approve a higher-than-lowest / pending quote outright).
  var isFinal = q.total <= minTotal || isFinanceUser;

  var dialog = isFinal
    ? {
      icon: "brand",
      title: "Approve this quotation?",
      body: "Approve " + q.vendor + " at " + CURRENCY.format(q.total) + ".\n\nAll other quotations for " + q.requestId + " will be marked Rejected.",
      confirmText: "Approve"
    }
    : {
      icon: "warn",
      title: "Not the lowest quote",
      body: q.vendor + " at " + CURRENCY.format(q.total) + " is not the lowest quote.\n\nIt will be sent for finance approval (Approval Pending by Finance Team) and the other quotations will be set to Open.",
      confirmText: "Send to finance"
    };

  showConfirm(dialog).then(function (ok) {
    if (!ok) return;

    // freeze all approve buttons while we save
    document.querySelectorAll(".btn-approve").forEach(function (b) { b.disabled = true; b.textContent = "Saving…"; });

    var updates = isFinal
      ? [updateStatus(q.id, "Approved")].concat(others.map(function (g) { return updateStatus(g.id, "Rejected"); }))
      : [updateStatus(q.id, "Approval Pending by Finance Team")].concat(others.map(function (g) { return updateStatus(g.id, "Open"); }));

    Promise.all(updates).then(function () {
      GetRecords(); // re-fetch so the widget shows the server's truth
    }).catch(function (err) {
      console.warn("ATRM widget: status update failed", err);
      showAlert({
        title: "Update failed",
        body: "Could not update one or more quotations. Please check report edit permissions and try again."
      });
      GetRecords();
    });
  });
}

/* =====================================================================
   5. RENDER
===================================================================== */
function render() {
  var quotes = currentQuotes();
  var best = bestOf(quotes);

  renderMeta(quotes);
  renderKpis(quotes, best);
  renderChart(quotes, best);
  renderFlow(quotes, best);
  renderTable(quotes, best);
}

/* --- chips next to the filters: trip type, route, dates, count --- */
function renderMeta(quotes) {
  var el = document.getElementById("reqMeta");
  if (!quotes.length) { el.innerHTML = ""; return; }
  var q = quotes[0];
  el.innerHTML =
    '<span class="chip">✈ <b>' + esc(q.travelType || "—") + "</b></span>" +
    '<span class="chip">🛫 ' + esc(q.source.city || "—") + " &rarr; " + esc(q.destination.city || "—") + "</span>" +
    '<span class="chip">📅 <b>' + esc(q.travelDate || "—") + "</b>" +
    (q.returnDate ? " &rarr; <b>" + esc(q.returnDate) + "</b>" : "") + "</span>" +
    '<span class="chip">🏷 <b>' + quotes.length + "</b> quotation" + (quotes.length > 1 ? "s" : "") + "</span>";
}

/* --- KPI tiles: vendor count, lowest, average, saving --- */
function renderKpis(quotes, best) {
  var el = document.getElementById("kpis");
  if (!quotes.length) { el.innerHTML = ""; return; }
  var totals = quotes.map(function (q) { return q.total; });
  var lo = Math.min.apply(null, totals), hi = Math.max.apply(null, totals);
  var avg = totals.reduce(function (a, b) { return a + b; }, 0) / totals.length;

  el.innerHTML =
    kpi("Vendors quoting", String(quotes.length), esc(best.vendor) + " is lowest", "accent") +
    kpi("Lowest total", CURRENCY.format(lo), "by " + esc(best.vendor), "best") +
    kpi("Average quote", CURRENCY.format(avg), "across all quotations", "") +
    kpi("Potential saving", CURRENCY.format(hi - lo), "<b>lowest vs highest</b> quote", "accent");

  function kpi(label, value, note, cls) {
    return '<div class="kpi ' + cls + '"><div class="k-label">' + label + '</div>' +
      '<div class="k-value">' + value + '</div><div class="k-note">' + note + "</div></div>";
  }
}

/* --- horizontal bar chart: one bar per vendor, best in amber --- */
function renderChart(quotes, best) {
  var el = document.getElementById("chart");
  if (!quotes.length) { el.innerHTML = '<div class="state"><p>No quotations match the current filters.</p></div>'; return; }
  var max = Math.max.apply(null, quotes.map(function (q) { return q.total; })) || 1;

  el.innerHTML = quotes.map(function (q, i) {
    var isBest = best && q.id === best.id;
    return '<div class="crow' + (isBest ? " is-best" : "") + '" data-i="' + i + '">' +
      '<div class="vname">' + (isBest ? '<span class="best-tag">BEST</span>' : "") + esc(q.vendor) + "</div>" +
      '<div class="track"><div class="bar" data-w="' + (q.total / max * 100).toFixed(1) + '"></div></div>' +
      '<div class="fare">' + CURRENCY.format(q.total) +
      "<small>" + esc(q.travelType || (q.legs.length + " flight" + (q.legs.length !== 1 ? "s" : ""))) + "</small></div></div>";
  }).join("");

  // animate bars from 0 to their width
  requestAnimationFrame(function () {
    el.querySelectorAll(".bar").forEach(function (b) { b.style.width = b.getAttribute("data-w") + "%"; });
  });

  // hover tooltip with quotation details
  var tip = document.getElementById("tip");
  el.querySelectorAll(".crow").forEach(function (row) {
    row.addEventListener("mousemove", function (ev) {
      var q = quotes[+row.getAttribute("data-i")];
      tip.innerHTML = '<div class="t-title">' + esc(q.vendor) + "</div>" +
        trow("Quotation", esc(q.quotationId || "—")) +
        trow("Total", CURRENCY.format(q.total)) +
        trow("Status", esc(q.status || "—")) +
        (q.email ? trow("Email", esc(q.email)) : "");
      tip.classList.add("show");
      var x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 12);
      var y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 12);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
    row.addEventListener("mouseleave", function () { tip.classList.remove("show"); });
  });

  function trow(k, v) { return '<div class="t-row"><span>' + k + "</span><span>" + v + "</span></div>"; }
}

// one flight segment row (from -> at, airline, flight, timing, fare)
function legRow(l, airline, badge, cls) {
  return '<div class="leg ' + cls + '">' +
    '<div class="port"><div class="city">' + esc(l.from.city || "—") + '</div>' +
    '<div class="country">' + esc(l.from.country) + '</div>' +
    '<div class="dt">' + esc(l.dep || "—") + "</div></div>" +

    '<div class="conn">' +
    '<span class="dirtag ' + cls + '">' + badge + "</span>" +
    '<div class="airline">' + esc(airline || "—") + '</div>' +
    '<div class="fno">' + esc(l.flightNo) + '</div>' +
    '<div class="path"><span class="pt"></span><span class="ln"></span>' +
    '<svg viewBox="0 0 24 24"><path d="M21.5 15.5v-2l-8.5-5V3.25a1.5 1.5 0 0 0-3 0V8.5l-8.5 5v2l8.5-2.5v5.25L7.5 20v1.5l4.5-1 4.5 1V20L14 18.25V13l7.5 2.5z"/></svg>' +
    '<span class="ln"></span><span class="pt"></span></div>' +
    (l.journey ? '<span class="dur">' + esc(l.journey) + "</span>" : "") +
    "</div>" +

    '<div class="port to"><div class="city">' + esc(l.at.city || "—") + '</div>' +
    '<div class="country">' + esc(l.at.country) + '</div>' +
    "</div>" +

    '<div class="leg-fare"><small>Fare</small>' + CURRENCY.format(l.fare) + "</div>" +
    "</div>";
}

/* --- route flow: one card per vendor; each direction may be a direct or "via" flight --- */
function renderFlow(quotes, best) {
  var el = document.getElementById("flow");
  if (!quotes.length) { el.innerHTML = ""; return; }

  el.innerHTML = quotes.map(function (q) {
    var isBest = best && q.id === best.id;

    var legsHtml = directions(q).map(function (d) {
      var cls = d.dir === "ret" ? "ret" : "out";
      var badge = d.dir === "ret" ? "RETURN" : "OUTBOUND";

      // direct flight — single segment row
      if (d.segs.length <= 1) return legRow(d.segs[0], q.airline, badge, cls);

      // connecting ("via") flight — header with overall route + via, then each segment
      var s = dirSummary(d.segs);
      var head = '<div class="dir-head">' +
        '<span class="dirtag ' + cls + '">' + badge + "</span>" +
        '<span class="dir-route">' + esc(s.from.city || "—") + '<span class="rc-arrow">&rarr;</span>' + esc(s.to.city || "—") + "</span>" +
        (s.via.length ? '<span class="via-note">via ' + esc(s.via.join(", ")) + "</span>" : "") +
        "</div>";
      var segs = d.segs.map(function (seg, i) {
        return legRow(seg, q.airline, "LEG " + (i + 1), cls);
      }).join("");
      return '<div class="dir-group">' + head + '<div class="dir-segs">' + segs + "</div></div>";
    }).join("");

    return '<div class="quote-block' + (isBest ? " is-best" : "") + '">' +
      '<div class="qhead">' +
      '<span class="qvendor">' + esc(q.vendor) + "</span>" +
      (q.quotationId ? '<span class="qmail">' + esc(q.quotationId) + "</span>" : "") +
      (q.email ? '<span class="qmail">' + esc(q.email) + "</span>" : "") +
      (q.status ? '<span class="status-pill ' + statusClass(q.status) + '">' + esc(q.status) + "</span>" : "") +
      (isBest ? '<span class="best-flag">★ BEST PRICE</span>' : "") +
      '<span class="spacer"></span>' +
      '<span class="qtotal"><small>TOTAL</small>' + CURRENCY.format(q.total) + "</span>" +
      "</div>" +
      '<div class="legs">' + (legsHtml || '<div class="card-sub">No ticket options in this quotation.</div>') + "</div>" +
      "</div>";
  }).join("");
}

/* --- comparison table: one row per leg, totals on the first row --- */
function renderTable(quotes, best) {
  var body = document.getElementById("tblBody");
  var rows = [];
  quotes.forEach(function (q) {
    var isBest = best && q.id === best.id;
    // Approve button visibility is decided by canApprove() (status + finance role)
    var showApprove = canApprove(q);
    var blank = { city: "", country: "" };
    var legs = q.legs.length ? q.legs : [{ dir: "out", from: blank, at: blank, flightNo: "—", dep: "", journey: "", fare: 0 }];
    // count segments per direction so we can flag connecting ("via") flights
    var dirCounts = { out: 0, ret: 0 };
    legs.forEach(function (l) { dirCounts[l.dir] = (dirCounts[l.dir] || 0) + 1; });
    var seen = { out: 0, ret: 0 };
    legs.forEach(function (l, i) {
      var isRet = l.dir === "ret";
      var cls = isRet ? "ret" : "out";
      var isVia = dirCounts[l.dir] > 1;
      var segNo = ++seen[l.dir];
      var badge = (isRet ? "RETURN" : "OUTBOUND") + (isVia ? " " + segNo : "");
      rows.push('<tr class="' + (isBest ? "row-best" : "") + '">' +
        "<td class='strong'>" + (i === 0 ? esc(q.vendor) : "") + "</td>" +
        "<td>" + (i === 0 && q.status ? '<span class="status-pill ' + statusClass(q.status) + '">' + esc(q.status) + "</span>" : "") +
        (i === 0 && showApprove ? '<button class="btn-approve" type="button" data-id="' + esc(q.id) + '">Approve</button>' : "") + "</td>" +
        // baggage & remarks are quote-level — show once, on the first leg row
        "<td>" + (i === 0 ? esc(q.cabinBaggage || "—") : "") + "</td>" +
        "<td>" + (i === 0 ? esc(q.checkinBaggage || "—") : "") + "</td>" +
        "<td class='remarks'>" + (i === 0 ? esc(q.remarks || "—") : "") + "</td>" +
        '<td><span class="dirtag ' + cls + '" style="margin-bottom:0">' + badge + "</span>" +
        (isVia ? ' <span class="via-tag">VIA</span>' : "") + "</td>" +
        "<td>" + esc(l.from.city || "—") + " &rarr; " + esc(l.at.city || "—") + "</td>" +
        "<td>" + esc(q.airline) + "</td>" +
        "<td>" + esc(l.flightNo) + "</td>" +
        "<td>" + esc(l.dep || "—") + "</td>" +
        "<td>" + esc(l.journey || "—") + "</td>" +
        "<td class='num'>" + CURRENCY.format(l.fare) + "</td>" +
        "<td class='num strong'>" + (i === 0 ? CURRENCY.format(q.total) : "") + "</td>" +
        "</tr>");
    });
  });
  body.innerHTML = rows.join("") ||
    '<tr><td colspan="13" style="text-align:center;color:var(--ink-3)">No ticket options to display.</td></tr>';
}

/* =====================================================================
   6. EVENTS
===================================================================== */
document.getElementById("selStatus").addEventListener("change", render);
document.getElementById("btnRefresh").addEventListener("click", GetRecords);

// selecting a travel-request card drives the whole view
document.getElementById("reqCards").addEventListener("click", function (ev) {
  var card = ev.target.closest(".req-card");
  if (!card) return;
  selectedRequest = card.getAttribute("data-req");
  // update the active highlight without rebuilding (keeps scroll position)
  this.querySelectorAll(".req-card").forEach(function (c) {
    c.classList.toggle("active", c === card);
  });
  render();
});

// Approve buttons are re-rendered with the table, so listen on the tbody
document.getElementById("tblBody").addEventListener("click", function (ev) {
  var btn = ev.target.closest(".btn-approve");
  if (btn && !btn.disabled) approveQuote(btn.getAttribute("data-id"));
});
