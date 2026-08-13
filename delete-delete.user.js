// ==UserScript==
// @name         Delete Delete - Auto Delete Items
// @author       joyhjoe
// @version      4.1
// @description  Automated multi-container item deletion with price lookup (optimized)
// @match        https://aft-qt-eu.aka.amazon.com/app/deleteitems*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      amazon.co.uk
// @connect      qi-fcresearch-eu.corp.amazon.com
// ==/UserScript==

(function () {
    'use strict';

    const FCR_BASE = 'https://qi-fcresearch-eu.corp.amazon.com';
    const WAREHOUSE = location.pathname.match(/^\/([A-Z]{3}\d)\//)?.[1] || 'EMA4';
    const LS = { list: 'dd_list', idx: 'dd_idx', running: 'dd_running', done: 'dd_done', type: 'dd_type' };
    const get = (k, d = '') => localStorage.getItem(k) ?? d;
    const set = (k, v) => localStorage.setItem(k, String(v));

    let containerList = [], doneSet = new Set(), currentIdx = 0;
    let polling = null, lastClick = 0, needsRestart = false, waitingForPrice = false;

    const isRunning = () => get(LS.running) === '1';
    const saveState = () => { set(LS.idx, currentIdx); set(LS.done, JSON.stringify([...doneSet])); };

    function restoreState() {
        currentIdx = parseInt(get(LS.idx, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(get(LS.done, '[]'))); } catch { doneSet = new Set(); }
    }

    // --- Lightweight DOM reads (no heavy queries) ---
    const getTitle = () => document.querySelector('#workflow h1')?.textContent.trim() || '';
    const getError = () => document.querySelector('.a-alert-inline-error .a-alert-content')?.textContent.trim() || '';

    function fillInput(el, val) {
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (s) s.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickPrimary() {
        if (Date.now() - lastClick < 400) return false;
        const btn = document.querySelector('.a-button-primary input.a-button-input');
        if (!btn || !btn.offsetParent) return false;
        lastClick = Date.now();
        btn.click();
        btn.closest('.a-button')?.click();
        return true;
    }

    function clickConfirm() {
        if (Date.now() - lastClick < 400) return false;
        const btn = document.querySelector('[data-click-action*="Confirm"] input.a-button-input');
        if (btn) { lastClick = Date.now(); btn.click(); btn.closest('.a-button')?.click(); return true; }
        return clickPrimary();
    }

    function startOver() {
        const link = document.querySelector('[data-action="click-restart"] a, [data-click-restart] a');
        if (link) { link.click(); return; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', keyCode: 82, bubbles: true }));
    }

    // --- Price fetch (FC Research) - lightweight parse ---
    function fetchFCResearch(sku) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${FCR_BASE}/${WAREHOUSE}/results/product?s=${encodeURIComponent(sku)}`,
                headers: { Accept: 'text/html' },
                timeout: 8000,
                onload(r) {
                    try {
                        const html = r.responseText;
                        // Fast regex extraction first (avoids full DOM parse)
                        let asin = (html.match(/data-row-id="(B[A-Z0-9]{9})"/) || html.match(/results\?s=(B[A-Z0-9]{9})/))?.[1] || null;
                        let fcPrice = html.match(/<th>List Price<\/th>\s*<td>([^<]+)<\/td>/)?.[1]?.replace(/^[A-Z]{3}\s+/, '').trim() || 'N/A';
                        let title = html.match(/<th>Title<\/th>\s*<td>([^<]+)<\/td>/)?.[1]?.trim() || '';

                        // Fallback: DOM parse only if regex missed
                        if (!asin || (fcPrice === 'N/A' && !title)) {
                            const doc = new DOMParser().parseFromString(html, 'text/html');
                            const table = doc.querySelector('table.a-keyvalue[data-row-id]');
                            if (table) {
                                if (!asin) asin = table.getAttribute('data-row-id');
                                for (const row of table.querySelectorAll('tr')) {
                                    const th = row.querySelector('th')?.textContent.trim();
                                    const td = row.querySelector('td')?.textContent.trim();
                                    if (th === 'List Price' && td && fcPrice === 'N/A') fcPrice = td.replace(/^[A-Z]{3}\s+/, '');
                                    if (th === 'Title' && td && !title) title = td;
                                }
                            }
                        }
                        resolve({ asin, fcPrice, title });
                    } catch { resolve({ asin: null, fcPrice: 'Error', title: '' }); }
                },
                onerror() { resolve({ asin: null, fcPrice: 'Error', title: '' }); },
                ontimeout() { resolve({ asin: null, fcPrice: 'Timeout', title: '' }); },
            });
        });
    }

    // --- Amazon price - fast selectors, early exit ---
    function fetchAmazonPrice(asin) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.amazon.co.uk/gp/product/${asin}?th=1`,
                headers: { Accept: 'text/html' },
                timeout: 8000,
                onload(r) {
                    try {
                        const html = r.responseText;
                        // Fast regex first - covers 90% of cases
                        const m = html.match(/"priceAmount":([\d.]+)/) || html.match(/class="a-offscreen">\s*(£[\d,.]+)/) || html.match(/£\s*(\d+[.,]\d{2})/);
                        if (m) { resolve(m[1].startsWith('£') ? m[1] : `£${m[1]}`); return; }
                        // Fallback: DOM parse with limited selectors
                        const doc = new DOMParser().parseFromString(html, 'text/html');
                        const sels = ['#corePrice_feature_div .a-offscreen', '#apex_desktop .a-offscreen', '#price_inside_buybox', '#priceblock_ourprice', '#newBuyBoxPrice .a-offscreen', '.a-price[data-a-color="price"] .a-offscreen'];
                        for (const s of sels) {
                            const t = doc.querySelector(s)?.textContent.trim();
                            if (t && /£\d/.test(t)) { resolve(t); return; }
                        }
                        resolve('N/A');
                    } catch { resolve('N/A'); }
                },
                onerror() { resolve('N/A'); },
                ontimeout() { resolve('N/A'); },
            });
        });
    }

    // --- Page field extraction ---
    function getField(label) {
        const dts = document.querySelectorAll('dt.a-list-item');
        for (let i = 0; i < dts.length; i++) {
            if (dts[i].textContent.indexOf(label) === 0) return dts[i].nextElementSibling?.textContent.trim() || null;
        }
        return null;
    }

    // --- Price overlay ---
    function showPrice(fcSku, data, qty) {
        let box = document.getElementById('dd-price-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'dd-price-box';
            box.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999998;background:#fff;border:2px solid #3498db;border-radius:10px;padding:12px 16px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:13px Segoe UI,sans-serif;max-width:320px';
            document.body.appendChild(box);
        }
        const price = data.amazonPrice || data.fcPrice || 'N/A';
        const priceNum = parseFloat(price.replace(/[^0-9.]/g, '')) || 0;
        const critical = priceNum >= 1000, high = priceNum >= 100, qtyHigh = qty >= 99;
        const blocked = critical || qtyHigh;

        box.style.background = blocked ? '#fde' : high ? '#fee' : '#f0f9ff';
        box.style.borderColor = blocked ? '#c0392b' : high ? '#e74c3c' : '#3498db';

        const alert = (critical ? '<div style="margin-top:6px;padding:5px;background:#c0392b;color:#fff;border-radius:4px;font:700 11px Segoe UI;text-align:center">🚨 £1000+ STOPPED</div>' : '') +
                      (qtyHigh ? `<div style="margin-top:4px;padding:5px;background:#e67e22;color:#fff;border-radius:4px;font:700 11px Segoe UI;text-align:center">⚠️ QTY ${qty} STOPPED</div>` : '');

        const btns = blocked && !price.includes('Loading') && !price.includes('Fetching')
            ? '<div style="display:flex;gap:6px;margin-top:8px"><button id="dd-ok" style="flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#27ae60;color:#fff">✓ Continue</button><button id="dd-skip" style="flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#e74c3c;color:#fff">✗ Skip</button></div>' : '';

        box.innerHTML = `<div style="font:700 12px Segoe UI;color:${blocked ? '#c0392b' : '#2c3e50'};margin-bottom:4px">${blocked ? '🚨 REVIEW' : '💰 Price'}</div>
            <table style="font:11px monospace;width:100%"><tr><td style="color:#999">Sku</td><td><b>${fcSku}</b></td></tr>${data.asin ? `<tr><td style="color:#999">ASIN</td><td>${data.asin}</td></tr>` : ''}<tr><td style="color:#999">FC</td><td>${data.fcPrice}</td></tr><tr><td style="color:#999">AMZ</td><td style="font-weight:700;color:${critical ? '#c0392b' : high ? '#e74c3c' : '#27ae60'}">${data.amazonPrice || 'N/A'}</td></tr><tr><td style="color:#999">Qty</td><td style="color:${qtyHigh ? '#e67e22' : '#333'};font-weight:700">${qty}</td></tr></table>
            ${data.title ? `<div style="font:10px Segoe UI;color:#666;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.title.slice(0, 50)}</div>` : ''}${alert}${btns}`;

        if (blocked && btns) {
            document.getElementById('dd-ok')?.addEventListener('click', () => { clickConfirm(); hidePrice(); });
            document.getElementById('dd-skip')?.addEventListener('click', () => {
                doneSet.add(currentIdx); currentIdx++; saveState(); renderList();
                needsRestart = true; waitingForPrice = false; hidePrice();
                setStatus(`Skipped → next`, 'orange');
            });
        }
        return blocked;
    }

    function hidePrice() { document.getElementById('dd-price-box')?.remove(); }

    // --- Handle confirm page: fetch price ---
    async function handleConfirm() {
        const fcSku = getField('FcSku');
        if (!fcSku) { waitingForPrice = false; return; }
        const qty = parseInt(getField('Quantity to delete') || getField('Quantity') || '1', 10);

        // Quick check: if qty >= 99, block immediately without fetching price
        if (qty >= 99) {
            showPrice(fcSku, { fcPrice: '-', amazonPrice: '-', title: '', asin: null }, qty);
            waitingForPrice = false;
            setStatus(`[${currentIdx + 1}] ⚠️ QTY ALERT`, '#c0392b');
            return;
        }

        showPrice(fcSku, { fcPrice: '...', amazonPrice: '...', title: '', asin: null }, qty);

        const fcData = await fetchFCResearch(fcSku);
        let amzPrice = 'N/A';
        if (fcData.asin) {
            showPrice(fcSku, { ...fcData, amazonPrice: '...' }, qty);
            amzPrice = await fetchAmazonPrice(fcData.asin);
        }

        const blocked = showPrice(fcSku, { ...fcData, amazonPrice: amzPrice }, qty);
        waitingForPrice = false;

        if (blocked) { setStatus(`[${currentIdx + 1}] ⚠️ ALERT`, '#c0392b'); return; }

        // Auto-confirm after brief display
        if (isRunning()) setTimeout(() => { if (isRunning() && getTitle().includes('Confirm')) clickConfirm(); }, 800);
    }

    // --- Core tick ---
    function tick() {
        if (!isRunning()) { stop(); return; }
        if (currentIdx >= containerList.length) { setStatus(`Done! ${containerList.length}`, '#27ae60'); stop(); return; }

        const title = getTitle(), error = getError();
        const id = containerList[currentIdx], delType = get(LS.type, 'MISSING');

        if (needsRestart) { startOver(); needsRestart = false; return; }

        if (title.includes('Scan container')) {
            hidePrice();
            if (error.includes('is empty')) {
                doneSet.add(currentIdx); currentIdx++; saveState(); renderList();
                needsRestart = true; setStatus(`[${currentIdx}] Empty`, 'orange'); return;
            }
            const inp = document.querySelector('#workflow form input[type="text"]');
            if (!inp) return;
            if (inp.value !== id) { fillInput(inp, id); setStatus(`[${currentIdx + 1}/${containerList.length}] ${id}`, '#c0392b'); }
            else clickPrimary();
            return;
        }

        if (title.includes('Select Item to Delete')) {
            hidePrice();
            const r = document.querySelector('#workflow input[type="radio"]');
            if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
            clickPrimary(); return;
        }

        if (title.includes('deletion type')) {
            let r = document.querySelector(`#workflow input[type="radio"][value="${delType}"]`);
            if (!r) {
                const key = delType === 'MISSING' ? 'Sweeping' : delType === 'DAMAGED' ? 'Damaged' : 'theft';
                document.querySelectorAll('#workflow label, #workflow span.a-label').forEach(l => {
                    if (!r && l.textContent.includes(key)) r = l.closest('.a-row, .a-radio')?.querySelector('input[type="radio"]');
                });
            }
            if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
            clickPrimary(); return;
        }

        if (title.includes('Confirm')) {
            if (!waitingForPrice) { waitingForPrice = true; handleConfirm(); }
            return;
        }

        // Fallback: back on scan = done
        if (title.includes('Scan') && !error) {
            hidePrice(); doneSet.add(currentIdx); currentIdx++; saveState(); renderList(); needsRestart = true;
        }
    }

    function start() {
        if (!containerList.length) { setStatus('Load list first', 'orange'); return; }
        set(LS.type, document.getElementById('dd-type').value);
        set(LS.running, '1'); needsRestart = true; waitingForPrice = false; saveState();
        polling = setInterval(tick, 600);
        document.getElementById('dd-start').style.display = 'none';
        document.getElementById('dd-stop').style.display = '';
        setStatus('Running...', '#c0392b'); renderList();
    }

    function stop() {
        if (polling) { clearInterval(polling); polling = null; }
        set(LS.running, '0'); waitingForPrice = false;
        document.getElementById('dd-start').style.display = '';
        document.getElementById('dd-stop').style.display = 'none';
        setStatus('Stopped', '#e74c3c');
    }

    // --- UI helpers ---
    const setStatus = (msg, color) => { const e = document.getElementById('dd-status'); if (e) { e.textContent = msg; e.style.color = color; } };

    function renderList() {
        const wrap = document.getElementById('dd-list'), fill = document.getElementById('dd-fill');
        if (!wrap) return;
        if (fill) fill.style.width = containerList.length ? `${Math.round(doneSet.size / containerList.length * 100)}%` : '0%';
        if (!containerList.length) { wrap.innerHTML = '<div style="padding:10px;text-align:center;color:#aaa;font-size:11px">Paste IDs above</div>'; return; }
        // Only rebuild if count changed or not built
        if (wrap.childElementCount !== containerList.length) {
            wrap.innerHTML = '';
            containerList.forEach((id, i) => {
                const d = document.createElement('div');
                d.dataset.i = i;
                d.style.cssText = 'display:flex;align-items:center;padding:4px 8px;border-bottom:1px solid #f5f5f5;gap:6px;font:11px monospace';
                d.innerHTML = `<span class="dd-dot" style="width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#fff"></span><span class="dd-id" style="flex:1"></span><span class="dd-chk"></span>`;
                d.querySelector('.dd-id').textContent = id;
                wrap.appendChild(d);
            });
        }
        // Update states
        for (let i = 0; i < wrap.children.length; i++) {
            const row = wrap.children[i], done = doneSet.has(i), active = i === currentIdx && !done && isRunning();
            row.style.background = done ? '#f0f9f0' : active ? '#fff8e1' : '';
            row.style.fontWeight = active ? '700' : '';
            const dot = row.querySelector('.dd-dot');
            dot.style.background = done ? '#2ecc71' : active ? '#f39c12' : '#ddd';
            dot.textContent = i + 1;
            row.querySelector('.dd-chk').textContent = done ? '✓' : '';
        }
    }

    // --- Build panel (minimal DOM) ---
    const p = document.createElement('div');
    p.id = 'dd-panel';
    p.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:260px;background:#fff;border:2px solid #c0392b;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:12px Segoe UI,sans-serif;overflow:hidden';
    p.innerHTML = `
        <div id="dd-hdr" style="background:#c0392b;color:#fff;padding:8px 10px;font:700 13px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
            <span>Delete Delete v4.1</span><span id="dd-col" style="margin-left:auto;cursor:pointer;font-size:15px">−</span>
        </div>
        <div id="dd-body" style="padding:8px 10px">
            <textarea id="dd-ta" placeholder="Container IDs (one per line)" style="width:100%;height:60px;padding:5px;box-sizing:border-box;border:1px solid #ddd;border-radius:5px;font:10px monospace;resize:vertical"></textarea>
            <select id="dd-type" style="width:100%;padding:4px;border:1px solid #ddd;border-radius:5px;font:10px Segoe UI;margin:5px 0">
                <option value="MISSING">Sweeping out (Missing)</option>
                <option value="DAMAGED">Damaged and unreturnable</option>
                <option value="THEFT">Known theft</option>
            </select>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
                <button id="dd-load" style="padding:6px;border:none;border-radius:5px;cursor:pointer;font:600 10px Segoe UI;background:#c0392b;color:#fff">Load</button>
                <button id="dd-clear" style="padding:6px;border:none;border-radius:5px;cursor:pointer;font:600 10px Segoe UI;background:#eee;color:#555">Clear</button>
                <button id="dd-start" style="padding:6px;border:none;border-radius:5px;cursor:pointer;font:600 10px Segoe UI;background:#27ae60;color:#fff">▶ Start</button>
                <button id="dd-stop" style="padding:6px;border:none;border-radius:5px;cursor:pointer;font:600 10px Segoe UI;background:#e74c3c;color:#fff;display:none">⬛ Stop</button>
            </div>
            <div id="dd-list" style="max-height:130px;overflow-y:auto;border:1px solid #eee;border-radius:5px"></div>
            <div id="dd-status" style="margin-top:5px;padding:4px;border-radius:4px;font:600 10px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
            <div style="height:3px;background:#eee;border-radius:2px;overflow:hidden;margin-top:4px"><div id="dd-fill" style="height:100%;background:#c0392b;width:0%;transition:width .3s"></div></div>
        </div>`;
    document.body.appendChild(p);

    // Draggable (throttled)
    let dx, dy, dragging = false;
    document.getElementById('dd-hdr').onmousedown = e => {
        e.preventDefault(); dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop; dragging = true;
    };
    document.addEventListener('mousemove', e => { if (dragging) { p.style.left = (e.clientX - dx) + 'px'; p.style.top = (e.clientY - dy) + 'px'; p.style.right = 'auto'; } });
    document.addEventListener('mouseup', () => { dragging = false; });

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
        set(LS.list, containerList.join('\n')); set(LS.idx, '0'); set(LS.done, '[]'); set(LS.running, '0');
        renderList(); setStatus(`${containerList.length} loaded`, '#27ae60');
    };
    document.getElementById('dd-clear').onclick = () => {
        stop(); containerList = []; doneSet = new Set(); currentIdx = 0;
        document.getElementById('dd-ta').value = '';
        set(LS.list, ''); set(LS.idx, '0'); set(LS.done, '[]');
        renderList(); setStatus('Cleared', '#7f8c8d');
    };
    document.getElementById('dd-start').onclick = start;
    document.getElementById('dd-stop').onclick = stop;

    // Init
    const saved = get(LS.list);
    if (saved) { document.getElementById('dd-ta').value = saved; containerList = saved.split('\n').filter(Boolean); }
    document.getElementById('dd-type').value = get(LS.type, 'MISSING');
    restoreState(); renderList();

    // Auto-resume
    if (isRunning() && containerList.length && currentIdx < containerList.length) {
        polling = setInterval(tick, 600);
        document.getElementById('dd-start').style.display = 'none';
        document.getElementById('dd-stop').style.display = '';
        setStatus('Resuming...', '#3498db');
    }
})();
