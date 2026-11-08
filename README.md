# SPINE Attendance Hours & Late Optimizer

Chrome Extension to view attendance hours summary, calculate total daily punch hours, track late hours, and optimize swipe regularization (using a greedy largest-to-lowest strategy within allowed grace limits).

## Features

- **Daily Punch Summary**: Automatically calculates total IN/OUT duration, elapsed working time, and remaining hours.
- **Late Hours Tracker & Greedy Optimizer**: Identifies late hours against the 45-minute monthly grace limit and marks the optimal minimum days needed for "Apply Swipe".
- **1-Click "Apply Swipe" & Modal Auto-Fill**: Click any orange **"⚡ Apply Swipe"** badge in the table or the summary banner to automatically trigger the regularization dialog and auto-fill the reason, remarks, and late minutes.
- **Dynamic Active Website Manager**: Easily add, toggle, or remove any company HRMS URL directly from the extension popup without touching code.

## How to Install in Chrome

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top right corner.
3. Click **Load unpacked** and select this directory (`SPINE`).

## Managing Active Websites

You no longer need to edit `manifest.json` manually!

1. Open your company portal (e.g., `https://example.com/`).
2. Click the **SPINE Helper** icon in the Chrome toolbar.
3. Click **⚡ Enable on this site** (or type any domain/wildcard pattern like `example.com` or `https://example.com/*` and click **+ Add**).
4. The extension activates immediately without even needing to reload!

---

### Screenshots

<img width="1010" height="403" alt="image" src="https://github.com/user-attachments/assets/c1c921fb-f32e-4d5b-a20d-fc398a5855a3" />

<img width="1416" height="165" alt="image" src="https://github.com/user-attachments/assets/a0394aa8-f048-4f38-a95d-ae14975510d9" />

<img width="1401" height="67" alt="image" src="https://github.com/user-attachments/assets/793a0e41-7814-4fda-abb6-92702867b9ed" />
