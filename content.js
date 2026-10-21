(() => {
  "use strict";

  const PANEL_ID = "spine-punch-hours-summary";
  const STYLE_ID = "spine-punch-hours-style";

  let renderTimer = null;
  let tickInterval = null;
  let observerStarted = false;
  let latestResult = null;

  function norm(v) {
    return (v || "").replace(/\s+/g, " ").trim();
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

  function fmt(mins) {
    const total = Math.max(0, Math.floor(Number(mins) || 0));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}h ${m}m`;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        margin: 10px 0 12px 0;
        width: 100%;
        box-sizing: border-box;
      }
      #${PANEL_ID} .sp-card {
        background: #eef7ff;
        border: 1px solid #c8dced;
        border-radius: 8px;
        padding: 12px;
        font-family: Arial, sans-serif;
        box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      }
      #${PANEL_ID} .sp-title {
        font-size: 16px;
        font-weight: 700;
        color: #234861;
        margin-bottom: 10px;
      }
      #${PANEL_ID} .sp-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(150px, 1fr));
        gap: 10px;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .sp-box {
        background: #ffffff;
        border: 1px solid #dce6ef;
        border-radius: 6px;
        padding: 10px;
      }
      #${PANEL_ID} .sp-label {
        font-size: 12px;
        color: #617284;
        margin-bottom: 4px;
      }
      #${PANEL_ID} .sp-value {
        font-size: 22px;
        font-weight: 700;
        color: #0a517d;
      }
      #${PANEL_ID} .sp-value.small {
        font-size: 18px;
      }
      #${PANEL_ID} .sp-meta,
      #${PANEL_ID} .sp-line {
        font-size: 12px;
        color: #48596a;
      }
      #${PANEL_ID} .sp-line {
        padding: 4px 0;
        border-bottom: 1px dashed #dfe6ec;
      }
      #${PANEL_ID} .sp-warning {
        color: #a13d3d;
      }
      #${PANEL_ID} .sp-good {
        color: #1f8a43 !important;
      }
      #${PANEL_ID} .sp-bad {
        color: #c0392b !important;
      }
      #${PANEL_ID} .sp-sub {
        margin-top: 4px;
        font-size: 12px;
        font-weight: 600;
      }
      #${PANEL_ID} details {
        margin-top: 8px;
      }
      #${PANEL_ID} summary {
        cursor: pointer;
        color: #0a517d;
        font-weight: 600;
      }
    `;
    document.head.appendChild(style);
  }

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

  function extractRows(table) {
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

  function uniqueRows(rows) {
    const seen = new Set();

    return rows.filter(row => {
      const key = `${row.date}|${row.entryTime}|${row.dir}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function calculate(rows) {
    const cleanRows = uniqueRows(rows);

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

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
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

  function render() {
    try {
      ensureStyles();

      const table = findPunchTable();
      if (!table) return;

      const panel = ensurePanel();

      if (panel.parentElement !== table.parentElement) {
        panel.remove();
        table.parentElement.insertBefore(panel, table);
      }

      const rows = extractRows(table);
      const result = calculate(rows);
      latestResult = result;

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
    } catch (err) {
      console.error("Spine punch summary error", err);
    }
  }

  function startTicking(panel) {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }

    tickInterval = setInterval(() => {
      if (!latestResult || !document.getElementById(PANEL_ID)) return;

      const openInEl = panel.querySelector('[data-role="open-in"]');
      const totalOpenEl = panel.querySelector('[data-role="total-open"]');

      if (latestResult.lastOpenInTime) {
        const openStart = parseMinutes(latestResult.lastOpenInTime);
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        if (openStart != null && nowMinutes >= openStart) {
          latestResult.openInMinutes = nowMinutes - openStart;
          latestResult.totalInPlusOpen = latestResult.inMinutes + latestResult.openInMinutes;

          if (openInEl) openInEl.textContent = fmt(latestResult.openInMinutes);
          if (totalOpenEl) totalOpenEl.textContent = fmt(latestResult.totalInPlusOpen);
        }
      }

      updateCompletionUI(panel, latestResult);
    }, 1000);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const mo = new MutationObserver(() => {
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