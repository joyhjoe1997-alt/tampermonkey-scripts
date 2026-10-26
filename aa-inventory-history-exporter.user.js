// ==UserScript==
// @name         AA Inventory History Batch Exporter
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Paste a list of AA logins + a date range, pull each AA's Inventory History (background, no navigation) and export a multi-sheet .xlsx (home summary + one sheet per AA).
// @author       joyhjoe
// @match        *://qi-fcresearch-eu.corp.amazon.com/*/results?s=*
// @match        *://qi-fcresearch-na.corp.amazon.com/*/results?s=*
// @match        *://fcresearch-eu.aka.amazon.com/*/results?s=*
// @match        *://qi-fcresearch-eu.corp.amazon.com/*
// @match        *://qi-fcresearch-na.corp.amazon.com/*
// @match        *://fcresearch-eu.aka.amazon.com/*
// @icon         https://cdn-icons-png.flaticon.com/512/4300/4300058.png
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      qi-fcresearch-eu.corp.amazon.com
// @connect      qi-fcresearch-na.corp.amazon.com
// @connect      fcresearch-eu.aka.amazon.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js
// ==/UserScript==

/*
 * ============================================================================
 *  AA INVENTORY HISTORY BATCH EXPORTER
 * ============================================================================
 *
 *  WHAT IT DOES
 *  ------------
 *  Adds a floating launcher + panel to the FC Research results page. You paste
 *  a list of AA logins, choose one start date and one end date, and the tool
 *  pulls every AA's Inventory History for that range WITHOUT navigating the
 *  current tab. Results are written to a single .xlsx workbook:
 *    - "Home"  : summary row per AA (login, rows, range, first/last event, span, status)
 *    - "<login>": one sheet per AA with the full Inventory History rows + a
 *                 computed "Gap (since prev)" column.
 *
 *  HOW THE FETCH WORKS  (Task 2 discovery result)
 *  ----------------------------------------------
 *  The Inventory History table (#table-inventory-history) is NOT present in the
 *  raw results HTML. It is rendered client-side after the page JS fires an AJAX
 *  request when the search button is clicked. A plain GM_xmlhttpRequest GET of
 *  /<FC>/results?s=<login> therefore returns a page with an EMPTY table.
 *
 *  Two ways to get real data:
 *
 *   PATH A (direct endpoint) - FASTEST, but requires knowing the internal
 *     endpoint the search button calls. To capture it: open the results page,
 *     open DevTools > Network, set a date range + click Search, and look for the
 *     XHR that returns the inventory-history rows. Record its METHOD, URL and
 *     params (login, start, end). Then fill in DIRECT_ENDPOINT below and set
 *     ENGINE = 'A'. parseDirectResponse() must be adapted to that payload shape.
 *
 *   PATH B (hidden iframe) - DEFAULT, always works. We create a hidden,
 *     same-origin <iframe> pointed at /<FC>/results?s=<login>. Because it is
 *     same-origin, the parent script can reach into iframe.contentDocument,
 *     set #searchStart / #searchEnd, click the search button, wait for the
 *     inventory-history status to leave "loading", then scrape
 *     #table-inventory-history. The top-level tab (and this panel) never move.
 *
 *  The engine is selected by ENGINE. Default 'B'. Flip to 'A' once you have
 *  captured a direct endpoint and implemented parseDirectResponse().
 *
 *  COLUMN MAPPING
 *  --------------
 *  Column order on the results page has historically been (per EU FC Research
 *  Augmentor): [0]=date/time, [1]=operation, [2]=reason, ... [9]=old bin,
 *  [10]=new bin, ... [13]=tool. Rather than hardcode, we read the <thead> and
 *  key each row by its header text, so the export survives column re-ordering.
 * ============================================================================
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // SECTION 0: GUARD — only run in the TOP window, never inside our
    // own hidden iframes (they load the same URL and would re-inject).
    // ═══════════════════════════════════════════════════════════════
    if (window.top !== window.self) {
        // We're inside an iframe. Mark it so the fetch engine can detect
        // readiness, but do NOT build any UI.
        try { window.__AA_EXPORTER_IFRAME__ = true; } catch (e) {}
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: CONFIG
    // ═══════════════════════════════════════════════════════════════
    const VERSION = '1.5';
    const STORAGE_KEY = 'aa_inv_exporter_settings_v1';
    const ORIGIN = location.origin;

    // Derive the FC segment from the current URL (e.g. "EMA4" from /EMA4/results?s=...)
    // Falls back to scanning the path for an all-caps token.
    function detectFcSegment() {
        const m = location.pathname.match(/^\/([^/]+)\/results/i);
        if (m) return m[1];
        const parts = location.pathname.split('/').filter(Boolean);
        return parts[0] || 'EMA4';
    }
    const FC_SEGMENT = detectFcSegment();

    // Engine selection: 'B' = hidden-iframe (default, always works),
    // 'A' = direct endpoint (fill DIRECT_ENDPOINT + parseDirectResponse first).
    const ENGINE = 'B';

    // Path A placeholder — fill after DevTools capture. Example shape:
    //   { method: 'GET', url: (login, startMMDDYYYY, endMMDDYYYY) => `${ORIGIN}/${FC_SEGMENT}/api/inventoryHistory?s=${login}&start=${...}&end=${...}` }
    const DIRECT_ENDPOINT = null;

    // Concurrency: iframes are heavy, keep this low. Direct endpoint can go higher.
    const CONCURRENCY = ENGINE === 'A' ? 5 : 2;

    // Per-AA timeout (ms) for a single inventory-history load.
    const AA_TIMEOUT_MS = 60000;

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
    let lastResults = null; // array of per-AA result objects from the last run

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: SETTINGS PERSISTENCE
    // ═══════════════════════════════════════════════════════════════
    function loadSettings() {
        try {
            const raw = GM_getValue(STORAGE_KEY, null);
            settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
        } catch (e) {
            settings = { ...DEFAULT_SETTINGS };
        }
        // Sensible date defaults: last 7 days.
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: DATE / UTIL HELPERS
    // ═══════════════════════════════════════════════════════════════

    // Matches formatDate() used by the existing Day-history scripts: MM/DD/YYYY.
    function formatDate(date) {
        return String(date.getMonth() + 1).padStart(2, '0') + '/' +
               String(date.getDate()).padStart(2, '0') + '/' +
               date.getFullYear();
    }

    // Validate/normalize an MM/DD/YYYY string → returns normalized string or null.
    function normalizeDateStr(s) {
        if (!s || typeof s !== 'string') return null;
        const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return null;
        const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10), yy = parseInt(m[3], 10);
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
        const d = new Date(yy, mm - 1, dd);
        if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
        return formatDate(d);
    }

    // Parse the inventory-history timestamp cell into a Date for gap math.
    // The results page renders timestamps like "YYYY-MM-DD HH:MM:SS" or
    // "MM/DD/YYYY HH:MM:SS" or "MM/DD-HH:MM:SS". Try several shapes; return
    // null if unparseable (gap column will be blank for that row).
    function parseEventTimestamp(str) {
        if (!str) return null;
        const s = String(str).trim();

        // ISO-ish: 2026-10-26 14:03:21  or 2026-10-26T14:03:21
        let m = s.match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));

        // US: 10/26/2026 14:03:21
        m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));

        // Short: 10/26-14:03:21  (assume current year)
        m = s.match(/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (m) return new Date(new Date().getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +(m[5] || 0));

        // Last resort: let Date try.
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    // Validate/normalize a 24-hour time string → "HH:MM:SS" or null.
    // Accepts H:MM, HH:MM, or HH:MM:SS. Seconds default to 00.
    function normalizeTimeStr(s) {
        if (!s || typeof s !== 'string') return null;
        const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m) return null;
        const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = m[3] != null ? parseInt(m[3], 10) : 0;
        if (hh > 23 || mm > 59 || ss > 59) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    }

    function timeParts(hhmmss) {
        const [h, m, s] = hhmmss.split(':').map(Number);
        return { h, m, s };
    }

    // Build the concrete [from, to] Date window for a run from the date + time
    // inputs. If endTime <= startTime it is treated as an overnight window, so
    // the end instant rolls to the day AFTER endDate (shift crossing midnight).
    // dateStr is MM/DD/YYYY, timeStr is HH:MM:SS. timeStr may be '' (no time
    // filtering → window is the whole start-of-startDate to end-of-endDate).
    function buildWindow(startDate, endDate, startTime, endTime) {
        const sd = startDate.split('/').map(Number);      // [MM, DD, YYYY]
        const ed = endDate.split('/').map(Number);

        let from, to;
        if (startTime && endTime) {
            const st = timeParts(startTime);
            const et = timeParts(endTime);
            from = new Date(sd[2], sd[0] - 1, sd[1], st.h, st.m, st.s);
            to = new Date(ed[2], ed[0] - 1, ed[1], et.h, et.m, et.s);
            // Overnight: end time is earlier than (or equal to) start time → next day.
            if (et.h * 3600 + et.m * 60 + et.s <= st.h * 3600 + st.m * 60 + st.s) {
                to.setDate(to.getDate() + 1);
            }
        } else {
            // No time filtering: full days.
            from = new Date(sd[2], sd[0] - 1, sd[1], 0, 0, 0);
            to = new Date(ed[2], ed[0] - 1, ed[1], 23, 59, 59);
        }
        return { from, to };
    }

    function fmtWindowLabel(startDate, endDate, startTime, endTime) {
        if (startTime && endTime) {
            return `${startDate} ${startTime} → ${endDate} ${endTime}`;
        }
        return `${startDate} → ${endDate}`;
    }

    // Map a gap in minutes to an ARGB fill color for Excel.
    //   ≤ 5 min   → green
    //   ≥ 60 min  → red
    //   between   → smooth green → yellow → orange → red ramp
    // Returns an 8-char ARGB hex string (ExcelJS fill format), or null for
    // no fill (empty/first-row gaps).
    const GAP_GREEN_MAX = 5;    // minutes: at/below → full green
    const GAP_RED_MIN = 60;     // minutes: at/above → full red
    function gapFillARGB(gapMin) {
        if (gapMin == null || isNaN(gapMin) || gapMin < 0) return null;

        // Normalize to 0..1 across the ramp.
        let t;
        if (gapMin <= GAP_GREEN_MAX) t = 0;
        else if (gapMin >= GAP_RED_MIN) t = 1;
        else t = (gapMin - GAP_GREEN_MAX) / (GAP_RED_MIN - GAP_GREEN_MAX);

        // Two-leg interpolation: green→yellow (t 0..0.5), yellow→red (t 0.5..1).
        // Green  #63BE7B (99,190,123), Yellow #FFEB84 (255,235,132), Red #F8696B (248,105,107)
        const lerp = (a, b, f) => Math.round(a + (b - a) * f);
        let r, g, b;
        if (t <= 0.5) {
            const f = t / 0.5;
            r = lerp(99, 255, f); g = lerp(190, 235, f); b = lerp(123, 132, f);
        } else {
            const f = (t - 0.5) / 0.5;
            r = lerp(255, 248, f); g = lerp(235, 105, f); b = lerp(132, 107, f);
        }
        const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
        return 'FF' + hex(r) + hex(g) + hex(b);
    }

    function formatGap(ms) {
        if (ms == null || isNaN(ms) || ms < 0) return '';
        const totalSec = Math.floor(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${pad(m)}:${pad(s)}`;
    }

    function uniqueNonEmpty(arr) {
        const seen = new Set();
        const out = [];
        for (const v of arr) {
            const t = String(v || '').trim();
            if (!t) continue;
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
        return out;
    }

    function parseLoginList(text) {
        // Split on commas, whitespace, semicolons, newlines.
        return uniqueNonEmpty(String(text || '').split(/[\s,;]+/));
    }

    // Excel sheet-name sanitizer: max 31 chars, strip [ ] : * ? / \, dedupe.
    function makeSheetNamer() {
        const used = new Set(['Home']);
        return function (raw) {
            let name = String(raw || 'AA').replace(/[\[\]:*?/\\]/g, '_').slice(0, 31);
            if (!name) name = 'AA';
            let candidate = name;
            let i = 2;
            while (used.has(candidate.toLowerCase())) {
                const suffix = '_' + i;
                candidate = name.slice(0, 31 - suffix.length) + suffix;
                i++;
            }
            used.add(candidate.toLowerCase());
            return candidate;
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: TABLE SCRAPING (shared by iframe engine)
    //   Reads #table-inventory-history from a given Document, mapping
    //   columns by header text. Returns { headers:[], rows:[{...}] }.
    // ═══════════════════════════════════════════════════════════════
    function scrapeInventoryTable(doc) {
        // DataTables splits header and body into separate scroll containers.
        // Prefer the split layout (used by the CSV script), fall back to a
        // plain <table id="table-inventory-history">.
        let headerCells = doc.querySelectorAll(
            '#table-inventory-history_wrapper .dataTables_scrollHead thead tr th'
        );
        let bodyRows = doc.querySelectorAll(
            '#table-inventory-history_wrapper .dataTables_scrollBody tbody tr'
        );

        if (!headerCells.length || !bodyRows.length) {
            const table = doc.getElementById('table-inventory-history');
            if (table) {
                headerCells = table.querySelectorAll('thead tr th');
                bodyRows = table.querySelectorAll('tbody tr');
            }
        }

        const headers = Array.from(headerCells)
            .map(th => (th.innerText || th.textContent || '').trim())
            .filter((h, i, a) => true); // keep positional alignment

        const rows = [];
        bodyRows.forEach(tr => {
            // Skip DataTables "empty" placeholder rows.
            if (tr.querySelector('td.dataTables_empty')) return;
            const cells = Array.from(tr.querySelectorAll('td'));
            if (!cells.length) return;
            const obj = {};
            cells.forEach((td, i) => {
                const key = headers[i] && headers[i].length ? headers[i] : `col${i}`;
                obj[key] = (td.innerText || td.textContent || '').trim();
            });
            rows.push(obj);
        });

        return { headers: headers.length ? headers : (rows[0] ? Object.keys(rows[0]) : []), rows };
    }

    // Identify which header is the timestamp column (for gap math + sorting).
    function findTimestampHeader(headers) {
        const prefer = ['date', 'time', 'timestamp', 'event time', 'date/time', 'datetime'];
        for (const p of prefer) {
            const hit = headers.find(h => h.toLowerCase().includes(p));
            if (hit) return hit;
        }
        // Fall back to the first column (historically the timestamp).
        return headers[0] || null;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: FETCH ENGINE — PATH B (hidden same-origin iframe)
    // ═══════════════════════════════════════════════════════════════

    function buildResultsUrl(login) {
        return `${ORIGIN}/${FC_SEGMENT}/results?s=${encodeURIComponent(login)}`;
    }

    // Wait helper.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Load one AA's inventory history via a hidden iframe.
    // Resolves with { rows, headers } or rejects on error/timeout.
    function fetchViaIframe(login, startDate, endDate) {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText =
                'position:fixed; width:1280px; height:900px; left:-10000px; top:-10000px; ' +
                'border:0; opacity:0; pointer-events:none;';
            iframe.src = buildResultsUrl(login);

            let settled = false;
            const cleanup = () => {
                try { iframe.remove(); } catch (e) {}
            };
            const done = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poll);
                cleanup();
                fn(arg);
            };

            const timer = setTimeout(() => {
                done(reject, new Error('Timed out loading ' + login));
            }, AA_TIMEOUT_MS);

            let phase = 'init';     // init → searching → waiting → scraping
            let searchFiredAt = 0;

            iframe.addEventListener('load', async () => {
                // 'load' can fire for the initial document and again if the app
                // triggers a reload; we only act once we can see the search field.
                try {
                    const doc = iframe.contentDocument;
                    if (!doc) return;
                } catch (e) {
                    return done(reject, new Error('Cross-origin iframe for ' + login));
                }
            });

            // Poll the iframe's document for the controls and the loaded table.
            const poll = setInterval(async () => {
                if (cancelRequested) return done(reject, new Error('Cancelled'));
                let doc;
                try { doc = iframe.contentDocument; } catch (e) { return; }
                if (!doc) return;

                const startEl = doc.getElementById('searchStart');
                const endEl = doc.getElementById('searchEnd');

                // PHASE: init — wait for the date inputs + search button, then fire search.
                if (phase === 'init') {
                    if (!startEl) return; // not ready yet
                    const searchBtn = findSearchButton(doc);
                    if (!searchBtn) return;

                    startEl.value = startDate;
                    if (endEl && endDate) endEl.value = endDate;

                    // Fire input/change so any listeners pick up the new values.
                    ['input', 'change'].forEach(evt => {
                        startEl.dispatchEvent(new Event(evt, { bubbles: true }));
                        if (endEl) endEl.dispatchEvent(new Event(evt, { bubbles: true }));
                    });

                    searchBtn.click();
                    searchFiredAt = Date.now();
                    phase = 'waiting';
                    return;
                }

                // PHASE: waiting — wait for load to complete, then scrape.
                if (phase === 'waiting') {
                    // Give the click a moment to kick off the request.
                    if (Date.now() - searchFiredAt < 400) return;

                    const status = doc.getElementById('inventory-history-status');
                    const stillLoading = status && /(^|\s)loading(\s|$)/.test(status.className);
                    const filterReady = doc.getElementById('table-inventory-history_filter');
                    const table = doc.getElementById('table-inventory-history');

                    // Ready when: status present and not loading, OR the filter UI
                    // (built by DataTables after data loads) exists, OR a populated
                    // table body is present.
                    const hasRows = table && table.querySelector('tbody tr td:not(.dataTables_empty)');

                    if ((status && !stillLoading) || filterReady || hasRows) {
                        // Small settle delay so DataTables finishes painting rows.
                        phase = 'scraping';
                        setTimeout(() => {
                            try {
                                const result = scrapeInventoryTable(iframe.contentDocument);
                                done(resolve, result);
                            } catch (e) {
                                done(reject, e);
                            }
                        }, 600);
                    }
                    return;
                }
            }, 300);

            document.body.appendChild(iframe);
        });
    }

    // Locate the inventory-history search button inside a document.
    function findSearchButton(doc) {
        // Preferred: the declarative action attribute used across FC scripts.
        const decl = doc.querySelector('[data-action="inventory-history-search-button"]');
        if (decl) {
            // The clickable element is usually an <input>/<button> inside it.
            const inner = decl.querySelector('input,button,a,span');
            return inner || decl;
        }
        // Fallback: the a-button span pattern the Day scripts click.
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5A: FETCH ENGINE — PATH A (direct endpoint) [stub]
    // ═══════════════════════════════════════════════════════════════
    function gmRequest(method, url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method, url,
                headers: { 'Accept': 'application/json, text/html, */*' },
                timeout: AA_TIMEOUT_MS,
                onload: (r) => (r.status >= 200 && r.status < 400) ? resolve(r) : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timeout'))
            });
        });
    }

    // Adapt this once a direct endpoint is captured (see header PATH A notes).
    function parseDirectResponse(/* responseText */) {
        throw new Error('Path A not configured. Capture the endpoint and implement parseDirectResponse().');
    }

    async function fetchViaDirect(login, startDate, endDate) {
        if (!DIRECT_ENDPOINT) throw new Error('DIRECT_ENDPOINT not set');
        const url = DIRECT_ENDPOINT.url(login, startDate, endDate);
        const r = await gmRequest(DIRECT_ENDPOINT.method || 'GET', url);
        return parseDirectResponse(r.responseText);
    }

    // Unified single-AA fetch.
    function fetchOneAA(login, startDate, endDate) {
        return ENGINE === 'A'
            ? fetchViaDirect(login, startDate, endDate)
            : fetchViaIframe(login, startDate, endDate);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: TIME-DIFFERENCE COMPUTATION
    //   Sort rows by timestamp, add "Gap (since prev)" column, and
    //   compute first/last event + total span for the summary.
    // ═══════════════════════════════════════════════════════════════
    // `window` is an optional { from: Date, to: Date }. When present, rows whose
    // parsed timestamp falls outside [from, to] are dropped before gap math.
    // Rows with an unparseable timestamp are kept only when no window is given.
    function enrichWithGaps(result, window) {
        const { headers } = result;
        const tsHeader = findTimestampHeader(headers);

        // Attach a parsed Date to each row for sorting (non-destructive key).
        let decorated = result.rows.map(r => ({
            row: r,
            ts: tsHeader ? parseEventTimestamp(r[tsHeader]) : null
        }));

        // Apply the time window filter if one was supplied.
        if (window && window.from && window.to) {
            decorated = decorated.filter(d =>
                d.ts && d.ts.getTime() >= window.from.getTime() && d.ts.getTime() <= window.to.getTime()
            );
        }

        // Sort ascending by timestamp when available; rows without a timestamp
        // keep their original relative order at the end.
        decorated.sort((a, b) => {
            if (a.ts && b.ts) return a.ts - b.ts;
            if (a.ts) return -1;
            if (b.ts) return 1;
            return 0;
        });

        const GAP_COL = 'Gap (since prev)';
        let prev = null;
        let firstTs = null, lastTs = null;
        decorated.forEach(d => {
            if (d.ts) {
                if (!firstTs) firstTs = d.ts;
                lastTs = d.ts;
                if (prev) {
                    const deltaMs = d.ts - prev;
                    d.row[GAP_COL] = formatGap(deltaMs);
                    // Numeric gap in minutes for Excel color-coding (non-exported key).
                    d.row.__gapMin = deltaMs / 60000;
                } else {
                    d.row[GAP_COL] = '';
                    d.row.__gapMin = null;
                }
                prev = d.ts;
            } else {
                d.row[GAP_COL] = '';
                d.row.__gapMin = null;
            }
        });

        const outHeaders = headers.slice();
        if (!outHeaders.includes(GAP_COL)) outHeaders.push(GAP_COL);

        return {
            headers: outHeaders,
            rows: decorated.map(d => d.row),
            firstEvent: firstTs ? fmtDateTime(firstTs) : '',
            lastEvent: lastTs ? fmtDateTime(lastTs) : '',
            totalSpan: (firstTs && lastTs) ? formatGap(lastTs - firstTs) : ''
        };
    }

    function fmtDateTime(d) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: EXCEL WORKBOOK GENERATION (ExcelJS — supports fills)
    //   ExcelJS is used instead of SheetJS because the free SheetJS
    //   community build cannot write cell background colors. The
    //   "Gap (since prev)" column is color-coded green→red by gap size.
    // ═══════════════════════════════════════════════════════════════
    const GAP_COL = 'Gap (since prev)';

    // Build the workbook AND trigger the download. Async because ExcelJS
    // serializes to a buffer asynchronously.
    async function buildAndDownloadWorkbook(results, startDate, endDate, startTime, endTime, winLabel) {
        if (typeof ExcelJS === 'undefined') {
            throw new Error('ExcelJS failed to load via @require.');
        }
        const wb = new ExcelJS.Workbook();
        wb.creator = 'AA Inventory History Exporter';
        wb.created = new Date();
        const nameSheet = makeSheetNamer();

        // ── Home / summary sheet ──
        const home = wb.addWorksheet('Home');
        const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF232F3E' } };
        const headerFont = { bold: true, color: { argb: 'FFFFFFFF' } };

        home.addRow(['AA Inventory History Export']);
        home.addRow(['Window', winLabel || `${startDate}  →  ${endDate}`]);
        home.addRow(['Generated', fmtDateTime(new Date())]);
        home.addRow(['FC', FC_SEGMENT]);
        home.addRow([]);
        const homeHeaderRow = home.addRow(['Login', 'Sheet', 'Rows', 'First event', 'Last event', 'Total span', 'Status']);
        homeHeaderRow.eachCell(c => { c.fill = headerFill; c.font = headerFont; });
        home.getRow(1).font = { bold: true, size: 14 };

        const perAaSheets = []; // {sheetName, result}
        results.forEach(res => {
            let sheetName = '';
            let rowCount = 0;
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

        // ── Per-AA sheets ──
        perAaSheets.forEach(({ sheetName, result }) => {
            const headers = result.headers;
            const ws = wb.addWorksheet(sheetName);
            const gapIdx = headers.indexOf(GAP_COL); // 0-based; ExcelJS cols are 1-based

            // Header row.
            const hr = ws.addRow(headers);
            hr.eachCell(c => { c.fill = headerFill; c.font = headerFont; });

            // Data rows.
            result.rows.forEach(r => {
                const row = ws.addRow(headers.map(h => (r[h] != null ? r[h] : '')));
                // Color-code the gap cell from its numeric minutes.
                if (gapIdx >= 0) {
                    const argb = gapFillARGB(r.__gapMin);
                    if (argb) {
                        const cell = row.getCell(gapIdx + 1);
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
                        // Dark text on pale greens, near-black everywhere keeps it readable.
                        cell.font = { color: { argb: 'FF1A1A1A' }, bold: true };
                        cell.alignment = { horizontal: 'center' };
                    }
                }
            });

            // Set widths without reassigning ws.columns (which would run after
            // rows are added and can disturb data). Iterate the column getters.
            headers.forEach((h, i) => {
                ws.getColumn(i + 1).width = Math.min(Math.max(h.length + 2, 10), 40);
            });
            ws.views = [{ state: 'frozen', ySplit: 1 }]; // freeze header row
        });

        // ── Serialize + download ──
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8: BATCH RUNNER (concurrency + progress + cancel)
    // ═══════════════════════════════════════════════════════════════
    async function runBatch(logins, startDate, endDate, window) {
        // Per-AA result record.
        const results = logins.map(login => ({
            login,
            status: 'pending',       // pending | running | done | empty | error
            statusLabel: 'Pending',
            data: null,
            error: null
        }));

        renderProgress(results);

        let index = 0;
        let completed = 0;
        const total = results.length;

        async function worker() {
            while (index < results.length) {
                if (cancelRequested) return;
                const i = index++;
                const rec = results[i];
                rec.status = 'running';
                rec.statusLabel = 'Running…';
                renderProgress(results);

                try {
                    const raw = await fetchOneAA(rec.login, startDate, endDate);
                    if (!raw || !raw.rows || raw.rows.length === 0) {
                        rec.status = 'empty';
                        rec.statusLabel = 'No rows in range';
                        rec.data = { headers: raw ? raw.headers : [], rows: [], firstEvent: '', lastEvent: '', totalSpan: '' };
                    } else {
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
                } catch (e) {
                    rec.status = cancelRequested ? 'error' : 'error';
                    rec.statusLabel = (e && e.message) ? e.message : 'Failed';
                    rec.error = e;
                }
                completed++;
                updateProgressBar(completed, total);
                renderProgress(results);
            }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, results.length) }, () => worker());
        await Promise.all(workers);

        return results;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: UI — launcher + panel
    // ═══════════════════════════════════════════════════════════════
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
                margin-top: 5vh; width: 680px; max-width: calc(100vw - 32px);
                max-height: 90vh; overflow: auto;
                background: #fff; border-radius: 20px;
                box-shadow: 0 30px 80px rgba(0,0,0,.45);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #0f172a; animation: aaExpPop .22s cubic-bezier(.2,.8,.2,1);
            }
            @keyframes aaExpPop { from { transform: translateY(14px) scale(.98); opacity: .6; } to { transform: none; opacity: 1; } }

            .aa-exp-head {
                display: flex; align-items: center; justify-content: space-between;
                padding: 22px 28px;
                background: linear-gradient(135deg, #232f3e 0%, #37475a 100%); color: #fff;
                border-radius: 20px 20px 0 0;
            }
            .aa-exp-head h2 { margin: 0; font-size: 21px; font-weight: 800; display:flex; align-items:center; gap:11px; letter-spacing:.2px; }
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

            /* ── Custom popup (calendar / time) ── */
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
            .aa-time-foot button {
                border: none; background: none; font-size: 14px; font-weight: 700; cursor: pointer; padding: 4px 6px;
            }
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
            .aa-exp-badge { font-size: 13px; font-weight: 800; padding: 3px 12px; border-radius: 999px; }
            .st-pending { background: #f1f5f9; color: #64748b; }
            .st-running { background: #fef3c7; color: #b45309; }
            .st-done    { background: #dcfce7; color: #15803d; }
            .st-empty   { background: #e0f2fe; color: #0369a1; }
            .st-error   { background: #fee2e2; color: #b91c1c; }
        `;
        document.head.appendChild(style);
    }

    let el = {}; // cached UI element refs

    function buildUI() {
        injectStyles();

        // Launcher
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

        // Overlay + panel
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
                        <div class="aa-exp-field aa-exp-pick" id="aa-exp-start-wrap">
                            <label>Start date</label>
                            <input type="text" id="aa-exp-start" placeholder="MM/DD/YYYY" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick" id="aa-exp-start-time-wrap">
                            <label>Start time</label>
                            <input type="text" id="aa-exp-start-time" placeholder="HH:MM:SS" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick" id="aa-exp-end-wrap">
                            <label>End date</label>
                            <input type="text" id="aa-exp-end" placeholder="MM/DD/YYYY" readonly autocomplete="off">
                        </div>
                        <div class="aa-exp-field aa-exp-pick" id="aa-exp-end-time-wrap">
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

        // Cache refs
        el = {
            overlay,
            panel: overlay.querySelector('#aa-exp-panel'),
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

        // Prefill from settings
        el.logins.value = settings.logins || '';
        el.start.value = settings.startDate || '';
        el.end.value = settings.endDate || '';
        el.startTime.value = settings.startTime || '';
        el.endTime.value = settings.endTime || '';
        updateLoginCount();

        // Wire the custom date/time pickers onto the four readonly fields.
        attachDatePicker(el.start);
        attachDatePicker(el.end);
        attachTimePicker(el.startTime);
        attachTimePicker(el.endTime);

        // Events
        el.close.addEventListener('click', closePanel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('open') && !isRunning) closePanel();
        });

        el.logins.addEventListener('input', () => { persistInputs(); updateLoginCount(); });
        el.start.addEventListener('input', persistInputs);
        el.end.addEventListener('input', persistInputs);
        el.startTime.addEventListener('input', persistInputs);
        el.endTime.addEventListener('input', persistInputs);

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

    function openPanel() {
        el.overlay.classList.add('open');
    }
    function closePanel() {
        if (isRunning) return; // don't close mid-run
        closeOpenPop();
        el.overlay.classList.remove('open');
    }

    // ── Progress rendering ──
    function updateProgressBar(completed, total) {
        const pct = total ? Math.round((completed / total) * 100) : 0;
        el.barFill.style.width = pct + '%';
        el.counter.textContent = `${completed} / ${total}`;
    }

    function renderProgress(results) {
        el.list.innerHTML = '';
        results.forEach(r => {
            const row = document.createElement('div');
            row.className = 'aa-exp-row';
            const cls = 'st-' + r.status;
            row.innerHTML = `
                <span class="login">${escapeHtml(r.login)}</span>
                <span class="aa-exp-badge ${cls}">${escapeHtml(r.statusLabel || r.status)}</span>`;
            el.list.appendChild(row);
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9B: CUSTOM DATE / TIME PICKERS
    //   Self-contained popups rendered inside the panel — do not rely
    //   on native <input type=date/time> popups, which the host page
    //   can suppress. Fields stay readonly text holding MM/DD/YYYY and
    //   HH:MM:SS directly.
    // ═══════════════════════════════════════════════════════════════

    // Only one popup open at a time.
    let openPop = null;
    function closeOpenPop() {
        if (openPop && openPop.parentNode) openPop.parentNode.removeChild(openPop);
        openPop = null;
        document.removeEventListener('mousedown', onDocDownForPop, true);
    }
    function onDocDownForPop(e) {
        if (openPop && !openPop.contains(e.target) && !(openPop.__anchor && openPop.__anchor.contains(e.target))) {
            closeOpenPop();
        }
    }

    const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

    function attachDatePicker(input) {
        const open = () => {
            closeOpenPop();
            const wrap = input.closest('.aa-exp-pick') || input.parentNode;
            const pop = document.createElement('div');
            pop.className = 'aa-pop';
            pop.__anchor = input;
            // If this is an "end" field on the right half, anchor the popup to the right edge.
            if (/end/i.test(input.id)) pop.classList.add('right');

            // Seed view month from current value or today.
            let view;
            const cur = normalizeDateStr(input.value);
            if (cur) {
                const [mm, dd, yy] = cur.split('/').map(Number);
                view = new Date(yy, mm - 1, 1);
            } else {
                view = new Date();
                view.setDate(1);
            }

            const render = () => {
                const y = view.getFullYear();
                const m = view.getMonth();
                const first = new Date(y, m, 1);
                const startDow = first.getDay();
                const daysInMonth = new Date(y, m + 1, 0).getDate();
                const today = new Date();
                const selected = normalizeDateStr(input.value);

                let cells = '';
                // Leading blanks from previous month
                const prevDays = new Date(y, m, 0).getDate();
                for (let i = startDow - 1; i >= 0; i--) {
                    cells += `<button class="aa-cal-day other" disabled>${prevDays - i}</button>`;
                }
                for (let d = 1; d <= daysInMonth; d++) {
                    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
                    const ds = `${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
                    const isSel = selected === ds;
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
                    const d = parseInt(b.dataset.d, 10);
                    input.value = `${String(m + 1).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
                    persistInputs();
                    closeOpenPop();
                }));
                pop.querySelector('[data-act="today"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    const t = new Date();
                    input.value = `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
                    persistInputs();
                    closeOpenPop();
                });
                pop.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    input.value = '';
                    persistInputs();
                    closeOpenPop();
                });
            };

            render();
            wrap.appendChild(pop);
            openPop = pop;
            setTimeout(() => document.addEventListener('mousedown', onDocDownForPop, true), 0);
        };

        wireTrigger(input, open);
    }

    function attachTimePicker(input) {
        const open = () => {
            closeOpenPop();
            const wrap = input.closest('.aa-exp-pick') || input.parentNode;
            const pop = document.createElement('div');
            pop.className = 'aa-pop';
            pop.__anchor = input;
            if (/end/i.test(input.id)) pop.classList.add('right');

            // Seed from current value or 00:00:00.
            let h = 0, mi = 0, s = 0;
            const cur = normalizeTimeStr(input.value);
            if (cur) { const p = cur.split(':').map(Number); h = p[0]; mi = p[1]; s = p[2]; }

            const opts = (n, sel) => {
                let o = '';
                for (let i = 0; i < n; i++) {
                    o += `<option value="${i}"${i === sel ? ' selected' : ''}>${String(i).padStart(2, '0')}</option>`;
                }
                return o;
            };

            pop.innerHTML = `
                <div class="aa-time-row">
                    <select data-u="h" title="Hour">${opts(24, h)}</select>
                    <span class="aa-time-sep">:</span>
                    <select data-u="m" title="Minute">${opts(60, mi)}</select>
                    <span class="aa-time-sep">:</span>
                    <select data-u="s" title="Second">${opts(60, s)}</select>
                </div>
                <div class="aa-time-foot">
                    <button class="aa-time-clear" data-act="clear">✕ Clear</button>
                    <button class="aa-time-done" data-act="done">Done</button>
                </div>`;

            const apply = () => {
                const hh = pop.querySelector('[data-u="h"]').value;
                const mm = pop.querySelector('[data-u="m"]').value;
                const ss = pop.querySelector('[data-u="s"]').value;
                input.value = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
                persistInputs();
            };

            pop.querySelectorAll('select').forEach(sel => sel.addEventListener('change', (e) => { e.stopPropagation(); apply(); }));
            pop.querySelector('[data-act="done"]').addEventListener('click', (e) => { e.stopPropagation(); apply(); closeOpenPop(); });
            pop.querySelector('[data-act="clear"]').addEventListener('click', (e) => {
                e.stopPropagation();
                input.value = '';
                persistInputs();
                closeOpenPop();
            });

            wrap.appendChild(pop);
            openPop = pop;
            setTimeout(() => document.addEventListener('mousedown', onDocDownForPop, true), 0);
        };

        wireTrigger(input, open);
    }

    // Shared trigger: toggle the popup on mousedown. Using mousedown (capture)
    // and preventing default avoids the readonly-input focus race and any host
    // page handlers. A field that already owns the open popup toggles closed.
    function wireTrigger(input, open) {
        input.addEventListener('mousedown', (e) => {
            if (input.disabled) return;
            e.preventDefault();
            e.stopPropagation();
            const ownsOpen = openPop && openPop.__anchor === input;
            if (ownsOpen) { closeOpenPop(); } else { open(); }
        });
        // Keyboard access: Enter/Space opens.
        input.addEventListener('keydown', (e) => {
            if (input.disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!(openPop && openPop.__anchor === input)) open();
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: RUN / CANCEL / DOWNLOAD handlers
    // ═══════════════════════════════════════════════════════════════
    // Validate + normalize all inputs. On success returns
    //   { logins, startDate, endDate, startTime, endTime, window }
    // On failure, flashes the offending field, toasts a message, returns null.
    // `requireXlsx` adds the ExcelJS-loaded check (used by Run, not Test).
    function collectInputs(requireXlsx) {
        const logins = parseLoginList(el.logins.value);
        // Fields hold the internal formats directly (MM/DD/YYYY and HH:MM:SS).
        const startDate = normalizeDateStr(el.start.value);
        const endDate = normalizeDateStr(el.end.value);

        // Times are optional, but if one is given the other must be too.
        const rawStartT = el.startTime.value.trim();
        const rawEndT = el.endTime.value.trim();
        const startTime = rawStartT ? normalizeTimeStr(rawStartT) : '';
        const endTime = rawEndT ? normalizeTimeStr(rawEndT) : '';

        if (!logins.length) { flashField(el.logins); toast('Enter at least one AA login.'); return null; }
        if (!startDate) { flashField(el.start); toast('Pick a start date.'); return null; }
        if (!endDate) { flashField(el.end); toast('Pick an end date.'); return null; }

        if (rawStartT && startTime === null) { flashField(el.startTime); toast('Start time must be 24h HH:MM:SS (e.g. 18:15:00).'); return null; }
        if (rawEndT && endTime === null) { flashField(el.endTime); toast('End time must be 24h HH:MM:SS (e.g. 04:45:00).'); return null; }
        if ((startTime && !endTime) || (!startTime && endTime)) {
            flashField(startTime ? el.endTime : el.startTime);
            toast('Enter both start and end time, or leave both blank.');
            return null;
        }

        // Date-only ordering check (the time/overnight logic lives in buildWindow).
        if (parseEventTimestamp(startDate) > parseEventTimestamp(endDate)) {
            flashField(el.start); flashField(el.end);
            toast('Start date must be on or before end date.');
            return null;
        }

        if (requireXlsx && typeof ExcelJS === 'undefined') {
            toast('ExcelJS did not load (check @require / network). Cannot export.');
            return null;
        }

        // Normalize back into the fields.
        el.start.value = startDate;
        el.end.value = endDate;
        if (startTime) el.startTime.value = startTime;
        if (endTime) el.endTime.value = endTime;
        persistInputs();

        const window = buildWindow(startDate, endDate, startTime, endTime);
        return { logins, startDate, endDate, startTime, endTime, window };
    }

    async function onRun() {
        if (isRunning) return;

        const input = collectInputs(true);
        if (!input) return;
        const { logins, startDate, endDate, startTime, endTime, window } = input;
        const winLabel = fmtWindowLabel(startDate, endDate, startTime, endTime);

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

        if (cancelRequested) {
            toast('Cancelled. Partial results not exported.');
            return;
        }

        lastResults = { results, startDate, endDate, startTime, endTime, winLabel };
        el.download.disabled = false;

        const anyData = results.some(r => r.status === 'done');
        if (!anyData) {
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
                'position:fixed; bottom:72px; right:18px; z-index:2147483002; max-width:360px;' +
                'background:#232f3e; color:#fff; padding:12px 16px; border-radius:10px; font-size:13px;' +
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

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: BOOT
    // ═══════════════════════════════════════════════════════════════
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
