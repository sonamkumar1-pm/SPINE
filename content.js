(() => {
  "use strict";

  /* ==========================================================================
     Constants
     ========================================================================== */
  const PUNCH_PANEL_ID = "spine-punch-hours-summary";
  const LATE_BANNER_ID = "spine-late-banner";
  const ALLOWED_GRACE_MINUTES = 45;
  const PENDING_SWIPE_KEY = "spine_pending_swipe";
  const PENDING_SWIPE_TTL_MS = 15 * 60 * 1000;
  const DEFAULT_REASON = "Late mark regularization (${mins}m late on ${date}) - Swipe missed";

  // Elements injected by this script; DOM mutations inside them must not trigger a re-render
  const OWN_NODE_SELECTOR = [
    `#${PUNCH_PANEL_ID}`,
    `#${LATE_BANNER_ID}`,
    "#spine-toast",
    "#spine-apply-swipe-dialog-overlay",
    "#spine-page-autofill-banner",
    ".sp-date-swipe-pill",
    ".sp-apply-swipe-tag"
  ].join(", ");

  let renderTimer = null;
  let tickInterval = null;
  let observerStarted = false;
  let activeMutationObserver = null;
  let isRunning = false;
  let latestPunchResult = null;

  /* ==========================================================================
     Formatting & Parsing Utilities
     ========================================================================== */
  function norm(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  // Escapes page-derived text before it is interpolated into innerHTML
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  // Writes only when the text changes, so the 1s tick doesn't churn the DOM
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function nowMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function applyTemplate(template, ctx) {
    return (template || DEFAULT_REASON)
      .replace(/\$\{mins\}/g, String(ctx.lateMinutes ?? ""))
      .replace(/\$\{date\}/g, String(ctx.rawDate ?? ""))
      .replace(/\$\{late\}/g, String(ctx.rawLate ?? ""));
  }

  function storageArea(area) {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage[area] ? chrome.storage[area] : null;
  }

  function clearPendingSwipe() {
    try {
      sessionStorage.removeItem(PENDING_SWIPE_KEY);
    } catch (_) {}
    storageArea("local")?.remove(PENDING_SWIPE_KEY);
  }

  function fmt(mins) {
    const total = Math.max(0, Math.floor(Number(mins) || 0));
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
  }

  function parseMinutes(timeStr) {
    const s = norm(timeStr).toUpperCase();
    const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (!m) return null;

    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const mer = m[3];

    if (Number.isNaN(h) || Number.isNaN(min) || h < 1 || h > 12 || min < 0 || min > 59) {
      return null;
    }

    if (mer === "AM" && h === 12) h = 0;
    if (mer === "PM" && h !== 12) h += 12;

    return h * 60 + min;
  }

  function to12Hour(totalMinutes) {
    let mins = ((totalMinutes % 1440) + 1440) % 1440;
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const mer = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${mer}`;
  }

  /* Universal Late HRS Parser */
  function parseLateValueToMinutes(raw) {
    if (raw == null) return 0;
    const s = String(raw).replace(/\s+/g, " ").trim();
    if (!s || s === "-" || s === "--" || s === "N/A" || s === "nil" || s === "0" || s === "0.00" || s === "00:00" || s === "0:00") {
      return 0;
    }

    // Text format "1h 20m", "45m", "20 mins"
    const textMatch = s.match(/(?:(\d+)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?/i);
    if (textMatch && (textMatch[1] || textMatch[2])) {
      const h = parseInt(textMatch[1] || "0", 10);
      const m = parseInt(textMatch[2] || "0", 10);
      if (h > 0 || m > 0) return h * 60 + m;
    }

    // Colon format "00:21", "1:15"
    const colonMatch = s.match(/^(\d{1,2}):(\d{2})$/);
    if (colonMatch) {
      return parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10);
    }

    // Dot format "0.21" -> 21m, "0.06" -> 6m, "1.15" -> 75m, "3.01" -> 181m
    const dotTwoMatch = s.match(/^(\d+)\.(\d{2})$/);
    if (dotTwoMatch) {
      const h = parseInt(dotTwoMatch[1], 10);
      const m = parseInt(dotTwoMatch[2], 10);
      if (m < 60) return h * 60 + m;
      return Math.round((h + m / 100) * 60);
    }

    // Single decimal "0.5" -> 30m
    const dotOneMatch = s.match(/^(\d+)\.(\d{1})$/);
    if (dotOneMatch) {
      return Math.round(parseFloat(s) * 60);
    }

    // Arbitrary float
    if (/^\d+\.\d+$/.test(s)) {
      return Math.round(parseFloat(s) * 60);
    }

    // Plain integer "21" -> 21m
    const intMatch = s.match(/^(\d+)$/);
    if (intMatch) {
      return parseInt(intMatch[1], 10);
    }

    return 0;
  }

  /* ==========================================================================
     FEATURE 1: Daily Punch Summary Panel (Purana In/Out Flow)
     ========================================================================== */
  function getHeaderCells(table) {
    const headerRow = table.querySelector("tr");
    if (!headerRow) return [];
    return Array.from(headerRow.querySelectorAll("th, td")).map(el => norm(el.innerText));
  }

  function isPunchTable(table) {
    const headers = getHeaderCells(table);
    if (headers.length < 4) return false;

    const joined = headers.join("|").toLowerCase();
    return (
      joined.includes("date") &&
      joined.includes("entry time") &&
      joined.includes("in/out") &&
      joined.includes("ip address")
    );
  }

  function findPunchTable() {
    const tables = Array.from(document.querySelectorAll("table"));
    let bodyHasShiftTime = null; // body text is expensive to read, so read it at most once

    for (const table of tables) {
      if (!isPunchTable(table)) continue;
      if (!table.textContent.includes("Web Attendance Api")) continue;

      const aroundText = norm(
        (table.parentElement?.innerText || "") + " " +
        (table.parentElement?.previousElementSibling?.innerText || "") + " " +
        (table.previousElementSibling?.innerText || "")
      );

      if (!aroundText.includes("Daily In Out Punch") && bodyHasShiftTime === null) {
        bodyHasShiftTime = document.body.textContent.includes("Shift [GS] Time");
      }

      if (aroundText.includes("Daily In Out Punch") || bodyHasShiftTime) {
        return table;
      }
    }

    return null;
  }

  function extractPunchRows(table) {
    const rows = [];
    const trList = Array.from(table.querySelectorAll("tr"));

    for (const tr of trList) {
      const cells = Array.from(tr.querySelectorAll("td")).map(td => norm(td.innerText));
      if (cells.length < 3) continue;

      const [date, entryTime, inOut] = cells;
      const dir = (inOut || "").toUpperCase();

      if (!date || !entryTime || !["IN", "OUT"].includes(dir)) continue;
      rows.push({ date, entryTime, dir });
    }

    return rows;
  }

  function uniquePunchRows(rows) {
    const seen = new Set();
    return rows.filter(row => {
      const key = `${row.date}|${row.entryTime}|${row.dir}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function calculatePunch(rows) {
    const cleanRows = uniquePunchRows(rows);

    const result = {
      inMinutes: 0,
      outMinutes: 0,
      openInMinutes: 0,
      totalInPlusOpen: 0,
      estimatedCompletionMinute: null,
      details: [],
      warnings: [],
      rawCount: rows.length,
      uniqueCount: cleanRows.length,
      lastOpenInTime: null
    };

    if (!cleanRows.length) {
      result.warnings.push("No valid rows found.");
      return result;
    }

    for (let i = 0; i < cleanRows.length - 1; i++) {
      const current = cleanRows[i];
      const next = cleanRows[i + 1];

      const currentMin = parseMinutes(current.entryTime);
      const nextMin = parseMinutes(next.entryTime);

      if (currentMin == null || nextMin == null) {
        result.warnings.push(`Invalid pair: ${current.entryTime} -> ${next.entryTime}`);
        continue;
      }

      const diff = nextMin - currentMin;

      if (diff < 0) {
        result.warnings.push(`Invalid sequence: ${current.entryTime} -> ${next.entryTime}`);
        continue;
      }

      if (current.dir === "IN" && next.dir === "OUT") {
        result.inMinutes += diff;
        result.details.push(`In: ${current.entryTime} → ${next.entryTime} = ${fmt(diff)}`);
      } else if (current.dir === "OUT" && next.dir === "IN") {
        result.outMinutes += diff;
        result.details.push(`Out: ${current.entryTime} → ${next.entryTime} = ${fmt(diff)}`);
      } else {
        result.warnings.push(`Unexpected sequence: ${current.dir} -> ${next.dir} at ${current.entryTime} -> ${next.entryTime}`);
      }
    }

    const lastRow = cleanRows[cleanRows.length - 1];
    if (lastRow && lastRow.dir === "IN") {
      const current = nowMinutes();
      const lastMinutes = parseMinutes(lastRow.entryTime);

      result.lastOpenInTime = lastRow.entryTime;

      if (lastMinutes != null && current >= lastMinutes) {
        result.openInMinutes = current - lastMinutes;
        result.warnings.push(`Open In since ${lastRow.entryTime} = ${fmt(result.openInMinutes)}`);
      } else {
        result.warnings.push(`Open In at ${lastRow.entryTime}`);
      }
    } else if (lastRow) {
      result.warnings.push(`Last punch is ${lastRow.dir} at ${lastRow.entryTime}`);
    }

    result.totalInPlusOpen = result.inMinutes + result.openInMinutes;

    const remainingFor8Hours = 480 - result.inMinutes;
    if (result.lastOpenInTime) {
      const openStartMin = parseMinutes(result.lastOpenInTime);
      if (openStartMin != null) {
        result.estimatedCompletionMinute = openStartMin + Math.max(0, remainingFor8Hours);
      }
    }

    return result;
  }

  function ensurePunchPanel() {
    let panel = document.getElementById(PUNCH_PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PUNCH_PANEL_ID;
    panel.innerHTML = `
      <div class="sp-card">
        <div class="sp-title">Attendance Hours Summary</div>
        <div class="sp-grid">
          <div class="sp-box">
            <div class="sp-label">Total In Hours</div>
            <div class="sp-value" data-role="in">0h 0m</div>
          </div>
          <div class="sp-box">
            <div class="sp-label">Total Out Hours</div>
            <div class="sp-value" data-role="out">0h 0m</div>
          </div>
          <div class="sp-box">
            <div class="sp-label">Open In Since</div>
            <div class="sp-value" data-role="open-in">0h 0m</div>
          </div>
          <div class="sp-box">
            <div class="sp-label">Total In + Open</div>
            <div class="sp-value" data-role="total-open">0h 0m</div>
          </div>
          <div class="sp-box">
            <div class="sp-label">Estimated 8 Hours Completion</div>
            <div class="sp-value small" data-role="completion-time">--</div>
            <div class="sp-sub" data-role="completion-timer">--</div>
          </div>
          <div class="sp-box">
            <div class="sp-label">Rows Summary</div>
            <div class="sp-value small" data-role="rows">0 / 0</div>
            <div class="sp-sub" data-role="meta-note">raw / unique</div>
          </div>
        </div>
        <div class="sp-meta" data-role="meta">Waiting for punch table...</div>
        <details>
          <summary>Show details</summary>
          <div data-role="details"></div>
          <div data-role="warnings"></div>
        </details>
      </div>
    `;
    return panel;
  }

  function updateCompletionUI(panel, result) {
    const completionTimeEl = panel.querySelector('[data-role="completion-time"]');
    const completionTimerEl = panel.querySelector('[data-role="completion-timer"]');

    if (!completionTimeEl || !completionTimerEl) return;

    if (result.estimatedCompletionMinute == null) {
      for (const el of [completionTimeEl, completionTimerEl]) el.classList.remove("sp-good", "sp-bad");
      setText(completionTimeEl, "--");
      setText(completionTimerEl, "Need an open IN punch");
      return;
    }

    const diff = result.estimatedCompletionMinute - nowMinutes();
    const done = diff <= 0;

    for (const el of [completionTimeEl, completionTimerEl]) {
      el.classList.toggle("sp-good", done);
      el.classList.toggle("sp-bad", !done);
    }
    setText(completionTimeEl, to12Hour(result.estimatedCompletionMinute));
    setText(completionTimerEl, done ? `Completed by ${fmt(-diff)} ago` : `${fmt(diff)} remaining`);
  }

  function renderPunchSummary() {
    const table = findPunchTable();
    if (!table) return;

    const panel = ensurePunchPanel();
    if (panel.parentElement !== table.parentElement) {
      panel.remove();
      table.parentElement.insertBefore(panel, table);
    }

    const rows = extractPunchRows(table);
    const result = calculatePunch(rows);
    latestPunchResult = result;

    const q = role => panel.querySelector(`[data-role="${role}"]`);

    setText(q("in"), fmt(result.inMinutes));
    setText(q("out"), fmt(result.outMinutes));
    setText(q("open-in"), fmt(result.openInMinutes || 0));
    setText(q("total-open"), fmt(result.totalInPlusOpen || 0));
    setText(q("rows"), `${result.rawCount} / ${result.uniqueCount}`);
    setText(q("meta"), `Rows found: ${result.rawCount}, unique rows used: ${result.uniqueCount}`);

    const linesHtml = (lines, cls, empty) => lines.length
      ? lines.map(line => `<div class="${cls}">${esc(line)}</div>`).join("")
      : `<div class="sp-line">${empty}</div>`;

    const detailsEl = q("details");
    const warningsEl = q("warnings");
    const detailsHtml = linesHtml(result.details, "sp-line", "No valid sessions found.");
    const warningsHtml = linesHtml(result.warnings, "sp-line sp-warning", "No warnings.");
    if (detailsEl && detailsEl.innerHTML !== detailsHtml) detailsEl.innerHTML = detailsHtml;
    if (warningsEl && warningsEl.innerHTML !== warningsHtml) warningsEl.innerHTML = warningsHtml;

    updateCompletionUI(panel, result);
    startTicking(panel);
  }

  function startTicking(panel) {
    clearInterval(tickInterval);

    const openInEl = panel.querySelector('[data-role="open-in"]');
    const totalOpenEl = panel.querySelector('[data-role="total-open"]');
    const openStart = latestPunchResult?.lastOpenInTime ? parseMinutes(latestPunchResult.lastOpenInTime) : null;

    tickInterval = setInterval(() => {
      if (!latestPunchResult || !panel.isConnected) return;

      const current = nowMinutes();
      if (openStart != null && current >= openStart) {
        latestPunchResult.openInMinutes = current - openStart;
        latestPunchResult.totalInPlusOpen = latestPunchResult.inMinutes + latestPunchResult.openInMinutes;
        setText(openInEl, fmt(latestPunchResult.openInMinutes));
        setText(totalOpenEl, fmt(latestPunchResult.totalInPlusOpen));
      }

      updateCompletionUI(panel, latestPunchResult);
    }, 1000);
  }

  /* ==========================================================================
     FEATURE 2: Late Hours Detection & Greedy Highlighting
     ========================================================================== */

  // Helper: Detect if a <tr> is a valid daily attendance row (starts with a date like 01-Oct-26, Mon 01/10/2026, etc.)
  function isDateRow(tr, dateColIdx) {
    const dateCell = tr.cells[dateColIdx] || tr.cells[0];
    if (!dateCell) return false;
    const txt = (dateCell.innerText || "").trim();
    // Ignore non-data / total rows
    if (/^(total|sub\s*total|summary|grand\s*total)/i.test(txt)) return false;
    // Match date formats with or without leading weekday prefixes (e.g. "01-Oct", "Mon, 01-10", "1/10/2026")
    return /^(?:[a-zA-Z]{3,9},?\s*)?\d{1,2}[-/ .]?[a-zA-Z0-9]*/.test(txt);
  }

  function findAttendanceTableAndColumns() {
    const allTables = Array.from(document.querySelectorAll("table"));

    for (const table of allTables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 5) continue; // Must be a monthly attendance table with multiple rows

      // Check rows for header
      let headerTr = null;
      let lateColIndex = -1;
      let dateColIndex = -1;

      for (let r = 0; r < Math.min(5, rows.length); r++) {
        const tr = rows[r];
        const cells = Array.from(tr.querySelectorAll("th, td"));

        for (let c = 0; c < cells.length; c++) {
          const text = (cells[c].innerText || "").replace(/\s+/g, " ").trim().toLowerCase();

          // Target "Late HRS." column strictly, avoiding "Acc Late Hrs"
          if (lateColIndex === -1 && text.includes("late") && !text.includes("acc")) {
            lateColIndex = c;
          }

          // Target "Date" column
          if (dateColIndex === -1 && (text === "date" || text.includes("att date") || text === "dt")) {
            dateColIndex = c;
          }
        }

        if (lateColIndex !== -1) {
          headerTr = tr;
          break;
        }
      }

      // If we found a table with "Late HRS." header and multiple date rows:
      if (lateColIndex !== -1) {
        if (dateColIndex === -1) dateColIndex = 0;

        // Verify that data rows actually exist under this table
        const dateRows = rows.filter(tr => isDateRow(tr, dateColIndex));
        if (dateRows.length >= 3) {
          return {
            table,
            headerTr,
            lateColIndex,
            dateColIndex,
            dateRows
          };
        }
      }
    }

    // Secondary scan: Find any table where column 0 has dates and another column has decimal numbers (e.g. 0.21, 0.27)
    for (const table of allTables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 10) continue;

      const dateRows = rows.filter(tr => isDateRow(tr, 0));
      if (dateRows.length < 5) continue;

      // Scan each column index (skipping the date column) to find one holding h.mm late values
      const sampleRow = dateRows[0];
      for (let c = 1; c < sampleRow.cells.length; c++) {
        const values = dateRows.map(r => (r.cells[c]?.textContent || "").trim());
        const decimals = values.filter(v => /^\d+\.\d{2}$/.test(v));

        // Late values are mostly 0.00 with a few small non-zero entries (e.g. 0.21), never whole shifts
        const nonZero = decimals.filter(v => v !== "0.00");
        const looksLikeLate = nonZero.length > 0 &&
          nonZero.length < decimals.length &&
          nonZero.every(v => parseFloat(v) < 5);

        if (decimals.length >= dateRows.length * 0.7 && looksLikeLate) {
          console.log(`🎯 [Spine Helper] Verified Late HRS column via content matching at index: ${c}`);
          return {
            table,
            headerTr: null,
            lateColIndex: c,
            dateColIndex: 0,
            dateRows
          };
        }
      }
    }

    return null;
  }

  /* ==========================================================================
     FEATURE 3: Apply Swipe Quick Dialog & Redirect Auto-Fill
     ========================================================================== */
  let cachedDefaultReason = DEFAULT_REASON;
  let cachedApplySwipeUrl = "";

  function showToast(message, type = "info") {
    let toast = document.getElementById("spine-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "spine-toast";
      document.body.appendChild(toast);
    }
    toast.className = `spine-toast spine-toast-${type} spine-toast-show`;
    toast.innerHTML = `<span class="spine-toast-icon">⚡</span><span class="spine-toast-msg">${message}</span>`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove("spine-toast-show");
    }, 4500);
  }

  function extractRowTimes(tr) {
    if (!tr) return { shiftIn: "10:30 AM", shiftOut: "07:30 PM", actualIn: "", actualOut: "" };
    const cells = Array.from(tr.querySelectorAll("td, th")).map(c => norm(c.innerText));
    const timeRegex = /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi;
    const foundTimes = [];
    
    for (const cell of cells) {
      const matches = cell.match(timeRegex);
      if (matches) {
        matches.forEach(m => foundTimes.push(m.trim()));
      }
    }

    return {
      shiftIn: foundTimes[0] || "10:30 AM",
      shiftOut: foundTimes[1] || "07:30 PM",
      actualIn: foundTimes[2] || "",
      actualOut: foundTimes[3] || ""
    };
  }

  function openApplySwipeDialog(rowData) {
    const { rawDate, rawLate, lateMinutes, tr } = rowData;
    const times = extractRowTimes(tr);

    document.getElementById("spine-apply-swipe-dialog-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "spine-apply-swipe-dialog-overlay";
    overlay.className = "sp-dialog-overlay";

    const defaultComment = applyTemplate(cachedDefaultReason, rowData);
    const safe = {
      date: esc(rawDate),
      late: esc(rawLate),
      shiftIn: esc(times.shiftIn),
      shiftOut: esc(times.shiftOut),
      actualIn: esc(times.actualIn || "--")
    };

    overlay.innerHTML = `
      <div class="sp-dialog-card">
        <div class="sp-dialog-header">
          <div class="sp-dialog-title">
            <span class="sp-dialog-icon">⚡</span>
            <span>Apply Swipe Regularization</span>
          </div>
          <button type="button" class="sp-dialog-close-btn" id="spDialogClose" title="Close">&times;</button>
        </div>

        <div class="sp-dialog-body">
          <div class="sp-dialog-summary-box">
            <div class="sp-summary-item">
              <span class="sp-summary-label">Date Selected</span>
              <span class="sp-summary-val" id="spDialogDate">${safe.date}</span>
            </div>
            <div class="sp-summary-item">
              <span class="sp-summary-label">Late Duration</span>
              <span class="sp-summary-val" style="color: #ea580c;">${safe.late} (${lateMinutes} mins)</span>
            </div>
            <div class="sp-summary-item">
              <span class="sp-summary-label">Shift Hours</span>
              <span class="sp-summary-val">${safe.shiftIn} - ${safe.shiftOut}</span>
            </div>
            <div class="sp-summary-item">
              <span class="sp-summary-label">Punched In At</span>
              <span class="sp-summary-val">${safe.actualIn}</span>
            </div>
          </div>

          <!-- Swipe Type Selection -->
          <div class="sp-dialog-field">
            <label class="sp-field-label">Choose Type of Swipe to Apply:</label>
            <div class="sp-type-pill-group" id="spTypePills">
              <label class="sp-type-pill active">
                <input type="radio" name="spSwipeType" value="IN" checked>
                <span>In Swipe (${safe.shiftIn})</span>
              </label>
              <label class="sp-type-pill">
                <input type="radio" name="spSwipeType" value="OUT">
                <span>Out Swipe (${safe.shiftOut})</span>
              </label>
              <label class="sp-type-pill">
                <input type="radio" name="spSwipeType" value="BOTH">
                <span>Both In & Out</span>
              </label>
              <label class="sp-type-pill">
                <input type="radio" name="spSwipeType" value="LATE">
                <span>Late Regularization</span>
              </label>
            </div>
          </div>

          <!-- Comment / Reason -->
          <div class="sp-dialog-field">
            <label class="sp-field-label" for="spDialogComment">Comment / Reason to Add:</label>
            <textarea id="spDialogComment" class="sp-dialog-textarea" rows="2" placeholder="Enter reason for regularization...">${esc(defaultComment)}</textarea>
            <div class="sp-field-hint">You can freely edit or type your remarks before redirecting.</div>
          </div>

          <!-- Apply Swipe Page URL (Uses user-provided URL) -->
          <div class="sp-dialog-field" id="spUrlFieldRow">
            <label class="sp-field-label" for="spApplySwipeUrlInput">Apply Swipe Page URL:</label>
            <input 
              type="text" 
              id="spApplySwipeUrlInput" 
              class="sp-dialog-input" 
              value="${esc(cachedApplySwipeUrl)}" 
              placeholder="Paste your portal's Apply Swipe URL (e.g. https://.../SwipeRequestList.aspx?mnusr=...)"
            >
            <div class="sp-field-hint">Paste your portal's Apply Swipe URL. Saved automatically and reused for all future requests.</div>
          </div>
        </div>

        <div class="sp-dialog-footer">
          <button type="button" class="sp-btn sp-btn-secondary" id="spDialogCopyBtn">📋 Copy Details</button>
          <button type="button" class="sp-btn sp-btn-primary" id="spDialogRedirectBtn">🚀 Redirect to Apply Swipe & Auto-Fill</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Pill active toggle styling
    const pillInputs = overlay.querySelectorAll('input[name="spSwipeType"]');
    pillInputs.forEach(input => {
      input.addEventListener("change", () => {
        overlay.querySelectorAll(".sp-type-pill").forEach(p => p.classList.remove("active"));
        input.closest(".sp-type-pill")?.classList.add("active");
      });
    });

    // Close handlers
    const closeDialog = () => overlay.remove();
    overlay.querySelector("#spDialogClose")?.addEventListener("click", closeDialog);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeDialog();
    });

    // Copy Button
    overlay.querySelector("#spDialogCopyBtn")?.addEventListener("click", () => {
      const selectedType = overlay.querySelector('input[name="spSwipeType"]:checked')?.value || "IN";
      const comment = overlay.querySelector("#spDialogComment")?.value || "";
      const text = `Date: ${rawDate}\nLate: ${rawLate} (${lateMinutes}m)\nSwipe Type: ${selectedType}\nComment: ${comment}`;
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .then(
          () => showToast("✓ Details copied to clipboard!", "success"),
          () => showToast("Couldn't access the clipboard. Copy the details manually.", "warning")
        );
    });

    // Redirect & Auto-Fill Button
    overlay.querySelector("#spDialogRedirectBtn")?.addEventListener("click", () => {
      const selectedType = overlay.querySelector('input[name="spSwipeType"]:checked')?.value || "IN";
      const comment = overlay.querySelector("#spDialogComment")?.value || defaultComment;
      let swipeTime = times.shiftIn;
      if (selectedType === "OUT") swipeTime = times.shiftOut;

      const payload = {
        rawDate,
        date: rawDate,
        lateMinutes,
        rawLate,
        swipeType: selectedType,
        swipeTime,
        comment,
        timestamp: Date.now()
      };

      try {
        sessionStorage.setItem(PENDING_SWIPE_KEY, JSON.stringify(payload));
      } catch (_) {}
      storageArea("local")?.set({ [PENDING_SWIPE_KEY]: payload });

      // Check if native modal is already present or opened via row
      const nativeBtn = findNativeSwipeTrigger(tr);
      if (nativeBtn) {
        showToast(`Opening Apply Swipe for <strong>${safe.date}</strong>...`, "info");
        closeDialog();
        nativeBtn.click();
        watchAndAutoFillModal();
        return;
      }

      // Use user-provided URL from input or cached storage
      const customUrlInput = overlay.querySelector("#spApplySwipeUrlInput");
      const targetUrl = (customUrlInput ? customUrlInput.value.trim() : "") || cachedApplySwipeUrl;

      if (!targetUrl) {
        showToast("Please enter your portal's Apply Swipe URL in the box above!", "warning");
        if (customUrlInput) {
          customUrlInput.focus();
          customUrlInput.style.borderColor = "#ea580c";
        }
        return;
      }

      // Save user-provided URL to storage for future clicks
      cachedApplySwipeUrl = targetUrl;
      storageArea("sync")?.set({ spine_apply_swipe_url: targetUrl });

      showToast(`Redirecting to Apply Swipe for <strong>${safe.date}</strong>...`, "info");
      closeDialog();
      window.location.href = targetUrl;
    });
  }

  function findNativeSwipeTrigger(tr) {
    if (!tr) return null;
    const elements = Array.from(tr.querySelectorAll("a, button, input[type='button'], span[onclick], i[onclick], div[onclick]"));
    for (const el of elements) {
      if (el.classList.contains("sp-date-swipe-pill") || el.classList.contains("sp-apply-swipe-tag")) continue;
      
      const hay = [
        el.innerText || "",
        el.getAttribute("title") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("onclick") || "",
        el.getAttribute("href") || "",
        el.className || ""
      ].join(" ").toLowerCase();

      if (hay.includes("swipe") || hay.includes("regulariz") || hay.includes("apply")) {
        return el;
      }
    }
    return null;
  }

  function findOpenModal() {
    const modals = Array.from(document.querySelectorAll(
      ".modal.show, .modal.in, .modal[style*='display: block'], [role='dialog']:not([aria-hidden='true']), .ui-dialog:not([style*='display: none']), div[id*='modal' i]:not([style*='display: none']), div[id*='swipe' i]:not([style*='display: none']), div[id*='regulariz' i]:not([style*='display: none'])"
    ));

    for (const m of modals) {
      const rect = m.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 80) {
        return m;
      }
    }
    return null;
  }

  function fillModalForm(modal, context) {
    if (!modal || !context) return false;
    let filledCount = 0;
    const reasonText = context.comment || applyTemplate(cachedDefaultReason, context);

    const textFields = Array.from(modal.querySelectorAll("textarea, input[type='text'], input:not([type])"));
    for (const field of textFields) {
      const fieldId = (field.id || field.name || field.placeholder || "").toLowerCase();
      if (fieldId.includes("date") || fieldId.includes("time") || field.readOnly) continue;

      if (
        field.tagName === "TEXTAREA" ||
        fieldId.includes("reason") ||
        fieldId.includes("remark") ||
        fieldId.includes("desc") ||
        fieldId.includes("comment") ||
        fieldId.includes("narration")
      ) {
        field.value = reasonText;
        field.dataset.spineAutofilled = "true";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        field.dispatchEvent(new Event("blur", { bubbles: true }));
        filledCount++;
        break;
      }
    }

    const selects = Array.from(modal.querySelectorAll("select"));
    for (const select of selects) {
      if (select.disabled) continue;
      const options = Array.from(select.options);
      let targetOption = null;

      const keywords = ["late", "swipe", "missed", "technical", "delay", "forgot", "punch"];
      for (const kw of keywords) {
        targetOption = options.find(opt => (opt.text || "").toLowerCase().includes(kw));
        if (targetOption) break;
      }

      if (targetOption && select.value !== targetOption.value) {
        select.value = targetOption.value;
        select.dataset.spineAutofilled = "true";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        filledCount++;
      }
    }

    return filledCount > 0;
  }

  function watchAndAutoFillModal() {
    let attempts = 0;
    const maxAttempts = 20;

    const timer = setInterval(() => {
      attempts++;
      const modal = findOpenModal();

      if (modal) {
        clearInterval(timer);
        let pending = null;
        try {
          pending = JSON.parse(sessionStorage.getItem(PENDING_SWIPE_KEY));
        } catch (_) {}
        if (fillModalForm(modal, pending || {})) {
          clearPendingSwipe(); // consumed here, so the redirect page must not fill it again
          showToast("✓ Auto-filled swipe details!", "success");
        }
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
      }
    }, 250);
  }

  /* ==========================================================================
     Auto-Fill Logic on Destination Apply Swipe Page (AddSwipeRequest.aspx)
     ========================================================================== */
  let addButtonClicked = false;

  function findFieldByLabel(labelRegex, selector = "input, select, textarea") {
    const candidates = Array.from(document.querySelectorAll("label, td, th, span, div"));
    for (const el of candidates) {
      // Must be a small text node / direct label, not the whole page container
      if (el.children.length > 3) continue;
      const text = (el.innerText || "").trim().toLowerCase();
      if (labelRegex.test(text)) {
        if (el.tagName === "LABEL") {
          const forId = el.getAttribute("for");
          if (forId) {
            const target = document.getElementById(forId);
            if (target && target.matches(selector)) return target;
          }
        }

        const sibling = el.nextElementSibling;
        if (sibling) {
          if (sibling.matches(selector)) return sibling;
          const inside = sibling.querySelector(selector);
          if (inside) return inside;
        }

        const td = el.closest("td");
        if (td && td.nextElementSibling) {
          const field = td.nextElementSibling.querySelector(selector);
          if (field) return field;
        }

        const parent = el.parentElement;
        if (parent) {
          const field = parent.querySelector(selector);
          if (field && field !== el) return field;
        }
      }
    }
    return null;
  }

  function findAddNewSwipeButton() {
    const candidates = Array.from(document.querySelectorAll(
      "input[type='submit'], input[type='button'], button, a.btn, a[id*='Add' i], a[id*='Apply' i], input[id*='Add' i], input[id*='Apply' i], a"
    ));
    for (const el of candidates) {
      if (el.classList.contains("sp-date-swipe-pill") || el.classList.contains("sp-banner-btn")) continue;
      const text = (el.value || el.innerText || el.title || "").toLowerCase().trim();
      const id = (el.id || "").toLowerCase();
      if (
        text === "add" ||
        text === "add new" ||
        text === "add request" ||
        text === "apply" ||
        text === "apply swipe" ||
        text.includes("add new") ||
        id.includes("btnadd") ||
        id.includes("btnapply") ||
        id.includes("lnkadd") ||
        id.includes("btnnew")
      ) {
        return el;
      }
    }
    return null;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function formatSpineDate(rawDate) {
    const m = String(rawDate).match(/(\d{1,2})[-/ .]?([A-Za-z]{3,9}|\d{1,2})[-/ .]?(\d{2,4})/);
    if (!m) return norm(rawDate);

    let mon = m[2];
    if (/^\d+$/.test(mon)) {
      const idx = parseInt(mon, 10) - 1;
      if (idx < 0 || idx > 11) return norm(rawDate);
      mon = MONTHS[idx];
    } else {
      mon = mon.charAt(0).toUpperCase() + mon.slice(1, 3).toLowerCase();
    }

    const day = m[1].padStart(2, "0");
    const yr = m[3].length === 4 ? m[3].slice(2) : m[3];
    return `${day}-${mon}-${yr}`;
  }

  function tryFillApplySwipeForm(payload) {
    if (!payload || !payload.rawDate) return false;

    // 1. Identify Date Input
    // In AddSwipeRequest.aspx: labeled "Request Date" with value e.g. "31-Oct-26"
    const dateInput = findFieldByLabel(/request\s*date/i, "input") ||
      document.querySelector("input[id*='txtRequestDate' i], input[id*='txtDate' i], input[id*='SwipeDate' i], input.datepicker, input[id*='dt' i]");

    // If on SwipeRequestList.aspx and no date input is visible yet, auto-click the "Add New" button!
    if (!dateInput) {
      if (!addButtonClicked) {
        const addBtn = findAddNewSwipeButton();
        if (addBtn) {
          addButtonClicked = true;
          showToast("⚡ Opening Add Swipe Request form...", "info");
          addBtn.click();
        }
      }
      return false;
    }

    // 2. Set Request Date in Spine's "31-Oct-26" format; keep the raw text if it can't be parsed
    const formattedDate = formatSpineDate(payload.rawDate);

    if (dateInput.value !== formattedDate) {
      dateInput.value = formattedDate;
      dateInput.dataset.spineAutofilled = "true";
      dateInput.dispatchEvent(new Event("input", { bubbles: true }));
      dateInput.dispatchEvent(new Event("change", { bubbles: true }));
      dateInput.dispatchEvent(new Event("blur", { bubbles: true }));

      try {
        if (typeof window.$ !== "undefined" && window.$(dateInput).datepicker) {
          window.$(dateInput).datepicker("setDate", formattedDate);
        }
      } catch (_) {}
    }

    // 3. Select Swipe Request Category *
    // In AddSwipeRequest.aspx: dropdown next to "Swipe Request Category *"
    const categorySelect = findFieldByLabel(/category/i, "select") ||
      document.querySelector("select[id*='Category' i], select[id*='ddlCat' i]");

    if (categorySelect && categorySelect.options.length > 1) {
      const opts = Array.from(categorySelect.options);
      // Look for options like "Late", "Swipe Missed", "Technical", "Forgot"
      const keywords = ["late", "swipe", "missed", "technical", "delay", "regulariz", "punch", "duty"];
      let chosenCat = null;
      for (const kw of keywords) {
        chosenCat = opts.find(o => (o.text || "").toLowerCase().includes(kw));
        if (chosenCat) break;
      }
      // Fallback to first non-empty option if none matched
      if (!chosenCat) {
        chosenCat = opts.find(o => o.value && o.value !== "0" && !o.text.toLowerCase().includes("select"));
      }
      if (chosenCat && categorySelect.value !== chosenCat.value) {
        categorySelect.value = chosenCat.value;
        categorySelect.dataset.spineAutofilled = "true";
        categorySelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // 4. Select In/Out Mode
    // In AddSwipeRequest.aspx: dropdown next to "In/Out Mode" with options "In", "Out", "Both"
    const modeSelect = findFieldByLabel(/mode/i, "select") ||
      document.querySelector("select[id*='Mode' i], select[id*='ddlMode' i]");

    if (modeSelect) {
      const opts = Array.from(modeSelect.options);
      const targetModeText = payload.swipeType === "OUT" ? "out" : payload.swipeType === "BOTH" ? "both" : "in";
      const matchedOpt = opts.find(o => (o.text || "").toLowerCase().trim() === targetModeText || (o.value || "").toLowerCase() === targetModeText);
      if (matchedOpt && modeSelect.value !== matchedOpt.value) {
        modeSelect.value = matchedOpt.value;
        modeSelect.dataset.spineAutofilled = "true";
        modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // 5. Fill In Time or Out Time
    const inTimeInput = findFieldByLabel(/in\s*time/i, "input") ||
      document.querySelector("input[id*='txtInTime' i], input[id*='InTime' i]");
    const outTimeInput = findFieldByLabel(/out\s*time/i, "input") ||
      document.querySelector("input[id*='txtOutTime' i], input[id*='OutTime' i]");

    if (payload.swipeType === "IN" && inTimeInput && !inTimeInput.disabled && !inTimeInput.readOnly) {
      if (payload.swipeTime) {
        inTimeInput.value = payload.swipeTime;
        inTimeInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (payload.swipeType === "OUT" && outTimeInput && !outTimeInput.disabled && !outTimeInput.readOnly) {
      if (payload.swipeTime) {
        outTimeInput.value = payload.swipeTime;
        outTimeInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // 6. Fill Reason / Remarks
    // In AddSwipeRequest.aspx: textarea under "Reason *"
    const reasonTextarea = findFieldByLabel(/reason/i, "textarea, input") ||
      document.querySelector("textarea[id*='Reason' i], textarea[id*='Remarks' i], textarea");

    if (reasonTextarea) {
      const targetComment = payload.comment || applyTemplate(cachedDefaultReason, payload);
      if (!reasonTextarea.value || reasonTextarea.dataset.spineAutofilled) {
        reasonTextarea.value = targetComment;
        reasonTextarea.dataset.spineAutofilled = "true";
        reasonTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        reasonTextarea.dispatchEvent(new Event("change", { bubbles: true }));
        reasonTextarea.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }

    // 7. Inject top confirmation banner on page
    if (!document.getElementById("spine-page-autofill-banner")) {
      const banner = document.createElement("div");
      banner.id = "spine-page-autofill-banner";
      banner.className = "sp-page-autofill-banner";
      banner.innerHTML = `
        <span style="font-size: 24px;">⚡</span>
        <div style="flex: 1;">
          <strong>Spine Helper Auto-Filled:</strong> Date <strong>${esc(formattedDate)}</strong> with <strong>${esc(payload.swipeType)} Mode (${esc(payload.swipeTime || "")})</strong> and your remarks! Please review and click <strong>Save</strong>.
        </div>
        <button type="button" class="sp-autofill-refill-btn" id="spPageRefillBtn">Re-fill</button>
      `;
      banner.querySelector("#spPageRefillBtn")?.addEventListener("click", () => {
        tryFillApplySwipeForm(payload);
        showToast("✓ Re-applied auto-fill values!", "success");
      });

      // Insert at the top of the form or content panel
      const container = document.querySelector(".content, #form1, form, .container, body");
      if (container) {
        container.insertBefore(banner, container.firstChild);
      }
    }

    // 8. Highlight the Save Button
    const saveBtn = Array.from(document.querySelectorAll("input[type='submit'], input[type='button'], button, a.btn")).find(
      b => (b.value || b.innerText || "").trim().toLowerCase() === "save"
    );
    if (saveBtn) {
      saveBtn.style.boxShadow = "0 0 0 3px #16a34a, 0 4px 14px rgba(22, 163, 74, 0.4)";
      saveBtn.style.transition = "box-shadow 0.2s ease";
    }

    return true;
  }

  // Auto-fill only runs on the swipe request pages, so a pending payload never makes the helper
  // click "Add"/"Apply" buttons on the attendance page or anywhere else on the portal
  function isApplySwipePage() {
    const here = window.location.pathname.toLowerCase();
    if (here.includes("swipe")) return true;
    try {
      return Boolean(cachedApplySwipeUrl) && new URL(cachedApplySwipeUrl, window.location.href).pathname.toLowerCase() === here;
    } catch (_) {
      return false;
    }
  }

  function processPendingSwipeOnPage(payload) {
    if (!payload || !payload.rawDate) return;
    if (Date.now() - (payload.timestamp || 0) > PENDING_SWIPE_TTL_MS) {
      clearPendingSwipe();
      return;
    }
    if (!isApplySwipePage()) return;

    let attempts = 0;
    const maxAttempts = 15;

    const fillTimer = setInterval(() => {
      attempts++;
      const isFilled = tryFillApplySwipeForm(payload);
      if (isFilled || attempts >= maxAttempts) {
        clearInterval(fillTimer);
        if (isFilled) {
          clearPendingSwipe();
          showToast(`✓ Auto-filled swipe for <strong>${esc(payload.rawDate)}</strong>!`, "success");
        }
      }
    }, 350);
  }

  function checkAndFillApplySwipePage() {
    let pendingRaw = null;
    try {
      pendingRaw = sessionStorage.getItem(PENDING_SWIPE_KEY);
    } catch (_) {}

    if (!pendingRaw) {
      storageArea("local")?.get({ [PENDING_SWIPE_KEY]: null }, (res) => {
        if (res[PENDING_SWIPE_KEY]) {
          processPendingSwipeOnPage(res[PENDING_SWIPE_KEY]);
        }
      });
      return;
    }

    try {
      const payload = JSON.parse(pendingRaw);
      processPendingSwipeOnPage(payload);
    } catch (_) {}
  }

  function clearLateMarkers(root) {
    root.querySelectorAll(".sp-apply-swipe-tag, .sp-date-swipe-pill").forEach(el => el.remove());
    root.querySelectorAll(".spine-late-cell-marker, .sp-covered-by-grace").forEach(el => {
      el.classList.remove("spine-late-cell-marker", "sp-covered-by-grace");
      el.removeAttribute("title");
      el.onclick = null;
    });
    root.querySelectorAll(".sp-late-row-highlight").forEach(el => el.classList.remove("sp-late-row-highlight"));
  }

  function renderLateHoursTracker() {
    const tableInfo = findAttendanceTableAndColumns();
    if (!tableInfo) return;

    const { table, lateColIndex, dateColIndex, dateRows } = tableInfo;

    // 1. Clean up any previous markers
    clearLateMarkers(table);

    // 2. Extract valid data rows
    const dataRows = [];
    for (const tr of dateRows) {
      const lateCell = tr.cells[lateColIndex];
      const dateCell = tr.cells[dateColIndex] || tr.cells[0];
      if (!lateCell) continue;

      const rawLate = norm(lateCell.innerText);
      const rawDate = dateCell ? norm(dateCell.innerText) : "";
      const lateMins = parseLateValueToMinutes(rawLate);

      dataRows.push({
        tr,
        lateCell,
        dateCell,
        rawLate,
        rawDate,
        lateMinutes: lateMins
      });
    }

    if (!dataRows.length) return;

    // 3. Calculate Total Late Minutes
    const totalLateMinutes = dataRows.reduce((sum, r) => sum + r.lateMinutes, 0);
    const totalLateHours = (totalLateMinutes / 60).toFixed(2);
    console.log(`⏱️ [Spine Helper] Attendance Sheet: ${dataRows.length} days | Total Late: ${totalLateMinutes}m (${fmt(totalLateMinutes)})`);

    // 4. Run Greedy Algorithm: Sort rows with late > 0 from largest to lowest
    const rowsWithLate = dataRows.filter(r => r.lateMinutes > 0);
    rowsWithLate.sort((a, b) => b.lateMinutes - a.lateMinutes);

    let currentRemaining = totalLateMinutes;
    const markedRows = new Set();

    if (totalLateMinutes > ALLOWED_GRACE_MINUTES) {
      for (const row of rowsWithLate) {
        if (currentRemaining <= ALLOWED_GRACE_MINUTES) {
          break; // Target <= 45 mins reached! Stop!
        }
        markedRows.add(row);
        currentRemaining -= row.lateMinutes;
      }
    }

    console.log(`🎯 [Spine Helper] Marked ${markedRows.size} days for Apply Swipe (Largest to lowest). Remaining Late: ${currentRemaining}m`);

    // 5. Apply Visual Markers on UI
    for (const row of dataRows) {
      if (row.lateMinutes === 0) continue;

      if (markedRows.has(row)) {
        // HIGHLIGHT: Orange Cell Marker (Matches user screenshot)
        row.lateCell.classList.add("spine-late-cell-marker");
        row.lateCell.title = `⚡ Apply Swipe Required: ${row.rawLate} (${row.lateMinutes} mins late)\nClick to Apply Swipe!`;

        const onSwipeClick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openApplySwipeDialog(row);
        };
        row.lateCell.onclick = onSwipeClick;

        // Add "Apply Swipe" tag inside cell (previous markers were cleared above)
        const tag = document.createElement("span");
        tag.className = "sp-apply-swipe-tag";
        tag.textContent = "Apply Swipe";
        row.lateCell.appendChild(tag);

        // Add "⚡ Apply Swipe" pill in Date column
        if (row.dateCell) {
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "sp-date-swipe-pill";
          pill.textContent = "⚡ Apply Swipe";
          pill.title = `Click to Apply Swipe for ${row.rawDate || "this date"} (${row.rawLate})`;
          pill.onclick = onSwipeClick;
          row.dateCell.appendChild(pill);
        }

        // Highlight Row
        row.tr.classList.add("sp-late-row-highlight");
      } else {
        // Safe: Covered by the 45-minute grace allowance
        row.lateCell.classList.add("sp-covered-by-grace");
        row.lateCell.title = `✅ Late: ${row.rawLate} (${row.lateMinutes} mins) - Covered by 45m grace limit (No swipe needed)`;
        row.lateCell.onclick = null;
      }
    }

    // 6. Display Clean Summary Banner Above Table
    let banner = document.getElementById(LATE_BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = LATE_BANNER_ID;
    }

    if (banner.parentElement !== table.parentElement) {
      banner.remove();
      table.parentElement.insertBefore(banner, table);
    }

    if (totalLateMinutes > ALLOWED_GRACE_MINUTES) {
      const markedList = Array.from(markedRows);
      const markedListStr = markedList
        .map((r, i) => `<button type="button" class="sp-banner-badge sp-banner-btn" data-idx="${i}" title="Click to apply swipe for ${esc(r.rawDate)} (${esc(r.rawLate)})">⚡ ${esc(r.rawDate)}: ${esc(r.rawLate)}</button>`)
        .join(" ");
      const excessMins = totalLateMinutes - ALLOWED_GRACE_MINUTES;

      banner.innerHTML = `
        <div class="sp-banner-main">
          <span class="sp-banner-icon">⏱️</span>
          <span>Total Late: <strong>${fmt(totalLateMinutes)} (${totalLateMinutes} mins / ${totalLateHours} hrs)</strong> | Allowed Grace: <strong>${ALLOWED_GRACE_MINUTES} mins</strong> | Excess to Adjust: <strong>${excessMins} mins</strong></span>
        </div>
        <div class="sp-banner-sub">
          👉 <strong>${markedRows.size} Days Marked for "Apply Swipe" (Largest to Lowest):</strong> ${markedListStr}
          <br>Regularizing these ${markedRows.size} days brings remaining late down to <strong>${currentRemaining} mins (<= ${ALLOWED_GRACE_MINUTES} mins safe)</strong>.
        </div>
      `;

      // Wire interactive click on banner badges
      banner.querySelectorAll(".sp-banner-btn").forEach(btn => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetRow = markedList[Number(btn.dataset.idx)];
          if (targetRow) {
            targetRow.tr.scrollIntoView({ behavior: "smooth", block: "center" });
            openApplySwipeDialog(targetRow);
          }
        };
      });
    } else {
      banner.innerHTML = `
        <div class="sp-banner-main" style="color: #15803d;">
          <span class="sp-banner-icon">✅</span>
          <span>Total Late: <strong>${totalLateMinutes} mins (${fmt(totalLateMinutes)})</strong> | Allowed Grace: <strong>${ALLOWED_GRACE_MINUTES} mins</strong></span>
        </div>
        <div class="sp-banner-sub" style="color: #15803d;">
          Your late hours are completely within the ${ALLOWED_GRACE_MINUTES}-minute allowed grace limit. No swipe regularization required!
        </div>
      `;
    }
  }

  /* ==========================================================================
     Master Render & Event Listeners
     ========================================================================== */
  function render() {
    try {
      renderPunchSummary();
      renderLateHoursTracker();
    } catch (err) {
      console.error("Spine Helper Render Error:", err);
    } finally {
      // Drop the mutations this render just caused (markers on page cells, panel text),
      // otherwise the observer would schedule another render and loop forever
      activeMutationObserver?.takeRecords();
    }
  }

  function isOwnMutation(m) {
    const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
    if (el?.closest(OWN_NODE_SELECTOR)) return true;
    if (m.type !== "childList") return false;

    const nodes = [...m.addedNodes, ...m.removedNodes];
    return nodes.length > 0 && nodes.every(n => n.nodeType === Node.ELEMENT_NODE && n.matches(OWN_NODE_SELECTOR));
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    // Re-render only when the page itself changed, not when one of our own nodes did
    activeMutationObserver = new MutationObserver((mutations) => {
      if (mutations.some(m => !isOwnMutation(m))) scheduleRender();
    });

    activeMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  function onWindowClick() {
    setTimeout(scheduleRender, 250);
  }

  function startHelper() {
    if (isRunning) return;
    isRunning = true;
    console.log(`🚀 [Spine Helper] Active on: ${window.location.hostname}`);
    startObserver();
    scheduleRender();
    checkAndFillApplySwipePage();
    window.addEventListener("load", scheduleRender, { passive: true });
    document.addEventListener("click", onWindowClick, { passive: true });
  }

  function cleanup() {
    if (!isRunning) return;
    if (activeMutationObserver) {
      activeMutationObserver.disconnect();
      activeMutationObserver = null;
    }
    observerStarted = false;
    clearTimeout(renderTimer);
    clearInterval(tickInterval);
    latestPunchResult = null;
    window.removeEventListener("load", scheduleRender);
    document.removeEventListener("click", onWindowClick);
    for (const id of [PUNCH_PANEL_ID, LATE_BANNER_ID, "spine-toast", "spine-apply-swipe-dialog-overlay"]) {
      document.getElementById(id)?.remove();
    }
    clearLateMarkers(document);
    isRunning = false;
  }

  /* ==========================================================================
     Active URL Evaluation & Storage Sync
     ========================================================================== */
  function evaluateActiveState() {
    const matcher = window.SpineUrlMatcher;
    const currentHref = window.location.href;

    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
      // Fallback if storage API is unavailable
      startHelper();
      return;
    }

    chrome.storage.sync.get(
      {
        spine_allowed_patterns: [],
        spine_global_active: false,
        spine_default_reason: "",
        spine_apply_swipe_url: ""
      },
      (items) => {
        if (items.spine_default_reason) {
          cachedDefaultReason = items.spine_default_reason;
        }
        if (items.spine_apply_swipe_url) {
          cachedApplySwipeUrl = items.spine_apply_swipe_url;
        }
        const patterns = items.spine_allowed_patterns || [];
        const isGlobal = Boolean(items.spine_global_active);
        const shouldRun = matcher ? matcher.isMatch(currentHref, patterns, isGlobal) : true;

        if (shouldRun) {
          startHelper();
        } else if (isRunning) {
          console.log("⏸️ [Spine Helper] Deactivating (Site not in active sites list)");
          cleanup();
        }
      }
    );
  }

  // Live updates when user adds/removes URLs in popup or updates settings
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        if (changes.spine_default_reason) {
          cachedDefaultReason = changes.spine_default_reason.newValue || cachedDefaultReason;
        }
        if (changes.spine_apply_swipe_url) {
          cachedApplySwipeUrl = changes.spine_apply_swipe_url.newValue || cachedApplySwipeUrl;
        }
        if (changes.spine_allowed_patterns || changes.spine_global_active) {
          evaluateActiveState();
        }
      }
    });
  }

  evaluateActiveState();
})();
