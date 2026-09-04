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
var isDirectorUser = false;                 // Director — approves > $1000 quotes
var directorFromDept = false;               // …says DuplicateDepartment (Department_Name = Director)
var directorFromMaster = false;             // …says Department_Master (may be unreadable → stays false)
var FINANCE_DEPT = "Finance & Accounts";
var DIRECTOR_THRESHOLD = 1000;              // quotes ABOVE this need Director approval after Finance

// Director if EITHER source says so — Department_Master is often permission-restricted
// (403), so DuplicateDepartment is the primary source in practice.
function recomputeDirector() {
  isDirectorUser = directorFromDept || directorFromMaster;
}

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
  getDirector();   // is the user a Director? (Department_Master) — approves > $1000 quotes
  getPassengers(); // passenger names per travel request (for the request cards)
  getMyRequests(); // view-only page: restrict to requests raised by / for this person
  GetRecords();    // load the quotations
});

// passengers per travel request, from report `travel_request_Report`, subform
// `Passenger_Details` (fields Passenger_Name, Age). Keyed by the request number.
var passengersByRequest = {};

// VIEW-ONLY page: the set of request numbers this person may see — those where their
// login matches the Raiser_Email or HOD_Email in report Travel_Request_Report_for_Employee.
// null = not loaded yet (view page shows nothing until it resolves). Unused by the main widget.
var allowedRequests = null;

// does any email field on a record match the logged-in user? (Raiser_Email / HOD_Email
// / any *email* field) — used to decide which requests a view-only user may see
function recordMatchesUser(r) {
  if (norm(r.Raiser_Email) === loggedInUser || norm(r.HOD_Email) === loggedInUser) return true;
  for (var k in r) {
    if (r.hasOwnProperty(k) && /email/i.test(k) && norm(r[k]) === loggedInUser) return true;
  }
  return false;
}

function getRecordsFrom(report) {
  return ZOHO.CREATOR.DATA.getRecords({
    app_name: "air-travel-request-management",
    report_name: report,
    max_records: 1000,
    field_config: "all",
  }).then(function (response) { return response.data || []; },
    function (err) { console.warn("ATRM widget: lookup failed for " + report, err); return []; });
}

function getMyRequests() {
  if (!VIEW_ONLY) return; // this whole feature is view.html-only; widget.html is unaffected
  var set = {};

  // Report 1 — Travel_Request_Report_for_Employee: scoping only (Raiser/HOD email match)
  var pEmp = getRecordsFrom("Travel_Request_Report_for_Employee").then(function (rows) {
    rows.forEach(function (r) {
      if (recordMatchesUser(r)) { var n = findRequestNo(r); if (n) set[reqKey(n)] = true; }
    });
  });

  // Report 2 — HOD_Request_Approval_for_HOD: the logged-in HOD's own approval queue
  // (server-side filtered to them), so ACCESS to it is the permission — authorize every
  // request it returns, no email check. It's request-level, so only rows that actually
  // carry quotation data are merged as a data source (avoids empty junk quotes).
  var pHod = getRecordsFrom("HOD_Request_Approval_for_HOD").then(function (rows) {
    rows.forEach(function (r) { var n = findRequestNo(r); if (n) set[reqKey(n)] = true; });
    hodRecords = rows.filter(function (r) {
      return val(r.Service_Provider_Name) || num(r.total_amount) ||
        (Array.isArray(r.Travel_Ticket_Options) && r.Travel_Ticket_Options.length);
    });
  });

  Promise.all([pEmp, pHod]).then(function () {
    allowedRequests = set; // fail closed: empty set shows nothing rather than everyone's
    console.log("ATRM view-only: allowed requests for", loggedInUser, "→", Object.keys(set),
      "| HOD data records:", hodRecords.length);
    finish();  // re-merge now that HOD data + the allowed set are ready
  });
}

// may this request be shown? Main widget: always. View page: only the person's own.
function allowedRequest(requestId) {
  if (!VIEW_ONLY) return true;
  if (!allowedRequests) return false;   // not loaded yet — show nothing
  return !!allowedRequests[reqKey(requestId)];
}

// normalise a request number so "Req-0002" / "req 0002" / " REQ-0002 " all match
function reqKey(s) { return val(s).toLowerCase().replace(/[\s-]/g, ""); }

// find the "Req-XXXX" request number on a record — handle a flat field, a nested
// travel_request.Travel_Request_ID, or a lookup object; else scan every field.
function findRequestNo(r) {
  var tr = r.travel_request;
  var nested = (tr && typeof tr === "object") ? val(tr.Travel_Request_ID) : ""; // quotation shape
  var direct = val(r.Travel_Request_ID) || nested || val(r.travel_request) ||
    val(r.Request_ID) || val(r.Travel_Request) || val(r.Name);
  if (/req[\s-]?\d/i.test(direct)) return direct;
  for (var k in r) {
    if (!r.hasOwnProperty(k)) continue;
    var v = val(r[k]);
    if (/^req[\s-]?\d+/i.test(v)) return v;
  }
  return direct; // fall back to whatever we had
}

// pull passenger rows out of a record — the Passenger_Details subform, or any
// array field whose rows look like passengers
function extractPassengers(r) {
  var sub = r.Passenger_Details || r.passenger_details || r.Passenger_Detail || r.Passengers;
  if (!Array.isArray(sub)) {
    for (var k in r) {
      if (r.hasOwnProperty(k) && Array.isArray(r[k]) && r[k].length && r[k][0] && typeof r[k][0] === "object") {
        var f = r[k][0];
        if ("Passenger_Name" in f || "passenger_name" in f || "Age" in f) { sub = r[k]; break; }
      }
    }
  }
  return (Array.isArray(sub) ? sub : []).map(function (p) {
    return { name: val(p.Passenger_Name) || val(p.passenger_name) || val(p.Name), age: val(p.Age) || val(p.age) };
  }).filter(function (p) { return p.name || p.age; });
}

function getPassengers() {
  var config = {
    app_name: "air-travel-request-management",
    report_name: "travel_request_Report",
    max_records: 1000,
    field_config: "all",
  };
  ZOHO.CREATOR.DATA.getRecords(config).then(function (response) {
    var rows = response.data || [];
    var map = {};
    rows.forEach(function (r) {
      var reqNo = findRequestNo(r);
      var list = extractPassengers(r);
      if (reqNo && list.length) map[reqKey(reqNo)] = (map[reqKey(reqNo)] || []).concat(list);
    });
    passengersByRequest = map;
    if (allQuotes.length) buildRequestCards(); // redraw cards if quotes already loaded
  }).catch(function (err) {
    console.warn("ATRM widget: passenger lookup failed", err); // cards just omit passengers
  });
}

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

    // a user can have several rows — Finance/Director if ANY of their rows says so
    var mine = rows.filter(function (d) { return norm(d.HOD_Email) === loggedInUser; });
    isFinanceUser = mine.some(function (d) { return norm(d.Department_Name) === norm(FINANCE_DEPT); });
    directorFromDept = mine.some(function (d) { return /director/.test(norm(d.Department_Name)); });
    recomputeDirector();
    console.log("ATRM role check → loginUser:", loggedInUser,
      "| depts:", mine.map(function (d) { return val(d.Department_Name); }).join(", ") || "(no HOD_Email match)",
      "| isFinanceUser:", isFinanceUser, "| isDirectorUser:", isDirectorUser);
    applyDefaultStatus();                 // Finance lands on their queue (All statuses)
    if (allQuotes.length) buildRequestCards();
    render(); // role now known — redraw so Approve buttons reflect it
  }).catch(function (err) {
    console.warn("ATRM widget: department lookup failed", err);
    isFinanceUser = false; // fail closed — no finance powers if the lookup fails
    directorFromDept = false;
    recomputeDirector();
  });
}

// does this record belong to the logged-in user? (any field === the login email/user)
function rowIsMine(r) {
  for (var k in r) {
    if (r.hasOwnProperty(k) && norm(r[k]) === loggedInUser) return true;
  }
  return false;
}


// Look the user up in Department_Master to decide if they are a Director (approves > $1000).
function getDirector() {
  var config = {
    app_name: "air-travel-request-management",
    report_name: "Department_Master",
    max_records: 1000,
    field_config: "all",
  };
  ZOHO.CREATOR.DATA.getRecords(config).then(function (response) {
    var rows = response.data || [];
    directorFromMaster = rows.some(function (r) {
      if (!rowIsMine(r)) return false;
      // department field says "Director"…
      var d = norm(val(r.Department_Name) || val(r.Department) || val(r.Dept_Name) ||
        val(r.DepartmentName) || val(r.Role) || val(r.Designation));
      if (/director/.test(d)) return true;
      // …or, if the field name differs, any field on my row that is exactly "Director"
      for (var k in r) { if (r.hasOwnProperty(k) && norm(r[k]) === "director") return true; }
      return false;
    });
    recomputeDirector();
    console.log("ATRM director check (Department_Master) →", directorFromMaster, "| isDirectorUser:", isDirectorUser);
    applyDefaultStatus();                 // Director lands on their queue (All statuses)
    if (allQuotes.length) buildRequestCards();
    render();
  }).catch(function (err) {
    // Department_Master is often not shared with widget users (403) — that's fine,
    // the DuplicateDepartment lookup still grants the Director role.
    console.warn("ATRM widget: Department_Master lookup failed", err);
    directorFromMaster = false;
    recomputeDirector();
  });
}

// raw records by source, so the view page can MERGE quotations from DuplicateVQ and
// (view-only) the HOD approval report before normalising.
var vqRecords = [];   // DuplicateVQ
var hodRecords = [];  // HOD_Request_Approval_for_HOD (view-only extra data source)

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
    vqRecords = response.data || [];
    finish();
  }).catch(function (err) {
    console.warn("ATRM widget: fetch failed", err);
    vqRecords = [];
    // on the view page the HOD report may still have data even if DuplicateVQ failed
    if (VIEW_ONLY && hodRecords.length) { finish(); return; }
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


// wrap a long place name onto two balanced lines (break near the middle at a word
// boundary) when it is longer than 25 characters — used for the From/To columns.
// Returns HTML: each line is escaped, joined by a <br>.
function wrapName(s) {
  s = val(s);
  if (s.length <= 25) return esc(s);
  var words = s.split(/\s+/);
  if (words.length < 2) return esc(s); // single long word — nothing to break on
  var mid = s.length / 2, pos = 0, best = 1, bestDiff = Infinity;
  for (var i = 0; i < words.length - 1; i++) {
    pos += words[i].length + (i > 0 ? 1 : 0); // length of the prefix ending at word i
    var diff = Math.abs(pos - mid);
    if (diff < bestDiff) { bestDiff = diff; best = i + 1; }
  }
  return esc(words.slice(0, best).join(" ")) + "<br>" + esc(words.slice(best).join(" "));
}

// parse a duration string to total minutes — tolerant of the many shapes Creator
// can return so layover/journey values always register:
//   "1 Days 2 Hours 30 Minutes", "2 Hrs 30 Mins", "2h 30m", "2:30" (h:mm), "150" (mins)
function durationMins(s) {
  s = (val(s) || "").toLowerCase().trim();
  if (!s) return 0;
  // clock format H:MM (optionally :SS)
  var clock = s.match(/^(\d+):(\d{2})(?::\d{2})?$/);
  if (clock) return (+clock[1]) * 60 + (+clock[2]);
  // worded: days / hours / minutes — handles day(s), h/hr/hrs/hour(s), m/min(s)/minute(s)
  if (/day|hour|hr|min|\dh|\dm/.test(s)) {
    var d = (s.match(/(\d+)\s*d(?:ay|ays)?\b/) || [0, 0])[1];
    var h = (s.match(/(\d+)\s*h(?:r|rs|our|ours)?\b/) || [0, 0])[1];
    var m = (s.match(/(\d+)\s*m(?:in|ins|inute|inutes)?\b/) || [0, 0])[1];
    return (+d) * 1440 + (+h) * 60 + (+m);
  }
  // bare number = minutes
  var n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}

// minutes -> "8h 30m"
function fmtDur(mins) {
  if (!mins) return "—";
  var h = Math.floor(mins / 60), m = mins % 60;
  return ((h ? h + "h " : "") + (m ? m + "m" : "")).trim() || "0m";
}

var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// parse "05-Aug-2026 14:00" / "12-Aug 03:40" / "25-Jul-2026 8:15 pm" -> epoch ms (NaN if unparseable)
function parseDateTime(s) {
  s = val(s);
  var m = s.match(/(\d{1,2})[-\/\s]([A-Za-z]{3,9})(?:[-\/\s](\d{4}))?[\sT,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (!m) return NaN;
  var mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon == null) return NaN;
  var year = m[3] ? +m[3] : 2000; // year sometimes omitted; a constant keeps intra-trip gaps correct
  var h = +m[4], ap = (m[6] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;   // "8:15 pm" -> 20:15
  if (ap === "am" && h === 12) h = 0;   // "12:10 am" -> 00:10
  return new Date(year, mon, +m[1], h, +m[5], 0).getTime();
}

// UTC offsets (minutes) by IATA airport code — used to turn local dep/arr clocks into
// a TRUE elapsed duration (Johannesburg 10:05 → Dubai 20:15 reads 10h10m on the clocks
// but is 8h10m in the air, Dubai running 2h ahead). Only zones WITHOUT daylight saving
// are listed (Africa, Gulf, India, East Asia); an unknown code simply falls back to the
// vendor-entered journey time — safer than being an hour off half the year (Europe/US/AU).
var AIRPORT_TZ = {
  // Southern & East Africa
  HRE: 120, BUQ: 120, VFA: 120, JNB: 120, CPT: 120, DUR: 120, GBE: 120, LUN: 120,
  LLW: 120, MPM: 120, KGL: 120, ADD: 180, NBO: 180, MBA: 180, DAR: 180, EBB: 180, JRO: 180,
  // West / North Africa
  LOS: 60, ABV: 60, ACC: 0, CAI: 120,
  // Gulf / Middle East
  DXB: 240, AUH: 240, SHJ: 240, MCT: 240, DOH: 180, BAH: 180, KWI: 180, RUH: 180, JED: 180,
  // Indian subcontinent
  DEL: 330, BOM: 330, NAG: 330, MAA: 330, BLR: 330, HYD: 330, CCU: 330, AMD: 330,
  PNQ: 330, GOI: 330, COK: 330, AGR: 330, JAI: 330, LKO: 330, IXC: 330, PNY: 330,
  TRZ: 330, IXM: 330, VTZ: 330, BBI: 330, PAT: 330, GAU: 330, IXB: 330, IDR: 330,
  CMB: 330, DAC: 360, KTM: 345, KHI: 300, ISB: 300,
  // East / South-East Asia
  SIN: 480, KUL: 480, HKG: 480, PVG: 480, PEK: 480, CAN: 480, BKK: 420, SGN: 420, NRT: 540, HND: 540, ICN: 540
};

// "Johannesburg OR Tambo Airport (JNB)" / "Dubai - DXB" -> "JNB" / "DXB"
function airportCode(place) {
  var c = (place && place.city) || "";
  var m = c.match(/\(([A-Za-z]{3})\)/) || c.match(/[-–]\s*([A-Za-z]{3})\s*$/) || c.match(/\b([A-Z]{3})\s*$/);
  return m ? m[1].toUpperCase() : "";
}

// the airport's UTC offset in minutes, or null when unknown
function placeOffset(place) {
  var code = airportCode(place);
  return AIRPORT_TZ.hasOwnProperty(code) ? AIRPORT_TZ[code] : null;
}

// true elapsed minutes of one leg: (arrival − departure) corrected for the timezone
// difference between the two airports; falls back to the vendor-entered journey time
// when times or timezones aren't available.
function legElapsedMins(l) {
  var dep = parseDateTime(l.dep), arr = parseDateTime(l.arr);
  var oF = placeOffset(l.from), oT = placeOffset(l.at);
  if (!isNaN(dep) && !isNaN(arr) && oF !== null && oT !== null) {
    var m = Math.round((arr - dep) / 60000) - (oT - oF);
    if (m > 0 && m < 4 * 1440) return m; // sanity: 0 < duration < 4 days
  }
  return durationMins(l.journey);
}

// arrival time of a leg: use its arrival if given, else departure + journey time,
// shifted onto the DESTINATION's clock (layovers compare same-airport local times)
function arrivalOf(l) {
  var arr = parseDateTime(l.arr);
  if (!isNaN(arr)) return arr;
  var dep = parseDateTime(l.dep), fly = durationMins(l.journey);
  if (isNaN(dep) || !fly) return NaN;
  var oF = placeOffset(l.from), oT = placeOffset(l.at);
  var shift = (oF !== null && oT !== null) ? (oT - oF) : 0;
  return dep + (fly + shift) * 60000;
}

// layover we compute ourselves at each connection: next leg's departure minus this
// leg's arrival, summed over a direction's segments (0 when it can't be worked out)
function dirLayoverMins(segs) {
  var total = 0;
  for (var i = 0; i < segs.length - 1; i++) {
    var nextDep = parseDateTime(segs[i + 1].dep);
    var arr = arrivalOf(segs[i]);
    if (!isNaN(nextDep) && !isNaN(arr)) {
      var gap = Math.round((nextDep - arr) / 60000);
      if (gap > 0) total += gap;
    }
  }
  return total;
}

// total travel time of one direction — first take-off to final touch-down including
// layovers, timezone-corrected end-to-end when both endpoints have known clocks/zones;
// else per-leg elapsed times + computed layovers.
function dirDurationMins(segs) {
  var first = segs[0], last = segs[segs.length - 1];
  var dep = parseDateTime(first.dep), arr = parseDateTime(last.arr);
  var oF = placeOffset(first.from), oT = placeOffset(last.at);
  if (!isNaN(dep) && !isNaN(arr) && oF !== null && oT !== null) {
    var m = Math.round((arr - dep) / 60000) - (oT - oF);
    if (m > 0 && m < 6 * 1440) return m;
  }
  return segs.reduce(function (t, l) { return t + legElapsedMins(l); }, 0) + dirLayoverMins(segs);
}

// total elapsed travel time of a quote (all directions, timezone-corrected)
function quoteDuration(q) {
  return directions(q).reduce(function (t, d) { return t + dirDurationMins(d.segs); }, 0);
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
      arr: val(r.Arrival_Date_Time) || val(r.Arrival_Time) || val(r.Arrival_Date),
      journey: val(r.Journey_Time1) || val(r.Journey_Time) || val(r.Journey),
      // layover is NOT read from the subform — it is computed from the flight times
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

// just the CITY from a place string: "New Delhi - DEL" -> "New Delhi",
// "Delhi, India" -> "Delhi", "Cape Town - CPT" -> "Cape Town"
function cityOnly(s) {
  s = val(s);
  return (s.split(/\s+-\s+|,/)[0] || s).trim();
}

function normalise(rec) {
  var tr = rec.travel_request || {};
  var legs = legsFrom(rec.Travel_Ticket_Options, "out").concat(legsFrom(rec.SubForm2, "ret"));

  // overall request route — the client wants the CITY, not the long airport name.
  // The flight segments carry the city ("New Delhi - DEL"); the main Source/Destination
  // holds the airport name, so prefer the segment city and fall back to the main field.
  var outSegs = legs.filter(function (l) { return l.dir === "out"; });
  var source, destination;
  if (outSegs.length) {
    source = { city: cityOnly(outSegs[0].from.city), country: outSegs[0].from.country };
    destination = { city: cityOnly(outSegs[outSegs.length - 1].at.city), country: outSegs[outSegs.length - 1].at.country };
  } else {
    source = { city: cityOnly(rec.Source), country: splitPlace(rec.Source).country };
    destination = { city: cityOnly(rec.Destination), country: splitPlace(rec.Destination).country };
  }

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

function finish() {
  // merge DuplicateVQ with the view-only HOD records, de-duped by record/quotation id
  var seen = {}, merged = [];
  vqRecords.concat(hodRecords).forEach(function (r) {
    var id = val(r.ID) || val(r.Quotation_ID);
    var key = id || (val(r.travel_request) + "|" + val(r.Service_Provider_Name) + "|" + val(r.total_amount));
    if (seen[key]) return;
    seen[key] = true;
    merged.push(r);
  });
  allQuotes = merged.map(normalise);

  if (!allQuotes.length) {
    showEmpty("No quotations yet", "Once vendors submit quotations against a travel request, they will appear here for comparison.");
    return;
  }
  buildStatusSelect(); // sets the default status
  buildRequestCards();  // …so the request cards honour it
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

// the Quote Status currently chosen in the top filter ("" = all statuses)
function currentStatus() {
  var el = document.getElementById("selStatus");
  return el ? el.value : "";
}

// short word for a request-card badge, derived from a quote status
function statusWord(st) {
  var t = (st || "").toLowerCase();
  if (/pend/.test(t)) return "pending";
  if (/approv/.test(t)) return "approved";
  if (/reject/.test(t)) return "rejected";
  if (/open|submit/.test(t)) return "open";
  return t || "quotes";
}

// one summary per travel request. The top Quote Status filter decides which
// requests appear: "All statuses" shows every request; a specific status shows
// only requests that have a quote in that status — this is how already approved
// requests become visible when "Approved" is selected.
function requestSummaries() {
  var st = currentStatus();
  var map = {}, order = [];
  allQuotes.forEach(function (q) {
    if (!allowedRequest(q.requestId)) return; // view page: only this person's own requests
    if (!map[q.requestId]) { map[q.requestId] = []; order.push(q.requestId); }
    map[q.requestId].push(q);
  });
  return order.map(function (id) {
    var g = map[id];
    // a specific status shows exactly that status (incl. Invalid); "All" drops Invalid
    var visible = st ? g.filter(function (q) { return q.status === st; })
                     : g.filter(function (q) { return !isInvalid(q.status); });
    return {
      id: id,
      first: visible[0] || g[0],
      count: visible.length,
      matchCount: visible.length,
      openCount: visible.filter(function (q) { return isFresh(q.status); }).length,
      lowest: visible.length ? Math.min.apply(null, visible.map(function (q) { return q.total; })) : 0
    };
  }).filter(function (s) { return s.matchCount > 0; });
}

// horizontal strip of selectable travel-request cards (replaces the old dropdown)
function buildRequestCards() {
  var el = document.getElementById("reqCards");
  var sub = document.getElementById("reqSub");
  var st = currentStatus();
  var summaries = requestSummaries();

  if (sub) {
    sub.innerHTML = st
      ? 'Showing travel requests with a <b>' + esc(st) + '</b> quotation'
      : 'All travel requests &mdash; use the Quote Status filter above to narrow down';
  }

  if (!summaries.length) {
    var msg;
    if (VIEW_ONLY && !allowedRequests) msg = "Loading your travel requests&hellip;";
    else if (VIEW_ONLY) msg = "You have no travel requests" + (st ? ' with a &ldquo;' + esc(st) + '&rdquo; quotation.' : ".");
    else msg = "No travel requests" + (st ? ' with a &ldquo;' + esc(st) + '&rdquo; quotation.' : " to show.");
    el.innerHTML = '<div class="req-empty">' + msg + "</div>";
    selectedRequest = null;
    return;
  }

  // keep the previous selection if it still matches the filter, else pick the first
  var ids = summaries.map(function (s) { return s.id; });
  if (ids.indexOf(selectedRequest) < 0) selectedRequest = ids[0];

  var badgeWord = st ? statusWord(st) : "open";
  el.innerHTML = summaries.map(function (s) {
    var src = s.first.source.city || "—";
    var dst = s.first.destination.city || "—";
    var badgeCount = st ? s.matchCount : s.openCount;
    // both dates for a round trip (departure → return); just the one for a one-way
    var dateTxt = esc(s.first.travelDate || "—") +
      (s.first.returnDate ? ' <span class="rc-arrow">&rarr;</span> ' + esc(s.first.returnDate) : "");
    return '<button type="button" class="req-card' + (s.id === selectedRequest ? " active" : "") + '" data-req="' + esc(s.id) + '">' +
      '<div class="rc-top"><span class="rc-id">' + esc(s.id) + '</span>' +
      '<span class="rc-open">' + badgeCount + ' ' + badgeWord + '</span></div>' +
      paxLine(s.id) +
      '<div class="rc-route">' + esc(src) + '<span class="rc-arrow">&rarr;</span>' + esc(dst) + '</div>' +
      '<div class="rc-meta"><span class="rc-type">' + esc(s.first.travelType || "—") + '</span> &middot; ' + dateTxt + '</div>' +
      '<div class="rc-foot"><span class="rc-cnt">' + s.count + ' quote' + (s.count !== 1 ? "s" : "") + '</span>' +
      '<span class="rc-low"><small>Lowest</small>' + CURRENCY.format(s.lowest) + '</span></div>' +
      '</button>';
  }).join("");
}

// a passenger's age as a number (null if unknown)
function paxAgeNum(p) { var n = parseInt(val(p.age), 10); return isNaN(n) ? null : n; }
// infant = age <= 5
function paxIsInfant(p) { var a = paxAgeNum(p); return a !== null && a <= 5; }
// does a request have any infant passenger (age <= 5)?
function requestHasInfant(requestId) {
  return (passengersByRequest[reqKey(requestId)] || []).some(paxIsInfant);
}

// passenger block for a request card — avatar + name + age, from travel_request_Report.
// A passenger aged <= 5 is flagged with an "Infant" sign.
function paxLine(requestId) {
  var pax = passengersByRequest[reqKey(requestId)] || [];
  if (!pax.length) return "";
  var rows = pax.map(function (p) {
    var name = (p.name || "—").trim();
    var initial = (name.charAt(0) || "?").toUpperCase();
    var inf = paxIsInfant(p);
    return '<div class="pax' + (inf ? " is-infant" : "") + '">' +
      '<span class="pax-av">' + esc(initial) + "</span>" +
      '<span class="pax-name">' + esc(name) + "</span>" +
      (p.age ? '<span class="pax-age">' + esc(p.age) + " yrs</span>" : "") +
      (inf ? '<span class="pax-infant">👶 Infant</span>' : "") +
      "</div>";
  }).join("");
  return '<div class="rc-pax">' +
    '<div class="pax-hd">' +
    '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z"/></svg>' +
    "Passenger" + (pax.length > 1 ? "s" : "") +
    '<span class="pax-ct">' + pax.length + "</span></div>" +
    rows + "</div>";
}

// dropdown of unique quote statuses; defaults to "Submitted" when present
function buildStatusSelect() {
  var sel = document.getElementById("selStatus");
  var seen = {}, opts = [];
  allQuotes.forEach(function (q) {
    var s = q.status || "";
    if (s && !seen[s]) { seen[s] = true; opts.push(s); } // Invalid IS listed — picking it shows invalid quotes
  });
  sel.innerHTML = '<option value="">All statuses</option>' +
    opts.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("");
  applyDefaultStatus();
}

// default Quote Status by role: Travel Desk → "Submitted" (their queue); Finance,
// Director and the view page → "All statuses" so they see & act on forwarded/pending
// requests (which aren't Submitted). Not re-applied once the user picks a status.
var userChangedStatus = false;
function defaultStatus() {
  if (!VIEW_ONLY && !isFinanceUser && !isDirectorUser) return "Submitted";
  return ""; // All statuses
}
function applyDefaultStatus() {
  var sel = document.getElementById("selStatus");
  if (!sel || userChangedStatus) return;
  var want = defaultStatus();
  var has = [].some.call(sel.options, function (o) { return o.value === want; });
  sel.value = has ? want : "";
}

// quotations for the selected travel request + status, cheapest first.
// A specific status shows exactly that status (incl. "Invalid"); "All statuses"
// excludes Invalid quotes.
function currentQuotes() {
  var st = document.getElementById("selStatus").value;
  return allQuotes.filter(function (q) {
    if (q.requestId !== selectedRequest) return false;
    return st ? q.status === st : !isInvalid(q.status);
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
   APPROVAL — up to three stages: Travel Desk -> Finance -> (Director, if > $1000)
   - Travel Desk (any non-finance/non-director) : approve while every quote is fresh
                          (Open/Submitted) -> forwards to Finance, others Open.
   - Finance & Accounts : approve an Open / "Approval Pending by Finance Team" quote.
       * fare <= $1000 -> Approved (final), others Rejected.
       * fare  > $1000 -> "Approval Pending by Director", the other quotes STAY OPEN
                          until the Director decides (finance is then locked out).
   - Director : once a quote sits at "Approval Pending by Director", approve THAT
                quote OR any still-Open one -> Approved (final), all others Rejected.
   - Nobody once the request already has an Approved quote.
===================================================================== */

// quote already sent to finance — only a finance user can finalise it
function isFinancePending(status) {
  return (status || "").toLowerCase() === "approval pending by finance team";
}

// quote (> $1000) forwarded by finance to the Director for final approval
function isDirectorPending(status) {
  return (status || "").toLowerCase() === "approval pending by director";
}

// a "fresh" quote no one has acted on yet
function isFresh(status) {
  var t = (status || "").toLowerCase();
  return t === "open" || t === "submitted";
}

// a dead/ignored quote — not part of the active comparison or approval workflow
function isInvalid(status) {
  return (status || "").toLowerCase() === "invalid";
}

// has the approval WORKFLOW actually started for this request? Only forwarding to
// finance or a final decision counts — an Invalid quote is NOT an approval action,
// so it must not block the travel desk from approving the valid quotes.
function requestActedOn(requestId) {
  return groupOf(requestId).some(function (q) {
    var t = (q.status || "").toLowerCase();
    return t === "approval pending by finance team" || t === "approval pending by director" ||
      t === "approved" || t === "rejected";
  });
}

// view-only pages set window.VIEW_ONLY = true before loading this script — they get
// the full dashboard but no Approve/Reject actions.
var VIEW_ONLY = !!(typeof window !== "undefined" && window.VIEW_ONLY);

// is any quote of this request waiting on the Director?
function groupHasDirectorPending(requestId) {
  return groupOf(requestId).some(function (q) { return isDirectorPending(q.status); });
}

// Should this row show an Approve button for the current user?
function canApprove(q) {
  if (VIEW_ONLY) return false;                        // view-only page: no actions
  if (groupHasApproved(q.requestId)) return false;   // request already decided
  var t = (q.status || "").toLowerCase();
  var directorStage = groupHasDirectorPending(q.requestId);
  // Director acts once finance forwarded a > $1000 quote: they may approve the
  // forwarded quote OR any quote still Open (those stay Open until they decide)
  if (isDirectorUser && (isDirectorPending(q.status) || (t === "open" && directorStage))) return true;
  // Finance approves an Open or finance-pending quote — but once a quote sits with
  // the Director, the decision is the Director's alone
  if (isFinanceUser && !directorStage && (t === "open" || isFinancePending(q.status))) return true;
  // Travel desk (neither finance nor director): only while the request is still fresh
  if (!isFinanceUser && !isDirectorUser) return isFresh(q.status) && !requestActedOn(q.requestId);
  return false;
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

// one record update against the same report — normalised so it NEVER rejects:
// resolves to { id, status, ok }. Creator returns { code: 3000 } on success; any
// other code (or a thrown error) is treated as a failure so we don't silently miss it.
function updateStatus(id, status) {
  return ZOHO.CREATOR.DATA.updateRecordById({
    app_name: "air-travel-request-management",
    report_name: "DuplicateVQ",
    id: id,
    payload: { data: { quote_status: status } }
  }).then(function (res) {
    var ok = !res || res.code === undefined || res.code === 3000;
    return { id: id, status: status, ok: ok, res: res };
  }, function (err) {
    return { id: id, status: status, ok: false, err: err };
  });
}

// apply a list of {id, status} updates ONE AT A TIME. Parallel writes to the same
// Creator report get throttled/dropped (often returning a non-3000 code that looks
// like success), which left some quotes un-rejected — sequential + code-checking
// fixes that. Resolves to the list of updates that failed.
function applyUpdates(list) {
  var failures = [];
  return list.reduce(function (chain, u) {
    return chain.then(function () {
      return updateStatus(u.id, u.status).then(function (r) {
        if (!r.ok) failures.push(r);
      });
    });
  }, Promise.resolve()).then(function () { return failures; });
}

function approveQuote(id) {
  var q = null;
  for (var i = 0; i < allQuotes.length; i++) if (allQuotes[i].id === id) { q = allQuotes[i]; break; }
  if (!q || !canApprove(q)) return;

  var group = groupOf(q.requestId);
  // other quotes in the request, EXCLUDING invalid ones (leave dead quotes as-is)
  var others = group.filter(function (g) { return g.id !== q.id && !isInvalid(g.status); });
  var rejectOthers = others.map(function (g) { return { id: g.id, status: "Rejected" }; });
  var openOthers = others.map(function (g) { return { id: g.id, status: "Open" }; });
  var money = CURRENCY.format(q.total);

  // Work out this user's action from role + status + price.
  var dialog, updates;
  if (isDirectorUser && (isDirectorPending(q.status) || groupHasDirectorPending(q.requestId))) {
    // Director's final decision — the forwarded quote or any still-Open alternative
    dialog = {
      title: "Approve as Director?",
      body: "Approve " + q.vendor + " at " + money + " for " + q.requestId + ".\n\nThis is the final Director approval — all other quotations will be marked Rejected.",
      confirmText: "Approve"
    };
    updates = [{ id: q.id, status: "Approved" }].concat(rejectOthers);
  } else if (isFinanceUser && q.total > DIRECTOR_THRESHOLD) {
    // Finance approves, but > $1000 -> needs Director sign-off next; the other quotes
    // stay Open so the Director can still pick one of them instead
    dialog = {
      title: "Send for Director approval?",
      body: "Approve " + q.vendor + " at " + money + ".\n\nThis quotation is over " + CURRENCY.format(DIRECTOR_THRESHOLD) +
        ", so it needs Director approval (Approval Pending by Director). The other quotations for " + q.requestId + " will stay Open until the Director decides.",
      confirmText: "Send to Director"
    };
    updates = [{ id: q.id, status: "Approval Pending by Director" }].concat(openOthers);
  } else if (isFinanceUser) {
    // Finance final approval (<= $1000)
    dialog = {
      title: "Approve this quotation?",
      body: "Approve " + q.vendor + " at " + money + ".\n\nAll other quotations for " + q.requestId + " will be marked Rejected.",
      confirmText: "Approve"
    };
    updates = [{ id: q.id, status: "Approved" }].concat(rejectOthers);
  } else {
    // Travel desk forwards to Finance
    dialog = {
      title: "Send for finance approval?",
      body: "Approve " + q.vendor + " at " + money + ".\n\nThis quotation will be sent for finance approval (Approval Pending by Finance Team) and the other quotations will be set to Open.",
      confirmText: "Send to finance"
    };
    updates = [{ id: q.id, status: "Approval Pending by Finance Team" }].concat(openOthers);
  }
  dialog.icon = "brand";

  showConfirm(dialog).then(function (ok) {
    if (!ok) return;

    // freeze all approve buttons while we save
    document.querySelectorAll(".btn-approve").forEach(function (b) { b.disabled = true; b.textContent = "Saving…"; });

    applyUpdates(updates).then(function (failures) {
      if (failures.length) {
        console.warn("ATRM widget: some status updates failed", failures);
        showAlert({
          title: "Some updates didn't save",
          body: failures.length + " of " + updates.length + " quotation" + (updates.length > 1 ? "s" : "") +
            " could not be updated (likely report edit permissions or a Creator throttle). Reloading the current server state — please review and retry if needed."
        });
      }
      GetRecords(); // re-fetch so the widget shows the server's truth
    });
  });
}

/* =====================================================================
   5. RENDER
===================================================================== */
function render() {
  var quotes = currentQuotes();
  var best = bestOf(quotes);
  var infant = requestHasInfant(selectedRequest);

  // when a NEW request is opened, default the sort: infant → shortest trip (Fastest),
  // otherwise cheapest (Lowest fare). The user can still change it afterwards.
  if (sortAutoReq !== selectedRequest) {
    tableSort = infant ? "fastest" : "lowest";
    sortAutoReq = selectedRequest;
  }
  syncSortButtons();

  renderMeta(quotes);
  renderKpis(quotes, best);
  renderChart(quotes, best);
  renderFlow(quotes, best);
  renderTable(quotes, best, infant);
}

// reflect the current tableSort on the sort buttons
function syncSortButtons() {
  var bar = document.getElementById("sortBar");
  if (!bar) return;
  bar.querySelectorAll(".sort-btn").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-sort") === tableSort);
  });
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

// current sort for the comparison table: "lowest" (fare) | "fastest" (time)
var tableSort = "lowest";
var sortAutoReq = null; // request whose default sort we've already applied

// compact per-direction summary line for the Journey cell
function journeyLine(d) {
  var s = dirSummary(d.segs);
  var stops = d.segs.length - 1;
  var stopTxt = stops === 0 ? "non-stop"
    : stops + " stop" + (stops > 1 ? "s" : "") + (s.via.length ? " · via " + esc(s.via.join(", ")) : "");
  var cls = d.dir === "ret" ? "ret" : "out";
  return '<div class="jl">' +
    '<span class="dirtag ' + cls + '">' + (d.dir === "ret" ? "RETURN" : "OUTBOUND") + "</span>" +
    '<span class="jl-route">' + esc(s.from.city || "—") + " &rarr; " + esc(s.to.city || "—") + "</span>" +
    '<span class="jl-meta">' + stopTxt + "</span>" +
    '<span class="jl-times">' + esc(d.segs[0].dep || "—") + " &rarr; " + esc(d.segs[d.segs.length - 1].arr || "—") + "</span>" +
    "</div>";
}

// total computed layover across a quote (minutes)
function quoteLayover(q) {
  return directions(q).reduce(function (t, d) { return t + dirLayoverMins(d.segs); }, 0);
}

// flight numbers per direction (outbound on top, return below)
function flightNosCell(q) {
  return directions(q).map(function (d) {
    var nos = d.segs.map(function (s) { return esc(s.flightNo); }).filter(Boolean).join(" · ") || "—";
    return '<div class="fn-line">' + nos + "</div>";
  }).join("") || "—";
}

// first outbound departure date/time of a quote
function firstDep(q) {
  var out = q.legs.filter(function (l) { return l.dir === "out"; });
  return (out[0] && out[0].dep) || (q.legs[0] && q.legs[0].dep) || "—";
}

// "07-Jul-2026 16:30" -> date on line 1, time on line 2 (HTML with a <br>)
function twoLineDT(s) {
  s = val(s);
  var m = s.match(/^(.*?)\s+(\d{1,2}:\d{2}.*)$/); // break before the time part (H:MM)
  return m ? esc(m[1]) + "<br>" + esc(m[2]) : esc(s);
}

// itinerary identity: same airline + same flight numbers = the same flight,
// which one or more vendors may have quoted (each vendor becomes a column)
function itineraryKey(q) {
  var nos = q.legs.map(function (l) { return l.flightNo; }).filter(Boolean).join(",");
  return (q.airline || "?").toLowerCase() + "|" + nos.toLowerCase();
}

/* --- comparison grid: ONE row per flight, ONE column per vendor (fares side by side) --- */
function renderTable(quotes, best, infant) {
  var head = document.getElementById("tblHead");
  var body = document.getElementById("tblBody");
  var recNote = document.getElementById("recNote");
  var FIXED = 7; // Airline | Flight No | Departure | From | To | Travel Time | Layover

  if (!quotes.length) {
    head.innerHTML = "";
    body.innerHTML = '<tr><td colspan="' + (FIXED + 1) + '" style="text-align:center;color:var(--ink-3)">No ticket options to display.</td></tr>';
    if (recNote) recNote.style.display = "none";
    return;
  }

  // columns = every vendor quoting this request (union, first-seen order)
  var vendors = [], seenV = {};
  quotes.forEach(function (q) { if (!seenV[q.vendor]) { seenV[q.vendor] = true; vendors.push(q.vendor); } });

  // rows = distinct flight itineraries; a vendor that quoted one lands in its column
  var rowsMap = {}, order = [];
  quotes.forEach(function (q) {
    var k = itineraryKey(q);
    if (!rowsMap[k]) { rowsMap[k] = { sample: q, byVendor: {} }; order.push(k); }
    var cur = rowsMap[k].byVendor[q.vendor];
    if (!cur || q.total < cur.total) rowsMap[k].byVendor[q.vendor] = q; // keep a vendor's cheaper quote
  });
  var flightRows = order.map(function (k) { return rowsMap[k]; });

  // cheapest fare in a row (across the vendor columns)
  function rowMin(r) {
    var m = Infinity;
    vendors.forEach(function (v) { var q = r.byVendor[v]; if (q && q.total < m) m = q.total; });
    return isFinite(m) ? m : 0;
  }

  // sort rows: lowest = cheapest fare in the row; fastest = shortest travel time
  flightRows.sort(function (a, b) {
    return tableSort === "fastest"
      ? quoteDuration(a.sample) - quoteDuration(b.sample) || rowMin(a) - rowMin(b)
      : rowMin(a) - rowMin(b) || quoteDuration(a.sample) - quoteDuration(b.sample);
  });

  // with an infant on the request, the SHORTEST trip is recommended
  var recRow = null;
  if (infant) {
    recRow = flightRows.reduce(function (bestR, r) {
      return (!bestR || quoteDuration(r.sample) < quoteDuration(bestR.sample)) ? r : bestR;
    }, null);
  }
  if (recNote) {
    if (infant && recRow) {
      recNote.style.display = "";
      recNote.innerHTML = '<span class="rec-ic">👶</span><span><b>Infant traveller</b> (age &le; 5) on this request &mdash; ' +
        'the <b>shortest trip</b> (' + fmtDur(quoteDuration(recRow.sample)) + ') is recommended, marked below.</span>';
    } else {
      recNote.style.display = "none";
      recNote.innerHTML = "";
    }
  }

  // header: fixed flight columns + one column per vendor.
  // Widths are percentages that always total 100% (table-layout:fixed) so the grid
  // fits the page width instead of scrolling — the vendor columns share whatever the
  // fixed flight columns leave over.
  // Fixed flight columns are kept compact (they wrap) so the vendor columns stay
  // roomy — the vendor columns are NOT squeezed to make room.
  var fixedCols = [
    ["Airline", 9], ["Flight No", 8], ["Departure", 9],
    ["From", 11], ["To", 11], ["Travel Time", 6], ["Layover", 5]
  ];
  var fixedTotal = fixedCols.reduce(function (t, c) { return t + c[1]; }, 0); // 59
  var vw = (100 - fixedTotal) / vendors.length; // each vendor column's %
  head.innerHTML = "<tr>" +
    fixedCols.map(function (c) { return '<th style="width:' + c[1] + '%">' + c[0] + "</th>"; }).join("") +
    vendors.map(function (v) { return '<th class="vhead" style="width:' + vw.toFixed(3) + '%">' + esc(v) + "</th>"; }).join("") +
    "</tr>";

  // body: one row per DIRECTION (outbound / return) so per-direction Travel Time is
  // shown on its own — not summed. The vendor fare (a round-trip total) spans the
  // itinerary's direction rows via rowspan.
  body.innerHTML = flightRows.map(function (r) {
    var q = r.sample, min = rowMin(r);
    var dirs = directions(q);
    var span = Math.max(dirs.length, 1);

    // vendor cells — one per vendor, spanning all direction rows of this itinerary
    var vcells = vendors.map(function (v) {
      var vq = r.byVendor[v];
      if (!vq) return '<td class="vcell empty" rowspan="' + span + '">—</td>';
      var isLow = vq.total === min;
      return '<td class="vcell' + (isLow ? " vbest" : "") + '" rowspan="' + span + '">' +
        (isLow ? '<span class="vbest-tag">Lowest</span>' : "") +
        '<div class="vc-fare">' + CURRENCY.format(vq.total) + "</div>" +
        (vq.status ? '<span class="status-pill ' + statusClass(vq.status) + '">' + esc(vq.status) + "</span>" : "") +
        (canApprove(vq) ? '<button class="btn-approve' + (isLow ? " green" : "") + '" type="button" data-id="' + esc(vq.id) + '">Approve</button>' : "") +
        "</td>";
    }).join("");

    // no ticket legs at all — single fallback row
    if (!dirs.length) {
      return "<tr>" +
        "<td class='strong'>" + esc(q.airline || "—") + "</td>" +
        '<td class="cell-fn">—</td><td class="dur-cell">—</td>' +
        "<td>" + wrapName(q.source.city || "—") + "</td>" +
        "<td>" + wrapName(q.destination.city || "—") + "</td>" +
        "<td class='dur-cell'>—</td><td class='dur-cell'>—</td>" + vcells + "</tr>";
    }

    var isRec = infant && r === recRow; // the recommended (shortest) itinerary

    return dirs.map(function (d, di) {
      var s = dirSummary(d.segs);
      var isRet = d.dir === "ret";
      var badge = isRet ? "RETURN" : "OUTBOUND";
      var nos = d.segs.map(function (seg) { return esc(seg.flightNo); }).filter(Boolean).join(" · ") || "—";
      var lay = dirLayoverMins(d.segs);      // layover computed from the flight times
      var dur = dirDurationMins(d.segs);     // timezone-corrected end-to-end travel time
      var cls = [];
      if (di < dirs.length - 1) cls.push("dir-mid"); // dashed divider between the two directions
      if (isRec) cls.push("rec-row");
      var rowCls = cls.length ? ' class="' + cls.join(" ") + '"' : "";
      var recTag = (isRec && di === 0) ? '<span class="rec-tag">★ Recommended</span>' : "";

      var fixed =
        "<td class='strong'>" + recTag + "<span class='dirtag " + (isRet ? "ret" : "out") + "'>" + badge + "</span><br>" + esc(q.airline || "—") + "</td>" +
        '<td class="cell-fn">' + nos + "</td>" +
        "<td class='dur-cell'>" + twoLineDT(d.segs[0].dep) + "</td>" +
        "<td>" + wrapName(s.from.city || "—") + "</td>" +
        "<td>" + wrapName(s.to.city || "—") + "</td>" +
        "<td class='dur-cell strong'>" + fmtDur(dur) + "</td>" +
        "<td class='dur-cell'>" + fmtDur(lay) + "</td>";

      return "<tr" + rowCls + ">" + fixed + (di === 0 ? vcells : "") + "</tr>";
    }).join("");
  }).join("");
}

/* =====================================================================
   6. EVENTS
===================================================================== */
document.getElementById("selStatus").addEventListener("change", function () {
  userChangedStatus = true; // stop auto-defaulting once the user picks a status
  buildRequestCards(); // the request cards shown depend on the selected status
  render();
});
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

// sort buttons above the comparison table (Lowest fare / Fastest)
document.getElementById("sortBar").addEventListener("click", function (ev) {
  var btn = ev.target.closest(".sort-btn");
  if (!btn) return;
  tableSort = btn.getAttribute("data-sort"); // syncSortButtons() (in render) reflects it
  render();
});
