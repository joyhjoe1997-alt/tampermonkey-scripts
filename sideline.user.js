// ==UserScript==
// @name         Sideline - Multi-Tote Deletion Automation
// @author       joyhjoe
// @version      7.8
// @description  Automated tote processing for AFT Poirot V3 with multi-item price lookup
// @match        https://aft-poirot-website-dub.dub.proxy.amazon.com/*
// @match        https://river-dub.amazon.com/*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @updateURL    https://github.com/joyhjoe1997-alt/tampermonkey-scripts/raw/main/sideline.user.js
// @downloadURL  https://github.com/joyhjoe1997-alt/tampermonkey-scripts/raw/main/sideline.user.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      amazon.co.uk
// @connect      qi-fcresearch-eu.corp.amazon.com
// @connect      github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

/**
 * SIDELINE v7.8 - AFT Poirot Tote Automation
 *
 * Features:
 *   - Paste tote IDs, auto-processes them sequentially
 *   - Background-tab safe: polling runs off a Web Worker ticker so the
 *     automation keeps progressing when the tab is unfocused/backgrounded
 *   - In-script update checker: compares @version against the GitHub raw file
 *     and shows an "Install update" banner when a newer version is published
 *   - Silent duplicate removal on Load List (persists across reloads)
 *   - Detects blocking scan errors (e.g. Reverse Logistics) instantly and
 *     shows a "Cannot Process" skip/stop dialog
 *   - Reads all items (FNSKU/ASIN + qty) from the Change Container page,
 *     auto-clicking "Load All Rows" first so capped lists (e.g. 25 of 27)
 *     fully expand before reading — otherwise rows are missed downstream
 *   - Resolves X0 FNSKUs to ASINs via FC Research /results/product API
 *   - Prices use a fallback chain: FC Research "List Price" first, then the
 *     live Amazon.co.uk price, and "NIL" if neither returns a usable value
 *     (parallel batches of 3; source shown per row)
 *   - Shows confirmation dialog with item table, prices, and grand total
 *   - Skips vt/pa/numeric totes with warning
 *   - High quantity (>100) warning before emptying
 *   - High-value totes (>£1,000) show a "Create DL" button that opens the
 *     river-dub Large Adjustment SIM in a new tab and auto-selects the matching
 *     threshold band (value/units -> adjustmentType radio; UNRECEIVE excluded).
 *     After the user clicks "Confirm & Continue", step 2 is auto-filled:
 *     Tool=Sideline, Container=tote, ASIN=first row, Qty=units, Value=round(gt).
 *     The adjustment Comment is built from FC Research (Inventory History rows
 *     where OP=A & RS=A, joined to Receive History POs on FNSKU) on the Poirot
 *     tab before the SIM opens. Root Cause + its comment stay manual; nothing
 *     is auto-submitted.
 *   - Persists progress across page reloads (skip = refresh + auto-resume)
 *   - Draggable, collapsible floating panel
 *
 * Flow per tote:
 *   1. Wait for scan page -> fill tote ID -> press Enter
 *   2. Wait for Change Container page to load
 *   3. Read all items from rendered alchemy-tag elements
 *   4. Resolve FNSKUs via FC Research, fetch Amazon prices in parallel
 *   5. Show confirmation dialog with price table
 *   6. On "Yes" -> click Change Container -> click Yes popup -> next tote
 *   7. On "Skip" -> save state, reload page, auto-resume from next tote
 */
(function () {
    'use strict';

    // =========================================================================
    //  CONFIGURATION
    // =========================================================================

    /** DOM selectors for the Poirot page elements */
    const SEL = {
        scanInput:       '#scan-text-input',
        pageTitle:       '#task-component-title',
        changeContainer: '#change-container-button',
        modalRoot:       '#modal-root',
        yesButton:       'button.btn-primary.btn--xs',
        itemQuantity:    '#container-item-quantity',
        rowCount:        '#container-number-of-rows',
    };

    /** Timing constants (ms) - timeouts for polling waits */
    const TIMING = {
        pollInterval:   200,   // DOM polling frequency
        scanTimeout:    10000, // max wait for scan page
        changeTimeout:  10000, // max wait for Change Container button
        yesTimeout:     12000, // max wait for Yes popup
        pageTimeout:    12000, // max wait for page transitions
        itemsTimeout:   60000, // max wait for items to render (60s for large totes)
    };

    const HIGH_QTY_THRESHOLD = 100;   // warn if total items exceed this
    const BATCH_SIZE = 3;             // parallel Amazon price requests
    const ASIN_RE = /\bB[A-Z0-9]{9}\b/;
    const FNSKU_RE = /\bX[A-Z0-9]{9}\b/;
    const FCR_BASE = 'https://qi-fcresearch-eu.corp.amazon.com';

    /** Current running version + where to check/download updates */
    const VERSION = '7.8';
    const UPDATE_URL = 'https://github.com/joyhjoe1997-alt/tampermonkey-scripts/raw/main/sideline.user.js';

    // =========================================================================
    //  CREATE DL (river-dub Large Adjustment SIM) CONFIG
    // =========================================================================
    // "Create DL" button (shown on the HIGH VALUE TOTE warning) opens this
    // river-dub workflow in a NEW TAB. Sideline stashes the tote's grand total
    // and unit count via GM_setValue; the river-dub half of this script (see the
    // RIVER-DUB AUTO-SELECT section at the bottom) reads that payload and ticks
    // the matching "adjustmentType" radio using an Angular-safe event dispatch.

    /** The river-dub Large Adjustment workflow URL opened by "Create DL". */
    const DL_URL = 'https://river-dub.amazon.com/EMA4/workflows?buildingType=fc&q0=e48846d7-01a3-42d0-abcd-5a843986e187&q1=01a54358-f9df-463a-97a1-4cee2946bb3b&id=01a54358-f9df-463a-97a1-4cee2946bb3b';

    /** Cross-tab handoff key (GM storage) carrying { gt, qty, ts } to river-dub. */
    const DL_HANDOFF_KEY = 'sideline_dl_handoff';

    /** How long a stashed handoff is considered fresh (ms). */
    const DL_HANDOFF_TTL = 5 * 60 * 1000; // 5 minutes

    /**
     * Maps a tote's grand-total value (£) and unit count to the river-dub
     * "adjustmentType" radio value. When units and value disagree, the HIGHER
     * (stricter) band wins, so the SIM routes to the correct approval process.
     * UNRECEIVE (unreceiveProcess) is NEVER auto-selected — user picks it manually.
     * Returns null if no band can be determined.
     */
    function mapAdjustmentBand(gt, qty) {
        const v = Number(gt) || 0;
        const u = Number(qty) || 0;
        // Value-driven upper bands (value alone decides these).
        if (v > 500000) return 'extraExtraMegaLarge';   // > £/€500,000
        if (v > 30000)  return 'extraExtraLarge';        // > £/€30,000
        if (v >= 15000) return 'extraLarge';             // £/€15,000–30,000
        // Mixed units-or-value bands: higher of the two wins.
        if (u > 1000 || v >= 7500) return 'large';       // >1,000 units OR £/€7,500–15,000
        if (u >= 200 || v >= 2000) return 'medium';      // 200–1,000 units OR £/€2,000–7,500
        if (u >= 100 || v >= 1000) return 'small';       // 100–200 units OR £/€1,000–2,000
        return 'extraSmall';                             // < 100 units AND < £/€1,000
    }

    /** localStorage keys */
    const LS = {
        list: 'poirot_tote_list_v4',
        idx:  'poirot_currentIdx',
        auto: 'poirot_autoRunning',
        done: 'poirot_doneSet',
    };

    // =========================================================================
    //  STATE
    // =========================================================================

    let toteList = [];
    let doneSet = new Set();
    let currentIdx = 0;
    let autoRunning = false;
    const priceCache = {};

    // =========================================================================
    //  UTILITIES
    // =========================================================================

    const ls = {
        get: (k, d = '') => localStorage.getItem(k) ?? d,
        set: (k, v) => localStorage.setItem(k, String(v)),
    };

    // =========================================================================
    //  BACKGROUND TICKER - keeps polling alive in unfocused/background tabs
    // =========================================================================
    // Browsers throttle setInterval/setTimeout to ~1/sec (or worse) in
    // background tabs, which stalls the automation loop. A Web Worker runs on
    // its own thread that is NOT throttled the same way, so we drive all polling
    // from worker "ticks". Falls back to setInterval if workers are unavailable.

    const bgTicker = (() => {
        const TICK_MS = 200;
        const callbacks = new Map(); // id -> fn
        let nextId = 1;
        let worker = null;

        function fireAll() { for (const fn of callbacks.values()) { try { fn(); } catch { } } }

        let fallbackIv = null;
        function startFallback() {
            if (fallbackIv) return;
            // Main-thread interval (throttled in background, but still works)
            fallbackIv = setInterval(fireAll, TICK_MS);
        }

        try {
            const blob = new Blob([
                `let iv=null;onmessage=e=>{if(e.data==='start'&&!iv){iv=setInterval(()=>postMessage('tick'),${TICK_MS});}else if(e.data==='stop'&&iv){clearInterval(iv);iv=null;}};`
            ], { type: 'application/javascript' });
            worker = new Worker(URL.createObjectURL(blob));
            let gotTick = false;
            worker.onmessage = () => { gotTick = true; fireAll(); };
            worker.onerror = () => { worker = null; startFallback(); };
            // Watchdog: if the worker is silently blocked (e.g. strict CSP on
            // worker-src blob:), fall back to a main-thread interval.
            worker.postMessage('start');
            setTimeout(() => { if (!gotTick) { worker = null; startFallback(); } }, 1000);
        } catch { worker = null; }

        if (!worker) startFallback();

        function ensureRunning() { if (worker && callbacks.size > 0) worker.postMessage('start'); }
        function maybeStop() { if (worker && callbacks.size === 0) worker.postMessage('stop'); }

        return {
            /** Registers fn to run every tick (~200ms). Returns an id to clear. */
            add(fn) { const id = nextId++; callbacks.set(id, fn); ensureRunning(); return id; },
            /** Stops a previously added callback. */
            remove(id) { callbacks.delete(id); maybeStop(); },
        };
    })();

    /** Non-throttled interval built on the background ticker. Returns a handle. */
    function bgInterval(fn) { return bgTicker.add(fn); }
    /** Clears a bgInterval handle. */
    function clearBgInterval(id) { bgTicker.remove(id); }
    /** Non-throttled sleep (resolves after ~ms, unaffected by background throttling). */
    function bgSleep(ms) {
        return new Promise(resolve => {
            const start = Date.now();
            const id = bgTicker.add(() => { if (Date.now() - start >= ms) { bgTicker.remove(id); resolve(); } });
        });
    }

    // =========================================================================
    //  UTILITIES
    // =========================================================================

    /** True when a price string is a real, usable price (contains a number and
     *  is not one of our failure sentinels). Used for the FC Research -> Amazon
     *  -> NIL fallback chain. */
    function isValidPrice(p) {
        return !!p && !['N/A', 'NIL', 'Error', 'Timeout'].includes(p) && /\d/.test(p);
    }

    /** Escapes a string for safe interpolation into innerHTML. */
    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Sets a React-compatible input value and fires synthetic events */
    function setNativeValue(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Simulates Enter keypress (keydown + keypress + keyup) */
    function pressEnter(el) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    // =========================================================================
    //  STATE PERSISTENCE (survives page reloads)
    // =========================================================================

    function saveState() {
        ls.set(LS.idx, currentIdx);
        ls.set(LS.auto, autoRunning ? '1' : '0');
        ls.set(LS.done, JSON.stringify([...doneSet]));
    }

    /** Restores state from localStorage. Returns true if auto-run should resume. */
    function restoreState() {
        currentIdx = parseInt(ls.get(LS.idx, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(ls.get(LS.done, '[]'))); } catch { doneSet = new Set(); }
        return ls.get(LS.auto, '0') === '1';
    }

    function clearState() {
        ls.set(LS.idx, '0');
        ls.set(LS.auto, '0');
        ls.set(LS.done, '[]');
    }

    // =========================================================================
    //  PAGE DETECTION & DOM READING
    // =========================================================================

    /** Returns true when the "Scan source container" page is active */
    function isOnScanPage() {
        const title = document.querySelector(SEL.pageTitle);
        return title && /Scan.*source container/i.test(title.textContent);
    }

    /** Reads the total item quantity from the Change Container page */
    function getItemQuantity() {
        const label = document.querySelector(SEL.itemQuantity);
        if (!label) return -1;
        const span = label.parentElement?.querySelector('span:not([id])');
        return span ? (parseInt(span.textContent.trim(), 10) || -1) : -1;
    }

    /** Reads expected row count from the "Number of rows" label */
    function getExpectedRowCount() {
        const label = document.getElementById('container-number-of-rows');
        if (!label) return -1;
        const span = label.parentElement?.querySelector('span:not([id])');
        return span ? (parseInt(span.textContent.trim(), 10) || -1) : -1;
    }

    /** Extracts warehouse ID from URL path (e.g. /EMA4/...) */
    function getWarehouseId() {
        return location.pathname.match(/^\/([A-Z]{3}\d)\//)?.[1] || 'EMA4';
    }

    // =========================================================================
    //  ITEM READER - Parses all items from the Change Container page
    // =========================================================================

    /**
     * Reads all product rows from the Change Container page.
     * Each item is displayed as alchemy-tag pills: "N qty", "FNSKU: X00...", etc.
     * Returns array of { fnsku, qty, title, isAsin, price, resolvedAsin, fcPrice }
     */
    function readAllItems() {
        const items = [];
        const getText = tag => (tag.innerText || tag.textContent || tag.shadowRoot?.textContent || '').trim();

        // Find all qty tags (these mark the start of each item row)
        const qtyTags = [...document.querySelectorAll('alchemy-tag')]
            .filter(tag => !tag.closest('#pvt-panel, #pvt-cc-dialog, #pvt-hq-dialog'))
            .filter(tag => /^\d+\s*qty$/i.test(getText(tag)));

        for (const qtyTag of qtyTags) {
            const qty = parseInt(getText(qtyTag).match(/^(\d+)/)?.[1], 10) || 0;
            const container = qtyTag.parentElement;
            if (!container || qty === 0) continue;

            // Find FNSKU in sibling alchemy-tags
            let fnsku = null;
            for (const tag of container.querySelectorAll('alchemy-tag')) {
                const match = getText(tag).match(/^FNSKU:\s*([A-Z0-9]{6,14})$/);
                if (match) { fnsku = match[1]; break; }
            }
            if (!fnsku) continue;

            // Find product title in parent column layout
            let title = '';
            const parent = container.closest('.flex-layout--column')
                || container.closest('.flex-layout--row')
                || container.parentElement;
            if (parent) {
                for (const el of parent.querySelectorAll('span.font-weight-bold, span.text--size-md')) {
                    if (el.closest('alchemy-tag')) continue;
                    const t = el.textContent.trim();
                    if (t.length > 5) { title = t; break; }
                }
            }

            items.push({ fnsku, qty, title, isAsin: ASIN_RE.test(fnsku), price: null, resolvedAsin: null, fcPrice: null });
        }
        return items;
    }

    /**
     * Reads items the instant they are fully parseable — event-driven, no fixed
     * delay. Resolves as soon as readAllItems() returns `expected` rows (when the
     * page's "Number of rows" is known), otherwise when a non-zero count holds
     * steady for two consecutive ticks. Re-clicks "Load All Rows" if it reappears.
     * Falls back to whatever was read once the items timeout elapses, so it never
     * hangs. Runs on the background ticker so it isn't throttled in background tabs.
     */
    function readItemsWhenReady(expected) {
        return new Promise(resolve => {
            const start = Date.now();
            let prevCount = -1;
            let settled = false;
            const finish = (id, items) => { clearBgInterval(id); resolve(items); };
            const id = bgInterval(() => {
                const clicked = clickLoadAllRows(); // no-op once expanded/absent
                const items = readAllItems();
                const n = items.length;
                const loadAllGone = !findLoadAllRowsButton();

                setStatus(
                    `Loading items... ${n}${expected > 0 ? '/' + expected : ''} rows` +
                    (clicked ? ' [Load All Rows]' : ''),
                    '#8e44ad'
                );

                // Known target row count: resolve the moment we reach it.
                if (expected > 0 && n >= expected && loadAllGone) { finish(id, items); return; }

                // Unknown target: resolve once a non-zero count repeats (stable)
                // across two ticks and nothing is still waiting to expand.
                if (expected <= 0 && n > 0 && n === prevCount && loadAllGone) {
                    if (settled) { finish(id, items); return; }
                    settled = true;
                } else {
                    settled = false;
                }
                prevCount = n;

                if (Date.now() - start > TIMING.itemsTimeout) { finish(id, items); }
            });
        });
    }

    // =========================================================================
    //  EXTERNAL DATA FETCHING
    // =========================================================================

    /**
     * Fetches product data from FC Research's server-rendered /results/product endpoint.
     * This returns ASIN, List Price, and Title for a given FNSKU.
     * Uses 3 parsing strategies: DOM table, positional selectors, regex fallback.
     */
    function fetchFCResearch(fnsku) {
        const url = `${FCR_BASE}/${getWarehouseId()}/results/product?s=${encodeURIComponent(fnsku)}`;
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' },
                onload(resp) {
                    try {
                        const html = resp.responseText || '';
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        let asin = null, fcPrice = 'N/A', title = '';

                        // Normalises an FC Research "List Price" cell to a clean
                        // price string. The cell looks like "\n\n GBP 69.99 \n\n":
                        // collapse whitespace, drop the 3-letter currency code,
                        // and prefix a £ so it displays like the Amazon price.
                        // Returns 'N/A' when there's no numeric value.
                        const normFcPrice = (raw) => {
                            const s = (raw || '').replace(/\s+/g, ' ').trim();
                            const m = s.match(/(\d[\d,]*\.?\d*)/); // first number
                            if (!m) return 'N/A';
                            return '\u00A3' + m[1].replace(/,/g, '');
                        };

                        // Strategy 1: Parse the product key-value table.
                        // Row shape: <th>List Price</th><td> GBP 69.99 </td>
                        const table = doc.querySelector('table.a-keyvalue[data-row-id]');
                        if (table) {
                            asin = table.getAttribute('data-row-id');
                            for (const row of table.querySelectorAll('tr')) {
                                const th = (row.querySelector('th')?.textContent || '').replace(/\s+/g, ' ').trim();
                                const tdRaw = row.querySelector('td')?.textContent || '';
                                if (th === 'List Price') { const p = normFcPrice(tdRaw); if (p !== 'N/A') fcPrice = p; }
                                if (th === 'Title') { const t = tdRaw.replace(/\s+/g, ' ').trim(); if (t) title = t; }
                            }
                        }

                        // Strategy 2: Positional CSS selectors
                        if (!asin) asin = doc.querySelector('.a-span7 > table > tbody > tr:nth-child(1) > td:nth-child(2) > a')?.textContent.trim() || null;
                        if (!title) title = doc.querySelector('a[href*="amazon.co.uk/gp/product"]')?.textContent.trim() || '';

                        // Strategy 3: Regex on raw HTML (whitespace-tolerant)
                        if (!asin) asin = (html.match(/data-row-id="(B[A-Z0-9]{9})"/) || html.match(/results\?s=(B[A-Z0-9]{9})/))?.[1] || null;
                        if (fcPrice === 'N/A') {
                            const m = html.match(/<th>\s*List Price\s*<\/th>\s*<td>([\s\S]*?)<\/td>/);
                            if (m) fcPrice = normFcPrice(m[1]);
                        }

                        resolve({ asin, fcPrice, title });
                    } catch { resolve({ asin: null, fcPrice: 'Error', title: '' }); }
                },
                onerror() { resolve({ asin: null, fcPrice: 'Error', title: '' }); },
                ontimeout() { resolve({ asin: null, fcPrice: 'Timeout', title: '' }); },
            });
        });
    }

    /**
     * Checks FC Research inventory history for PROBLEM_SOLVE entries.
     * Fetches /results/inventory-history?s={asin} and looks for rows where:
     *   - OP = "A" (Created inventory)
     *   - Old Owner column contains "PROBLEM_SOLVE"
     * Returns { hasProblemSolve: bool, count: number, lastDate: string }
     */
    function checkProblemSolve(asin) {
        const url = `${FCR_BASE}/${getWarehouseId()}/results/inventory-history?s=${encodeURIComponent(asin)}`;
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' },
                onload(resp) {
                    try {
                        const doc = new DOMParser().parseFromString(resp.responseText || '', 'text/html');
                        const rows = doc.querySelectorAll('#table-inventory-history tbody tr');
                        let count = 0;
                        let totalQty = 0;
                        let lastDate = '';

                        for (const row of rows) {
                            const cells = row.querySelectorAll('td');
                            if (cells.length < 13) continue;
                            // Column layout: Date, OP, RS, ASIN, FNSku, FCSku, LPN, Quantity, Person, Old Bin, New Bin, Old Owner, New Owner, Tool
                            const op = (cells[1]?.textContent || '').trim();
                            const qty = parseInt((cells[7]?.textContent || '').trim(), 10) || 0;
                            const oldOwner = (cells[11]?.textContent || '').trim();

                            if (op === 'A' && oldOwner.includes('PROBLEM_SOLVE')) {
                                count++;
                                totalQty += qty;
                                if (!lastDate) lastDate = (cells[0]?.textContent || '').trim();
                            }
                        }

                        resolve({ hasProblemSolve: count > 0, count, totalQty, lastDate });
                    } catch (e) {
                        resolve({ hasProblemSolve: false, count: 0, totalQty: 0, lastDate: '' });
                    }
                },
                onerror() { resolve({ hasProblemSolve: false, count: 0, totalQty: 0, lastDate: '' }); },
                ontimeout() { resolve({ hasProblemSolve: false, count: 0, totalQty: 0, lastDate: '' }); },
            });
        });
    }

    /**
     * Builds the river-dub adjustment comment from FC Research for a tote.
     *
     * Fetches TWO server-rendered partials ("/<WH>/results/inventory-history"
     * and "/<WH>/results/receive-history", ?s=<toteId>) in parallel — the full
     * "/results?s=" page is a JS shell with no tables, so the partials are used.
     * Then:
     *   - Keeps Inventory History rows where OP == 'A' AND RS == 'A'.
     *   - Joins each kept row to a Receive History PO on FNSKU (nearest date
     *     when a FNSKU appears more than once).
     *   - Emits one line per kept row:
     *       "<date>, <WH> received <qty> units of <fnsku> in <oldBin> using <tool>"
     *     plus " from PO : <po>" when a PO is found.
     *
     * Returns Promise<{ text, diag }>; text is '' if nothing qualifies.
     *
     * Column layouts (tbody <td> indexes):
     *   #table-inventory-history: Date(0) OP(1) RS(2) ASIN(3) FNSku(4) FCSku(5)
     *     LPN(6) Quantity(7) Person(8) OldBin(9) NewBin(10) OldOwner(11)
     *     NewOwner(12) Tool(13)
     *   #table-receive-history: Date(0) Receiver(1) ProcessPath(2) SKU/FNSKU(3)
     *     LPN(4) Quantity(5) Container(6) Shipment(7) PurchaseOrder(8)
     *
     * GETs a server-rendered FC Research HTML fragment and returns a parsed
     * Document (or null on failure). The FULL "/results?s=" page is a JS shell
     * with no data tables, so we hit the PARTIAL endpoints (same ones the site's
     * own tabs load), which come back server-rendered with the <table> present.
     */
    function fetchFcrPartial(path, s) {
        const url = `${FCR_BASE}/${getWarehouseId()}/${path}?s=${encodeURIComponent(s)}`;
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' },
                onload(resp) {
                    try {
                        const doc = new DOMParser().parseFromString(resp.responseText || '', 'text/html');
                        resolve({ doc, status: resp.status, len: (resp.responseText || '').length });
                    } catch (e) { resolve({ doc: null, status: resp.status, len: 0 }); }
                },
                onerror() { resolve({ doc: null, status: 0, len: 0 }); },
                ontimeout() { resolve({ doc: null, status: 0, len: 0 }); },
            });
        });
    }

    function buildAdjustmentComment(toteId) {
        const wh = getWarehouseId();
        // Fetch both partials in parallel: inventory-history (known-good, same
        // endpoint checkProblemSolve uses) and receive-history (same pattern).
        return Promise.all([
            fetchFcrPartial('results/inventory-history', toteId),
            fetchFcrPartial('results/receive-history', toteId),
        ]).then(([inv, rec]) => {
            const invDoc = inv.doc;
            if (!invDoc || !invDoc.querySelector('#table-inventory-history')) {
                return { text: '', diag: `no inv table (http ${inv.status}, ${inv.len}b)` };
            }
            const r = composeComment(invDoc, wh, rec.doc);
            return { text: r.text, diag: r.diag };
        }).catch(e => ({ text: '', diag: 'build error: ' + (e && e.message) }));
    }

    /** Parses a date-ish string to epoch ms for nearest-date matching (NaN-safe). */
    function parseFcrDate(s) {
        const t = Date.parse(String(s || '').trim());
        return isNaN(t) ? null : t;
    }

    /**
     * Pure DOM -> comment transform (split out so it is unit-testable without a
     * network call). `invDoc` holds #table-inventory-history; `recDoc` holds
     * #table-receive-history (a separate partial fetch). `recDoc` may be null.
     */
    function composeComment(invDoc, wh, recDoc) {
        const doc = invDoc;
        const recScope = recDoc || invDoc;
        // --- Receive History: FNSKU -> [{ po, when }] for nearest-date joining ---
        const poByFnsku = new Map();
        const recRows = recScope.querySelectorAll('#table-receive-history tbody tr');
        for (const row of recRows) {
            const c = row.querySelectorAll('td');
            if (c.length < 9) continue;
            const sku = (c[3]?.textContent || '').trim();
            const po  = (c[8]?.textContent || '').trim();
            if (!sku || !po) continue;
            const when = parseFcrDate(c[0]?.textContent);
            if (!poByFnsku.has(sku)) poByFnsku.set(sku, []);
            poByFnsku.get(sku).push({ po, when });
        }

        // Picks the PO for a FNSKU whose receive date is closest to the inv date.
        const poFor = (fnsku, invWhen) => {
            const list = poByFnsku.get(fnsku);
            if (!list || !list.length) return '';
            if (list.length === 1 || invWhen == null) return list[0].po;
            let best = list[0];
            let bestGap = Infinity;
            for (const e of list) {
                if (e.when == null) continue;
                const gap = Math.abs(e.when - invWhen);
                if (gap < bestGap) { bestGap = gap; best = e; }
            }
            return best.po;
        };

        // Normalises an OP/RS status cell. These render the letter inside a
        // tooltip wrapper, so textContent may carry stray whitespace or a title
        // string; take the first non-space character and compare case-insensitively.
        const statusLetter = (cell) => {
            const t = (cell?.textContent || '').replace(/\s+/g, '').toUpperCase();
            return t ? t[0] : '';
        };

        // --- Inventory History: keep OP=='A' && RS=='A', build one line each ---
        const lines = [];
        const invRows = doc.querySelectorAll('#table-inventory-history tbody tr');
        let seenOpRs = []; // diagnostics: what OP/RS pairs we actually read
        for (const row of invRows) {
            const c = row.querySelectorAll('td');
            if (c.length < 14) continue;
            const op = statusLetter(c[1]);
            const rs = statusLetter(c[2]);
            if (seenOpRs.length < 6) seenOpRs.push(`${op || '-'}/${rs || '-'}`);
            if (op !== 'A' || rs !== 'A') continue;

            const date   = (c[0]?.textContent || '').trim();
            const fnsku  = (c[4]?.textContent || '').trim();
            const qty    = (c[7]?.textContent || '').trim();
            const oldBin = (c[9]?.textContent || '').trim();
            const tool   = (c[13]?.textContent || '').trim();

            let line = `${date}, ${wh} received ${qty} units of ${fnsku} in ${oldBin} using ${tool}`;
            const po = poFor(fnsku, parseFcrDate(date));
            if (po) line += ` from PO : ${po}`;
            lines.push(line);
        }

        // Diagnostic string: how the parse saw the page. Surfaced in the toast
        // only when no line was built, so you can tell WHY (empty table vs.
        // OP/RS never 'A' vs. wrong columns).
        const recTable = !!recScope.querySelector('#table-receive-history');
        const diag =
            `inv-rows=${invRows.length}` +
            (invRows.length && !lines.length ? ` oprs=[${seenOpRs.join(',')}]` : '') +
            ` rec-table=${recTable ? 'y' : 'n'} rec-POs=${poByFnsku.size}`;

        return { text: lines.join('\n'), diag };
    }

    /**
     * Fetches the live price from Amazon.co.uk for a given ASIN.
     * Tries 17 different price selectors, then regex fallback.
     * Auto-retries once on N/A (handles temporary throttling).
     * Results are cached in-memory to avoid duplicate requests.
     */
    function fetchAmazonPrice(asin, retry = 0) {
        if (priceCache[asin]) return Promise.resolve(priceCache[asin]);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.amazon.co.uk/gp/product/${encodeURIComponent(asin)}?th=1`,
                headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9', 'Cache-Control': 'no-cache' },
                onload(resp) {
                    let price = 'N/A';
                    try {
                        const html = resp.responseText || '';
                        const doc = new DOMParser().parseFromString(html, 'text/html');

                        // Comprehensive price selector list (covers all Amazon layouts)
                        const selectors = [
                            '#corePrice_feature_div .a-price .a-offscreen',
                            '#apex_desktop .a-price .a-offscreen',
                            '#price_inside_buybox', '#priceblock_ourprice',
                            '#priceblock_dealprice', '#priceblock_saleprice',
                            '#newBuyBoxPrice .a-price .a-offscreen',
                            '#tmmSwatches .a-color-price .a-offscreen',
                            '#MediaMatrix .a-color-price .a-offscreen',
                            '.swatchElement.selected .a-color-price .a-offscreen',
                            '#buyNewSection .a-price .a-offscreen',
                            '#usedBuySection .a-price .a-offscreen',
                            '.offer-price', '#kindle-price .a-offscreen',
                            '#paperback .a-price .a-offscreen',
                            '#hardcover .a-price .a-offscreen',
                            '.a-price .a-offscreen',
                        ];
                        for (const sel of selectors) {
                            const t = doc.querySelector(sel)?.textContent.trim();
                            if (t && /\d/.test(t)) { price = t; break; }
                        }

                        // Regex fallback on raw HTML
                        if (price === 'N/A') price = (html.match(/<span class="a-offscreen">\s*([^\s<]*\d+[.,]\d{2})\s*<\/span>/) || [])[1] || 'N/A';
                        if (price === 'N/A') price = (html.match(/>\s*(\u00A3\s*\d+[.,]\d{2})\s*</) || [])[1] || 'N/A';
                    } catch { price = 'Error'; }

                    // Auto-retry once on failure (handles transient throttling)
                    if (price === 'N/A' && retry < 1) {
                        setTimeout(() => fetchAmazonPrice(asin, 1).then(resolve), 1000);
                        return;
                    }
                    // Only cache SUCCESSFUL prices. Caching failures (N/A/Error/
                    // Timeout) would make the same ASIN in a later tote — or a
                    // manual ASIN re-entry — return the stale failure without
                    // ever re-fetching.
                    if (price !== 'N/A' && price !== 'Error' && price !== 'Timeout') {
                        priceCache[asin] = price;
                    }
                    resolve(price);
                },
                onerror() { resolve('Error'); },
                ontimeout() { resolve('Timeout'); },
            });
        });
    }

    // =========================================================================
    //  WAIT HELPERS - Promise-based DOM polling
    // =========================================================================

    /** Waits until a selector matches a visible element, or times out (returns null) */
    function waitFor(selector, timeout = TIMING.changeTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = bgInterval(() => {
                const el = document.querySelector(selector);
                if (el?.offsetParent !== null) { clearBgInterval(iv); resolve(el); }
                else if (Date.now() - start > timeout) { clearBgInterval(iv); resolve(null); }
            });
        });
    }

    /** Waits until the scan page is active */
    function waitForScanPage(timeout = TIMING.scanTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = bgInterval(() => {
                if (isOnScanPage()) { clearBgInterval(iv); resolve(document.querySelector(SEL.scanInput)); }
                else if (Date.now() - start > timeout) { clearBgInterval(iv); resolve(null); }
            });
        });
    }

    /** Waits until we leave the scan page (page transition detected) */
    function waitForPageLeave(timeout = TIMING.pageTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = bgInterval(() => {
                if (!isOnScanPage() || Date.now() - start > timeout) { clearBgInterval(iv); resolve(); }
            });
        });
    }

    /**
     * Finds and clicks the "Load All Rows" button if present. The scan page
     * only renders a capped number of rows (e.g. 25 of 27) until this button
     * is clicked — without it readAllItems() misses items and the grand total
     * in the next step is wrong. Returns true if a button was clicked this call.
     * Matches by button text so it survives markup changes; skips our own panels
     * and ignores a button that's already been clicked (data-sideline-clicked).
     */
    /** Returns the live, unclicked "Load All Rows" button, or null. */
    function findLoadAllRowsButton() {
        try {
            const btns = [...document.querySelectorAll('alchemy-button, button')]
                .filter(b => !b.closest('#pvt-panel,#pvt-cc-dialog,#pvt-hq-dialog,#bpeta-panel'));
            for (const b of btns) {
                const txt = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (txt.includes('load all rows') && b.getAttribute('data-sideline-clicked') !== '1') {
                    return b;
                }
            }
        } catch { /* never let a lookup error abort the caller */ }
        return null;
    }

    function clickLoadAllRows() {
        const b = findLoadAllRowsButton();
        if (!b) return false;
        try {
            b.setAttribute('data-sideline-clicked', '1');
            // alchemy-button may host a real <button> in light/shadow DOM;
            // click the inner control if present, else the element itself.
            const inner = b.querySelector('button') || b;
            inner.click();
            return true;
        } catch { return false; }
    }

    /** Waits until all item rows have rendered on the Change Container page.
     *  Uses MutationObserver for instant detection (no polling delay).
     *  Clicks "Load All Rows" first (if present) so capped lists fully expand.
     *  Resolves when rendered count matches expected, or stabilizes for 500ms.
     */
    function waitForItemsRendered() {
        return new Promise(resolve => {
            const start = Date.now();
            const expected = getExpectedRowCount();
            let lastCount = 0;
            let stableTimer = null;
            let loadAllClicked = false; // did we expand a capped list this run?

            function countItems() {
                return [...document.querySelectorAll('alchemy-tag')]
                    .filter(t => !t.closest('#pvt-panel,#pvt-cc-dialog,#pvt-hq-dialog'))
                    .filter(t => /^\d+\s*qty$/i.test((t.innerText || t.textContent || '').trim()))
                    .length;
            }

            let stableSince = 0; // timestamp when count last stabilized (>0)

            function check() {
                const count = countItems();
                const elapsed = Math.round((Date.now() - start) / 1000);

                // Expand a capped list: if a "Load All Rows" button is showing,
                // click it and keep waiting for the remaining rows to render.
                const clicked = clickLoadAllRows();
                if (clicked) loadAllClicked = true;
                const loadAllPresent = !!findLoadAllRowsButton();

                setStatus(
                    `Loading items... ${count}/${expected > 0 ? expected : '?'} rows (${elapsed}s)` +
                    (clicked ? ' [Load All Rows]' : ''),
                    '#8e44ad'
                );

                // If we just clicked Load All Rows, reset the stability window so
                // we wait for the newly-expanded rows instead of finishing early.
                if (clicked) { lastCount = count; stableSince = 0; return; }

                // Exact match with expected row count — done immediately, but
                // only once no "Load All Rows" button remains (the expected count
                // can equal the pre-expansion cap, so don't finish while more
                // rows are still hidden behind the button).
                if (expected > 0 && count >= expected && !loadAllPresent) { done(); return; }

                // Count changed — reset stability window
                if (count !== lastCount) {
                    lastCount = count;
                    stableSince = count > 0 ? Date.now() : 0;
                }

                // Stable for 500ms with items present — but NOT while an unclicked
                // "Load All Rows" button is still on the page (more rows pending).
                if (stableSince && Date.now() - stableSince >= 500 && !loadAllPresent) { done(); return; }

                // Safety timeout
                if (Date.now() - start > TIMING.itemsTimeout) { done(); }
            }

            let finished = false;
            function done() {
                if (finished) return;
                finished = true;
                observer.disconnect();
                clearBgInterval(tick);
                resolve({ loadAllClicked, count: countItems(), expected });
            }

            // Observe DOM mutations — fires instantly when new elements are added
            const observer = new MutationObserver(check);
            observer.observe(document.body, { childList: true, subtree: true });

            // Background-safe polling tick drives the stability + safety timing
            // (MutationObserver alone can miss the "no more changes" case, and
            // setTimeout is throttled in background tabs).
            const tick = bgInterval(check);

            // Initial check (items might already be there)
            check();
        });
    }

    /** Returns the trimmed text of a visible blocking error banner on the scan
     *  page, or null. Scoped to exclude our own panel/dialogs. */
    function getScanError() {
        for (const alert of document.querySelectorAll('.alert--error')) {
            if (alert.closest('#pvt-panel, #pvt-cc-dialog, #pvt-hq-dialog, #pvt-skip-dialog, #pvt-error-dialog')) continue;
            if (alert.offsetParent === null) continue; // not visible
            const msg = (alert.innerText || alert.textContent || '').trim();
            if (msg) return msg;
        }
        return null;
    }

    /** Races the Change Container button against an error banner after a scan.
     *  Resolves with { type: 'change'|'error'|'timeout', el?, message? }. */
    function waitForChangeOrError(timeout = TIMING.changeTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = bgInterval(() => {
                const btn = document.querySelector(SEL.changeContainer);
                if (btn?.offsetParent != null) { clearBgInterval(iv); resolve({ type: 'change', el: btn }); return; }
                const err = getScanError();
                if (err) { clearBgInterval(iv); resolve({ type: 'error', message: err }); return; }
                if (Date.now() - start > timeout) { clearBgInterval(iv); resolve({ type: 'timeout' }); }
            });
        });
    }

    /** Finds and returns the Yes/OK button in the confirmation popup */
    function findYesButton() {
        // Exact selector first
        for (const btn of document.querySelectorAll(SEL.yesButton)) {
            if (btn.textContent.trim().toLowerCase() === 'yes' && btn.offsetParent) return btn;
        }
        // Any primary button with "yes" text (not in our panel)
        for (const btn of document.querySelectorAll('button.btn-primary')) {
            if (btn.closest('#pvt-panel')) continue;
            if (btn.textContent.trim().toLowerCase() === 'yes' && btn.offsetParent) return btn;
        }
        // Modal fallback
        const modal = document.querySelector(SEL.modalRoot);
        if (modal?.childElementCount > 0) {
            for (const btn of modal.querySelectorAll('button')) {
                if (['yes', 'ok', 'confirm'].includes(btn.textContent.trim().toLowerCase()) && btn.offsetParent) return btn;
            }
        }
        return null;
    }

    /** Waits for the Yes confirmation popup button */
    function waitForYesButton(timeout = TIMING.yesTimeout) {
        window.confirm = () => true; // auto-accept native dialogs
        return new Promise(resolve => {
            const start = Date.now();
            const iv = bgInterval(() => {
                const btn = findYesButton();
                if (btn) { clearBgInterval(iv); resolve(btn); }
                else if (Date.now() - start > timeout) { clearBgInterval(iv); resolve(null); }
            });
        });
    }

    // =========================================================================
    //  DIALOGS
    // =========================================================================

    /** Creates a modal overlay with given inner HTML and returns it */
    function createDialog(id, html) {
        document.getElementById(id)?.remove();
        const overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:Segoe UI,system-ui,sans-serif';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        return overlay;
    }

    /** Shows "Do Not Process" warning for vt/pa/numeric totes */
    function showSkipWarning(toteId, reason) {
        return new Promise(resolve => {
            const overlay = createDialog('pvt-skip-dialog', `
                <div style="background:#fff;border-radius:14px;padding:28px;max-width:380px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center">
                    <div style="font-size:40px">&#9940;</div>
                    <div style="font-size:17px;font-weight:700;color:#e74c3c;margin:12px 0">Do Not Process</div>
                    <div style="font-size:14px;color:#2c3e50;line-height:1.6;margin-bottom:20px">
                        Tote <b>${escapeHtml(toteId)}</b> is <b>${escapeHtml(reason)}</b><br>and should not be emptied.
                    </div>
                    <div style="display:flex;gap:10px;justify-content:center">
                        <button id="pvt-skip-next" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#f39c12;color:#fff">Skip to next</button>
                        <button id="pvt-skip-stop" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#e74c3c;color:#fff">Stop</button>
                    </div>
                </div>`);
            document.getElementById('pvt-skip-next').onclick = () => { overlay.remove(); resolve('skip'); };
            document.getElementById('pvt-skip-stop').onclick = () => { overlay.remove(); resolve('stop'); };
        });
    }

    /** Shows "Cannot Process" dialog when a blocking error banner appears after
     *  scanning (e.g. Reverse Logistics item). Shows the real error text. */
    function showCannotProcess(toteId, message) {
        return new Promise(resolve => {
            const safeMsg = (message || 'This container cannot be used.')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const overlay = createDialog('pvt-error-dialog', `
                <div style="background:#fff;border-radius:14px;padding:28px;max-width:440px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center">
                    <div style="font-size:40px">&#9940;</div>
                    <div style="font-size:17px;font-weight:700;color:#e74c3c;margin:12px 0">Cannot Process</div>
                    <div style="font-size:14px;color:#2c3e50;line-height:1.6;margin-bottom:16px">
                        Tote <b>${escapeHtml(toteId)}</b> returned an error:
                    </div>
                    <div style="font-size:13px;color:#c0392b;background:#fdf0ef;border:1px solid #f5c6cb;border-radius:8px;padding:12px;line-height:1.5;margin-bottom:20px;text-align:left">${safeMsg}</div>
                    <div style="display:flex;gap:10px;justify-content:center">
                        <button id="pvt-err-next" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#f39c12;color:#fff">Skip to next</button>
                        <button id="pvt-err-stop" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#e74c3c;color:#fff">Stop</button>
                    </div>
                </div>`);
            document.getElementById('pvt-err-next').onclick = () => { overlay.remove(); resolve('skip'); };
            document.getElementById('pvt-err-stop').onclick = () => { overlay.remove(); resolve('stop'); };
        });
    }

    /** Shows high-quantity confirmation dialog */
    function confirmHighQuantity(toteId, qty) {
        return new Promise(resolve => {
            const overlay = createDialog('pvt-hq-dialog', `
                <div style="background:#fff;border-radius:14px;padding:28px;max-width:360px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center">
                    <div style="font-size:40px">&#9888;</div>
                    <div style="font-size:17px;font-weight:700;color:#c0392b;margin:12px 0">High Item Count</div>
                    <div style="font-size:14px;color:#2c3e50;line-height:1.6;margin-bottom:20px">
                        Tote <b>${escapeHtml(toteId)}</b> has <b>${qty} items</b> (threshold: ${HIGH_QTY_THRESHOLD}).<br><br>Proceed with emptying?
                    </div>
                    <div style="display:flex;gap:10px;justify-content:center">
                        <button id="pvt-hq-yes" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#e74c3c;color:#fff">Yes, empty it</button>
                        <button id="pvt-hq-no" style="padding:10px 22px;border:none;border-radius:8px;font:600 13px Segoe UI;cursor:pointer;background:#ecf0f1;color:#555">No, skip</button>
                    </div>
                </div>`);
            document.getElementById('pvt-hq-yes').onclick = () => { overlay.remove(); resolve(true); };
            document.getElementById('pvt-hq-no').onclick = () => { overlay.remove(); resolve(false); };
        });
    }

    /** Shows the Change Container confirmation dialog with item price table */
    function confirmChangeContainer(toteId, toteNum, total, items, totalQty) {
        // Build table rows
        const rows = items.map((item, i) => {
            const hasPrice = isValidPrice(item.price);
            // Valid price -> green, with a small FCR/Amazon source tag.
            // No usable price (NIL from the FCR->Amazon chain) -> show the
            // "Paste ASIN" box so it can still be corrected manually, with a
            // red "NIL" hint beside it.
            // Source tag. When the price came from Amazon (FCR fell back), also
            // show what FCR returned so it's visible why FCR wasn't used.
            let srcTag = '';
            if (item.priceSource === 'FCR') {
                srcTag = `<span style="color:#95a5a6;font-size:11px;margin-left:5px">FCR</span>`;
            } else if (item.priceSource === 'Amazon') {
                srcTag = `<span style="color:#95a5a6;font-size:11px;margin-left:5px" title="FC Research price: ${escapeHtml(item.fcPriceRaw || '(none)')}">Amazon</span>`;
            }
            const priceHtml = hasPrice
                ? `<span style="color:#27ae60;font-weight:700">${escapeHtml(item.price)}</span>${srcTag}`
                : `<span style="color:#e74c3c;font-weight:700;margin-right:6px">NIL</span><input type="text" class="pvt-asin-in" data-idx="${i}" placeholder="Paste ASIN" maxlength="10" style="font:700 10px monospace;width:85px;border:1.5px solid #ddd;border-radius:4px;padding:2px 4px;text-transform:uppercase">`;
            const num = hasPrice ? parseFloat(item.price.replace(/[^0-9.]/g, '')) : NaN;
            const lineTotal = isNaN(num) ? '-' : '\u00A3' + (num * item.qty).toFixed(2);
            const fnskuEnc = encodeURIComponent(item.fnsku);
            const fnskuTxt = escapeHtml(item.fnsku);
            const id = `<a href="${FCR_BASE}/${getWarehouseId()}/results?s=${fnskuEnc}" target="_blank" rel="noopener" style="color:#8e44ad;text-decoration:none" title="Open in FC Research">${fnskuTxt}</a>` + (item.resolvedAsin ? ` <span style="color:#27ae60;font-size:15px">\u2192 <a href="${FCR_BASE}/${getWarehouseId()}/results?s=${encodeURIComponent(item.resolvedAsin)}" target="_blank" rel="noopener" style="color:#27ae60;text-decoration:none" title="Open in FC Research">${escapeHtml(item.resolvedAsin)}</a></span>` : '');
            const psCount = item.problemSolve?.totalQty || 0;
            const psEntries = item.problemSolve?.count || 0;
            const psBadge = psCount > 0 ? `<span style="background:#e74c3c;color:#fff;font:700 15px Segoe UI;padding:2px 8px;border-radius:3px" title="${escapeHtml(psEntries)} Problem Solve entries, total qty: ${escapeHtml(psCount)}, last: ${escapeHtml(item.problemSolve.lastDate)}">${psCount} PS</span>` : '<span style="color:#ccc;font-size:15px">0</span>';
            return `<tr><td style="font:600 16px monospace">${id}</td><td style="text-align:center;font-weight:700">${item.qty}</td><td style="white-space:nowrap" id="pvt-p-${i}">${priceHtml}</td><td style="white-space:nowrap;font-weight:600" id="pvt-lt-${i}">${lineTotal}</td><td style="text-align:center">${psBadge}</td><td style="font-size:16px;color:#666;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((item.title || '').substring(0, 50))}</td></tr>`;
        }).join('');

        // Calculate grand total
        let gt = 0;
        items.forEach(it => { const n = parseFloat((it.price || '').replace(/[^0-9.]/g, '')); if (!isNaN(n)) gt += n * it.qty; });
        const highValue = gt > 1000;

        const overlay = createDialog('pvt-cc-dialog', `
            <div id="pvt-cc-box" style="background:${highValue ? '#fff5f5' : '#fff'};border-radius:14px;width:800px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 16px 50px rgba(0,0,0,.35);overflow:hidden;${highValue ? 'border:3px solid #e74c3c' : ''}">
                <div style="background:${highValue ? 'linear-gradient(135deg,#c0392b,#e74c3c)' : 'linear-gradient(135deg,#0b3948,#1abc9c)'};color:#fff;padding:16px 20px;font:700 20px Segoe UI">Change Container - Tote ${toteNum}/${total}</div>
                ${highValue ? '<div id="pvt-hv-warn" style="background:#e74c3c;color:#fff;padding:12px 20px;font:700 19px Segoe UI;text-align:center;animation:pvt-blink 1s infinite">&#9888; HIGH VALUE TOTE - Grand Total exceeds \u00A31,000! Verify before proceeding.<br><button id="pvt-create-dl" style="margin-top:10px;padding:8px 18px;border:none;border-radius:8px;font:700 14px Segoe UI;cursor:pointer;background:#fff;color:#c0392b;animation:none">\uD83D\uDCCB Create DL</button></div>' : ''}
                <div style="padding:16px 20px;overflow-y:auto;flex:1">
                    <div style="display:flex;justify-content:space-between;font-size:18px;color:#555;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #eee">
                        <span><b>Tote:</b> <a href="${FCR_BASE}/${getWarehouseId()}/results?s=${encodeURIComponent(toteId)}" target="_blank" rel="noopener" style="color:#8e44ad;text-decoration:none;font-weight:700" title="Open in FC Research">${escapeHtml(toteId)}</a></span><span><b>Items:</b> ${items.length} rows, ${totalQty} units</span>
                    </div>
                    <table style="width:100%;border-collapse:collapse;font-size:17px">
                        <thead><tr style="background:#f4f6f8"><th style="padding:8px 10px;text-align:left;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">FNSKU/ASIN</th><th style="padding:8px;text-align:center;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Qty</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Price</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Total</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd;text-align:center">PS</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Title</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700;padding:10px;border-top:2px solid #ddd;font-size:17px">Grand Total:</td><td id="pvt-gt" style="font-weight:700;color:${highValue ? '#e74c3c' : '#27ae60'};padding:10px;border-top:2px solid #ddd;font-size:19px">\u00A3${gt.toFixed(2)}</td><td style="border-top:2px solid #ddd"></td></tr></tfoot>
                    </table>
                    <div style="font-size:10px;color:#888;margin-top:6px;font-style:italic">${items.some(i => !isValidPrice(i.price)) ? 'Prices tried FC Research then Amazon. Paste an ASIN for any NIL row - auto-fetches on paste.' : 'All prices fetched'}</div>
                </div>
                <div style="display:flex;gap:8px;padding:14px 18px;background:#f8f9fa;border-top:1px solid #eee">
                    <button id="pvt-cc-yes" style="flex:1;padding:12px;border:none;border-radius:8px;font:600 18px Segoe UI;cursor:pointer;background:#2ecc71;color:#fff">Yes, change it</button>
                    <button id="pvt-cc-skip" style="flex:1;padding:12px;border:none;border-radius:8px;font:600 18px Segoe UI;cursor:pointer;background:#f39c12;color:#fff">Skip tote</button>
                    <button id="pvt-cc-no" style="flex:1;padding:12px;border:none;border-radius:8px;font:600 18px Segoe UI;cursor:pointer;background:#e74c3c;color:#fff">Stop</button>
                </div>
            </div>`);

        // Add blink animation for high-value warning
        if (!document.getElementById('pvt-blink-style')) {
            const style = document.createElement('style');
            style.id = 'pvt-blink-style';
            style.textContent = '@keyframes pvt-blink { 0%,100%{opacity:1} 50%{opacity:0.6} }';
            document.head.appendChild(style);
        };

        // Wire ASIN input fields: auto-fetch price when a valid ASIN is pasted
        overlay.querySelectorAll('.pvt-asin-in').forEach(input => {
            input.addEventListener('input', async () => {
                const val = input.value.trim().toUpperCase();
                if (!/^B[A-Z0-9]{9}$/.test(val)) return;
                input.style.borderColor = '#f39c12';
                input.disabled = true; // lock while fetching to avoid overlap
                const idx = +input.dataset.idx;
                const price = await fetchAmazonPrice(val);
                items[idx].price = isValidPrice(price) ? price : 'NIL';
                // Update cells
                const bad = !isValidPrice(items[idx].price);
                const shownPrice = items[idx].price;
                // Carry the manually-entered ASIN onto the item so downstream
                // consumers (e.g. the Create DL handoff) use it too. (Leave
                // isAsin as-is — the fnsku field is still the original FNSKU.)
                items[idx].resolvedAsin = val;
                // Keep the input usable on failure (so a corrected ASIN can be
                // re-pasted); only lock it green once a real price comes back.
                if (bad) { input.disabled = false; input.style.borderColor = '#e74c3c'; }
                else { input.style.borderColor = '#2ecc71'; }
                document.getElementById(`pvt-p-${idx}`).innerHTML = bad ? `<span style="color:#e74c3c">${escapeHtml(shownPrice)}</span>` : `<span style="color:#27ae60;font-weight:700">${escapeHtml(shownPrice)}</span>`;
                const num = parseFloat((shownPrice || '').replace(/[^0-9.]/g, ''));
                document.getElementById(`pvt-lt-${idx}`).textContent = isNaN(num) ? '-' : '\u00A3' + (num * items[idx].qty).toFixed(2);
                // Recalculate grand total
                let newGt = 0;
                items.forEach(it => { const n = parseFloat((it.price || '').replace(/[^0-9.]/g, '')); if (!isNaN(n)) newGt += n * it.qty; });
                const gtEl = document.getElementById('pvt-gt');
                gtEl.textContent = '\u00A3' + newGt.toFixed(2);
                // Trigger high-value warning if total crosses 1000
                const box = document.getElementById('pvt-cc-box');
                const warn = document.getElementById('pvt-hv-warn');
                if (newGt > 1000) {
                    gtEl.style.color = '#e74c3c';
                    if (box) { box.style.background = '#fff5f5'; box.style.border = '3px solid #e74c3c'; }
                    if (!warn && box) {
                        const hdr = box.querySelector('div');
                        const w = document.createElement('div');
                        w.id = 'pvt-hv-warn';
                        w.style.cssText = 'background:#e74c3c;color:#fff;padding:10px 18px;font:700 13px Segoe UI;text-align:center;animation:pvt-blink 1s infinite';
                        w.innerHTML = '&#9888; HIGH VALUE TOTE - Grand Total exceeds \u00A31,000! Verify before proceeding.<br><button id="pvt-create-dl" style="margin-top:8px;padding:7px 16px;border:none;border-radius:8px;font:700 13px Segoe UI;cursor:pointer;background:#fff;color:#c0392b;animation:none">\uD83D\uDCCB Create DL</button>';
                        hdr.after(w);
                        wireCreateDlButton(toteId, totalQty);
                    }
                } else {
                    gtEl.style.color = '#27ae60';
                    if (box) { box.style.background = '#fff'; box.style.border = ''; }
                    if (warn) warn.remove();
                }
            });
        });

        // Wire the "Create DL" button (inside the high-value warning banner).
        // Reads the LIVE grand total from #pvt-gt (it changes after ASIN pastes),
        // stashes { gt, qty, toteId, asin } for the river-dub tab, and opens the
        // SIM. The river-dub half fills step 1 (band radio) and, after the user
        // clicks Confirm & Continue, step 2 (Tool/Container/ASIN/Qty/Value).
        function wireCreateDlButton(tId, tQty) {
            const btn = document.getElementById('pvt-create-dl');
            if (!btn || btn.dataset.wired) return;
            btn.dataset.wired = '1';
            btn.onclick = async () => {
                if (btn.dataset.busy) return; // guard against double-click re-entry
                const gtEl = document.getElementById('pvt-gt');
                const liveGt = gtEl ? parseFloat((gtEl.textContent || '').replace(/[^0-9.]/g, '')) : gt;
                // ASIN for step 2: first item's resolved ASIN if available, else
                // its FNSKU (the first FNSKU/ASIN row on the high-value tote page).
                const first = (items && items[0]) || null;
                const asin = first ? (first.resolvedAsin || first.fnsku || '') : '';
                const payload = {
                    gt: isNaN(liveGt) ? gt : liveGt,
                    qty: tQty,
                    toteId: tId,
                    asin,
                    comment: '',
                    ts: Date.now(),
                };

                // Over £1,000: build the adjustment comment from FC Research
                // (Inventory + Receive History) on THIS tab before opening the
                // SIM, so the handoff carries the finished text to river-dub.
                if (payload.gt > 1000) {
                    btn.dataset.busy = '1';
                    const label = btn.textContent;
                    btn.textContent = '\u23F3 Building comment...';
                    setStatus('Building adjustment comment from FC Research...', '#8e44ad');
                    let diag = '';
                    try {
                        const r = await buildAdjustmentComment(tId);
                        payload.comment = (r && r.text) || '';
                        diag = (r && r.diag) || '';
                    } catch (e) { payload.comment = ''; diag = 'exception'; }
                    payload.commentDiag = diag; // carried to river-dub for the toast
                    btn.textContent = label;
                    delete btn.dataset.busy;
                    setStatus(
                        payload.comment
                            ? `Comment ready (${payload.comment.split('\n').length} line(s)). Opening DL...`
                            : `No comment built [${diag}]. Opening DL...`,
                        payload.comment ? '#27ae60' : '#f39c12'
                    );
                } else {
                    setStatus(`Opening DL (£${payload.gt.toFixed(2)}, ${payload.qty} units)...`, '#8e44ad');
                }

                try { GM_setValue(DL_HANDOFF_KEY, JSON.stringify(payload)); } catch { }
                window.open(DL_URL, '_blank', 'noopener');
            };
        }

        // Wire the initial banner's button (present when the tote opens high-value).
        wireCreateDlButton(toteId, totalQty);

        return new Promise(resolve => {
            document.getElementById('pvt-cc-yes').onclick = () => { overlay.remove(); resolve('yes'); };
            document.getElementById('pvt-cc-skip').onclick = () => { overlay.remove(); resolve('skip'); };
            document.getElementById('pvt-cc-no').onclick = () => { overlay.remove(); resolve('no'); };
        });
    }

    // =========================================================================
    //  MAIN AUTO-RUN LOOP
    // =========================================================================

    async function autoRun() {
        if (!toteList.length) { setStatus('Load tote list first', 'orange'); return; }
        document.getElementById('pvt-btn-auto').style.display = 'none';
        document.getElementById('pvt-btn-stop').style.display = '';
        autoRunning = true;
        saveState();

        while (autoRunning && currentIdx < toteList.length) {
            const toteId = toteList[currentIdx];
            const idx = currentIdx;
            const lower = toteId.toLowerCase();

            // --- Guard: skip vt/pa/numeric totes (virtual, pallet, shipment IDs) ---
            if (lower.startsWith('vt') || lower.startsWith('pa') || /^\d+$/.test(toteId)) {
                const reason = lower.startsWith('vt') ? 'virtual tote (vt)' : lower.startsWith('pa') ? 'pallet (pa)' : 'numeric ID';
                const decision = await showSkipWarning(toteId, reason);
                if (decision === 'stop') { autoRunning = false; clearState(); break; }
                currentIdx++;
                saveState();
                renderList();
                continue;
            }

            // --- Step 1: Wait for scan page ---
            setStatus(`[${idx + 1}/${toteList.length}] Waiting for scan page...`, '#3498db');
            const scanInput = await waitForScanPage();
            if (!scanInput) { setStatus('Scan page timeout - retrying', 'orange'); continue; }

            // --- Step 2: Fill tote ID and submit ---
            scanInput.focus();
            setNativeValue(scanInput, toteId);
            setStatus(`[${idx + 1}/${toteList.length}] Scanning: ${toteId}`, '#0b3948');
            renderList();
            pressEnter(scanInput);

            // --- Step 3+4: Detect a blocking error immediately, or wait for the
            // page to transition to the Change Container button. The error check
            // runs concurrently so a Reverse Logistics error is caught instantly
            // instead of waiting out the page-transition timeout. ---
            setStatus('Waiting for Change Container...', '#3498db');
            const outcome = await waitForChangeOrError(TIMING.pageTimeout);
            if (!autoRunning) { continue; }

            // --- Blocking error (e.g. Reverse Logistics item) ---
            if (outcome.type === 'error') {
                setStatus(`Tote ${idx + 1} cannot be processed`, '#e74c3c');
                const decision = await showCannotProcess(toteId, outcome.message);
                if (decision === 'stop') { autoRunning = false; clearState(); break; }
                // Skip: mark handled, advance, reload for a clean DOM + auto-resume
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                location.reload();
                return;
            }

            if (outcome.type === 'timeout') { setStatus('Change Container timeout - retrying', 'orange'); continue; }

            const changeBtn = outcome.el;
            if (!changeBtn) { continue; }

            // Wait for item quantity to be readable (no timeout - wait until loaded)
            let qty = -1;
            const qtyStart = Date.now();
            setStatus('Waiting for inventory to load...', '#3498db');
            while (qty === -1) {
                await waitFor(SEL.itemQuantity, 2000);
                qty = getItemQuantity();
                // Also check for "No items found" text - means empty tote
                if (qty === -1 && document.body.innerText.includes('No items found in this container')) {
                    qty = 0;
                    break;
                }
                if (qty === -1) {
                    const elapsed = Math.round((Date.now() - qtyStart) / 1000);
                    setStatus(`Waiting for inventory to load... (${elapsed}s)`, '#3498db');
                    await bgSleep(300);
                }
            }

            // --- Handle empty totes - skip without processing ---
            if (qty === 0) {
                setStatus(`Tote ${idx + 1} is empty - skipping to next`, 'orange');
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                location.reload();
                return;
            } else {
                // --- Step 5: High-quantity guard ---
                if (qty > HIGH_QTY_THRESHOLD) {
                    if (!await confirmHighQuantity(toteId, qty)) {
                        currentIdx++;
                        saveState();
                        renderList();
                        location.reload();
                        return;
                    }
                }

                // --- Step 6: Read items the moment they're ready (event-driven) ---
                // readItemsWhenReady both waits and reads in one non-throttled
                // loop: it clicks "Load All Rows" if present and resolves the
                // instant the full row set is parseable — no fixed delays.
                setStatus('Loading items...', '#8e44ad');
                let items = await readItemsWhenReady(getExpectedRowCount());

                // Fallback: text scan if alchemy-tags not found
                if (!items.length) {
                    const text = document.body.innerText || '';
                    const asins = [...new Set(text.match(/\bB0[A-Z0-9]{8}\b/g) || [])];
                    const fnskus = [...new Set(text.match(/\bX[A-Z0-9]{9}\b/g) || [])];
                    asins.forEach(a => items.push({ fnsku: a, qty: 1, title: '', isAsin: true, price: null, resolvedAsin: null, fcPrice: null }));
                    fnskus.forEach(f => items.push({ fnsku: f, qty: 1, title: '', isAsin: false, price: null, resolvedAsin: null, fcPrice: null }));
                }

                // --- Step 7: FC Research (ASIN + price) then Amazon, in parallel ---
                if (items.length) {
                    // Phase 1: Query FC Research for EVERY item in parallel batches.
                    //   - FNSKU items (isAsin=false): resolves the ASIN AND gets the
                    //     FC Research List Price.
                    //   - ASIN items (isAsin=true): no resolve needed, but we STILL
                    //     query FCR to get its List Price, so the price chain is
                    //     FC Research first for all items (ASINs no longer skip FCR
                    //     straight to Amazon — that was the "Amazon first" cause).
                    // The FCR /results/product endpoint accepts an ASIN or an FNSKU
                    // as its search term, so the same call serves both cases.
                    let resolved = 0;
                    const fcrJobs = items.map(item => async () => {
                        // Search term is the scanned code (ASIN or FNSKU); FCR
                        // /results/product accepts either.
                        const fcr = await fetchFCResearch(item.fnsku);
                        if (fcr?.asin && !item.isAsin) { item.resolvedAsin = fcr.asin; }
                        if (fcr?.title) item.title = item.title || fcr.title;
                        if (fcr?.fcPrice) item.fcPrice = fcr.fcPrice; // FC Research price for the fallback chain
                        resolved++;
                        setStatus(`FC Research ${resolved}/${items.length}...`, '#8e44ad');
                    });
                    for (let i = 0; i < fcrJobs.length; i += BATCH_SIZE) {
                        await Promise.all(fcrJobs.slice(i, i + BATCH_SIZE).map(fn => fn()));
                    }

                    // Phase 2: Resolve each item's price + PS count in parallel.
                    // Price fallback chain: FC Research "List Price" first, then
                    // the live Amazon.co.uk price, and finally "NIL" if neither
                    // returns a usable number.
                    let done = 0;
                    const jobs = items.map(item => async () => {
                        const asin = item.isAsin ? item.fnsku : item.resolvedAsin;

                        // PS count still comes from FC Research by ASIN (unchanged).
                        const psPromise = asin ? checkProblemSolve(asin) : Promise.resolve(null);

                        // 1) FC Research price (already fetched during Phase 1).
                        let price = isValidPrice(item.fcPrice) ? item.fcPrice : null;
                        let source = price ? 'FCR' : '';
                        // Diagnostic: record what FCR actually returned so we can
                        // see WHY it fell back (e.g. fcPrice was 'N/A'/empty).
                        item.fcPriceRaw = item.fcPrice ?? '(none)';

                        // 2) Fall back to the live Amazon price when FCR had none.
                        if (!price && asin) {
                            const amz = await fetchAmazonPrice(asin);
                            if (isValidPrice(amz)) { price = amz; source = 'Amazon'; }
                        }

                        // 3) Neither source produced a usable price -> NIL.
                        item.price = price || 'NIL';
                        item.priceSource = source || 'none';
                        item.problemSolve = await psPromise;

                        done++;
                        setStatus(`Fetching prices: ${done}/${items.length}`, '#8e44ad');
                    });
                    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
                        await Promise.all(jobs.slice(i, i + BATCH_SIZE).map(fn => fn()));
                    }
                }

                // --- Step 8: Show confirmation dialog ---
                const decision = await confirmChangeContainer(toteId, idx + 1, toteList.length, items, qty);

                if (decision === 'skip') {
                    currentIdx++;
                    saveState();
                    renderList();
                    location.reload();
                    return;
                }
                if (decision === 'no') { autoRunning = false; clearState(); break; }

                // --- Step 9: Click Change Container + Yes popup ---
                setStatus('Processing change...', '#0b3948');
                changeBtn.click();

                const yesBtn = await waitForYesButton();
                if (yesBtn) yesBtn.click();
            }

            // --- Step 10: Mark done and wait for next scan page ---
            doneSet.add(idx);
            currentIdx++;
            saveState();
            renderList();
            setStatus('Returning to scan page...', '#3498db');
            await waitFor(SEL.scanInput, TIMING.pageTimeout);
        }

        // --- Finished ---
        if (autoRunning && currentIdx >= toteList.length) {
            setStatus(`Done! All ${toteList.length} totes processed.`, '#27ae60');
            clearState();
        }
        autoRunning = false;
        document.getElementById('pvt-btn-auto').style.display = '';
        document.getElementById('pvt-btn-stop').style.display = 'none';
    }

    // =========================================================================
    //  UI - Status, Progress, List Rendering
    // =========================================================================

    function setStatus(msg, color = '#7f8c8d') {
        const el = document.getElementById('pvt-status');
        if (el) { el.textContent = msg; el.style.color = color; }
    }

    function renderList() {
        const wrap = document.getElementById('pvt-list-wrap');
        if (!wrap) return;
        const fill = document.getElementById('pvt-prog-fill');
        if (fill) fill.style.width = toteList.length ? `${Math.round(doneSet.size / toteList.length * 100)}%` : '0%';

        if (!toteList.length) { wrap.innerHTML = '<div style="padding:18px;text-align:center;color:#aaa;font-size:12px">Paste tote IDs above and click Load List</div>'; return; }
        wrap.innerHTML = '';
        toteList.forEach((id, i) => {
            const done = doneSet.has(i);
            const active = i === currentIdx && !done && autoRunning;
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;padding:7px 10px;border-bottom:1px solid #f5f5f5;cursor:pointer;gap:8px;transition:background .15s;${done ? 'background:#f0f9f0;color:#27ae60' : active ? 'background:#fff3cd;font-weight:700' : ''}`;
            row.innerHTML = `<div style="width:22px;height:22px;background:${done ? '#2ecc71' : active ? '#f39c12' : '#0b3948'};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${i + 1}</div><div style="flex:1;font:12px monospace">${id}</div>${done ? '<span style="color:#27ae60;font-weight:700">&#10003;</span>' : ''}`;
            row.onclick = () => { if (!done) { const inp = document.querySelector(SEL.scanInput); if (inp) { inp.focus(); setNativeValue(inp, id); currentIdx = i; renderList(); setStatus('Filled: ' + id, '#0b3948'); } } };
            wrap.appendChild(row);
        });
        wrap.children[currentIdx]?.scrollIntoView({ block: 'nearest' });
    }

    /** Parses textarea text into a deduped tote list (keeps first occurrence,
     *  preserves order, case-insensitive). Returns { list, removed }. */
    function dedupeTotes(text) {
        const raw = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
        const seen = new Set();
        const list = raw.filter(id => {
            const key = id.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return { list, removed: raw.length - list.length };
    }

    function loadList() {
        const ta = document.getElementById('pvt-ta');
        if (!ta) return;
        const { list, removed } = dedupeTotes(ta.value);
        toteList = list;
        doneSet = new Set();
        currentIdx = 0;
        // Persist the deduped list so reloads (skip/auto-resume) stay deduped
        ta.value = list.join('\n');
        ls.set(LS.list, ta.value);
        clearState();
        renderList();
        setStatus(`${toteList.length} tote(s) loaded${removed > 0 ? ` (${removed} duplicate${removed === 1 ? '' : 's'} removed)` : ''}`, '#27ae60');
    }

    function clearAll() {
        autoRunning = false;
        toteList = []; doneSet = new Set(); currentIdx = 0;
        const ta = document.getElementById('pvt-ta');
        if (ta) ta.value = '';
        ls.set(LS.list, '');
        clearState();
        renderList();
        setStatus('Cleared', '#7f8c8d');
        document.getElementById('pvt-btn-auto').style.display = '';
        document.getElementById('pvt-btn-stop').style.display = 'none';
    }

    // =========================================================================
    //  UI - Panel Construction & Draggable
    // =========================================================================

    function buildPanel() {
        // Inject hover/active polish for the panel controls once.
        if (!document.getElementById('pvt-ui-style')) {
            const st = document.createElement('style');
            st.id = 'pvt-ui-style';
            st.textContent = `
                #pvt-panel button{transition:filter .15s,transform .05s,box-shadow .15s}
                #pvt-panel button:hover{filter:brightness(1.08)}
                #pvt-panel button:active{transform:translateY(1px)}
                #pvt-panel #pvt-collapse:hover{opacity:1}
                #pvt-panel textarea:focus{outline:none;border-color:#1abc9c;box-shadow:0 0 0 2px rgba(26,188,156,.18)}
                #pvt-list-wrap::-webkit-scrollbar{width:8px}
                #pvt-list-wrap::-webkit-scrollbar-thumb{background:#cfd8dc;border-radius:4px}
                #pvt-list-wrap::-webkit-scrollbar-thumb:hover{background:#b0bec5}`;
            document.head.appendChild(st);
        }

        const panel = document.createElement('div');
        panel.id = 'pvt-panel';
        panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:310px;background:#fff;border:2px solid #0b3948;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.22);font:13px Segoe UI,system-ui,sans-serif;color:#2c3e50;overflow:hidden';
        panel.innerHTML = `
            <div id="pvt-header" style="background:linear-gradient(135deg,#0b3948,#1abc9c);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px;font:700 14px Segoe UI;cursor:move;user-select:none">
                <span>Sideline v${VERSION}</span>
                <span id="pvt-collapse" title="Collapse / expand" style="margin-left:auto;cursor:pointer;font-size:18px;line-height:1;opacity:.8;padding:0 4px">\u2212</span>
            </div>
            <div id="pvt-body" style="padding:12px 14px">
                <textarea id="pvt-ta" placeholder="Paste tote IDs (one per line)" style="width:100%;height:100px;padding:8px;box-sizing:border-box;border:2px solid #e0e0e0;border-radius:8px;font:12px monospace;resize:vertical"></textarea>
                <div style="font-size:11px;color:#95a5a6;margin:5px 0 10px">Click row to fill manually, or Auto-Run for hands-free</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
                    <button id="pvt-btn-load" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#0b3948;color:#fff">Load List</button>
                    <button id="pvt-btn-clear" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#f0f0f0;color:#555">Clear</button>
                    <button id="pvt-btn-auto" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#2ecc71;color:#fff">Auto-Run</button>
                    <button id="pvt-btn-stop" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#e74c3c;color:#fff;display:none">Stop</button>
                </div>
                <div id="pvt-list-wrap" style="max-height:190px;overflow-y:auto;border:1px solid #eee;border-radius:8px"></div>
                <div id="pvt-status" style="margin-top:8px;padding:6px 10px;border-radius:7px;font:600 11px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d;min-height:28px;display:flex;align-items:center;justify-content:center">Ready</div>
                <div style="height:5px;background:#e0e0e0;border-radius:3px;overflow:hidden;margin-top:6px"><div id="pvt-prog-fill" style="height:100%;background:linear-gradient(90deg,#2ecc71,#1abc9c);width:0%;transition:width .35s;border-radius:3px"></div></div>
            </div>`;
        document.body.appendChild(panel);

        // Make panel draggable by header, clamped to the viewport so it can
        // never be dragged out of reach. The ignore-on-controls guard keeps the
        // collapse button clickable.
        let sx, sy;
        const hdr = panel.querySelector('#pvt-header');
        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        hdr.addEventListener('mousedown', e => {
            if (e.target.closest('#pvt-collapse')) return; // don't drag on the toggle
            e.preventDefault();
            sx = e.clientX; sy = e.clientY;
            const move = ev => {
                const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - 40); // keep header reachable
                panel.style.left = clamp(panel.offsetLeft + ev.clientX - sx, 0, maxLeft) + 'px';
                panel.style.top = clamp(panel.offsetTop + ev.clientY - sy, 0, maxTop) + 'px';
                panel.style.right = 'auto';
                sx = ev.clientX; sy = ev.clientY;
            };
            const stop = () => {
                document.removeEventListener('mousemove', move);
                // Remember where the user parked it (survives reloads).
                try { ls.set('pvt_pos', JSON.stringify({ t: panel.style.top, l: panel.style.left })); } catch { }
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', stop, { once: true });
        });

        // Restore a saved panel position (if any) from a previous drag.
        try {
            const pos = JSON.parse(ls.get('pvt_pos', 'null'));
            if (pos && pos.t && pos.l) { panel.style.top = pos.t; panel.style.left = pos.l; panel.style.right = 'auto'; }
        } catch { }

        return panel;
    }

    // =========================================================================
    //  UPDATE CHECKER - compares running @version against the remote raw file
    // =========================================================================

    /** Compares two dotted version strings. Returns 1 if a>b, -1 if a<b, 0 if equal. */
    function compareVersions(a, b) {
        const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const x = pa[i] || 0, y = pb[i] || 0;
            if (x > y) return 1;
            if (x < y) return -1;
        }
        return 0;
    }

    /** Fetches the remote script header and returns its @version, or null. */
    function fetchRemoteVersion() {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${UPDATE_URL}?_=${Date.now()}`, // cache-bust
                headers: { 'Cache-Control': 'no-cache' },
                onload(resp) {
                    const m = (resp.responseText || '').match(/@version\s+([\d.]+)/);
                    resolve(m ? m[1] : null);
                },
                onerror() { resolve(null); },
                ontimeout() { resolve(null); },
            });
        });
    }

    /** Shows an update banner inside the panel with a one-click install link. */
    function showUpdateBanner(remoteVersion) {
        if (document.getElementById('pvt-update-banner')) return;
        const body = document.getElementById('pvt-body');
        if (!body) return;
        const banner = document.createElement('div');
        banner.id = 'pvt-update-banner';
        banner.style.cssText = 'margin-bottom:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #ffe08a;color:#8a6d00;font:600 12px Segoe UI;text-align:center';
        banner.innerHTML = `Update available: v${remoteVersion} (you have v${VERSION})<br>
            <a href="${UPDATE_URL}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;padding:6px 14px;border-radius:6px;background:#f39c12;color:#fff;text-decoration:none">Install update</a>`;
        body.insertBefore(banner, body.firstChild);
    }

    /** Checks for a newer remote version and shows the banner if found. */
    async function checkForUpdate() {
        const remote = await fetchRemoteVersion();
        if (remote && compareVersions(remote, VERSION) > 0) {
            showUpdateBanner(remote);
            setStatus(`Update available: v${remote}`, '#f39c12');
        }
    }

    // =========================================================================
    //  INITIALIZATION
    // =========================================================================

    function init() {
        if (document.getElementById('pvt-panel')) return;
        buildPanel();

        // Check GitHub for a newer version (non-blocking)
        checkForUpdate();

        // Restore tote list from localStorage
        const saved = ls.get(LS.list);
        if (saved) {
            // Dedupe on restore too, so skip/auto-resume reloads never
            // reintroduce duplicates from a stale saved list.
            const { list } = dedupeTotes(saved);
            const deduped = list.join('\n');
            document.getElementById('pvt-ta').value = deduped;
            if (deduped !== saved) ls.set(LS.list, deduped);
            toteList = list;
        }

        // Restore run state (supports auto-resume after skip-reload)
        const shouldResume = restoreState();
        renderList();

        if (toteList.length && shouldResume && currentIdx < toteList.length) {
            setStatus(`Resuming from tote ${currentIdx + 1}...`, '#3498db');
            ls.set(LS.auto, '0');
            autoRun();
        } else if (toteList.length) {
            setStatus(`${toteList.length} tote(s) restored`, '#3498db');
        }

        // Button handlers
        document.getElementById('pvt-btn-load').onclick = loadList;
        document.getElementById('pvt-btn-clear').onclick = clearAll;
        document.getElementById('pvt-btn-auto').onclick = () => { if (!autoRunning) autoRun(); };
        document.getElementById('pvt-btn-stop').onclick = () => {
            autoRunning = false; clearState(); setStatus('Stopped', '#e74c3c');
            document.getElementById('pvt-btn-auto').style.display = '';
            document.getElementById('pvt-btn-stop').style.display = 'none';
        };
        document.getElementById('pvt-collapse').onclick = () => {
            const body = document.getElementById('pvt-body');
            const btn = document.getElementById('pvt-collapse');
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            btn.textContent = hidden ? '+' : '\u2212'; // + when collapsed, − when open
            ls.set('pvt_collapsed', hidden ? '0' : '1');
        };
        // Restore collapsed state from a previous session.
        if (ls.get('pvt_collapsed', '0') === '1') {
            const body = document.getElementById('pvt-body');
            const btn = document.getElementById('pvt-collapse');
            if (body && btn) { body.style.display = 'none'; btn.textContent = '+'; }
        }
    }

    // =========================================================================
    //  RIVER-DUB AUTO-SELECT (runs only on river-dub.amazon.com)
    // =========================================================================
    // Reads the handoff stashed by "Create DL" on the Poirot tab, computes the
    // adjustment band from the tote's value/units, waits for the AngularJS radio
    // group to render, ticks the matching radio, and notifies Angular so its
    // ng-model ("data.adjustmentType") updates. UNRECEIVE is never auto-selected.

    /** Ticks a radio in an Angular-safe way (sets .checked + fires events). */
    function setAngularRadio(radio) {
        if (!radio || radio.checked) return radio && radio.checked;
        radio.checked = true;
        // AngularJS binds to click for radios; also fire input/change for safety.
        radio.dispatchEvent(new Event('click', { bubbles: true }));
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        return radio.checked;
    }

    /**
     * Sets a text input/textarea value so AngularJS's ng-model updates. Uses the
     * native value setter (bypasses any framework override) then fires
     * input/change/keyup, and also drives $apply via a triggerHandler-style
     * dispatch so ng-pristine/ng-invalid flip correctly.
     */
    function setNgText(el, val) {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, String(val)); else el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return true;
    }

    /**
     * Selects an option in the river-dub custom cs-select dropdown by its value.
     * The widget is a <div class="cs-select-wrapper"> containing a visible
     * trigger + a hidden native <select ng-model=...>. We set the native select
     * (so Angular's ng-model updates) AND the visible trigger label + the
     * matching option's selected class (so the UI reflects the choice).
     * `selectEl` is the hidden <select> element; `value` is the option value.
     */
    function setCsSelect(selectEl, value) {
        if (!selectEl) return false;
        const opt = [...selectEl.options].find(o => o.value === value);
        if (!opt) return false;
        selectEl.value = value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        // Update the visible cs-select UI so the user sees the selection.
        const wrapper = selectEl.closest('.cs-select-wrapper');
        if (wrapper) {
            const label = wrapper.querySelector('.cs-select-trigger-text');
            if (label) label.textContent = value;
            wrapper.querySelectorAll('.cs-select-option').forEach(o => {
                const sel = o.getAttribute('data-value') === value;
                o.classList.toggle('cs-select-option-selected', sel);
                const check = o.querySelector('.cs-select-check');
                if (check) check.style.visibility = sel ? '' : 'hidden';
            });
        }
        return true;
    }

    /** Shows a small toast banner on the river-dub page (fixed, dismissable). */
    function dlToast(message, color = '#8e44ad') {
        document.getElementById('sideline-dl-toast')?.remove();
        const t = document.createElement('div');
        t.id = 'sideline-dl-toast';
        t.style.cssText = `position:fixed;top:16px;right:16px;z-index:2147483647;background:${color};color:#fff;padding:12px 16px;border-radius:10px;font:600 13px Segoe UI,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:380px;line-height:1.4;white-space:pre-line`;
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 12000);
    }

    const DL_BAND_LABELS = {
        extraSmall: '< 100 units / £1,000',
        small: '100-200 units / £1,000-2,000',
        medium: '200-1,000 units / £2,000-7,500',
        large: '>1,000 units / £7,500-15,000',
        extraLarge: '£15,000-30,000',
        extraExtraLarge: '£30,000+',
        extraExtraMegaLarge: '£500,000+',
    };

    /**
     * river-dub driver. Two phases, both driven by a single long-lived
     * MutationObserver because river-dub is an AngularJS SPA (step 2 replaces
     * step 1's DOM without a page reload):
     *   Phase 1 — tick the adjustmentType band radio (handoff kept).
     *   Phase 2 — after the user clicks "Confirm & Continue", the step-2 form
     *             renders; fill Tool=Sideline, Container=toteId, ASIN, Qty,
     *             Total value (rounded, no decimals), then CONSUME the handoff.
     * UNRECEIVE is never auto-selected. Nothing is submitted; the user reviews.
     */
    function riverDubAutoSelect() {
        let raw;
        try { raw = GM_getValue(DL_HANDOFF_KEY, ''); } catch { raw = ''; }
        if (!raw) return; // No handoff -> user opened river-dub directly; do nothing.

        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        if (!payload || typeof payload.gt !== 'number') return;

        // Ignore a stale handoff so an old value never auto-fills a fresh visit.
        if (!payload.ts || (Date.now() - payload.ts) > DL_HANDOFF_TTL) return;

        const band = mapAdjustmentBand(payload.gt, payload.qty);
        if (!band) return;

        const toteLabel = payload.toteId ? ` for ${payload.toteId}` : '';
        let bandDone = false;
        let step2Done = false;
        let step2CommentWaits = 0;

        // --- Phase 1: tick the band radio (does NOT consume the handoff) ---
        function tryBand() {
            if (bandDone) return;
            const radios = [...document.querySelectorAll('input[type="radio"][name="adjustmentType"]')];
            if (!radios.length) return;
            const matches = radios.filter(r => r.value === band);
            // Prefer the visible instance (vertical vs paged flow copies exist).
            const target = matches.find(r => r.offsetParent !== null) || matches[0];
            if (!target) return;
            bandDone = true;
            const ok = setAngularRadio(target);
            dlToast(
                ok
                    ? `\u2705 Band selected: ${DL_BAND_LABELS[band] || band} (£${payload.gt.toFixed(2)}, ${payload.qty} units)${toteLabel}.\nClick "Confirm & Continue" to fill the form.`
                    : `\u26A0 Could not auto-select the band. Pick it manually (£${payload.gt.toFixed(2)}, ${payload.qty} units).`,
                ok ? '#27ae60' : '#e74c3c'
            );
        }

        // --- Phase 2: fill the step-2 form once it renders ---
        // river-dub renders BOTH a vertical-flow and a paged-flow copy of the
        // form (one hidden via ng-show). Pick the VISIBLE element so the fill is
        // also reflected on screen (offsetParent !== null means it's visible).
        const pick = (sel) => {
            const els = [...document.querySelectorAll(sel)];
            return els.find(e => e.offsetParent !== null) || els[0] || null;
        };

        // Prefers a visible element from a list (same rule as pick()).
        const preferVisible = (els) => els.find(e => e.offsetParent !== null) || els[0] || null;

        /**
         * Finds the "Enter the adjustment comment below" textarea robustly.
         * The exact ng-model can vary, so try, in order:
         *   1. known ng-model bindings (data.commentAreaS / commentArea)
         *   2. a textarea whose label / placeholder / aria-label mentions
         *      "adjustment comment", then just "comment"
         *   3. the last visible textarea on the step (comment is the big one)
         * Never returns the Root Cause comment field (that stays manual), so
         * matches mentioning "root cause" are excluded.
         */
        function findCommentField() {
            const byModel = document.querySelector(
                '[ng-model="data.commentAreaS"],[ng-model="data.commentArea"],textarea[ng-model*="comment" i]'
            );
            if (byModel && byModel.offsetParent !== null) return byModel;

            const areas = [...document.querySelectorAll('textarea')].filter(t => t.offsetParent !== null);
            if (!areas.length) return byModel || null;

            // Build a searchable text blob per textarea from its labels/attrs.
            const blobOf = (t) => {
                let s = `${t.placeholder || ''} ${t.getAttribute('aria-label') || ''} ${t.name || ''} ${t.id || ''}`;
                if (t.id) {
                    const lab = document.querySelector(`label[for="${CSS.escape(t.id)}"]`);
                    if (lab) s += ' ' + (lab.textContent || '');
                }
                // Nearby label/heading text (previous siblings + parent block).
                const near = t.closest('div, fieldset, .form-group, li');
                if (near) s += ' ' + (near.textContent || '');
                return s.toLowerCase();
            };

            const notRootCause = (t) => !blobOf(t).includes('root cause');
            const adj = areas.filter(t => blobOf(t).includes('adjustment comment') && notRootCause(t));
            if (adj.length) return preferVisible(adj);
            const cmt = areas.filter(t => blobOf(t).includes('comment') && notRootCause(t));
            if (cmt.length) return preferVisible(cmt);

            // Last resort: the known binding, else the last non-root-cause area.
            const fallback = areas.filter(notRootCause);
            return byModel || fallback[fallback.length - 1] || null;
        }

        function tryStep2() {
            if (step2Done) return;
            // Step 2 is identified by the container input (ng-model data.containerInputS).
            const container = pick('[ng-model="data.containerInputS"]');
            if (!container) return;

            const asinEl    = pick('[ng-model="data.asinInputS"]');
            const qtyEl     = pick('[ng-model="data.qtyInputS"]');
            const valueEl   = pick('[ng-model="data.totalCostInputS"]');
            const toolSel   = pick('select[ng-model="data.toolDropdownS"]');
            const commentEl = findCommentField();

            // Total value: rounded to a whole number, no decimals (field is int-only).
            const valueInt = String(Math.round(Number(payload.gt) || 0));
            const qtyInt   = String(Math.round(Number(payload.qty) || 0));

            // If a comment is expected but its textarea hasn't rendered yet,
            // don't finish this pass — let the observer retry. (We track how
            // many times we've waited so we give up gracefully rather than
            // looping forever if the field genuinely never appears.)
            if (payload.comment && !commentEl) {
                step2CommentWaits = (step2CommentWaits || 0) + 1;
                if (step2CommentWaits < 20) return; // ~retry as the DOM settles
            }

            const filled = [];
            if (toolSel && setCsSelect(toolSel, 'Sideline')) filled.push('Tool=Sideline');
            if (setNgText(container, payload.toteId || '')) filled.push('Container');
            if (payload.asin && asinEl && setNgText(asinEl, payload.asin)) filled.push('ASIN');
            if (setNgText(qtyEl, qtyInt)) filled.push('Qty');
            if (setNgText(valueEl, valueInt)) filled.push('Value');
            // Comment: FC Research history lines, built on the Poirot tab.
            // Root Cause dropdown + its comment stay MANUAL (user decides those).
            let commentNote = '';
            if (!payload.comment) {
                commentNote = `Comment: none built [${payload.commentDiag || 'no history'}].`;
            } else if (!commentEl) {
                commentNote = 'Comment: field not found - paste manually.';
            } else if (setNgText(commentEl, payload.comment)) {
                filled.push('Comment');
            } else {
                commentNote = 'Comment: fill failed - paste manually.';
            }

            step2Done = true;
            // Consume the handoff now — step 2 is the last thing we auto-fill.
            try { GM_setValue(DL_HANDOFF_KEY, ''); } catch { }

            dlToast(
                `\u2705 Auto-filled: ${filled.join(', ') || '(nothing)'}.\n` +
                `Tote ${payload.toteId || '-'} | ASIN ${payload.asin || '(none)'} | ` +
                `Qty ${qtyInt} | Value £${valueInt}.\n` +
                (commentNote ? `\u26A0 ${commentNote}\n` : '') +
                `Now set Root Cause + comments, then review & submit.`,
                commentNote ? '#f39c12' : '#27ae60'
            );
        }

        // Run once now (page may already be on step 1), then watch for changes.
        tryBand();
        tryStep2();

        const obs = new MutationObserver(() => { tryBand(); tryStep2(); });
        obs.observe(document.body, { childList: true, subtree: true });

        // Safety: stop observing after the handoff TTL window regardless.
        setTimeout(() => obs.disconnect(), DL_HANDOFF_TTL);
    }

    // =========================================================================
    //  ENTRY POINT — route by host
    // =========================================================================
    if (location.hostname.indexOf('river-dub') !== -1) {
        // river-dub tab: only run the auto-select (no Poirot panel here).
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', riverDubAutoSelect);
        else riverDubAutoSelect();
    } else {
        // Poirot tab: run the full automation panel.
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

})();
