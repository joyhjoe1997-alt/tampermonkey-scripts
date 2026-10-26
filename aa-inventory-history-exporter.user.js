// ==UserScript==
// @name         AA Inventory History Batch Exporter
// @namespace    http://tampermonkey.net/
// @version      1.2
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
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
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
    const VERSION = '1.2';
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

    // ── Picker <-> internal format bridges ──
    // Native <input type="date"> uses YYYY-MM-DD; our internal/stored format and
    // the FC Research #searchStart field use MM/DD/YYYY.
    function isoToUsDate(iso) {
        if (!iso) return '';
        const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
    }
    function usToIsoDate(us) {
        if (!us) return '';
        const m = String(us).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return '';
        return `${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    }
    // Native <input type="time" step="1"> gives HH:MM or HH:MM:SS; pad to HH:MM:SS.
    function padTime(t) {
        if (!t) return '';
        const parts = String(t).split(':');
        if (parts.length === 2) parts.push('00');
        return parts.map(p => String(p).padStart(2, '0')).join(':');
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
                d.row[GAP_COL] = prev ? formatGap(d.ts - prev) : '';
                prev = d.ts;
            } else {
                d.row[GAP_COL] = '';
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
    // SECTION 7: EXCEL WORKBOOK GENERATION (SheetJS)
    // ═══════════════════════════════════════════════════════════════
    function buildWorkbook(results, startDate, endDate, winLabel) {
        if (typeof XLSX === 'undefined') {
            throw new Error('SheetJS (XLSX) failed to load via @require.');
        }
        const wb = XLSX.utils.book_new();
        const nameSheet = makeSheetNamer();

        // ── Home / summary sheet ──
        const homeAoa = [
            ['AA Inventory History Export'],
            ['Window', winLabel || `${startDate}  →  ${endDate}`],
            ['Generated', fmtDateTime(new Date())],
            ['FC', FC_SEGMENT],
            [],
            ['Login', 'Sheet', 'Rows', 'First event', 'Last event', 'Total span', 'Status']
        ];

        const perAaSheets = []; // {sheetName, result}

        results.forEach(res => {
            let sheetName = '';
            let rowCount = 0;
            if (res.status === 'done' && res.data && res.data.rows.length) {
                sheetName = nameSheet(res.login);
                rowCount = res.data.rows.length;
                perAaSheets.push({ sheetName, result: res.data });
            }
            homeAoa.push([
                res.login,
                sheetName,
                rowCount,
                res.data ? res.data.firstEvent : '',
                res.data ? res.data.lastEvent : '',
                res.data ? res.data.totalSpan : '',
                res.statusLabel || res.status
            ]);
        });

        const homeWs = XLSX.utils.aoa_to_sheet(homeAoa);
        homeWs['!cols'] = [
            { wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 21 }, { wch: 21 }, { wch: 12 }, { wch: 28 }
        ];
        XLSX.utils.book_append_sheet(wb, homeWs, 'Home');

        // ── Per-AA sheets ──
        perAaSheets.forEach(({ sheetName, result }) => {
            const headers = result.headers;
            const aoa = [headers];
            result.rows.forEach(r => {
                aoa.push(headers.map(h => r[h] != null ? r[h] : ''));
            });
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            ws['!cols'] = headers.map(h => ({ wch: Math.min(Math.max(h.length + 2, 10), 40) }));
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
        });

        return wb;
    }

    function downloadWorkbook(wb, startDate, endDate, startTime, endTime) {
        const safe = (s) => String(s).replace(/[/:]/g, '-');
        const tPart = (startTime && endTime)
            ? `_${safe(startTime)}_${safe(endTime)}`
            : '';
        const fname = `AA_Inventory_History_${safe(startDate)}_to_${safe(endDate)}${tPart}.xlsx`;
        XLSX.writeFile(wb, fname);
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
                position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
                display: inline-flex; align-items: center; gap: 8px;
                padding: 11px 16px; border: none; border-radius: 10px; cursor: pointer;
                background: linear-gradient(135deg, #217346, #185c37); color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px; font-weight: 700; letter-spacing: .3px;
                box-shadow: 0 4px 14px rgba(33,115,70,.45); transition: all .2s ease;
            }
            #aa-exp-launch:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(33,115,70,.55); }
            #aa-exp-launch svg { width: 16px; height: 16px; }

            #aa-exp-overlay {
                position: fixed; inset: 0; z-index: 2147483001; display: none;
                background: rgba(15,23,42,.45); backdrop-filter: blur(2px);
                align-items: flex-start; justify-content: center;
            }
            #aa-exp-overlay.open { display: flex; }

            #aa-exp-panel {
                margin-top: 48px; width: 560px; max-width: calc(100vw - 32px);
                max-height: calc(100vh - 96px); overflow: auto;
                background: #fff; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.35);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #0f172a;
            }
            .aa-exp-head {
                display: flex; align-items: center; justify-content: space-between;
                padding: 16px 20px; border-bottom: 1px solid #e2e8f0;
                background: linear-gradient(135deg, #232f3e, #37475a); color: #fff;
                border-radius: 14px 14px 0 0;
            }
            .aa-exp-head h2 { margin: 0; font-size: 15px; font-weight: 700; display:flex; align-items:center; gap:8px; }
            .aa-exp-head .aa-exp-ver { font-size: 11px; color: #ff9900; font-weight: 700; }
            .aa-exp-close { background: none; border: none; color: #cbd5e1; font-size: 22px; cursor: pointer; line-height: 1; }
            .aa-exp-close:hover { color: #fff; }

            .aa-exp-body { padding: 18px 20px; }
            .aa-exp-field { margin-bottom: 16px; }
            .aa-exp-field label {
                display: block; font-size: 12px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .6px; color: #475569; margin-bottom: 6px;
            }
            .aa-exp-field textarea {
                width: 100%; box-sizing: border-box; min-height: 110px; resize: vertical;
                border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
            }
            .aa-exp-dates { display: flex; gap: 12px; flex-wrap: wrap; }
            .aa-exp-dates .aa-exp-field { flex: 1 1 calc(50% - 6px); min-width: 120px; margin-bottom: 0; }
            .aa-exp-field input[type=text],
            .aa-exp-field input[type=date],
            .aa-exp-field input[type=time] {
                width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 8px;
                padding: 9px 12px; font-size: 14px; text-align: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                color: #0f172a; background: #fff; min-height: 38px;
            }
            .aa-exp-field input[type=date]::-webkit-calendar-picker-indicator,
            .aa-exp-field input[type=time]::-webkit-calendar-picker-indicator {
                cursor: pointer; opacity: .6;
            }
            textarea:focus, input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
            .aa-exp-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; }

            .aa-exp-actions { display: flex; gap: 10px; margin-top: 20px; align-items: center; }
            .aa-exp-btn {
                display: inline-flex; align-items: center; gap: 7px; padding: 10px 18px;
                border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 700;
                transition: all .2s ease;
            }
            .aa-exp-btn.run { background: linear-gradient(135deg, #217346, #185c37); color: #fff; }
            .aa-exp-btn.run:hover { background: linear-gradient(135deg, #2d9b5e, #217346); }
            .aa-exp-btn.cancel { background: #fee2e2; color: #b91c1c; }
            .aa-exp-btn.cancel:hover { background: #fecaca; }
            .aa-exp-btn:disabled { opacity: .5; cursor: not-allowed; }
            .aa-exp-btn.ghost { background: #f1f5f9; color: #334155; }
            .aa-exp-btn.ghost:hover { background: #e2e8f0; }
            .aa-exp-btn.test { background: #eef2ff; color: #4338ca; }
            .aa-exp-btn.test:hover { background: #e0e7ff; }

            .aa-exp-preview {
                margin-top: 16px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;
                font-size: 12px;
            }
            .aa-exp-preview-head {
                display: flex; align-items: center; justify-content: space-between; gap: 8px;
                padding: 9px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
                font-weight: 700; color: #334155;
            }
            .aa-exp-preview-head .meta { font-weight: 600; color: #64748b; font-size: 11px; }
            .aa-exp-preview-scroll { max-height: 260px; overflow: auto; }
            .aa-exp-preview table { border-collapse: collapse; width: 100%; white-space: nowrap; }
            .aa-exp-preview th, .aa-exp-preview td {
                border-bottom: 1px solid #f1f5f9; border-right: 1px solid #f1f5f9;
                padding: 5px 9px; text-align: left; font-family: ui-monospace, Menlo, Consolas, monospace;
            }
            .aa-exp-preview th {
                position: sticky; top: 0; background: #eef2ff; color: #3730a3; font-weight: 700;
                border-bottom: 2px solid #c7d2fe;
            }
            .aa-exp-preview td { color: #0f172a; }
            .aa-exp-preview tr:nth-child(even) td { background: #fafafa; }
            .aa-exp-preview-empty { padding: 14px 12px; color: #0369a1; }
            .aa-exp-preview-error { padding: 14px 12px; color: #b91c1c; }

            .aa-exp-progress-wrap { margin-top: 18px; }
            .aa-exp-bar { height: 8px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
            .aa-exp-bar > div { height: 100%; width: 0%; background: linear-gradient(90deg, #0ea5e9, #2563eb); transition: width .25s ease; }
            .aa-exp-counter { font-size: 12px; color: #64748b; margin: 8px 0 4px; font-weight: 600; }

            .aa-exp-list { margin-top: 8px; border: 1px solid #e2e8f0; border-radius: 8px; max-height: 220px; overflow: auto; }
            .aa-exp-row {
                display: flex; align-items: center; justify-content: space-between;
                padding: 7px 12px; font-size: 12.5px; border-bottom: 1px solid #f1f5f9;
            }
            .aa-exp-row:last-child { border-bottom: none; }
            .aa-exp-row .login { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 600; }
            .aa-exp-badge { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
            .st-pending { background: #f1f5f9; color: #64748b; }
            .st-running { background: #fef3c7; color: #b45309; }
            .st-done    { background: #dcfce7; color: #15803d; }
            .st-empty   { background: #e0f2fe; color: #0369a1; }
            .st-error   { background: #fee2e2; color: #b91c1c; }

            .aa-exp-note { font-size: 11px; color: #94a3b8; margin-top: 12px; line-height: 1.5; }
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
                        <label>AA Logins</label>
                        <textarea id="aa-exp-logins" placeholder="Paste logins — one per line, or separated by space/comma&#10;e.g.&#10;joyhjoe&#10;asmith&#10;bwilliam"></textarea>
                        <div class="aa-exp-hint" id="aa-exp-count">0 logins</div>
                    </div>
                    <div class="aa-exp-dates">
                        <div class="aa-exp-field">
                            <label>Start date</label>
                            <input type="date" id="aa-exp-start">
                        </div>
                        <div class="aa-exp-field">
                            <label>Start time</label>
                            <input type="time" id="aa-exp-start-time" step="1">
                        </div>
                        <div class="aa-exp-field">
                            <label>End date</label>
                            <input type="date" id="aa-exp-end">
                        </div>
                        <div class="aa-exp-field">
                            <label>End time</label>
                            <input type="time" id="aa-exp-end-time" step="1">
                        </div>
                    </div>
                    <div class="aa-exp-hint">Same window is applied to every AA. Pick dates and 24h times (seconds supported). Leave both times blank for full days. If end time ≤ start time (e.g. 18:15:00 → 04:45:00) the window is treated as overnight (ends next day).</div>

                    <div class="aa-exp-actions">
                        <button class="aa-exp-btn run" id="aa-exp-run">
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3"/></svg>
                            Run &amp; Export
                        </button>
                        <button class="aa-exp-btn test" id="aa-exp-test" title="Fetch &amp; preview the first login only — no Excel">
                            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24"
                                 stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                            Test one AA
                        </button>
                        <button class="aa-exp-btn cancel" id="aa-exp-cancel" disabled>Cancel</button>
                        <button class="aa-exp-btn ghost" id="aa-exp-download" disabled title="Re-download last result">Download .xlsx</button>
                    </div>

                    <div class="aa-exp-preview" id="aa-exp-preview" style="display:none;"></div>

                    <div class="aa-exp-progress-wrap" id="aa-exp-progress" style="display:none;">
                        <div class="aa-exp-counter" id="aa-exp-counter">0 / 0</div>
                        <div class="aa-exp-bar"><div id="aa-exp-bar-fill"></div></div>
                        <div class="aa-exp-list" id="aa-exp-list"></div>
                    </div>

                    <div class="aa-exp-note">
                        Engine: <b>${ENGINE === 'A' ? 'Direct endpoint' : 'Hidden iframe (same-origin)'}</b> ·
                        Concurrency ${CONCURRENCY}. Data is pulled in the background; this panel stays open.
                        The workbook has a <b>Home</b> summary tab plus one tab per AA with a
                        <b>Gap (since prev)</b> column.
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
            test: overlay.querySelector('#aa-exp-test'),
            cancel: overlay.querySelector('#aa-exp-cancel'),
            download: overlay.querySelector('#aa-exp-download'),
            preview: overlay.querySelector('#aa-exp-preview'),
            progress: overlay.querySelector('#aa-exp-progress'),
            counter: overlay.querySelector('#aa-exp-counter'),
            barFill: overlay.querySelector('#aa-exp-bar-fill'),
            list: overlay.querySelector('#aa-exp-list'),
            close: overlay.querySelector('.aa-exp-close')
        };

        // Prefill from settings
        el.logins.value = settings.logins || '';
        el.start.value = usToIsoDate(settings.startDate || '');
        el.end.value = usToIsoDate(settings.endDate || '');
        el.startTime.value = settings.startTime || '';
        el.endTime.value = settings.endTime || '';
        updateLoginCount();

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
        el.test.addEventListener('click', onTest);
        el.cancel.addEventListener('click', onCancel);
        el.download.addEventListener('click', onReDownload);
    }

    function persistInputs() {
        settings.logins = el.logins.value;
        settings.startDate = isoToUsDate(el.start.value);
        settings.endDate = isoToUsDate(el.end.value);
        settings.startTime = el.startTime.value ? padTime(el.startTime.value) : '';
        settings.endTime = el.endTime.value ? padTime(el.endTime.value) : '';
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
    // SECTION 10: RUN / CANCEL / DOWNLOAD handlers
    // ═══════════════════════════════════════════════════════════════
    // Validate + normalize all inputs. On success returns
    //   { logins, startDate, endDate, startTime, endTime, window }
    // On failure, flashes the offending field, toasts a message, returns null.
    // `requireXlsx` adds the SheetJS-loaded check (used by Run, not Test).
    function collectInputs(requireXlsx) {
        const logins = parseLoginList(el.logins.value);
        // Date pickers give YYYY-MM-DD; convert to internal MM/DD/YYYY.
        const startDate = normalizeDateStr(isoToUsDate(el.start.value));
        const endDate = normalizeDateStr(isoToUsDate(el.end.value));

        // Times are optional, but if one is given the other must be too.
        // Time pickers give HH:MM or HH:MM:SS.
        const rawStartT = el.startTime.value.trim();
        const rawEndT = el.endTime.value.trim();
        const startTime = rawStartT ? normalizeTimeStr(padTime(rawStartT)) : '';
        const endTime = rawEndT ? normalizeTimeStr(padTime(rawEndT)) : '';

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

        if (requireXlsx && typeof XLSX === 'undefined') {
            toast('SheetJS did not load (check @require / network). Cannot export.');
            return null;
        }

        // Normalize back into the fields (date pickers want ISO).
        el.start.value = usToIsoDate(startDate);
        el.end.value = usToIsoDate(endDate);
        if (startTime) el.startTime.value = startTime;
        if (endTime) el.endTime.value = endTime;
        persistInputs();

        const window = buildWindow(startDate, endDate, startTime, endTime);
        return { logins, startDate, endDate, startTime, endTime, window };
    }

    // Test one AA: fetch + parse the FIRST login only, render a preview table.
    // No gap enrichment math beyond what the preview needs, and no Excel.
    async function onTest() {
        if (isRunning) return;

        const input = collectInputs(false);
        if (!input) return;
        const { logins, startDate, endDate, startTime, endTime, window } = input;

        const login = logins[0];
        const winLabel = fmtWindowLabel(startDate, endDate, startTime, endTime);

        isRunning = true;
        cancelRequested = false;
        setRunningUI(true);
        // During a single-AA test we DO allow cancel.
        el.cancel.disabled = false;

        el.progress.style.display = 'none';
        el.preview.style.display = 'block';
        el.preview.innerHTML = `
            <div class="aa-exp-preview-head">
                <span>Testing <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(login)}</span>…</span>
                <span class="meta">${escapeHtml(winLabel)}</span>
            </div>
            <div class="aa-exp-preview-empty">Fetching in the background…</div>`;

        let raw;
        try {
            raw = await fetchOneAA(login, startDate, endDate);
        } catch (e) {
            isRunning = false;
            setRunningUI(false);
            if (cancelRequested) { el.preview.style.display = 'none'; return toast('Test cancelled.'); }
            el.preview.innerHTML = `
                <div class="aa-exp-preview-head"><span>Test: ${escapeHtml(login)}</span></div>
                <div class="aa-exp-preview-error">Failed: ${escapeHtml((e && e.message) || String(e))}</div>`;
            return;
        }

        isRunning = false;
        setRunningUI(false);

        if (cancelRequested) { el.preview.style.display = 'none'; return toast('Test cancelled.'); }

        renderPreview(login, winLabel, window, raw);
    }

    function renderPreview(login, winLabel, window, raw) {
        if (!raw || !raw.rows || raw.rows.length === 0) {
            el.preview.innerHTML = `
                <div class="aa-exp-preview-head">
                    <span>Test: <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(login)}</span></span>
                    <span class="meta">${escapeHtml(winLabel)}</span>
                </div>
                <div class="aa-exp-preview-empty">No rows returned for this AA in that date range.
                    (${raw && raw.headers ? raw.headers.length : 0} column header${raw && raw.headers && raw.headers.length === 1 ? '' : 's'} detected.)
                </div>`;
            return;
        }

        const rawCount = raw.rows.length;

        // Run the real gap enrichment + window filter so the preview reflects
        // the exact export output.
        const enriched = enrichWithGaps(raw, window);
        const headers = enriched.headers;
        const rows = enriched.rows;

        if (rows.length === 0) {
            el.preview.innerHTML = `
                <div class="aa-exp-preview-head">
                    <span>Test: <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(login)}</span></span>
                    <span class="meta">${escapeHtml(winLabel)}</span>
                </div>
                <div class="aa-exp-preview-empty">${rawCount} row${rawCount === 1 ? '' : 's'} fetched, but none fall inside the time window.</div>`;
            return;
        }

        const PREVIEW_MAX = 8;
        const shown = rows.slice(0, PREVIEW_MAX);

        const thead = '<tr>' + headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
        const tbody = shown.map(r =>
            '<tr>' + headers.map(h => `<td>${escapeHtml(r[h] != null ? r[h] : '')}</td>`).join('') + '</tr>'
        ).join('');

        const tsHeader = findTimestampHeader(raw.headers);
        el.preview.innerHTML = `
            <div class="aa-exp-preview-head">
                <span>✓ <span style="font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(login)}</span>
                    — ${rows.length} row${rows.length === 1 ? '' : 's'}${window ? ` (of ${rawCount} fetched)` : ''}</span>
                <span class="meta">ts col: ${escapeHtml(tsHeader || 'n/a')} · span ${escapeHtml(enriched.totalSpan || '—')}</span>
            </div>
            <div class="aa-exp-preview-scroll">
                <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
            </div>
            ${rows.length > PREVIEW_MAX
                ? `<div class="aa-exp-preview-empty">Showing first ${PREVIEW_MAX} of ${rows.length} rows. Full data goes to the Excel export.</div>`
                : ''}`;
    }

    async function onRun() {
        if (isRunning) return;

        // A fresh run clears any lingering single-AA preview.
        el.preview.style.display = 'none';

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
            const wb = buildWorkbook(results, startDate, endDate, winLabel);
            downloadWorkbook(wb, startDate, endDate, startTime, endTime);
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

    function onReDownload() {
        if (!lastResults) return;
        try {
            const wb = buildWorkbook(lastResults.results, lastResults.startDate, lastResults.endDate, lastResults.winLabel);
            downloadWorkbook(wb, lastResults.startDate, lastResults.endDate, lastResults.startTime, lastResults.endTime);
        } catch (e) {
            toast('Download failed: ' + (e.message || e));
        }
    }

    function setRunningUI(running) {
        el.run.disabled = running;
        el.test.disabled = running;
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
