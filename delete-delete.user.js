// ==UserScript==
// @name         Delete Delete - Auto Delete Items
// @author       joyhjoe
// @version      3.0
// @description  Automated multi-container item deletion for AFT DeleteItems
// @match        https://aft-qt-eu.aka.amazon.com/app/deleteitems*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const LS = { list: 'dd_list', idx: 'dd_idx', running: 'dd_running', done: 'dd_done', type: 'dd_type' };
    const get = (k, d = '') => localStorage.getItem(k) ?? d;
    const set = (k, v) => localStorage.setItem(k, String(v));

    let containerList = [];
    let doneSet = new Set();
    let currentIdx = 0;
    let polling = null;
    let lastClick = 0;
    let needsRestart = false;

    function isRunning() { return get(LS.running) === '1'; }
    function saveState() { set(LS.idx, currentIdx); set(LS.done, JSON.stringify([...doneSet])); }
    function restoreState() {
        currentIdx = parseInt(get(LS.idx, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(get(LS.done, '[]'))); } catch { doneSet = new Set(); }
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
        const btn = document.querySelector('.a-button-primary input.a-button-input, .a-button-primary button');
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
        // Click "Start over" link or press 'r'
        const link = document.querySelector('[data-action="click-restart"] a, [data-click-restart] a');
        if (link) { link.click(); return; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', keyCode: 82, bubbles: true }));
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
            setStatus(`[${currentIdx + 1}] Selecting item...`, '#c0392b');
            const radio = document.querySelector('#workflow input[type="radio"]');
            if (radio && !radio.checked) radio.checked = true;
            clickPrimary();
            return;
        }

        // Select deletion type
        if (title.includes('Select deletion type')) {
            setStatus(`[${currentIdx + 1}] Setting type...`, '#c0392b');
            const radio = document.querySelector(`input[type="radio"][value="${delType}"]`);
            if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
            clickPrimary();
            return;
        }

        // Confirm deletion
        if (title.includes('Confirm the deletion')) {
            setStatus(`[${currentIdx + 1}] Deleting...`, '#c0392b');
            clickConfirm();
            return;
        }

        // If we somehow ended back on scan without going through above flow
        if (title.includes('Scan') && !error) {
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
        wrap.children[currentIdx]?.scrollIntoView({ block: 'nearest' });
    }

    // Build panel
    const p = document.createElement('div');
    p.id = 'dd-panel';
    p.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:280px;background:#fff;border:2px solid #c0392b;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.2);font:13px Segoe UI,sans-serif;overflow:hidden';
    p.innerHTML = `
        <div id="dd-hdr" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;padding:10px 12px;font:700 14px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
            <span>Delete Delete v3</span><span id="dd-col" style="margin-left:auto;cursor:pointer;font-size:16px">-</span>
        </div>
        <div id="dd-body" style="padding:10px 12px">
            <textarea id="dd-ta" placeholder="Container IDs (one per line)" style="width:100%;height:70px;padding:6px;box-sizing:border-box;border:2px solid #e0e0e0;border-radius:6px;font:11px monospace;resize:vertical"></textarea>
            <select id="dd-type" style="width:100%;padding:5px;border:2px solid #e0e0e0;border-radius:6px;font:11px Segoe UI;margin:6px 0">
                <option value="MISSING">Sweeping out (Missing)</option>
                <option value="THEFT">Known theft</option>
            </select>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px">
                <button id="dd-load" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#c0392b;color:#fff">Load</button>
                <button id="dd-clear" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#eee;color:#555">Clear</button>
                <button id="dd-start" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#27ae60;color:#fff">Start</button>
                <button id="dd-stop" style="padding:7px;border:none;border-radius:6px;cursor:pointer;font:600 11px Segoe UI;background:#e74c3c;color:#fff;display:none">Stop</button>
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

    // Auto-resume
    if (isRunning() && containerList.length && currentIdx < containerList.length) {
        setStatus(`Resuming...`, '#3498db');
        needsRestart = true;
        polling = setInterval(tick, 500);
        document.getElementById('dd-start').style.display = 'none';
        document.getElementById('dd-stop').style.display = '';
    }
})();
