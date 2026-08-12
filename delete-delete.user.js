// ==UserScript==
// @name         Delete Delete - Auto Delete Items
// @author       joyhjoe
// @version      2.0
// @description  Automated multi-container item deletion for AFT DeleteItems tool
// @match        https://aft-qt-eu.aka.amazon.com/app/deleteitems*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const LS = {
        list: 'dd_list',
        idx: 'dd_idx',
        running: 'dd_running',
        done: 'dd_done',
        type: 'dd_deltype',
        log: 'dd_log',
    };

    const get = (k, d = '') => localStorage.getItem(k) ?? d;
    const set = (k, v) => localStorage.setItem(k, String(v));

    let containerList = [];
    let doneSet = new Set();
    let currentIdx = 0;
    let polling = null;

    // === LOG ===
    function log(action, details) {
        const entries = getLog();
        entries.unshift({ time: new Date().toLocaleTimeString('en-GB'), action, details });
        if (entries.length > 200) entries.length = 200;
        set(LS.log, JSON.stringify(entries));
    }
    function getLog() { try { return JSON.parse(get(LS.log, '[]')); } catch { return []; } }

    // === HELPERS ===
    function getTitle() {
        const h1 = document.querySelector('#workflow h1');
        return h1 ? h1.textContent.trim() : '';
    }

    function getError() {
        const el = document.querySelector('.a-alert-inline-error .a-alert-content');
        return el ? el.textContent.trim() : '';
    }

    function getPrimaryBtn() {
        // Find visible primary button input
        const btn = document.querySelector('.a-button-primary input.a-button-input');
        if (btn && btn.offsetParent !== null) return btn;
        // Fallback: any visible submit
        for (const b of document.querySelectorAll('input[type="submit"], button[type="submit"]')) {
            if (b.offsetParent !== null) {
                const text = (b.value || b.textContent || '').toLowerCase();
                if (text.includes('continue') || text.includes('delete') || text.includes('confirm')) return b;
            }
        }
        return null;
    }

    function getTextInput() {
        return document.querySelector('#workflow form input[type="text"]');
    }

    function fillInput(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isRunning() { return get(LS.running) === '1'; }

    function saveState() {
        set(LS.idx, currentIdx);
        set(LS.done, JSON.stringify([...doneSet]));
    }

    function restoreState() {
        currentIdx = parseInt(get(LS.idx, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(get(LS.done, '[]'))); } catch { doneSet = new Set(); }
    }

    // === CORE: Polling tick (runs every 500ms) ===
    function tick() {
        if (!isRunning()) { stopPolling(); return; }
        if (currentIdx >= containerList.length) {
            log('ALL_DONE', `${containerList.length} containers processed`);
            setStatus(`All ${containerList.length} done!`, '#27ae60');
            stopPolling();
            set(LS.running, '0');
            return;
        }

        const title = getTitle();
        const error = getError();
        const containerId = containerList[currentIdx];
        const delType = get(LS.type, 'MISSING');

        // --- On "Scan container" page ---
        if (title.includes('Scan container')) {
            // Check if error says empty
            if (error.includes('is empty')) {
                log('EMPTY', `${containerId} is empty`);
                setStatus(`[${currentIdx + 1}] Empty - next`, 'orange');
                doneSet.add(currentIdx);
                currentIdx++;
                saveState();
                renderList();
                // Clear input for next
                const inp = getTextInput();
                if (inp) fillInput(inp, containerList[currentIdx] || '');
                return;
            }
            // Fill and submit
            const inp = getTextInput();
            if (inp && inp.value !== containerId) {
                setStatus(`[${currentIdx + 1}/${containerList.length}] Scanning: ${containerId}`, '#c0392b');
                log('SCAN', containerId);
                fillInput(inp, containerId);
            }
            // Click continue
            const btn = getPrimaryBtn();
            if (btn && inp && inp.value === containerId) btn.click();
            return;
        }

        // --- On "Select deletion type" page ---
        if (title.includes('Select deletion type')) {
            setStatus(`[${currentIdx + 1}] Selecting type...`, '#c0392b');
            const radio = document.querySelector(`input[type="radio"][value="${delType}"]`);
            if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
            const btn = getPrimaryBtn();
            if (btn) btn.click();
            return;
        }

        // --- On "Select Item to Delete" page ---
        if (title.includes('Select Item to Delete')) {
            setStatus(`[${currentIdx + 1}] Selecting item...`, '#c0392b');
            // First radio should already be checked, just click continue
            const radio = document.querySelector('#workflow input[type="radio"]');
            if (radio && !radio.checked) radio.checked = true;
            const btn = getPrimaryBtn();
            if (btn) btn.click();
            return;
        }

        // --- On "Confirm the deletion" page ---
        if (title.includes('Confirm the deletion')) {
            setStatus(`[${currentIdx + 1}] Confirming...`, '#c0392b');
            // Click "Delete items" (the Confirm action button)
            const btn = document.querySelector('[data-click-action*="Confirm"] input.a-button-input');
            if (btn) { btn.click(); return; }
            // Fallback to primary
            const primaryBtn = getPrimaryBtn();
            if (primaryBtn) primaryBtn.click();
            return;
        }

        // --- On success/done page (back to scan means item deleted) ---
        // If none of the above matched, check if we're done with this container
        if (title.includes('Scan container')) {
            doneSet.add(currentIdx);
            currentIdx++;
            saveState();
            renderList();
        }
    }

    function startPolling() {
        if (polling) return;
        set(LS.running, '1');
        polling = setInterval(tick, 500);
    }

    function stopPolling() {
        if (polling) { clearInterval(polling); polling = null; }
    }

    // === UI ===
    function setStatus(msg, color = '#7f8c8d') {
        const el = document.getElementById('dd-status');
        if (el) { el.textContent = msg; el.style.color = color; }
    }

    function renderList() {
        const wrap = document.getElementById('dd-list-wrap');
        if (!wrap) return;
        const fill = document.getElementById('dd-prog-fill');
        if (fill) fill.style.width = containerList.length ? `${Math.round(doneSet.size / containerList.length * 100)}%` : '0%';
        if (!containerList.length) { wrap.innerHTML = '<div style="padding:14px;text-align:center;color:#aaa;font-size:12px">Paste container IDs above</div>'; return; }
        wrap.innerHTML = '';
        containerList.forEach((id, i) => {
            const done = doneSet.has(i);
            const active = i === currentIdx && !done && isRunning();
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid #f5f5f5;gap:8px;font:12px monospace;${done ? 'background:#f0f9f0;color:#27ae60' : active ? 'background:#fff3cd;font-weight:700' : ''}`;
            row.innerHTML = `<div style="width:20px;height:20px;background:${done ? '#2ecc71' : active ? '#f39c12' : '#c0392b'};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${i + 1}</div><div style="flex:1">${id}</div>${done ? '<span style="color:#27ae60">&#10003;</span>' : ''}`;
            wrap.appendChild(row);
        });
        wrap.children[currentIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function showLog() {
        const entries = getLog();
        const rows = entries.length ? entries.map(e => `<tr><td style="font-size:11px;color:#888;padding:3px 8px">${e.time}</td><td style="font:700 12px Segoe UI;padding:3px 8px">${e.action}</td><td style="font-size:12px;padding:3px 8px">${e.details}</td></tr>`).join('') : '<tr><td colspan="3" style="text-align:center;padding:20px;color:#aaa">Empty</td></tr>';
        const d = document.createElement('div');
        d.id = 'dd-log-dlg';
        d.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';
        d.innerHTML = `<div style="background:#fff;border-radius:14px;width:650px;max-width:95vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 16px 50px rgba(0,0,0,.35)"><div style="background:#c0392b;color:#fff;padding:12px 16px;font:700 15px Segoe UI;display:flex;justify-content:space-between"><span>Log (${entries.length})</span><button id="dd-log-x" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer">X</button></div><div style="overflow-y:auto;flex:1;padding:8px"><table style="width:100%;border-collapse:collapse">${rows}</table></div></div>`;
        document.getElementById('dd-log-dlg')?.remove();
        document.body.appendChild(d);
        document.getElementById('dd-log-x').onclick = () => d.remove();
    }

    function buildPanel() {
        const p = document.createElement('div');
        p.id = 'dd-panel';
        p.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:300px;background:#fff;border:2px solid #c0392b;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.22);font:13px Segoe UI,sans-serif;overflow:hidden';
        p.innerHTML = `
            <div id="dd-hdr" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;padding:12px 14px;display:flex;align-items:center;font:700 14px Segoe UI;cursor:move;user-select:none">
                <span>Delete Delete v2.0</span>
                <span id="dd-col" style="margin-left:auto;cursor:pointer;font-size:18px">-</span>
            </div>
            <div id="dd-body" style="padding:12px 14px">
                <textarea id="dd-ta" placeholder="Paste container IDs (one per line)" style="width:100%;height:80px;padding:8px;box-sizing:border-box;border:2px solid #e0e0e0;border-radius:8px;font:12px monospace;resize:vertical"></textarea>
                <div style="margin:8px 0">
                    <label style="font:600 11px Segoe UI;color:#555">Deletion Type:</label>
                    <select id="dd-type" style="width:100%;padding:5px;border:2px solid #e0e0e0;border-radius:6px;font:12px Segoe UI;margin-top:3px">
                        <option value="MISSING">Sweeping out (Missing)</option>
                        <option value="THEFT">Known theft</option>
                    </select>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
                    <button id="dd-load" style="padding:7px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#c0392b;color:#fff">Load</button>
                    <button id="dd-clear" style="padding:7px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#f0f0f0;color:#555">Clear</button>
                    <button id="dd-start" style="padding:7px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#27ae60;color:#fff">Start</button>
                    <button id="dd-stop" style="padding:7px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#e74c3c;color:#fff">Stop</button>
                    <button id="dd-log" style="padding:7px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#8e44ad;color:#fff;grid-column:span 2">View Log</button>
                </div>
                <div id="dd-list-wrap" style="max-height:170px;overflow-y:auto;border:1px solid #eee;border-radius:8px"></div>
                <div id="dd-status" style="margin-top:8px;padding:6px;border-radius:7px;font:600 11px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
                <div style="height:5px;background:#e0e0e0;border-radius:3px;overflow:hidden;margin-top:6px"><div id="dd-prog-fill" style="height:100%;background:linear-gradient(90deg,#e74c3c,#c0392b);width:0%;transition:width .35s;border-radius:3px"></div></div>
            </div>`;
        document.body.appendChild(p);

        // Draggable
        let sx, sy;
        document.getElementById('dd-hdr').onmousedown = e => {
            e.preventDefault(); sx = e.clientX; sy = e.clientY;
            const mv = ev => { p.style.top = (p.offsetTop + ev.clientY - sy) + 'px'; p.style.left = (p.offsetLeft + ev.clientX - sx) + 'px'; p.style.right = 'auto'; sx = ev.clientX; sy = ev.clientY; };
            const up = () => document.removeEventListener('mousemove', mv);
            document.addEventListener('mousemove', mv);
            document.addEventListener('mouseup', up, { once: true });
        };

        // Collapse
        document.getElementById('dd-col').onclick = () => {
            const b = document.getElementById('dd-body');
            b.style.display = b.style.display === 'none' ? '' : 'none';
            document.getElementById('dd-col').textContent = b.style.display === 'none' ? '+' : '-';
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
            stopPolling(); set(LS.running, '0');
            containerList = []; doneSet = new Set(); currentIdx = 0;
            document.getElementById('dd-ta').value = '';
            set(LS.list, ''); set(LS.idx, '0'); set(LS.done, '[]');
            renderList(); setStatus('Cleared', '#7f8c8d');
        };

        document.getElementById('dd-start').onclick = () => {
            if (!containerList.length) { setStatus('Load list first', 'orange'); return; }
            set(LS.type, document.getElementById('dd-type').value);
            saveState();
            startPolling();
            setStatus('Running...', '#c0392b');
        };

        document.getElementById('dd-stop').onclick = () => {
            stopPolling(); set(LS.running, '0');
            setStatus('Stopped', '#e74c3c');
        };

        document.getElementById('dd-log').onclick = showLog;
    }

    // === INIT ===
    buildPanel();
    const saved = get(LS.list);
    if (saved) {
        document.getElementById('dd-ta').value = saved;
        containerList = saved.split('\n').map(s => s.trim()).filter(Boolean);
    }
    const savedType = get(LS.type, 'MISSING');
    document.getElementById('dd-type').value = savedType;
    restoreState();
    renderList();

    // Auto-resume if was running
    if (isRunning() && containerList.length && currentIdx < containerList.length) {
        setStatus(`Resuming ${currentIdx + 1}/${containerList.length}...`, '#3498db');
        startPolling();
    }
})();
