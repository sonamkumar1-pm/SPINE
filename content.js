(() => {
  "use strict";

  console.log("🚀 [Spine Helper] v1.2.1 initialized");

  /* ==========================================================================
     Constants
     ========================================================================== */
  const PUNCH_PANEL_ID = "spine-punch-hours-summary";
  const LATE_BANNER_ID = "spine-late-banner";
  const ALLOWED_GRACE_MINUTES = 45;

  let renderTimer = null;
  let tickInterval = null;
  let observerStarted = false;
  let latestPunchResult = null;

  /* ==========================================================================
     Formatting & Parsing Utilities
     ========================================================================== */
  function norm(v) {
    return (v || "").replace(/\s+/g, " ").trim();
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

    for (const table of tables) {
      if (!isPunchTable(table)) continue;

      const tableText = norm(table.innerText);
      const aroundText = norm(
        (table.parentElement?.innerText || "") + " " +
        (table.parentElement?.previousElementSibling?.innerText || "") + " " +
        (table.previousElementSibling?.innerText || "")
      );

      if (
        tableText.includes("Web Attendance Api") &&
        (aroundText.includes("Daily In Out Punch") || document.body.innerText.includes("Shift [GS] Time"))
      ) {
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
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const lastMinutes = parseMinutes(lastRow.entryTime);

      result.lastOpenInTime = lastRow.entryTime;

      if (lastMinutes != null && nowMinutes >= lastMinutes) {
        result.openInMinutes = nowMinutes - lastMinutes;
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

    completionTimeEl.classList.remove("sp-good", "sp-bad");
    completionTimerEl.classList.remove("sp-good", "sp-bad");

    if (result.estimatedCompletionMinute == null) {
      completionTimeEl.textContent = "--";
      completionTimerEl.textContent = "Need an open IN punch";
      return;
    }

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const diff = result.estimatedCompletionMinute - nowMinutes;

    completionTimeEl.textContent = to12Hour(result.estimatedCompletionMinute);

    if (diff <= 0) {
      completionTimeEl.classList.add("sp-good");
      completionTimerEl.classList.add("sp-good");
      completionTimerEl.textContent = `Completed by ${fmt(Math.abs(diff))} ago`;
    } else {
      completionTimeEl.classList.add("sp-bad");
      completionTimerEl.classList.add("sp-bad");
      completionTimerEl.textContent = `${fmt(diff)} remaining`;
    }
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

    const inEl = panel.querySelector('[data-role="in"]');
    const outEl = panel.querySelector('[data-role="out"]');
    const openInEl = panel.querySelector('[data-role="open-in"]');
    const totalOpenEl = panel.querySelector('[data-role="total-open"]');
    const rowsEl = panel.querySelector('[data-role="rows"]');
    const metaEl = panel.querySelector('[data-role="meta"]');
    const detailsEl = panel.querySelector('[data-role="details"]');
    const warningsEl = panel.querySelector('[data-role="warnings"]');

    if (inEl) inEl.textContent = fmt(result.inMinutes);
    if (outEl) outEl.textContent = fmt(result.outMinutes);
    if (openInEl) openInEl.textContent = fmt(result.openInMinutes || 0);
    if (totalOpenEl) totalOpenEl.textContent = fmt(result.totalInPlusOpen || 0);
    if (rowsEl) rowsEl.textContent = `${result.rawCount} / ${result.uniqueCount}`;

    if (metaEl) {
      metaEl.textContent = `Rows found: ${result.rawCount}, unique rows used: ${result.uniqueCount}`;
    }

    if (detailsEl) {
      detailsEl.innerHTML = result.details.length
        ? result.details.map(line => `<div class="sp-line">${line}</div>`).join("")
        : `<div class="sp-line">No valid sessions found.</div>`;
    }

    if (warningsEl) {
      warningsEl.innerHTML = result.warnings.length
        ? result.warnings.map(line => `<div class="sp-line sp-warning">${line}</div>`).join("")
        : `<div class="sp-line">No warnings.</div>`;
    }

    updateCompletionUI(panel, result);
    startTicking(panel);
  }

  function startTicking(panel) {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }

    tickInterval = setInterval(() => {
      if (!latestPunchResult || !document.getElementById(PUNCH_PANEL_ID)) return;

      const openInEl = panel.querySelector('[data-role="open-in"]');
      const totalOpenEl = panel.querySelector('[data-role="total-open"]');

      if (latestPunchResult.lastOpenInTime) {
        const openStart = parseMinutes(latestPunchResult.lastOpenInTime);
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        if (openStart != null && nowMinutes >= openStart) {
          latestPunchResult.openInMinutes = nowMinutes - openStart;
          latestPunchResult.totalInPlusOpen = latestPunchResult.inMinutes + latestPunchResult.openInMinutes;

          if (openInEl) openInEl.textContent = fmt(latestPunchResult.openInMinutes);
          if (totalOpenEl) totalOpenEl.textContent = fmt(latestPunchResult.totalInPlusOpen);
        }
      }

      updateCompletionUI(panel, latestPunchResult);
    }, 1000);
  }

  /* ==========================================================================
     FEATURE 2: Late Hours Detection & Greedy Highlighting
     ========================================================================== */

  // Helper: Detect if a <tr> is a valid daily attendance row (starts with a date like 01-Oct-26 or 01/10/2026)
  function isDateRow(tr, dateColIdx) {
    const dateCell = tr.cells[dateColIdx] || tr.cells[0];
    if (!dateCell) return false;
    const txt = (dateCell.innerText || "").trim();
    return /^\d{1,2}[-/ ]?[a-zA-Z0-9]*/.test(txt);
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

      // Scan each column index to find the one with decimal time values
      const sampleRow = dateRows[0];
      for (let c = 0; c < sampleRow.cells.length; c++) {
        // Count how many date rows have values matching ^\d+\.\d{2}$ in column c
        const decimalCount = dateRows.filter(r => {
          const val = (r.cells[c]?.innerText || "").trim();
          return /^\d+\.\d{2}$/.test(val);
        }).length;

        // Check if there are non-zero late values (like 0.21, 0.27)
        const hasNonZeroLate = dateRows.some(r => {
          const val = (r.cells[c]?.innerText || "").trim();
          return val === "0.21" || val === "0.27" || val === "0.24" || val === "0.14" || val === "0.23";
        });

        if (decimalCount >= dateRows.length * 0.7 && hasNonZeroLate) {
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

  function renderLateHoursTracker() {
    const tableInfo = findAttendanceTableAndColumns();
    if (!tableInfo) return;

    const { table, lateColIndex, dateColIndex, dateRows } = tableInfo;

    // 1. Clean up any previous markers
    table.querySelectorAll(".spine-late-cell-marker").forEach(el => {
      el.classList.remove("spine-late-cell-marker");
      el.removeAttribute("title");
    });
    table.querySelectorAll(".sp-apply-swipe-tag").forEach(el => el.remove());
    table.querySelectorAll(".sp-date-swipe-pill").forEach(el => el.remove());
    table.querySelectorAll(".sp-late-row-highlight").forEach(el => {
      el.classList.remove("sp-late-row-highlight");
    });
    table.querySelectorAll(".sp-covered-by-grace").forEach(el => {
      el.classList.remove("sp-covered-by-grace");
      el.removeAttribute("title");
    });

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
        row.lateCell.title = `⚡ Apply Swipe Required: ${row.rawLate} (${row.lateMinutes} mins late)\nApply swipe to adjust this day!`;

        // Add "Apply Swipe" tag inside cell
        if (!row.lateCell.querySelector(".sp-apply-swipe-tag")) {
          const tag = document.createElement("span");
          tag.className = "sp-apply-swipe-tag";
          tag.textContent = "Apply Swipe";
          row.lateCell.appendChild(tag);
        }

        // Add "⚡ Apply Swipe" pill in Date column
        if (row.dateCell && !row.dateCell.querySelector(".sp-date-swipe-pill")) {
          const pill = document.createElement("span");
          pill.className = "sp-date-swipe-pill";
          pill.textContent = "⚡ Apply Swipe";
          pill.title = `Apply swipe for ${row.rawDate || "this date"} (${row.rawLate})`;
          row.dateCell.appendChild(pill);
        }

        // Highlight Row
        row.tr.classList.add("sp-late-row-highlight");
      } else {
        // Safe: Covered by the 45-minute grace allowance
        row.lateCell.classList.add("sp-covered-by-grace");
        row.lateCell.title = `✅ Late: ${row.rawLate} (${row.lateMinutes} mins) - Covered by 45m grace limit (No swipe needed)`;
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
      const markedListStr = Array.from(markedRows).map(r => `<span class="sp-banner-badge">${r.rawLate}</span>`).join(" ");
      const excessMins = totalLateMinutes - ALLOWED_GRACE_MINUTES;

      banner.innerHTML = `
        <div class="sp-banner-main">
          <span class="sp-banner-icon">⏱️</span>
          <span>Total Late: <strong>${fmt(totalLateMinutes)} (${totalLateMinutes} mins = 3.01)</strong> | Allowed Grace: <strong>45 mins</strong> | Excess to Adjust: <strong>${excessMins} mins</strong></span>
        </div>
        <div class="sp-banner-sub">
          👉 <strong>${markedRows.size} Days Marked for "Apply Swipe" (Largest to Lowest):</strong> ${markedListStr}
          <br>Regularizing these ${markedRows.size} days brings remaining late down to <strong>${currentRemaining} mins (<= 45 mins safe)</strong>.
        </div>
      `;
    } else {
      banner.innerHTML = `
        <div class="sp-banner-main" style="color: #15803d;">
          <span class="sp-banner-icon">✅</span>
          <span>Total Late: <strong>${totalLateMinutes} mins</strong> | Allowed Grace: <strong>45 mins</strong></span>
        </div>
        <div class="sp-banner-sub" style="color: #15803d;">
          Your late hours are completely within the 45-minute allowed grace limit. No swipe regularization required!
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
    }
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.target.id === PUNCH_PANEL_ID ||
          m.target.id === LATE_BANNER_ID ||
          m.target.closest?.(`#${PUNCH_PANEL_ID}`) ||
          m.target.closest?.(`#${LATE_BANNER_ID}`)
        ) {
          return;
        }
      }
      scheduleRender();
    });

    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  function init() {
    startObserver();
    scheduleRender();
    window.addEventListener("load", scheduleRender, { passive: true });
    document.addEventListener("click", () => setTimeout(scheduleRender, 250), { passive: true });
  }

  init();
})();
