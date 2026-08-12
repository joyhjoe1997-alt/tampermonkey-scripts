// ==UserScript==
// @name         Sideline - Multi-Tote Deletion Automation
// @author       joyhjoe
// @version      6.0
// @description  Automated tote processing for AFT Poirot V3 with multi-item price lookup
// @match        https://aft-poirot-website-dub.dub.proxy.amazon.com/*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      amazon.co.uk
// @connect      qi-fcresearch-eu.corp.amazon.com
// ==/UserScript==

/**
 * SIDELINE v6.0 - AFT Poirot Tote Automation
 *
 * Features:
 *   - Paste tote IDs, auto-processes them sequentially
 *   - Reads all items (FNSKU/ASIN + qty) from the Change Container page
 *   - Resolves X0 FNSKUs to ASINs via FC Research /results/product API
 *   - Fetches live Amazon.co.uk prices (parallel batches of 3)
 *   - Shows confirmation dialog with item table, prices, and grand total
 *   - Skips vt/pa/numeric totes with warning
 *   - High quantity (>100) warning before emptying
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
    // =========================================================================
// =========================================================================
    //  UTILITIES
    // =========================================================================

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

                        // Strategy 1: Parse the product key-value table
                        const table = doc.querySelector('table.a-keyvalue[data-row-id]');
                        if (table) {
                            asin = table.getAttribute('data-row-id');
                            for (const row of table.querySelectorAll('tr')) {
                                const th = row.querySelector('th')?.textContent.trim();
                                const td = row.querySelector('td')?.textContent.trim();
                                if (th === 'List Price' && td) fcPrice = td.replace(/^[A-Z]{3}\s+/, '');
                                if (th === 'Title' && td) title = td;
                            }
                        }

                        // Strategy 2: Positional CSS selectors
                        if (!asin) asin = doc.querySelector('.a-span7 > table > tbody > tr:nth-child(1) > td:nth-child(2) > a')?.textContent.trim() || null;
                        if (!title) title = doc.querySelector('a[href*="amazon.co.uk/gp/product"]')?.textContent.trim() || '';

                        // Strategy 3: Regex on raw HTML
                        if (!asin) asin = (html.match(/data-row-id="(B[A-Z0-9]{9})"/) || html.match(/results\?s=(B[A-Z0-9]{9})/))?.[1] || null;
                        if (fcPrice === 'N/A') fcPrice = html.match(/<th>List Price<\/th>\s*<td>([^<]+)<\/td>/)?.[1]?.replace(/^[A-Z]{3}\s+/, '').trim() || 'N/A';

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
                    priceCache[asin] = price;
                    resolve(price);
                },
                onerror() { priceCache[asin] = 'Error'; resolve('Error'); },
                ontimeout() { priceCache[asin] = 'Timeout'; resolve('Timeout'); },
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
            const iv = setInterval(() => {
                const el = document.querySelector(selector);
                if (el?.offsetParent !== null) { clearInterval(iv); resolve(el); }
                else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
            }, TIMING.pollInterval);
        });
    }

    /** Waits until the scan page is active */
    function waitForScanPage(timeout = TIMING.scanTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = setInterval(() => {
                if (isOnScanPage()) { clearInterval(iv); resolve(document.querySelector(SEL.scanInput)); }
                else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
            }, TIMING.pollInterval);
        });
    }

    /** Waits until we leave the scan page (page transition detected) */
    function waitForPageLeave(timeout = TIMING.pageTimeout) {
        return new Promise(resolve => {
            const start = Date.now();
            const iv = setInterval(() => {
                if (!isOnScanPage() || Date.now() - start > timeout) { clearInterval(iv); resolve(); }
            }, TIMING.pollInterval);
        });
    }

    /** Waits until all item rows have rendered on the Change Container page.
     *  Uses MutationObserver for instant detection (no polling delay).
     *  Resolves when rendered count matches expected, or stabilizes for 500ms.
     */
    function waitForItemsRendered() {
        return new Promise(resolve => {
            const start = Date.now();
            const expected = getExpectedRowCount();
            let lastCount = 0;
            let stableTimer = null;

            function countItems() {
                return [...document.querySelectorAll('alchemy-tag')]
                    .filter(t => !t.closest('#pvt-panel,#pvt-cc-dialog,#pvt-hq-dialog'))
                    .filter(t => /^\d+\s*qty$/i.test((t.innerText || t.textContent || '').trim()))
                    .length;
            }

            function check() {
                const count = countItems();
                const elapsed = Math.round((Date.now() - start) / 1000);
                setStatus(`Loading items... ${count}/${expected > 0 ? expected : '?'} rows (${elapsed}s)`, '#8e44ad');

                // Exact match with expected row count — done immediately
                if (expected > 0 && count >= expected) { done(); return; }

                // Count changed — reset stability timer
                if (count !== lastCount) {
                    lastCount = count;
                    if (stableTimer) clearTimeout(stableTimer);
                    // Wait 500ms of no changes to confirm all loaded
                    if (count > 0) {
                        stableTimer = setTimeout(done, 500);
                    }
                }
            }

            function done() {
                observer.disconnect();
                if (stableTimer) clearTimeout(stableTimer);
                if (safetyTimeout) clearTimeout(safetyTimeout);
                resolve();
            }

            // Observe DOM mutations — fires instantly when new elements are added
            const observer = new MutationObserver(check);
            observer.observe(document.body, { childList: true, subtree: true });

            // Safety timeout
            const safetyTimeout = setTimeout(done, TIMING.itemsTimeout);

            // Initial check (items might already be there)
            check();
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
            const iv = setInterval(() => {
                const btn = findYesButton();
                if (btn) { clearInterval(iv); resolve(btn); }
                else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
            }, TIMING.pollInterval);
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
                        Tote <b>${toteId}</b> is <b>${reason}</b><br>and should not be emptied.
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

    /** Shows high-quantity confirmation dialog */
    function confirmHighQuantity(toteId, qty) {
        return new Promise(resolve => {
            const overlay = createDialog('pvt-hq-dialog', `
                <div style="background:#fff;border-radius:14px;padding:28px;max-width:360px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center">
                    <div style="font-size:40px">&#9888;</div>
                    <div style="font-size:17px;font-weight:700;color:#c0392b;margin:12px 0">High Item Count</div>
                    <div style="font-size:14px;color:#2c3e50;line-height:1.6;margin-bottom:20px">
                        Tote <b>${toteId}</b> has <b>${qty} items</b> (threshold: ${HIGH_QTY_THRESHOLD}).<br><br>Proceed with emptying?
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
            const hasPrice = item.price && !['N/A', 'Error', 'Timeout'].includes(item.price);
            const priceHtml = hasPrice
                ? `<span style="color:#27ae60;font-weight:700">${item.price}</span>`
                : item.price !== null
                    ? `<span style="color:#e74c3c">${item.price || 'N/A'}</span>`
                    : `<input type="text" class="pvt-asin-in" data-idx="${i}" placeholder="Paste ASIN" maxlength="10" style="font:700 10px monospace;width:85px;border:1.5px solid #ddd;border-radius:4px;padding:2px 4px;text-transform:uppercase">`;
            const num = hasPrice ? parseFloat(item.price.replace(/[^0-9.]/g, '')) : NaN;
            const lineTotal = isNaN(num) ? '-' : '\u00A3' + (num * item.qty).toFixed(2);
            const id = `<a href="${FCR_BASE}/${getWarehouseId()}/results?s=${item.fnsku}" target="_blank" rel="noopener" style="color:#8e44ad;text-decoration:none" title="Open in FC Research">${item.fnsku}</a>` + (item.resolvedAsin ? ` <span style="color:#27ae60;font-size:15px">\u2192 <a href="${FCR_BASE}/${getWarehouseId()}/results?s=${item.resolvedAsin}" target="_blank" rel="noopener" style="color:#27ae60;text-decoration:none" title="Open in FC Research">${item.resolvedAsin}</a></span>` : '');
            const psCount = item.problemSolve?.totalQty || 0;
            const psEntries = item.problemSolve?.count || 0;
            const psBadge = psCount > 0 ? `<span style="background:#e74c3c;color:#fff;font:700 15px Segoe UI;padding:2px 8px;border-radius:3px" title="${psEntries} Problem Solve entries, total qty: ${psCount}, last: ${item.problemSolve.lastDate}">${psCount} PS</span>` : '<span style="color:#ccc;font-size:15px">0</span>';
            return `<tr><td style="font:600 16px monospace">${id}</td><td style="text-align:center;font-weight:700">${item.qty}</td><td style="white-space:nowrap" id="pvt-p-${i}">${priceHtml}</td><td style="white-space:nowrap;font-weight:600" id="pvt-lt-${i}">${lineTotal}</td><td style="text-align:center">${psBadge}</td><td style="font-size:16px;color:#666;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(item.title || '').substring(0, 50)}</td></tr>`;
        }).join('');

        // Calculate grand total
        let gt = 0;
        items.forEach(it => { const n = parseFloat((it.price || '').replace(/[^0-9.]/g, '')); if (!isNaN(n)) gt += n * it.qty; });
        const highValue = gt > 1000;

        const overlay = createDialog('pvt-cc-dialog', `
            <div id="pvt-cc-box" style="background:${highValue ? '#fff5f5' : '#fff'};border-radius:14px;width:800px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 16px 50px rgba(0,0,0,.35);overflow:hidden;${highValue ? 'border:3px solid #e74c3c' : ''}">
                <div style="background:${highValue ? 'linear-gradient(135deg,#c0392b,#e74c3c)' : 'linear-gradient(135deg,#0b3948,#1abc9c)'};color:#fff;padding:16px 20px;font:700 20px Segoe UI">Change Container - Tote ${toteNum}/${total}</div>
                ${highValue ? '<div id="pvt-hv-warn" style="background:#e74c3c;color:#fff;padding:12px 20px;font:700 19px Segoe UI;text-align:center;animation:pvt-blink 1s infinite">&#9888; HIGH VALUE TOTE - Grand Total exceeds \u00A31,000! Verify before proceeding.</div>' : ''}
                <div style="padding:16px 20px;overflow-y:auto;flex:1">
                    <div style="display:flex;justify-content:space-between;font-size:18px;color:#555;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #eee">
                        <span><b>Tote:</b> <a href="${FCR_BASE}/${getWarehouseId()}/results?s=${toteId}" target="_blank" rel="noopener" style="color:#8e44ad;text-decoration:none;font-weight:700" title="Open in FC Research">${toteId}</a></span><span><b>Items:</b> ${items.length} rows, ${totalQty} units</span>
                    </div>
                    <table style="width:100%;border-collapse:collapse;font-size:17px">
                        <thead><tr style="background:#f4f6f8"><th style="padding:8px 10px;text-align:left;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">FNSKU/ASIN</th><th style="padding:8px;text-align:center;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Qty</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Price</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Total</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd;text-align:center">PS</th><th style="padding:8px 10px;font-size:16px;text-transform:uppercase;border-bottom:2px solid #ddd">Title</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><td colspan="4" style="text-align:right;font-weight:700;padding:10px;border-top:2px solid #ddd;font-size:17px">Grand Total:</td><td id="pvt-gt" style="font-weight:700;color:${highValue ? '#e74c3c' : '#27ae60'};padding:10px;border-top:2px solid #ddd;font-size:19px">\u00A3${gt.toFixed(2)}</td><td style="border-top:2px solid #ddd"></td></tr></tfoot>
                    </table>
                    <div style="font-size:10px;color:#888;margin-top:6px;font-style:italic">${items.some(i => !i.price) ? 'Paste ASIN for unresolved items - auto-fetches on paste' : 'All prices fetched'}</div>
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
                input.style.borderColor = '#2ecc71';
                input.disabled = true;
                const idx = +input.dataset.idx;
                const price = await fetchAmazonPrice(val);
                items[idx].price = price;
                // Update cells
                const bad = !price || ['N/A', 'Error', 'Timeout'].includes(price);
                document.getElementById(`pvt-p-${idx}`).innerHTML = bad ? `<span style="color:#e74c3c">${price}</span>` : `<span style="color:#27ae60;font-weight:700">${price}</span>`;
                const num = parseFloat((price || '').replace(/[^0-9.]/g, ''));
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
                        w.innerHTML = '&#9888; HIGH VALUE TOTE - Grand Total exceeds \u00A31,000! Verify before proceeding.';
                        hdr.after(w);
                    }
                } else {
                    gtEl.style.color = '#27ae60';
                    if (box) { box.style.background = '#fff'; box.style.border = ''; }
                    if (warn) warn.remove();
                }
            });
        });

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

            // --- Step 3: Wait for page transition ---
            await waitForPageLeave();

            // --- Step 4: Wait for Change Container button ---
            setStatus('Waiting for Change Container...', '#3498db');
            const changeBtn = await waitFor(SEL.changeContainer);
            if (!changeBtn || !autoRunning) { continue; }

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
                    await new Promise(r => setTimeout(r, 300));
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

                // --- Step 6: Wait for items to render, then read them ---
                setStatus('Loading items...', '#8e44ad');
                await waitForItemsRendered();
                let items = readAllItems();

                // Fallback: text scan if alchemy-tags not found
                if (!items.length) {
                    const text = document.body.innerText || '';
                    const asins = [...new Set(text.match(/\bB0[A-Z0-9]{8}\b/g) || [])];
                    const fnskus = [...new Set(text.match(/\bX[A-Z0-9]{9}\b/g) || [])];
                    asins.forEach(a => items.push({ fnsku: a, qty: 1, title: '', isAsin: true, price: null, resolvedAsin: null, fcPrice: null }));
                    fnskus.forEach(f => items.push({ fnsku: f, qty: 1, title: '', isAsin: false, price: null, resolvedAsin: null, fcPrice: null }));
                }

                // --- Step 7: Resolve FNSKUs, fetch prices + PS count in parallel ---
                if (items.length) {
                    // Phase 1: Resolve X0 FNSKUs via FC Research (sequential - same domain)
                    let resolved = 0;
                    for (const item of items.filter(i => !i.isAsin)) {
                        resolved++;
                        setStatus(`Resolving FNSKU ${resolved}/${items.filter(i => !i.isAsin).length}...`, '#8e44ad');
                        const fcr = await fetchFCResearch(item.fnsku);
                        if (fcr?.asin) { item.resolvedAsin = fcr.asin; item.fcPrice = fcr.fcPrice; item.title = item.title || fcr.title; }
                    }

                    // Phase 2: Fetch Amazon prices + PS count in parallel batches
                    let done = 0;
                    const jobs = items.map(item => async () => {
                        const asin = item.isAsin ? item.fnsku : item.resolvedAsin;
                        if (asin) {
                            // Fetch price and PS count simultaneously
                            const [price, ps] = await Promise.all([
                                fetchAmazonPrice(asin),
                                checkProblemSolve(asin),
                            ]);
                            item.price = price;
                            item.problemSolve = ps;
                        }
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
                if (yesBtn) { yesBtn.click(); }
                else { }
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

    function loadList() {
        const ta = document.getElementById('pvt-ta');
        if (!ta) return;
        toteList = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
        doneSet = new Set();
        currentIdx = 0;
        ls.set(LS.list, ta.value);
        clearState();
        renderList();
        setStatus(`${toteList.length} tote(s) loaded`, '#27ae60');
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
        const panel = document.createElement('div');
        panel.id = 'pvt-panel';
        panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:310px;background:#fff;border:2px solid #0b3948;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.22);font:13px Segoe UI,system-ui,sans-serif;color:#2c3e50;overflow:hidden';
        panel.innerHTML = `
            <div id="pvt-header" style="background:linear-gradient(135deg,#0b3948,#1abc9c);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px;font:700 14px Segoe UI;cursor:move;user-select:none">
                <span>Sideline v6.0</span>
                <span id="pvt-collapse" style="margin-left:auto;cursor:pointer;font-size:18px;opacity:.8">-</span>
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

        // Make panel draggable by header
        let sx, sy;
        const hdr = panel.querySelector('#pvt-header');
        hdr.addEventListener('mousedown', e => {
            e.preventDefault(); sx = e.clientX; sy = e.clientY;
            const move = ev => { panel.style.top = (panel.offsetTop + ev.clientY - sy) + 'px'; panel.style.left = (panel.offsetLeft + ev.clientX - sx) + 'px'; panel.style.right = 'auto'; sx = ev.clientX; sy = ev.clientY; };
            const stop = () => document.removeEventListener('mousemove', move);
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', stop, { once: true });
        });

        return panel;
    }

    // =========================================================================
    //  INITIALIZATION
    // =========================================================================

    function init() {
        if (document.getElementById('pvt-panel')) return;
        buildPanel();

        // Restore tote list from localStorage
        const saved = ls.get(LS.list);
        if (saved) {
            document.getElementById('pvt-ta').value = saved;
            toteList = saved.split('\n').map(s => s.trim()).filter(Boolean);
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
            btn.textContent = hidden ? '-' : '+';
        };
    }

    // Entry point
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
