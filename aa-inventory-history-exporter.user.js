// ==UserScript==
// @name         AA Inventory History Batch Exporter
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Paste AA logins + a date/time window, pull each AA's full Inventory History in the background, and export a multi-sheet .xlsx (home summary + one colour-coded sheet per AA).
// @author       joyhjoe
// @match        *://qi-fcresearch-eu.corp.amazon.com/*/results?s=*
// @match        *://qi-fcresearch-na.corp.amazon.com/*/results?s=*
// @match        *://fcresearch-eu.aka.amazon.com/*/results?s=*
// @match        *://qi-fcresearch-eu.corp.amazon.com/*
// @match        *://qi-fcresearch-na.corp.amazon.com/*
// @match        *://fcresearch-eu.aka.amazon.com/*
// @icon         https://cdn-icons-png.flaticon.com/512/4300/4300058.png
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js
// ==/UserScript==

/*
 * AA INVENTORY HISTORY BATCH EXPORTER
 * ===================================
 *
 * Adds a floating launcher + panel to the FC Research results page. Enter a
 * list of AA logins and one start/end date (optionally start/end time), and the
 * tool pulls every AA's Inventory History for that window WITHOUT navigating the
 * current tab, then exports one .xlsx workbook:
 *   - "Home"   : one summary row per AA (rows, first/last event, span, status).
 *   - "<login>": one sheet per AA with all rows + a "Gap (since prev)" column,
 *                colour-coded green (≤5 min) → red (≥60 min).
 *
 * HOW THE DATA IS FETCHED
 * -----------------------
 * The inventory-history table is rendered client-side after an AJAX call, so a
 * plain HTTP GET of the results page returns an empty table. Instead, for each
 * login we load /<FC>/results?s=<login> in a hidden SAME-ORIGIN iframe, fill in
 * the date fields, click Search, and read the table from inside the iframe.
 *
 * The table is a DataTables grid using the Scroller plugin: it only keeps ~100
 * rows materialised at a time and renders more as you scroll, recycling the
 * rows you scroll past. To capture everything we scroll the body end-to-end and
 * accumulate every row we see (deduped by DataTables row index), so histories
 * of thousands of rows are fully exported rather than capped at 100.
 *
 * Columns are keyed by their <thead> text (not fixed indices) so the export
 * survives column re-ordering.
 */

(function () {
    'use strict';

    // Only run in the top window. Our hidden iframes load the same URL; we must
    // not re-inject the UI inside them.
    if (window.top !== window.self) return;

    // ═══════════════════════════════════════════════════════════════════════
    // CONFIG + STATE
    // ═══════════════════════════════════════════════════════════════════════

    const VERSION = '2.0';
    const STORAGE_KEY = 'aa_inv_exporter_settings_v1';
    const ORIGIN = location.origin;

    // How many AAs to fetch at once. Iframes are heavy, so keep this low.
    const CONCURRENCY = 2;

    // Per-AA ceiling. Generous: large histories are loaded by scrolling through
    // every row, which takes time.
    const AA_TIMEOUT_MS = 180000;

    // Gap colour ramp (minutes): ≤ GREEN_MAX = green, ≥ RED_MIN = red.
    const GAP_GREEN_MAX = 5;
    const GAP_RED_MIN = 60;

    // The computed column appended to every AA sheet.
    const GAP_COL = 'Gap (since prev)';

    // FC segment from the URL, e.g. "EMA4" in /EMA4/results?s=...
    const FC_SEGMENT = (function () {
        const m = location.pathname.match(/^\/([^/]+)\/results/i);
        if (m) return m[1];
        const parts = location.pathname.split('/').filter(Boolean);
        return parts[0] || 'EMA4';
    })();

    const DEFAULT_SETTINGS = {
        logins: '',
        startDate: '',   // MM/DD/YYYY
        endDate: '',     // MM/DD/YYYY
        startTime: '',   // HH:MM:SS (24h), optional
        endTime: ''      // HH:MM:SS (24h), optional
    };

    let settings = { ...DEFAULT_SETTINGS };
    let isRunning = false;
    let cancelRequested = false;
    let lastResults = null;   // { results, startDate, endDate, startTime, endTime, winLabel } for re-download
    let activeRun = null;     // { results, startDate, endDate, window } for per-AA retry
    let el = {};              // cached UI element references

    // ═══════════════════════════════════════════════════════════════════════
    // SETTINGS PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════════

    function loadSettings() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
        } catch (e) {
            settings = { ...DEFAULT_SETTINGS };
        }
        // Default window: the last 7 days.
        if (!settings.endDate) settings.endDate = formatDate(new Date());
        if (!settings.startDate) {
            const d = new Date();
            d.setDate(d.getDate() - 7);
            settings.startDate = formatDate(d);
        }
    }

    function saveSettings() {
        try { GM_setValue(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DATE / TIME HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const pad2 = (n) => String(n).padStart(2, '0');

    // Date → "MM/DD/YYYY" (the format the FC Research #searchStart field expects).
    function formatDate(date) {
        return pad2(date.getMonth() + 1) + '/' + pad2(date.getDate()) + '/' + date.getFullYear();
    }

    // Date → "YYYY-MM-DD HH:MM:SS" for human-readable summary cells.
    function formatDateTime(d) {
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
               `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    // Validate/normalize an "MM/DD/YYYY" string → normalized string or null.
    function normalizeDateStr(s) {
        if (!s || typeof s !== 'string') return null;
        const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const mm = +m[1], dd = +m[2], yy = +m[3];
        const d = new Date(yy, mm - 1, dd);
        // Reject impossible dates (e.g. 02/31) by round-tripping.
        if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
        return formatDate(d);
    }

    // Validate/normalize a 24h time string ("H:MM", "HH:MM", "HH:MM:SS") →
    // "HH:MM:SS" or null. Seconds default to 00.
    function normalizeTimeStr(s) {
        if (!s || typeof s !== 'string') return null;
        const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return null;
        const hh = +m[1], mm = +m[2], ss = m[3] != null ? +m[3] : 0;
        if (hh > 23 || mm > 59 || ss > 59) return null;
        return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
    }

    // Parse an inventory-history timestamp cell into a Date (for sorting + gaps).
    // Handles "YYYY-MM-DD HH:MM:SS", "MM/DD/YYYY HH:MM:SS", "MM/DD-HH:MM:SS".
    function parseEventTimestamp(str) {
        if (!str) return null;
        const s = String(str).trim();

        let m = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));

        m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));

        m = s.match(/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +(m[5] || 0));

        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    // Build the concrete [from, to] Date window from the date/time inputs.
    // When both times are given and endTime <= startTime, the window is treated
    // as overnight (end rolls to the day after endDate). With no times, the
    // window spans whole days.
    function buildWindow(startDate, endDate, startTime, endTime) {
        const [sM, sD, sY] = startDate.split('/').map(Number);
        const [eM, eD, eY] = endDate.split('/').map(Number);

        if (startTime && endTime) {
            const [sh, sm, ss] = startTime.split(':').map(Number);
            const [eh, em, es] = endTime.split(':').map(Number);
            const from = new Date(sY, sM - 1, sD, sh, sm, ss);
            const to = new Date(eY, eM - 1, eD, eh, em, es);
            if (eh * 3600 + em * 60 + es <= sh * 3600 + sm * 60 + ss) {
                to.setDate(to.getDate() + 1); // overnight
            }
            return { from, to };
        }
        return {
            from: new Date(sY, sM - 1, sD, 0, 0, 0),
            to: new Date(eY, eM - 1, eD, 23, 59, 59)
        };
    }

    function windowLabel(startDate, endDate, startTime, endTime) {
        return (startTime && endTime)
            ? `${startDate} ${startTime} → ${endDate} ${endTime}`
            : `${startDate} → ${endDate}`;
    }

    // Milliseconds → "H:MM:SS" (or "MM:SS" under an hour). Blank for invalid.
    function formatGap(ms) {
        if (ms == null || isNaN(ms) || ms < 0) return '';
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
    }

    // Gap in minutes → ExcelJS ARGB fill (green → yellow → red), or null for
    // no fill (the first row of each AA has no previous event).
    function gapFillARGB(gapMin) {
        if (gapMin == null || isNaN(gapMin) || gapMin < 0) return null;

        let t;
        if (gapMin <= GAP_GREEN_MAX) t = 0;
        else if (gapMin >= GAP_RED_MIN) t = 1;
        else t = (gapMin - GAP_GREEN_MAX) / (GAP_RED_MIN - GAP_GREEN_MAX);

        // Green #63BE7B → Yellow #FFEB84 (t 0..0.5) → Red #F8696B (t 0.5..1).
        const lerp = (a, b, f) => Math.round(a + (b - a) * f);
        let r, g, b;
        if (t <= 0.5) {
            const f = t / 0.5;
            r = lerp(99, 255, f); g = lerp(190, 235, f); b = lerp(123, 132, f);
        } else {
            const f = (t - 0.5) / 0.5;
            r = lerp(255, 248, f); g = lerp(235, 105, f); b = lerp(132, 107, f);
        }
        const hx = (n) => n.toString(16).padStart(2, '0').toUpperCase();
        return 'FF' + hx(r) + hx(g) + hx(b);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MISC HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    // De-dupe (case-insensitive) and drop blanks, preserving order.
    function uniqueNonEmpty(arr) {
        const seen = new Set();
        const out = [];
        for (const v of arr) {
            const t = String(v || '').trim();
            if (!t) continue;
            const k = t.toLowerCase();
            if (!seen.has(k)) { seen.add(k); out.push(t); }
        }
        return out;
    }

    // Split a textarea value into unique logins (commas/whitespace/semicolons).
    function parseLoginList(text) {
        return uniqueNonEmpty(String(text || '').split(/[\s,;]+/));
    }

    // Strip HTML / collapse whitespace from a cell value.
    function cellText(v) {
        if (v == null) return '';
        let s = String(v);
        if (s.indexOf('<') !== -1) {
            const tmp = document.createElement('div');
            tmp.innerHTML = s;
            s = tmp.textContent || tmp.innerText || '';
        }
        return s.replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Returns a function that produces unique, Excel-safe sheet names (≤31
    // chars, no illegal characters, de-duplicated).
    function makeSheetNamer() {
        const used = new Set(['Home']);
        return function (raw) {
            let name = String(raw || 'AA').replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || 'AA';
            let candidate = name, i = 2;
            while (used.has(candidate.toLowerCase())) {
                const suffix = '_' + i++;
                candidate = name.slice(0, 31 - suffix.length) + suffix;
            }
            used.add(candidate.toLowerCase());
            return candidate;
        };
    }

    // Which header holds the timestamp (for sorting + gap maths)?
    function findTimestampHeader(headers) {
        const prefer = ['date', 'time', 'timestamp', 'event time', 'date/time', 'datetime'];
        for (const p of prefer) {
            const hit = headers.find(h => h.toLowerCase().includes(p));
            if (hit) return hit;
        }
        return headers[0] || null; // historically the first column
    }

    // ═══════════════════════════════════════════════════════════════════════
    // IFRAME TABLE ACCESS (inside the hidden per-AA iframe)
    // ═══════════════════════════════════════════════════════════════════════

    function buildResultsUrl(login) {
        return `${ORIGIN}/${FC_SEGMENT}/results?s=${encodeURIComponent(login)}`;
    }

    // Read the inventory-history header texts, in column order.
    function readHeaders(doc) {
        let cells = doc.querySelectorAll('#table-inventory-history_wrapper .dataTables_scrollHead thead tr th');
        if (!cells.length) {
            const t = doc.getElementById('table-inventory-history');
            if (t) cells = t.querySelectorAll('thead tr th');
        }
        return Array.from(cells).map(th => (th.innerText || th.textContent || '').trim());
    }

    // Read the DataTables "Showing 1 to 100 of N entries" total, or null.
    function getTableTotal(doc) {
        const infoEl = doc.getElementById('table-inventory-history_info') ||
                       doc.querySelector('#table-inventory-history_wrapper .dataTables_info');
        if (infoEl) {
            const m = (infoEl.textContent || '').replace(/,/g, '').match(/of\s+(\d+)\s+entries/i);
            if (m) return parseInt(m[1], 10);
        }
        return null;
    }

    // Estimate one row's pixel height, for sizing scroll steps.
    function estimateRowHeight(scrollBody) {
        const tr = scrollBody.querySelector('tbody tr');
        const h = tr ? tr.getBoundingClientRect().height : 0;
        return h > 4 ? h : 24;
    }

    // The table uses DataTables Scroller (virtualised rows). Scroll the body
    // end-to-end and ACCUMULATE every row that materialises — a single read
    // would only see the ~100 currently rendered. Returns { headers, rows }.
    async function loadAllRows(doc) {
        const total = getTableTotal(doc);
        const headers = readHeaders(doc);
        const scrollBody = doc.querySelector('#table-inventory-history_wrapper .dataTables_scrollBody');
        const rowsMap = new Map(); // stable key → row object (dedupe across scrolls)

        const harvest = () => {
            let trs = doc.querySelectorAll('#table-inventory-history_wrapper .dataTables_scrollBody tbody tr');
            if (!trs.length) {
                const t = doc.getElementById('table-inventory-history');
                if (t) trs = t.querySelectorAll('tbody tr');
            }
            trs.forEach(tr => {
                if (tr.querySelector('td.dataTables_empty')) return;
                const cells = Array.from(tr.querySelectorAll('td'));
                if (!cells.length) return;
                const obj = {};
                cells.forEach((td, i) => {
                    const key = headers[i] && headers[i].length ? headers[i] : `col${i}`;
                    obj[key] = (td.innerText || td.textContent || '').trim();
                });
                // Prefer DataTables' own row index; fall back to row content.
                const dtRow = tr.getAttribute('data-dt-row');
                const key = dtRow != null
                    ? 'r' + dtRow
                    : cells.map(c => (c.innerText || c.textContent || '').trim()).join('\u0001');
                rowsMap.set(key, obj);
            });
        };

        const MAX_ITERS = 2000;
        const STALL_LIMIT = 10;    // consecutive no-progress scrolls → stop
        const STEP_ROWS = 40;      // advance under the ~100-row window so none are skipped
        let lastSize = -1;
        let stalls = 0;
        let pos = 0;

        for (let i = 0; i < MAX_ITERS; i++) {
            if (cancelRequested) break;
            harvest();

            if (total && rowsMap.size >= total) break;

            if (rowsMap.size === lastSize) {
                if (++stalls >= STALL_LIMIT) break;
            } else {
                stalls = 0;
                lastSize = rowsMap.size;
            }

            if (!scrollBody) break;
            pos = Math.min(pos + STEP_ROWS * estimateRowHeight(scrollBody), scrollBody.scrollHeight);
            scrollBody.scrollTop = pos;
            if (pos >= scrollBody.scrollHeight - 2) scrollBody.scrollTop = scrollBody.scrollHeight;

            await sleep(220); // let Scroller fetch/render the next block
        }

        harvest(); // final sweep at the bottom
        if (scrollBody) { try { scrollBody.scrollTop = 0; } catch (e) {} }

        return {
            headers: headers.length ? headers : null,
            rows: Array.from(rowsMap.values())
        };
    }

    // Find the inventory-history Search button in a document.
    function findSearchButton(doc) {
        const decl = doc.querySelector('[data-action="inventory-history-search-button"]');
        if (decl) return decl.querySelector('input,button,a,span') || decl;

        // Fallback: the a-button span pattern used by the FC Day-history scripts.
        const spans = doc.getElementsByClassName('a-button a-button-base');
        if (spans && spans.length) {
            const first = spans[0];
            if (first.nodeName === 'DIV' && spans[1]) {
                return spans[1].childNodes[0] && spans[1].childNodes[0].childNodes[0];
            }
            return first.childNodes[0] && first.childNodes[0].childNodes[0];
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FETCH ONE AA (hidden same-origin iframe)
    // ═══════════════════════════════════════════════════════════════════════

    // Load one login's inventory history for [startDate, endDate]. Resolves
    // with { headers, rows } or rejects on error / timeout / cancel.
    function fetchOneAA(login, startDate, endDate) {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText =
                'position:fixed; width:1280px; height:900px; left:-10000px; top:-10000px; ' +
                'border:0; opacity:0; pointer-events:none;';
            iframe.src = buildResultsUrl(login);

            let settled = false;
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                try { iframe.remove(); } catch (e) {}
                fn(arg);
            };

            const timer = setTimeout(
                () => finish(reject, new Error('Timed out loading ' + login)),
                AA_TIMEOUT_MS
            );

            let phase = 'init';      // init → waiting → scraping
            let searchFiredAt = 0;
            let sawLoading = false;  // did the status indicator ever enter "loading"?

            const poll = setInterval(async () => {
                if (cancelRequested) return finish(reject, new Error('Cancelled'));

                let doc;
                try { doc = iframe.contentDocument; } catch (e) {
                    return finish(reject, new Error('Cross-origin iframe for ' + login));
                }
                if (!doc) return;

                // PHASE init: wait for the date field + Search button, fill, search.
                if (phase === 'init') {
                    const startEl = doc.getElementById('searchStart');
                    const searchBtn = startEl ? findSearchButton(doc) : null;
                    if (!startEl || !searchBtn) return;

                    const endEl = doc.getElementById('searchEnd');
                    startEl.value = startDate;
                    if (endEl && endDate) endEl.value = endDate;
                    ['input', 'change'].forEach(evt => {
                        startEl.dispatchEvent(new Event(evt, { bubbles: true }));
                        if (endEl) endEl.dispatchEvent(new Event(evt, { bubbles: true }));
                    });

                    searchBtn.click();
                    searchFiredAt = Date.now();
                    phase = 'waiting';
                    return;
                }

                // PHASE waiting: hold until FC Research has finished loading.
                if (phase === 'waiting') {
                    if (Date.now() - searchFiredAt < 500) return;

                    const status = doc.getElementById('inventory-history-status');
                    const stillLoading = status && /(^|\s)loading(\s|$)/.test(status.className);
                    if (stillLoading) { sawLoading = true; return; }

                    const table = doc.getElementById('table-inventory-history');
                    const hasRows = table && table.querySelector('tbody tr td:not(.dataTables_empty)');
                    const emptyRow = table && table.querySelector('td.dataTables_empty');
                    const elapsed = Date.now() - searchFiredAt;

                    // Loaded when: status went through loading then cleared, OR
                    // real rows exist, OR the "no records" row rendered, OR a
                    // grace period elapsed on pages with no status element.
                    const ready =
                        (status && sawLoading && !stillLoading) ||
                        hasRows ||
                        (emptyRow && elapsed > 2500) ||
                        (!status && elapsed > 3500);
                    if (!ready) return;

                    // PHASE scraping: scroll the whole table, accumulate all rows.
                    phase = 'scraping';
                    (async () => {
                        try {
                            const result = await loadAllRows(iframe.contentDocument);
                            if (cancelRequested) return finish(reject, new Error('Cancelled'));
                            finish(resolve, {
                                headers: result.headers || (result.rows[0] ? Object.keys(result.rows[0]) : []),
                                rows: result.rows
                            });
                        } catch (e) {
                            finish(reject, e);
                        }
                    })();
                }
            }, 300);

            document.body.appendChild(iframe);
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GAP COMPUTATION
    // ═══════════════════════════════════════════════════════════════════════

    // Given { headers, rows }, optionally filter to a time window, sort by
    // timestamp, and append the "Gap (since prev)" column. Returns the enriched
    // table plus first/last event + total span for the summary. Each row also
    // carries a non-exported __gapMin (minutes) used for Excel colouring.
    function enrichWithGaps(result, window) {
        const { headers } = result;
        const tsHeader = findTimestampHeader(headers);

        let decorated = result.rows.map(row => ({
            row,
            ts: tsHeader ? parseEventTimestamp(row[tsHeader]) : null
        }));

        if (window && window.from && window.to) {
            const lo = window.from.getTime();
            const hi = window.to.getTime();
            decorated = decorated.filter(d => d.ts && d.ts.getTime() >= lo && d.ts.getTime() <= hi);
        }

        // Ascending by timestamp; timeless rows keep their relative order last.
        decorated.sort((a, b) => {
            if (a.ts && b.ts) return a.ts - b.ts;
            if (a.ts) return -1;
            if (b.ts) return 1;
            return 0;
        });

        let prev = null, firstTs = null, lastTs = null;
        decorated.forEach(({ row, ts }) => {
            if (ts) {
                if (!firstTs) firstTs = ts;
                lastTs = ts;
                if (prev) {
                    const deltaMs = ts - prev;
                    row[GAP_COL] = formatGap(deltaMs);
                    row.__gapMin = deltaMs / 60000;
                } else {
                    row[GAP_COL] = '';
                    row.__gapMin = null;
                }
                prev = ts;
            } else {
                row[GAP_COL] = '';
                row.__gapMin = null;
            }
        });

        const outHeaders = headers.slice();
        if (!outHeaders.includes(GAP_COL)) outHeaders.push(GAP_COL);

        return {
            headers: outHeaders,
            rows: decorated.map(d => d.row),
            firstEvent: firstTs ? formatDateTime(firstTs) : '',
            lastEvent: lastTs ? formatDateTime(lastTs) : '',
            totalSpan: (firstTs && lastTs) ? formatGap(lastTs - firstTs) : ''
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EXCEL WORKBOOK (ExcelJS — supports cell fills)
    // ═══════════════════════════════════════════════════════════════════════

    const XLSX_HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF232F3E' } };
    const XLSX_HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Build the workbook and trigger the download. Async: ExcelJS serialises to
    // a buffer asynchronously.
    async function buildAndDownloadWorkbook(results, startDate, endDate, startTime, endTime, winLabel) {
        if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS failed to load via @require.');

        const wb = new ExcelJS.Workbook();
        wb.creator = 'AA Inventory History Exporter';
        wb.created = new Date();
        const nameSheet = makeSheetNamer();

        // Home / summary sheet.
        const home = wb.addWorksheet('Home');
        home.addRow(['AA Inventory History Export']);
        home.addRow(['Window', winLabel || `${startDate}  →  ${endDate}`]);
        home.addRow(['Generated', formatDateTime(new Date())]);
        home.addRow(['FC', FC_SEGMENT]);
        home.addRow([]);
        const homeHeader = home.addRow(['Login', 'Sheet', 'Rows', 'First event', 'Last event', 'Total span', 'Status']);
        homeHeader.eachCell(c => { c.fill = XLSX_HEADER_FILL; c.font = XLSX_HEADER_FONT; });
        home.getRow(1).font = { bold: true, size: 14 };

        const perAaSheets = [];
        results.forEach(res => {
            let sheetName = '', rowCount = 0;
            if (res.status === 'done' && res.data && res.data.rows.length) {
                sheetName = nameSheet(res.login);
                rowCount = res.data.rows.length;
                perAaSheets.push({ sheetName, result: res.data });
            }
            home.addRow([
                res.login,
                sheetName,
                rowCount,
                res.data ? res.data.firstEvent : '',
                res.data ? res.data.lastEvent : '',
                res.data ? res.data.totalSpan : '',
                res.statusLabel || res.status
            ]);
        });
        [16, 16, 8, 21, 21, 12, 28].forEach((w, i) => { home.getColumn(i + 1).width = w; });

        // One sheet per AA with the full rows + colour-coded gap column.
        perAaSheets.forEach(({ sheetName, result }) => {
            const headers = result.headers;
            const ws = wb.addWorksheet(sheetName);
            const gapIdx = headers.indexOf(GAP_COL); // 0-based; ExcelJS columns are 1-based

            const hr = ws.addRow(headers);
            hr.eachCell(c => { c.fill = XLSX_HEADER_FILL; c.font = XLSX_HEADER_FONT; });

            result.rows.forEach(r => {
                const row = ws.addRow(headers.map(h => (r[h] != null ? r[h] : '')));
                if (gapIdx >= 0) {
                    const argb = gapFillARGB(r.__gapMin);
                    if (argb) {
                        const cell = row.getCell(gapIdx + 1);
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
                        cell.font = { color: { argb: 'FF1A1A1A' }, bold: true };
                        cell.alignment = { horizontal: 'center' };
                    }
                }
            });

            // Set widths via column getters (reassigning ws.columns after rows
            // exist can disturb the data).
            headers.forEach((h, i) => {
                ws.getColumn(i + 1).width = Math.min(Math.max(h.length + 2, 10), 40);
            });
            ws.views = [{ state: 'frozen', ySplit: 1 }]; // freeze header row
        });

        // Serialise and download via a Blob link.
        const buffer = await wb.xlsx.writeBuffer();
        const safe = (s) => String(s).replace(/[/:]/g, '-');
        const tPart = (startTime && endTime) ? `_${safe(startTime)}_${safe(endTime)}` : '';
        const fname = `AA_Inventory_History_${safe(startDate)}_to_${safe(endDate)}${tPart}.xlsx`;

        const blob = new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BATCH RUNNER
    // ═══════════════════════════════════════════════════════════════════════

    // Apply one AA's fetch result to its record (shared by the batch + retry).
    function applyFetchResult(rec, raw, window) {
        if (!raw || !raw.rows || raw.rows.length === 0) {
            rec.status = 'empty';
            rec.statusLabel = 'No rows in range';
            rec.data = { headers: raw ? raw.headers : [], rows: [], firstEvent: '', lastEvent: '', totalSpan: '' };
            return;
        }
        const enriched = enrichWithGaps(raw, window);
        rec.data = enriched;
        if (enriched.rows.length === 0) {
            rec.status = 'empty';
            rec.statusLabel = 'No rows in window';
        } else {
            rec.status = 'done';
            rec.statusLabel = `${enriched.rows.length} rows`;
        }
    }

    // Fetch every login with bounded concurrency, updating progress as we go.
    async function runBatch(logins, startDate, endDate, window) {
        const results = logins.map(login => ({
            login,
            status: 'pending',      // pending | running | done | empty | error
            statusLabel: 'Pending',
            data: null,
            error: null,
            retrying: false
        }));

        // Exposed so a per-AA Retry can re-fetch one login with the same window.
        activeRun = { results, startDate, endDate, window };
        renderProgress(results);

        let index = 0;
        let completed = 0;
        const total = results.length;

        async function worker() {
            while (index < results.length) {
                if (cancelRequested) return;
                const rec = results[index++];
                rec.status = 'running';
                rec.statusLabel = 'Running…';
                renderProgress(results);

                try {
                    const raw = await fetchOneAA(rec.login, startDate, endDate);
                    applyFetchResult(rec, raw, window);
                } catch (e) {
                    rec.status = 'error';
                    rec.statusLabel = (e && e.message) ? e.message : 'Failed';
                    rec.error = e;
                }

                completed++;
                updateProgressBar(completed, total);
                renderProgress(results);
            }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, results.length) }, worker);
        await Promise.all(workers);
        return results;
    }

    // Re-fetch a single AA (per-row Retry button), reusing the active window.
    async function retryOneAA(login) {
        if (!activeRun) return;
        if (isRunning) { toast('Wait for the current run to finish before retrying.'); return; }

        cancelRequested = false;
        const rec = activeRun.results.find(r => r.login === login);
        if (!rec || rec.retrying) return;

        rec.retrying = true;
        rec.status = 'running';
        rec.statusLabel = 'Retrying…';
        renderProgress(activeRun.results);

        try {
            const raw = await fetchOneAA(rec.login, activeRun.startDate, activeRun.endDate);
            applyFetchResult(rec, raw, activeRun.window);
            rec.error = null;
        } catch (e) {
            rec.status = 'error';
            rec.statusLabel = (e && e.message) ? e.message : 'Failed';
            rec.error = e;
        }

        rec.retrying = false;
        renderProgress(activeRun.results);

        // Keep re-download in sync with whatever is now available.
        el.download.disabled = !activeRun.results.some(r => r.status === 'done');
        if (lastResults) lastResults.results = activeRun.results;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UI — STYLES
    // ═══════════════════════════════════════════════════════════════════════

    function injectStyles() {
        if (document.getElementById('aa-exp-styles')) return;
        const style = document.createElement('style');
        style.id = 'aa-exp-styles';
        style.textContent = `
            #aa-exp-launch {
                position: fixed; right: 22px; bottom: 22px; z-index: 2147483000;
                display: inline-flex; align-items: center; gap: 10px;
                padding: 15px 22px; border: none; border-radius: 14px; cursor: pointer;
                background: linear-gradient(135deg, #2d9b5e, #185c37); color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 16px; font-weight: 800; letter-spacing: .3px;
                box-shadow: 0 8px 24px rgba(24,92,55,.45); transition: transform .18s ease, box-shadow .18s ease;
            }
            #aa-exp-launch:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(24,92,55,.55); }
            #aa-exp-launch:active { transform: translateY(0) scale(.98); }
            #aa-exp-launch svg { width: 20px; height: 20px; }

            #aa-exp-overlay {
                position: fixed; inset: 0; z-index: 2147483001; display: none;
                background: rgba(15,23,42,.55); backdrop-filter: blur(4px);
                align-items: flex-start; justify-content: center;
            }
            #aa-exp-overlay.open { display: flex; animation: aaExpFade .2s ease; }
            @keyframes aaExpFade { from { opacity: 0; } to { opacity: 1; } }

            #aa-exp-panel {
                margin-top: 5vh; width: 960px; max-width: calc(100vw - 48px);
                max-height: 90vh; overflow: auto;
                background: #fff; border-radius: 20px; box-shadow: 0 30px 80px rgba(0,0,0,.45);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #0f172a; animation: aaExpPop .22s cubic-bezier(.2,.8,.2,1);
            }
            @keyframes aaExpPop { from { transform: translateY(14px) scale(.98); opacity: .6; } to { transform: none; opacity: 1; } }

            .aa-exp-head {
                display: flex; align-items: center; justify-content: space-between; padding: 22px 28px;
                background: linear-gradient(135deg, #232f3e 0%, #37475a 100%); color: #fff;
                border-radius: 20px 20px 0 0;
            }
            .aa-exp-head h2 { margin: 0; font-size: 21px; font-weight: 800; display: flex; align-items: center; gap: 11px; letter-spacing: .2px; }
            .aa-exp-head .aa-exp-ver { font-size: 13px; color: #ff9900; font-weight: 800; }
            .aa-exp-close {
                background: rgba(255,255,255,.1); border: none; color: #e2e8f0; font-size: 24px;
                cursor: pointer; line-height: 1; width: 38px; height: 38px; border-radius: 10px;
                display: inline-flex; align-items: center; justify-content: center; transition: background .15s;
            }
            .aa-exp-close:hover { background: rgba(255,255,255,.22); color: #fff; }

            .aa-exp-body { padding: 26px 28px 30px; }
            .aa-exp-field { margin-bottom: 22px; }
            .aa-exp-field label {
                display: flex; align-items: center; gap: 10px;
                font-size: 15px; font-weight: 800; letter-spacing: .3px; color: #1e293b; margin-bottom: 10px;
            }
            .aa-exp-count-badge {
                background: #2563eb; color: #fff; font-size: 13px; font-weight: 800;
                min-width: 24px; text-align: center; padding: 2px 10px; border-radius: 999px;
            }
            .aa-exp-field textarea {
                width: 100%; box-sizing: border-box; min-height: 130px; resize: vertical;
                border: 2px solid #e2e8f0; border-radius: 12px; padding: 14px 16px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 16px; line-height: 1.6; color: #0f172a;
            }
            .aa-exp-dates { display: flex; gap: 14px; flex-wrap: wrap; }
            .aa-exp-dates .aa-exp-field { flex: 1 1 calc(50% - 7px); min-width: 140px; margin-bottom: 0; }
            .aa-exp-field input[type=text] {
                width: 100%; box-sizing: border-box; border: 2px solid #e2e8f0; border-radius: 12px;
                padding: 13px 14px; font-size: 17px; font-weight: 600; text-align: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #0f172a; background: #fff; min-height: 50px;
            }
            .aa-exp-pick { position: relative; }
            .aa-exp-pick input[readonly] { cursor: pointer; background: #f8fafc; }
            .aa-exp-pick input[readonly]:hover { border-color: #93c5fd; background: #fff; }
            textarea:focus, input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,.14); }

            /* Custom calendar / time popup */
            .aa-pop {
                position: absolute; top: calc(100% + 8px); left: 0; z-index: 2147483010;
                background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
                box-shadow: 0 18px 44px rgba(0,0,0,.26); padding: 14px; min-width: 280px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .aa-pop.right { left: auto; right: 0; }
            .aa-cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
            .aa-cal-nav {
                border: none; background: #f1f5f9; color: #334155; width: 34px; height: 34px;
                border-radius: 9px; cursor: pointer; font-size: 19px; line-height: 1;
            }
            .aa-cal-nav:hover { background: #e2e8f0; }
            .aa-cal-title { font-size: 16px; font-weight: 800; color: #0f172a; }
            .aa-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
            .aa-cal-dow { font-size: 12px; font-weight: 800; color: #94a3b8; text-align: center; padding: 5px 0; }
            .aa-cal-day {
                border: none; background: none; cursor: pointer; border-radius: 8px;
                font-size: 15px; color: #0f172a; height: 38px; transition: background .12s;
            }
            .aa-cal-day:hover { background: #e0e7ff; }
            .aa-cal-day.other { color: #cbd5e1; }
            .aa-cal-day.today { outline: 2px solid #93c5fd; }
            .aa-cal-day.sel { background: #2563eb; color: #fff; font-weight: 800; }
            .aa-cal-foot { display: flex; justify-content: space-between; margin-top: 10px; }
            .aa-cal-foot button {
                border: none; background: none; color: #2563eb; font-size: 14px; font-weight: 700;
                cursor: pointer; padding: 4px 6px;
            }
            .aa-cal-foot button:hover { text-decoration: underline; }

            .aa-time-row { display: flex; align-items: center; gap: 8px; justify-content: center; }
            .aa-time-row select {
                border: 2px solid #e2e8f0; border-radius: 9px; padding: 11px 9px; font-size: 18px;
                background: #fff; color: #0f172a; cursor: pointer; font-weight: 700;
                font-family: ui-monospace, Menlo, Consolas, monospace;
            }
            .aa-time-sep { font-weight: 800; color: #475569; font-size: 18px; }
            .aa-time-foot { display: flex; justify-content: space-between; margin-top: 12px; }
            .aa-time-foot button { border: none; background: none; font-size: 14px; font-weight: 700; cursor: pointer; padding: 4px 6px; }
            .aa-time-clear { color: #b91c1c; }
            .aa-time-done { color: #2563eb; }
            .aa-time-foot button:hover { text-decoration: underline; }

            .aa-exp-actions { display: flex; gap: 12px; margin-top: 26px; align-items: center; }
            .aa-exp-btn {
                display: inline-flex; align-items: center; gap: 9px; padding: 14px 24px;
                border: none; border-radius: 12px; cursor: pointer; font-size: 16px; font-weight: 800;
                transition: transform .15s ease, box-shadow .15s ease, background .15s ease;
            }
            .aa-exp-btn:active { transform: scale(.97); }
            .aa-exp-btn.run {
                background: linear-gradient(135deg, #2d9b5e, #185c37); color: #fff; flex: 1;
                justify-content: center; box-shadow: 0 6px 18px rgba(24,92,55,.4);
            }
            .aa-exp-btn.run:hover { box-shadow: 0 9px 24px rgba(24,92,55,.52); transform: translateY(-1px); }
            .aa-exp-btn.cancel { background: #fee2e2; color: #b91c1c; }
            .aa-exp-btn.cancel:hover { background: #fecaca; }
            .aa-exp-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }
            .aa-exp-btn.ghost { background: #eef2f7; color: #334155; }
            .aa-exp-btn.ghost:hover { background: #e2e8f0; }

            .aa-exp-progress-wrap { margin-top: 24px; }
            .aa-exp-bar { height: 12px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
            .aa-exp-bar > div { height: 100%; width: 0%; background: linear-gradient(90deg, #0ea5e9, #2563eb); transition: width .25s ease; }
            .aa-exp-counter { font-size: 15px; color: #475569; margin: 12px 0 6px; font-weight: 800; }

            .aa-exp-list { margin-top: 10px; border: 1px solid #e2e8f0; border-radius: 12px; max-height: 280px; overflow: auto; }
            .aa-exp-row {
                display: flex; align-items: center; justify-content: space-between;
                padding: 11px 16px; font-size: 15px; border-bottom: 1px solid #f1f5f9;
            }
            .aa-exp-row:last-child { border-bottom: none; }
            .aa-exp-row .login { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; }
            .aa-exp-row-right { display: inline-flex; align-items: center; gap: 10px; }
            .aa-exp-retry {
                border: none; background: #e0e7ff; color: #4338ca; font-size: 13px; font-weight: 800;
                padding: 4px 12px; border-radius: 8px; cursor: pointer; transition: background .15s;
            }
            .aa-exp-retry:hover { background: #c7d2fe; }
            .aa-exp-badge { font-size: 13px; font-weight: 800; padding: 3px 12px; border-radius: 999px; }
            .st-pending { background: #f1f5f9; color: #64748b; }
            .st-running { background: #fef3c7; color: #b45309; }
            .st-done    { background: #dcfce7; color: #15803d; }
            .st-empty   { background: #e0f2fe; color: #0369a1; }
            .st-error   { background: #fee2e2; color: #b91c1c; }
        `;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UI — BUILD + EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    function buildUI() {
        injectStyles();

        const launch = document.createElement('button');
        launch.id = 'aa-exp-launch';
        launch.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
                 stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 4h16v4H4z"/><path d="M4 10h16v10H4z"/><path d="M9 14h6"/>
            </svg>
            AA History → Excel`;
        launch.addEventListener('click', openPanel);
        document.body.appendChild(launch);

        const overlay = document.createElement('div');
        overlay.id = 'aa-exp-overlay';
        overlay.innerHTML = `
            <div id="aa-exp-panel" role="dialog" aria-modal="true">
                <div class="aa-exp-head">
                    <h2>
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24"
                             stroke="#ff9900" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="M9 4v16"/>
                        </svg>
                        AA Inventory History Exporter <span class="aa-exp-ver">v${VERSION}</span>
                    </h2>
                    <button class="aa-exp-close" title="Close">&times;</button>
                </div>
                <div class="aa-exp-body">
                    <div class="aa-exp-field">
                        <label>AA Logins <span class="aa-exp-count-badge" id="aa-exp-count">0</span></label>
                        <textarea id="aa-exp-logins" placeholder="joyhjoe&#10;asmith&#10;bwilliam"></textarea>
                    </div>
                    <div class="aa-exp-dates">
                        <div class="aa-exp-field aa-exp-pick">
                            <label>Start date</label>
                            <input type="text" id="aa-exp-start" placeholder="MM/DD/YYYY" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick">
                            <label>Start time</label>
                            <input type="text" id="aa-exp-start-time" placeholder="HH:MM:SS" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick">
                            <label>End date</label>
                            <input type="text" id="aa-exp-end" placeholder="MM/DD/YYYY" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick">
                            <label>End time</label>
                            <input type="text" id="aa-exp-end-time" placeholder="HH:MM:SS" readonly autocomplete="off">
                        </div>
                    </div>

                    <div class="aa-exp-actions">
                        <button class="aa-exp-btn run" id="aa-exp-run">
                            <svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3"/></svg>
                            Run &amp; Export
                        </button>
                        <button class="aa-exp-btn cancel" id="aa-exp-cancel" disabled>Cancel</button>
                        <button class="aa-exp-btn ghost" id="aa-exp-download" disabled title="Re-download last result">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download
                        </button>
                    </div>

                    <div class="aa-exp-progress-wrap" id="aa-exp-progress" style="display:none;">
                        <div class="aa-exp-counter" id="aa-exp-counter">0 / 0</div>
                        <div class="aa-exp-bar"><div id="aa-exp-bar-fill"></div></div>
                        <div class="aa-exp-list" id="aa-exp-list"></div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        el = {
            overlay,
            logins: overlay.querySelector('#aa-exp-logins'),
            start: overlay.querySelector('#aa-exp-start'),
            end: overlay.querySelector('#aa-exp-end'),
            startTime: overlay.querySelector('#aa-exp-start-time'),
            endTime: overlay.querySelector('#aa-exp-end-time'),
            count: overlay.querySelector('#aa-exp-count'),
            run: overlay.querySelector('#aa-exp-run'),
            cancel: overlay.querySelector('#aa-exp-cancel'),
            download: overlay.querySelector('#aa-exp-download'),
            progress: overlay.querySelector('#aa-exp-progress'),
            counter: overlay.querySelector('#aa-exp-counter'),
            barFill: overlay.querySelector('#aa-exp-bar-fill'),
            list: overlay.querySelector('#aa-exp-list'),
            close: overlay.querySelector('.aa-exp-close')
        };

        // Prefill from saved settings.
        el.logins.value = settings.logins || '';
        el.start.value = settings.startDate || '';
        el.end.value = settings.endDate || '';
        el.startTime.value = settings.startTime || '';
        el.endTime.value = settings.endTime || '';
        updateLoginCount();

        // Attach the custom pickers to the readonly fields.
        attachDatePicker(el.start);
        attachDatePicker(el.end);
        attachTimePicker(el.startTime);
        attachTimePicker(el.endTime);

        // Events.
        el.close.addEventListener('click', closePanel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('open') && !isRunning) closePanel();
        });
        el.logins.addEventListener('input', () => { persistInputs(); updateLoginCount(); });
        el.run.addEventListener('click', onRun);
        el.cancel.addEventListener('click', onCancel);
        el.download.addEventListener('click', onReDownload);
    }

    function persistInputs() {
        settings.logins = el.logins.value;
        settings.startDate = el.start.value;
        settings.endDate = el.end.value;
        settings.startTime = el.startTime.value;
        settings.endTime = el.endTime.value;
        saveSettings();
    }

    function updateLoginCount() {
        const n = parseLoginList(el.logins.value).length;
        el.count.textContent = `${n} login${n === 1 ? '' : 's'}`;
    }

    function openPanel() { el.overlay.classList.add('open'); }

    function closePanel() {
        if (isRunning) return; // don't close mid-run
        closeOpenPop();
        el.overlay.classList.remove('open');
    }

    // ── Progress rendering ──

    function updateProgressBar(completed, total) {
        el.barFill.style.width = (total ? Math.round((completed / total) * 100) : 0) + '%';
        el.counter.textContent = `${completed} / ${total}`;
    }

    function renderProgress(results) {
        el.list.innerHTML = '';
        results.forEach(r => {
            const row = document.createElement('div');
            row.className = 'aa-exp-row';
            // Retry is offered for failed/empty AAs that aren't mid-fetch.
            const canRetry = (r.status === 'error' || r.status === 'empty') && !r.retrying;
            const retryBtn = canRetry ? `<button class="aa-exp-retry" title="Re-fetch this AA">↻ Retry</button>` : '';
            row.innerHTML = `
                <span class="login">${escapeHtml(r.login)}</span>
                <span class="aa-exp-row-right">
                    <span class="aa-exp-badge st-${r.status}">${escapeHtml(r.statusLabel || r.status)}</span>
                    ${retryBtn}
                </span>`;
            const btn = row.querySelector('.aa-exp-retry');
            if (btn) btn.addEventListener('click', () => retryOneAA(r.login));
            el.list.appendChild(row);
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CUSTOM DATE / TIME PICKERS
    //   In-panel popups (not native <input type=date/time>, whose popups the
    //   host page can suppress). Fields stay readonly, holding MM/DD/YYYY and
    //   HH:MM:SS directly.
    // ═══════════════════════════════════════════════════════════════════════

    let openPop = null; // only one popup open at a time

    function closeOpenPop() {
        if (openPop && openPop.parentNode) openPop.parentNode.removeChild(openPop);
        openPop = null;
        document.removeEventListener('mousedown', onDocDownForPop, true);
    }

    function onDocDownForPop(e) {
        if (openPop && !openPop.contains(e.target) && !(openPop.anchor && openPop.anchor.contains(e.target))) {
            closeOpenPop();
        }
    }

    const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

    // Toggle a field's popup on mousedown (avoids the readonly-input focus race).
    function wireTrigger(input, open) {
        input.addEventListener('mousedown', (e) => {
            if (input.disabled) return;
            e.preventDefault();
            e.stopPropagation();
            if (openPop && openPop.anchor === input) closeOpenPop();
            else open();
        });
        input.addEventListener('keydown', (e) => {
            if (input.disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!(openPop && openPop.anchor === input)) open();
            }
        });
    }

    function makePopup(input) {
        const pop = document.createElement('div');
        pop.className = 'aa-pop';
        pop.anchor = input;
        if (/end/i.test(input.id)) pop.classList.add('right'); // anchor right half to the right edge
        return pop;
    }

    function showPopup(input, pop) {
        (input.closest('.aa-exp-pick') || input.parentNode).appendChild(pop);
        openPop = pop;
        setTimeout(() => document.addEventListener('mousedown', onDocDownForPop, true), 0);
    }

    function attachDatePicker(input) {
        const open = () => {
            closeOpenPop();
            const pop = makePopup(input);

            // Seed the visible month from the field's value, else today.
            let view;
            const cur = normalizeDateStr(input.value);
            if (cur) { const [mm, , yy] = cur.split('/').map(Number); view = new Date(yy, mm - 1, 1); }
            else { view = new Date(); view.setDate(1); }

            const setValue = (mm, dd, yy) => {
                input.value = `${pad2(mm)}/${pad2(dd)}/${yy}`;
                persistInputs();
                closeOpenPop();
            };

            const render = () => {
                const y = view.getFullYear();
                const m = view.getMonth();
                const startDow = new Date(y, m, 1).getDay();
                const daysInMonth = new Date(y, m + 1, 0).getDate();
                const prevDays = new Date(y, m, 0).getDate();
                const today = new Date();
                const selected = normalizeDateStr(input.value);

                let cells = '';
                for (let i = startDow - 1; i >= 0; i--) {
                    cells += `<button class="aa-cal-day other" disabled>${prevDays - i}</button>`;
                }
                for (let d = 1; d <= daysInMonth; d++) {
                    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
                    const isSel = selected === `${pad2(m + 1)}/${pad2(d)}/${y}`;
                    cells += `<button class="aa-cal-day${isToday ? ' today' : ''}${isSel ? ' sel' : ''}" data-d="${d}">${d}</button>`;
                }

                pop.innerHTML = `
                    <div class="aa-cal-head">
                        <button class="aa-cal-nav" data-nav="-1" title="Previous month">&#8249;</button>
                        <span class="aa-cal-title">${MONTHS[m]} ${y}</span>
                        <button class="aa-cal-nav" data-nav="1" title="Next month">&#8250;</button>
                    </div>
                    <div class="aa-cal-grid">
                        ${DOW.map(d => `<div class="aa-cal-dow">${d}</div>`).join('')}
                        ${cells}
                    </div>
                    <div class="aa-cal-foot">
                        <button data-act="today">Today</button>
                        <button data-act="clear">Clear</button>
                    </div>`;

                pop.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    view.setMonth(view.getMonth() + parseInt(b.dataset.nav, 10));
                    render();
                }));
                pop.querySelectorAll('.aa-cal-day[data-d]').forEach(b => b.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setValue(m + 1, parseInt(b.dataset.d, 10), y);
                }));
                pop.querySelector('[data-act="today"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    const t = new Date();
                    setValue(t.getMonth() + 1, t.getDate(), t.getFullYear());
                });
                pop.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    input.value = '';
                    persistInputs();
                    closeOpenPop();
                });
            };

            render();
            showPopup(input, pop);
        };

        wireTrigger(input, open);
    }

    function attachTimePicker(input) {
        const open = () => {
            closeOpenPop();
            const pop = makePopup(input);

            let h = 0, mi = 0, s = 0;
            const cur = normalizeTimeStr(input.value);
            if (cur) { const p = cur.split(':').map(Number); h = p[0]; mi = p[1]; s = p[2]; }

            const options = (count, sel) => {
                let o = '';
                for (let i = 0; i < count; i++) {
                    o += `<option value="${i}"${i === sel ? ' selected' : ''}>${pad2(i)}</option>`;
                }
                return o;
            };

            pop.innerHTML = `
                <div class="aa-time-row">
                    <select data-u="h" title="Hour">${options(24, h)}</select>
                    <span class="aa-time-sep">:</span>
                    <select data-u="m" title="Minute">${options(60, mi)}</select>
                    <span class="aa-time-sep">:</span>
                    <select data-u="s" title="Second">${options(60, s)}</select>
                </div>
                <div class="aa-time-foot">
                    <button class="aa-time-clear" data-act="clear">✕ Clear</button>
                    <button class="aa-time-done" data-act="done">Done</button>
                </div>`;

            const apply = () => {
                const hh = pop.querySelector('[data-u="h"]').value;
                const mm = pop.querySelector('[data-u="m"]').value;
                const ss = pop.querySelector('[data-u="s"]').value;
                input.value = `${pad2(+hh)}:${pad2(+mm)}:${pad2(+ss)}`;
                persistInputs();
            };

            pop.querySelectorAll('select').forEach(sel =>
                sel.addEventListener('change', (e) => { e.stopPropagation(); apply(); }));
            pop.querySelector('[data-act="done"]').addEventListener('click', (e) => {
                e.stopPropagation(); apply(); closeOpenPop();
            });
            pop.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
                e.stopPropagation();
                input.value = '';
                persistInputs();
                closeOpenPop();
            });

            showPopup(input, pop);
        };

        wireTrigger(input, open);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RUN / CANCEL / DOWNLOAD
    // ═══════════════════════════════════════════════════════════════════════

    // Validate + normalize inputs. Returns the run context, or null (after
    // flashing the bad field + toasting) on failure.
    function collectInputs() {
        const logins = parseLoginList(el.logins.value);
        const startDate = normalizeDateStr(el.start.value);
        const endDate = normalizeDateStr(el.end.value);

        const rawStartT = el.startTime.value.trim();
        const rawEndT = el.endTime.value.trim();
        const startTime = rawStartT ? normalizeTimeStr(rawStartT) : '';
        const endTime = rawEndT ? normalizeTimeStr(rawEndT) : '';

        if (!logins.length) { flashField(el.logins); toast('Enter at least one AA login.'); return null; }
        if (!startDate) { flashField(el.start); toast('Pick a start date.'); return null; }
        if (!endDate) { flashField(el.end); toast('Pick an end date.'); return null; }
        if (rawStartT && startTime === null) { flashField(el.startTime); toast('Start time must be 24h HH:MM:SS.'); return null; }
        if (rawEndT && endTime === null) { flashField(el.endTime); toast('End time must be 24h HH:MM:SS.'); return null; }
        if ((startTime && !endTime) || (!startTime && endTime)) {
            flashField(startTime ? el.endTime : el.startTime);
            toast('Enter both start and end time, or leave both blank.');
            return null;
        }
        if (parseEventTimestamp(startDate) > parseEventTimestamp(endDate)) {
            flashField(el.start); flashField(el.end);
            toast('Start date must be on or before end date.');
            return null;
        }
        if (typeof ExcelJS === 'undefined') {
            toast('ExcelJS did not load (check @require / network). Cannot export.');
            return null;
        }

        // Write the normalized values back.
        el.start.value = startDate;
        el.end.value = endDate;
        if (startTime) el.startTime.value = startTime;
        if (endTime) el.endTime.value = endTime;
        persistInputs();

        return {
            logins, startDate, endDate, startTime, endTime,
            window: buildWindow(startDate, endDate, startTime, endTime)
        };
    }

    async function onRun() {
        if (isRunning) return;

        const input = collectInputs();
        if (!input) return;
        const { logins, startDate, endDate, startTime, endTime, window } = input;
        const winLabel = windowLabel(startDate, endDate, startTime, endTime);

        isRunning = true;
        cancelRequested = false;
        lastResults = null;
        setRunningUI(true);
        el.progress.style.display = 'block';
        updateProgressBar(0, logins.length);

        let results;
        try {
            results = await runBatch(logins, startDate, endDate, window);
        } catch (e) {
            isRunning = false;
            setRunningUI(false);
            return toast('Run failed: ' + (e.message || e));
        }

        isRunning = false;
        setRunningUI(false);

        if (cancelRequested) { toast('Cancelled. Partial results not exported.'); return; }

        lastResults = { results, startDate, endDate, startTime, endTime, winLabel };
        el.download.disabled = false;

        if (!results.some(r => r.status === 'done')) {
            toast('No data found for any AA in that window.');
            return;
        }

        try {
            await buildAndDownloadWorkbook(results, startDate, endDate, startTime, endTime, winLabel);
            const ok = results.filter(r => r.status === 'done').length;
            toast(`Exported ${ok} AA sheet${ok === 1 ? '' : 's'} to Excel.`);
        } catch (e) {
            toast('Excel build failed: ' + (e.message || e));
        }
    }

    function onCancel() {
        if (!isRunning) return;
        cancelRequested = true;
        el.cancel.disabled = true;
        el.cancel.textContent = 'Cancelling…';
    }

    async function onReDownload() {
        if (!lastResults) return;
        try {
            await buildAndDownloadWorkbook(
                lastResults.results, lastResults.startDate, lastResults.endDate,
                lastResults.startTime, lastResults.endTime, lastResults.winLabel
            );
        } catch (e) {
            toast('Download failed: ' + (e.message || e));
        }
    }

    function setRunningUI(running) {
        el.run.disabled = running;
        el.cancel.disabled = !running;
        el.cancel.textContent = 'Cancel';
        el.logins.disabled = running;
        el.start.disabled = running;
        el.end.disabled = running;
        el.startTime.disabled = running;
        el.endTime.disabled = running;
        el.close.style.visibility = running ? 'hidden' : 'visible';
    }

    function flashField(node) {
        node.style.boxShadow = '0 0 0 3px rgba(239,68,68,.35)';
        node.style.borderColor = '#ef4444';
        setTimeout(() => { node.style.boxShadow = ''; node.style.borderColor = ''; }, 1200);
    }

    // ── Lightweight toast ──
    let toastTimer = null;
    function toast(msg) {
        let t = document.getElementById('aa-exp-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'aa-exp-toast';
            t.style.cssText =
                'position:fixed; bottom:90px; right:22px; z-index:2147483002; max-width:380px;' +
                'background:#232f3e; color:#fff; padding:14px 18px; border-radius:12px; font-size:15px;' +
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
                'box-shadow:0 8px 24px rgba(0,0,0,.35); opacity:0; transform:translateY(8px);' +
                'transition:opacity .25s, transform .25s; border-left:4px solid #ff9900;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; }, 4000);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BOOT
    // ═══════════════════════════════════════════════════════════════════════

    function boot() {
        loadSettings();
        buildUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
