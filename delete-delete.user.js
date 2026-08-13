// ==UserScript==
// @name         Delete Delete - Auto Delete Items
// @author       joyhjoe
// @version      4.0
// @description  Automated multi-container item deletion with price lookup
// @match        https://aft-qt-eu.aka.amazon.com/app/deleteitems*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      amazon.co.uk
// @connect      qi-fcresearch-eu.corp.amazon.com
// ==/UserScript==

(function () {
    'use strict';

    // --- Config ---
    const FCR_BASE = 'https://qi-fcresearch-eu.corp.amazon.com';
    const LS = { list: 'dd_list', idx: 'dd_idx', running: 'dd_running', done: 'dd_done', type: 'dd_type' };
    const get = (k, d = '') => localStorage.getItem(k) ?? d;
    const set = (k, v) => localStorage.setItem(k, String(v));

    let containerList = [];
    let doneSet = new Set();
    let currentIdx = 0;
    let polling = null;
    let lastClick = 0;
    let needsRestart = false;
    let waitingForPrice = false;

    function isRunning() { return get(LS.running) === '1'; }
    function saveState() { set(LS.idx, currentIdx); set(LS.done, JSON.stringify([...doneSet])); }
    function restoreState() {
        currentIdx = parseInt(get(LS.idx, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(get(LS.done, '[]'))); } catch { doneSet = new Set(); }
    }

    // --- Warehouse ID from URL ---
    function getWarehouseId() {
        return location.pathname.match(/^\/([A-Z]{3}\d)\//)?.[1] || 'EMA4';
    }

    // --- Page helpers ---
    function getTitle() { return document.querySelector('#workflow h1')?.textContent.trim() || ''; }
    function getError() { return document.querySelector('.a-alert-inline-error .a-alert-content')?.textContent.trim() || ''; }
    function getInput() { return document.querySelector('#workflow form input[type="text"]'); }

    function fillInput(el, val) {
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (s) s.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickPrimary() {
        if (Date.now() - lastClick < 800) return false;
        const btn = document.querySelector('.a-button-primary input.a-button-input');
        if (!btn || !btn.offsetParent) return false;
        lastClick = Date.now();
        btn.click();
        btn.closest('.a-button')?.click();
        return true;
    }

    function clickConfirm() {
        if (Date.now() - lastClick < 800) return false;
        const btn = document.querySelector('[data-click-action*="Confirm"] input.a-button-input');
        if (btn) { lastClick = Date.now(); btn.click(); btn.closest('.a-button')?.click(); return true; }
        return clickPrimary();
    }

    function startOver() {
        const link = document.querySelector('[data-action="click-restart"] a, [data-click-restart] a');
        if (link) { link.click(); return; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', keyCode: 82, bubbles: true }));
    }

    // --- Price fetching (FC Research + Amazon) ---
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
                        if (!asin) asin = doc.querySelector('.a-span7 > table > tbody > tr:nth-child(1) > td:nth-child(2) > a')?.textContent.trim() || null;
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

    function fetchAmazonPrice(asin) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.amazon.co.uk/gp/product/${encodeURIComponent(asin)}?th=1`,
                headers: { 'Accept': 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' },
                onload(resp) {
                    try {
                        const html = resp.responseText || '';
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const selectors = [
                            '#corePrice_feature_div .a-price .a-offscreen',
                            '#apex_desktop .a-price .a-offscreen',
                            '#price_inside_buybox', '#priceblock_ourprice',
                            '#priceblock_dealprice', '#priceblock_saleprice',
                            '#newBuyBoxPrice .a-price .a-offscreen',
                            '#tmmSwatches .a-color-price .a-offscreen',
                            '.swatchElement.selected .a-color-price .a-offscreen',
                            '#buyNewSection .a-price .a-offscreen',
                            '.a-price[data-a-color="price"] .a-offscreen',
                            '#kindle-price .a-color-price', '#tmm-grid-swatch-PAPERBACK .a-color-price',
                            '.a-section.a-spacing-micro .a-price .a-offscreen',
                            '#usedBuySection .a-price .a-offscreen',
                            '.offer-price', '#tp_price_block_total_price_ww .a-offscreen'
                        ];
                        for (const sel of selectors) {
                            const el = doc.querySelector(sel);
                            const t = el?.textContent.trim();
                            if (t && /£\d/.test(t)) { resolve(t); return; }
                        }
                        const m = html.match(/£\s*(\d+[.,]\d{2})/);
                        resolve(m ? `£${m[1]}` : 'N/A');
                    } catch { resolve('N/A'); }
                },
                onerror() { resolve('N/A'); },
                ontimeout() { resolve('N/A'); },
            });
        });
    }

    // --- Extract FcSku and Quantity from confirm page ---
    function getFieldFromPage(label) {
        const allDts = document.querySelectorAll('dt.a-list-item');
        for (const dt of allDts) {
            if (dt.textContent.trim().startsWith(label)) {
                const dd = dt.nextElementSibling;
                if (dd) return dd.textContent.trim();
            }
        }
        return null;
    }
    function getFcSkuFromPage() { return getFieldFromPage('FcSku'); }
    function getQuantityFromPage() { return parseInt(getFieldFromPage('Quantity to delete') || getFieldFromPage('Quantity') || '1', 10); }

    // --- Show price overlay on confirm page ---
    function showPriceInfo(fcSku, data, qty) {
        let box = document.getElementById('dd-price-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'dd-price-box';
            box.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999998;background:#fff;border:2px solid #3498db;border-radius:10px;padding:12px 16px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:13px Segoe UI,sans-serif;max-width:340px';
            document.body.appendChild(box);
        }
        const price = data.amazonPrice || data.fcPrice || 'N/A';
        const priceNum = parseFloat((price).replace(/[^0-9.]/g, '')) || 0;
        const isCritical = priceNum >= 1000;
        const isHigh = priceNum >= 100;
        const qtyAlert = qty >= 99;
        const blocked = isCritical || qtyAlert;
        const bgColor = blocked ? '#fde' : isHigh ? '#fee' : '#f0f9ff';
        const borderColor = blocked ? '#c0392b' : isHigh ? '#e74c3c' : '#3498db';
        box.style.background = bgColor;
        box.style.borderColor = borderColor;

        let alertHtml = '';
        if (isCritical) alertHtml += `<div style="margin-top:6px;padding:6px 8px;background:#c0392b;color:#fff;border-radius:4px;font:700 12px Segoe UI;text-align:center">🚨 PRICE OVER £1000 - STOPPED</div>`;
        if (qtyAlert) alertHtml += `<div style="margin-top:6px;padding:6px 8px;background:#e67e22;color:#fff;border-radius:4px;font:700 12px Segoe UI;text-align:center">⚠️ QTY ${qty} (99+) - STOPPED</div>`;

        let btnHtml = '';
        if (blocked && data.amazonPrice && data.amazonPrice !== 'Loading...' && data.amazonPrice !== 'Fetching...') {
            btnHtml = `<div style="display:flex;gap:6px;margin-top:8px">
                <button id="dd-alert-continue" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#27ae60;color:#fff">✓ Continue Delete</button>
                <button id="dd-alert-skip" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#e74c3c;color:#fff">✗ Skip & Next</button>
            </div>`;
        }

        box.innerHTML = `
            <div style="font:700 13px Segoe UI;margin-bottom:6px;color:${blocked ? '#c0392b' : isHigh ? '#e74c3c' : '#2c3e50'}">
                ${blocked ? '🚨 ALERT - REVIEW REQUIRED' : isHigh ? '⚠️ HIGH VALUE' : '💰 Item Price'}
            </div>
            <table style="font:12px monospace;border-collapse:collapse;width:100%">
                <tr><td style="padding:2px 8px 2px 0;color:#7f8c8d">FcSku:</td><td style="font-weight:700">${fcSku}</td></tr>
                ${data.asin ? `<tr><td style="padding:2px 8px 2px 0;color:#7f8c8d">ASIN:</td><td>${data.asin}</td></tr>` : ''}
                <tr><td style="padding:2px 8px 2px 0;color:#7f8c8d">FC Price:</td><td>${data.fcPrice}</td></tr>
                <tr><td style="padding:2px 8px 2px 0;color:#7f8c8d">Amazon:</td><td style="font-weight:700;color:${isCritical ? '#c0392b' : isHigh ? '#e74c3c' : '#27ae60'}">${data.amazonPrice || 'N/A'}</td></tr>
                <tr><td style="padding:2px 8px 2px 0;color:#7f8c8d">Qty:</td><td style="font-weight:700;color:${qtyAlert ? '#e67e22' : '#2c3e50'}">${qty}</td></tr>
                ${data.title ? `<tr><td colspan="2" style="padding-top:4px;font:11px Segoe UI;color:#555;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.title.substring(0, 55)}</td></tr>` : ''}
            </table>
            ${alertHtml}${btnHtml}`;

        // Bind alert buttons
        if (blocked && btnHtml) {
            document.getElementById('dd-alert-continue')?.addEventListener('click', () => {
                clickConfirm();
                hidePriceInfo();
            });
            document.getElementById('dd-alert-skip')?.addEventListener('click', () => {
                // Skip this container and move to next
                doneSet.add(currentIdx);
                currentIdx++;
                saveState();
                renderList();
                needsRestart = true;
                waitingForPrice = false;
                hidePriceInfo();
                setStatus(`[${currentIdx}] Skipped - next`, 'orange');
            });
        }

        return blocked;
    }

    function hidePriceInfo() {
        document.getElementById('dd-price-box')?.remove();
    }

    // --- Fetch and display price when on confirm page ---
    async function handleConfirmPage() {
        const fcSku = getFcSkuFromPage();
        if (!fcSku) { waitingForPrice = false; return; }
        const qty = getQuantityFromPage();

        showPriceInfo(fcSku, { fcPrice: 'Loading...', amazonPrice: 'Loading...', title: '', asin: null }, qty);

        // Fetch from FC Research
        const fcData = await fetchFCResearch(fcSku);
        let amazonPrice = 'N/A';

        // If we got an ASIN, fetch Amazon price
        if (fcData.asin) {
            showPriceInfo(fcSku, { ...fcData, amazonPrice: 'Fetching...' }, qty);
            amazonPrice = await fetchAmazonPrice(fcData.asin);
        }

        const blocked = showPriceInfo(fcSku, { ...fcData, amazonPrice }, qty);
        waitingForPrice = false;

        // If blocked (price >= £1000 or qty >= 99), stop and wait for user action
        if (blocked) {
            setStatus(`[${currentIdx + 1}] ⚠️ ALERT - waiting`, '#c0392b');
            return; // User must click Continue or Skip
        }

        // Auto-confirm after price is shown (1.5s delay so user can see it)
        if (isRunning()) {
            setTimeout(() => {
                if (isRunning() && getTitle().includes('Confirm the deletion')) {
                    clickConfirm();
                }
            }, 1500);
        }
    }

    // --- Core tick (every 500ms) ---
    function tick() {
        if (!isRunning()) { stop(); return; }
        if (currentIdx >= containerList.length) {
            setStatus(`Done! ${containerList.length} processed`, '#27ae60');
            stop();
            return;
        }

        const title = getTitle();
        const error = getError();
        const id = containerList[currentIdx];
        const delType = get(LS.type, 'MISSING');

        // Restart before each new container
        if (needsRestart) {
            setStatus(`[${currentIdx + 1}] Restarting...`, '#3498db');
            startOver();
            needsRestart = false;
            return;
        }

        // Scan container page
        if (title.includes('Scan container')) {
            hidePriceInfo();
            if (error.includes('is empty')) {
                setStatus(`[${currentIdx + 1}] Empty - skip`, 'orange');
                doneSet.add(currentIdx);
                currentIdx++;
                saveState();
                renderList();
                needsRestart = true;
                return;
            }
            const inp = getInput();
            if (!inp) return;
            if (inp.value !== id) { fillInput(inp, id); setStatus(`[${currentIdx + 1}/${containerList.length}] ${id}`, '#c0392b'); }
            else clickPrimary();
            return;
        }

        // Select Item to Delete
        if (title.includes('Select Item to Delete')) {
            hidePriceInfo();
            setStatus(`[${currentIdx + 1}] Selecting item...`, '#c0392b');
            const radio = document.querySelector('#workflow input[type="radio"]');
            if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
            clickPrimary();
            return;
        }

        // Select deletion type
        if (title.includes('Select deletion type') || title.includes('deletion type')) {
            setStatus(`[${currentIdx + 1}] Setting type: ${delType}`, '#c0392b');
            // Find the right radio - match by value or by label text
            let radio = document.querySelector(`#workflow input[type="radio"][value="${delType}"]`);
            if (!radio) {
                // Try matching by label text
                const labels = document.querySelectorAll('#workflow label, #workflow .a-label');
                for (const lbl of labels) {
                    if (lbl.textContent.includes(delType === 'MISSING' ? 'Sweeping' : delType === 'DAMAGED' ? 'Damaged' : 'theft')) {
                        radio = lbl.closest('.a-radio-label, .a-row')?.querySelector('input[type="radio"]') || lbl.previousElementSibling;
                        break;
                    }
                }
            }
            if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
            clickPrimary();
            return;
        }

        // Confirm deletion - fetch price first
        if (title.includes('Confirm the deletion')) {
            if (!waitingForPrice) {
                waitingForPrice = true;
                setStatus(`[${currentIdx + 1}] Fetching price...`, '#8e44ad');
                handleConfirmPage();
            }
            // Don't click here - handleConfirmPage will auto-click after showing price
            return;
        }

        // Back on scan = container done
        if (title.includes('Scan') && !error) {
            hidePriceInfo();
            doneSet.add(currentIdx);
            currentIdx++;
            saveState();
            renderList();
            needsRestart = true;
        }
    }

    function start() {
        if (!containerList.length) { setStatus('Load list first', 'orange'); return; }
        set(LS.type, document.getElementById('dd-type').value);
        set(LS.running, '1');
        needsRestart = true;
        waitingForPrice = false;
        saveState();
        polling = setInterval(tick, 500);
        document.getElementById('dd-start').style.display = 'none';
        document.getElementById('dd-stop').style.display = '';
        setStatus('Running...', '#c0392b');
        renderList();
    }

    function stop() {
        if (polling) { clearInterval(polling); polling = null; }
        set(LS.running, '0');
        waitingForPrice = false;
        document.getElementById('dd-start').style.display = '';
        document.getElementById('dd-stop').style.display = 'none';
        setStatus('Stopped', '#e74c3c');
    }

    // --- UI ---
    function setStatus(msg, color = '#7f8c8d') {
        const el = document.getElementById('dd-status');
        if (el) { el.textContent = msg; el.style.color = color; }
    }

    function renderList() {
        const wrap = document.getElementById('dd-list');
        if (!wrap) return;
        const fill = document.getElementById('dd-fill');
        if (fill) fill.style.width = containerList.length ? `${Math.round(doneSet.size / containerList.length * 100)}%` : '0%';
        if (!containerList.length) { wrap.innerHTML = '<div style="padding:12px;text-align:center;color:#aaa;font-size:12px">Paste IDs above</div>'; return; }
        wrap.innerHTML = '';
        containerList.forEach((id, i) => {
            const done = doneSet.has(i);
            const active = i === currentIdx && !done && isRunning();
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;padding:5px 10px;border-bottom:1px solid #f5f5f5;gap:8px;font:12px monospace;${done ? 'background:#f0f9f0;color:#27ae60' : active ? 'background:#fff3cd;font-weight:700' : ''}`;
            row.innerHTML = `<div style="width:18px;height:18px;background:${done ? '#2ecc71' : active ? '#f39c12' : '#c0392b'};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700">${i + 1}</div><div style="flex:1">${id}</div>${done ? '&#10003;' : ''}`;
            wrap.appendChild(row);
        });
        wrap.children[Math.min(currentIdx, containerList.length - 1)]?.scrollIntoView({ block: 'nearest' });
    }

    // --- Build panel ---
    const p = document.createElement('div');
    p.id = 'dd-panel';
    p.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:280px;background:#fff;border:2px solid #c0392b;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.2);font:13px Segoe UI,sans-serif;overflow:hidden';
    p.innerHTML = `
        <div id="dd-hdr" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;padding:10px 12px;font:700 14px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
            <span>Delete Delete v4</span><span id="dd-col" style="margin-left:auto;cursor:pointer;font-size:16px">−</span>
        </div>
        <div id="dd-body" style="padding:10px 12px">
            <textarea id="dd-ta" placeholder="Container IDs (one per line)" style="width:100%;height:70px;padding:6px;box-sizing:border-box;border:2px solid #e0e0e0;border-radius:6px;font:11px monospace;resize:vertical"></textarea>
            <select id="dd-type" style="width:100%;padding:5px;border:2px solid #e0e0e0;border-radius:6px;font:11px Segoe UI;margin:6px 0">
                <option value="MISSING">Sweeping out (Missing)</option>
                <option value="DAMAGED">Damaged and unreturnable</option>
                <option value="THEFT">Known theft</option>
            </select>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px">
                <button id="dd-load" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#c0392b;color:#fff">Load</button>
                <button id="dd-clear" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#eee;color:#555">Clear</button>
                <button id="dd-start" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#27ae60;color:#fff">▶ Start</button>
                <button id="dd-stop" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#e74c3c;color:#fff;display:none">⬛ Stop</button>
            </div>
            <div id="dd-list" style="max-height:150px;overflow-y:auto;border:1px solid #eee;border-radius:6px"></div>
            <div id="dd-status" style="margin-top:6px;padding:5px;border-radius:6px;font:600 11px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
            <div style="height:4px;background:#e0e0e0;border-radius:2px;overflow:hidden;margin-top:5px"><div id="dd-fill" style="height:100%;background:#e74c3c;width:0%;transition:width .3s"></div></div>
        </div>`;
    document.body.appendChild(p);

    // Draggable
    let sx, sy;
    document.getElementById('dd-hdr').onmousedown = e => {
        e.preventDefault(); sx = e.clientX; sy = e.clientY;
        const mv = ev => { p.style.top = (p.offsetTop + ev.clientY - sy) + 'px'; p.style.left = (p.offsetLeft + ev.clientX - sx) + 'px'; p.style.right = 'auto'; sx = ev.clientX; sy = ev.clientY; };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', () => document.removeEventListener('mousemove', mv), { once: true });
    };

    // Collapse
    document.getElementById('dd-col').onclick = () => {
        const b = document.getElementById('dd-body');
        b.style.display = b.style.display === 'none' ? '' : 'none';
        document.getElementById('dd-col').textContent = b.style.display === 'none' ? '+' : '−';
    };

    // Buttons
    document.getElementById('dd-load').onclick = () => {
        containerList = document.getElementById('dd-ta').value.split('\n').map(s => s.trim()).filter(Boolean);
        doneSet = new Set(); currentIdx = 0;
        set(LS.list, containerList.join('\n'));
        set(LS.idx, '0'); set(LS.done, '[]'); set(LS.running, '0');
        renderList();
        setStatus(`${containerList.length} loaded`, '#27ae60');
    };

    document.getElementById('dd-clear').onclick = () => {
        stop();
        containerList = []; doneSet = new Set(); currentIdx = 0;
        document.getElementById('dd-ta').value = '';
        set(LS.list, ''); set(LS.idx, '0'); set(LS.done, '[]');
        renderList(); setStatus('Cleared', '#7f8c8d');
    };

    document.getElementById('dd-start').onclick = start;
    document.getElementById('dd-stop').onclick = stop;

    // Init: restore state
    const saved = get(LS.list);
    if (saved) { document.getElementById('dd-ta').value = saved; containerList = saved.split('\n').map(s => s.trim()).filter(Boolean); }
    document.getElementById('dd-type').value = get(LS.type, 'MISSING');
    restoreState();
    renderList();

    // Auto-resume after page reload
    if (isRunning() && containerList.length && currentIdx < containerList.length) {
        setStatus('Resuming...', '#3498db');
        needsRestart = false;
        polling = setInterval(tick, 500);
        document.getElementById('dd-start').style.display = 'none';
        document.getElementById('dd-stop').style.display = '';
    }
})();
