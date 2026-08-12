// ==UserScript==
// @name         Delete Delete - Auto Delete Items
// @author       joyhjoe
// @version      1.0
// @description  Automated multi-container item deletion for AFT DeleteItems tool
// @match        https://aft-qt-eu.aka.amazon.com/app/deleteitems*
// @icon         https://cdn-icons-png.flaticon.com/512/3687/3687412.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * DELETE DELETE v1.0 - AFT Delete Items Automation
 *
 * Flow per container:
 *   1. Wait for "Scan container" page
 *   2. Enter container ID, press Enter
 *   3. If "is empty" error -> skip to next container
 *   4. If "Select Item to Delete" -> select first radio, press Enter
 *   5. Repeat step 4 until all items deleted
 *   6. Click "Change Container (d)" to go back to step 1
 *   7. Process next container from list
 */
(function () {
    'use strict';

    // =========================================================================
    //  CONFIG
    // =========================================================================

    const LS_KEY = 'dd_container_list';
    const LS_IDX = 'dd_currentIdx';
    const LS_DONE = 'dd_doneSet';
    const LS_AUTO = 'dd_autoRunning';

    // =========================================================================
    //  STATE
    // =========================================================================

    let containerList = [];
    let doneSet = new Set();
    let currentIdx = 0;
    let autoRunning = false;

    const ls = {
        get: (k, d = '') => localStorage.getItem(k) ?? d,
        set: (k, v) => localStorage.setItem(k, String(v)),
    };

    // =========================================================================
    //  STATE PERSISTENCE
    // =========================================================================

    function saveState() {
        ls.set(LS_IDX, currentIdx);
        ls.set(LS_AUTO, autoRunning ? '1' : '0');
        ls.set(LS_DONE, JSON.stringify([...doneSet]));
    }

    function restoreState() {
        currentIdx = parseInt(ls.get(LS_IDX, '0'), 10) || 0;
        try { doneSet = new Set(JSON.parse(ls.get(LS_DONE, '[]'))); } catch { doneSet = new Set(); }
        return ls.get(LS_AUTO, '0') === '1';
    }

    function clearState() {
        ls.set(LS_IDX, '0');
        ls.set(LS_AUTO, '0');
        ls.set(LS_DONE, '[]');
    }

    // =========================================================================
    //  PAGE DETECTION
    // =========================================================================

    /** Returns true if on "Scan container" page */
    function isOnScanPage() {
        const h1 = document.querySelector('#workflow h1');
        return h1 && h1.textContent.includes('Scan container');
    }

    /** Returns true if on "Select Item to Delete" page */
    function isOnSelectPage() {
        const h1 = document.querySelector('#workflow h1');
        return h1 && h1.textContent.includes('Select Item to Delete');
    }

    /** Returns the error message if container is empty */
    function getError() {
        const err = document.querySelector('.a-alert-inline-error .a-alert-content');
        return err ? err.textContent.trim() : '';
    }

    /** Returns the text input on the scan page */
    function getScanInput() {
        return document.querySelector('#workflow form input[type="text"]');
    }

    /** Returns the submit button */
    function getSubmitBtn() {
        return document.querySelector('#workflow form input[type="submit"]');
    }

    /** Returns the "Change Container (d)" button */
    function getChangeContainerBtn() {
        return document.querySelector('[data-click-action*="Done"] input[type="submit"]');
    }

    // =========================================================================
    //  UTILITIES
    // =========================================================================

    function setNativeValue(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Waits until a condition function returns truthy, using MutationObserver */
    function waitUntil(condFn, timeout = 30000) {
        return new Promise(resolve => {
            if (condFn()) { resolve(true); return; }
            const observer = new MutationObserver(() => {
                if (condFn()) { observer.disconnect(); clearTimeout(timer); resolve(true); }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
        });
    }

    // =========================================================================
    //  UI
    // =========================================================================

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
            const active = i === currentIdx && !done && autoRunning;
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid #f5f5f5;gap:8px;font:12px monospace;${done ? 'background:#f0f9f0;color:#27ae60' : active ? 'background:#fff3cd;font-weight:700' : ''}`;
            row.innerHTML = `<div style="width:20px;height:20px;background:${done ? '#2ecc71' : active ? '#f39c12' : '#c0392b'};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${i + 1}</div><div style="flex:1">${id}</div>${done ? '<span style="color:#27ae60">&#10003;</span>' : ''}`;
            wrap.appendChild(row);
        });
        wrap.children[currentIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'dd-panel';
        panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:300px;background:#fff;border:2px solid #c0392b;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.22);font:13px Segoe UI,system-ui,sans-serif;color:#2c3e50;overflow:hidden';
        panel.innerHTML = `
            <div id="dd-header" style="background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px;font:700 14px Segoe UI;cursor:move;user-select:none">
                <span>Delete Delete v1.0</span>
                <span id="dd-collapse" style="margin-left:auto;cursor:pointer;font-size:18px;opacity:.8">-</span>
            </div>
            <div id="dd-body" style="padding:12px 14px">
                <textarea id="dd-ta" placeholder="Paste container IDs (one per line)" style="width:100%;height:90px;padding:8px;box-sizing:border-box;border:2px solid #e0e0e0;border-radius:8px;font:12px monospace;resize:vertical"></textarea>
                <div style="font-size:11px;color:#95a5a6;margin:5px 0 10px">Auto-deletes ALL items in each container</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
                    <button id="dd-btn-load" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#c0392b;color:#fff">Load List</button>
                    <button id="dd-btn-clear" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#f0f0f0;color:#555">Clear</button>
                    <button id="dd-btn-auto" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#27ae60;color:#fff">Auto-Run</button>
                    <button id="dd-btn-stop" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#e74c3c;color:#fff;display:none">Stop</button>
                </div>
                <div id="dd-list-wrap" style="max-height:180px;overflow-y:auto;border:1px solid #eee;border-radius:8px"></div>
                <div id="dd-status" style="margin-top:8px;padding:6px 10px;border-radius:7px;font:600 11px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d;min-height:26px;display:flex;align-items:center;justify-content:center">Ready</div>
                <div style="height:5px;background:#e0e0e0;border-radius:3px;overflow:hidden;margin-top:6px"><div id="dd-prog-fill" style="height:100%;background:linear-gradient(90deg,#e74c3c,#c0392b);width:0%;transition:width .35s;border-radius:3px"></div></div>
            </div>`;
        document.body.appendChild(panel);

        // Draggable
        let sx, sy;
        const hdr = panel.querySelector('#dd-header');
        hdr.addEventListener('mousedown', e => {
            e.preventDefault(); sx = e.clientX; sy = e.clientY;
            const move = ev => { panel.style.top = (panel.offsetTop + ev.clientY - sy) + 'px'; panel.style.left = (panel.offsetLeft + ev.clientX - sx) + 'px'; panel.style.right = 'auto'; sx = ev.clientX; sy = ev.clientY; };
            const stop = () => document.removeEventListener('mousemove', move);
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', stop, { once: true });
        });
    }

    // =========================================================================
    //  MAIN AUTO-RUN LOOP
    // =========================================================================

    async function autoRun() {
        if (!containerList.length) { setStatus('Load list first', 'orange'); return; }
        document.getElementById('dd-btn-auto').style.display = 'none';
        document.getElementById('dd-btn-stop').style.display = '';
        autoRunning = true;
        saveState();

        while (autoRunning && currentIdx < containerList.length) {
            const containerId = containerList[currentIdx];
            const idx = currentIdx;

            // --- Step 1: Wait for Scan container page ---
            setStatus(`[${idx + 1}/${containerList.length}] Waiting for scan page...`, '#3498db');
            const scanReady = await waitUntil(isOnScanPage);
            if (!scanReady || !autoRunning) continue;

            // --- Step 2: Enter container ID and submit ---
            const input = getScanInput();
            if (!input) continue;
            setStatus(`[${idx + 1}/${containerList.length}] Scanning: ${containerId}`, '#c0392b');
            setNativeValue(input, containerId);
            renderList();

            const submitBtn = getSubmitBtn();
            if (submitBtn) submitBtn.click();

            // --- Step 3: Wait for response (either item page, error, or same page) ---
            await waitUntil(() => isOnSelectPage() || getError().includes('is empty') || getError().length > 0, 15000);

            // --- Step 3a: If empty container error, skip to next ---
            const error = getError();
            if (error.includes('is empty')) {
                setStatus(`[${idx + 1}] Empty - skipping`, 'orange');
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                continue;
            }

            // --- Step 3b: If other error, skip ---
            if (error && !isOnSelectPage()) {
                setStatus(`[${idx + 1}] Error: ${error.substring(0, 40)}`, '#e74c3c');
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                continue;
            }

            // --- Step 4: Delete all items one by one ---
            let itemCount = 0;
            while (autoRunning && isOnSelectPage()) {
                itemCount++;
                setStatus(`[${idx + 1}] Deleting item ${itemCount}...`, '#c0392b');

                // Select first radio button (should already be selected by default)
                const radio = document.querySelector('#workflow input[type="radio"]');
                if (radio) radio.checked = true;

                // Click Continue
                const continueBtn = getSubmitBtn();
                if (continueBtn) continueBtn.click();

                // Wait for page to transition (either more items, or back to scan)
                await waitUntil(() => {
                    // Still on select page (more items) or back to scan page
                    const h1 = document.querySelector('#workflow h1');
                    if (!h1) return false;
                    const text = h1.textContent;
                    return text.includes('Scan container') || text.includes('Select Item');
                }, 15000);

                // Small check: if we're back on scan page, container is done
                if (isOnScanPage()) break;
            }

            // --- Step 5: If still on select page with no more items, click Change Container ---
            if (isOnSelectPage()) {
                const changeBtn = getChangeContainerBtn();
                if (changeBtn) {
                    changeBtn.click();
                    await waitUntil(isOnScanPage, 10000);
                }
            }

            // --- Step 6: Mark done ---
            setStatus(`[${idx + 1}] Done - ${itemCount} item(s) deleted`, '#27ae60');
            doneSet.add(idx);
            currentIdx++;
            saveState();
            renderList();
        }

        // --- Finished ---
        if (autoRunning && currentIdx >= containerList.length) {
            setStatus(`All ${containerList.length} containers processed!`, '#27ae60');
            clearState();
        }
        autoRunning = false;
        document.getElementById('dd-btn-auto').style.display = '';
        document.getElementById('dd-btn-stop').style.display = 'none';
    }

    // =========================================================================
    //  INIT
    // =========================================================================

    function init() {
        if (document.getElementById('dd-panel')) return;
        buildPanel();

        const saved = ls.get(LS_KEY);
        if (saved) {
            document.getElementById('dd-ta').value = saved;
            containerList = saved.split('\n').map(s => s.trim()).filter(Boolean);
        }

        const shouldResume = restoreState();
        renderList();

        if (containerList.length && shouldResume && currentIdx < containerList.length) {
            setStatus(`Resuming from container ${currentIdx + 1}...`, '#3498db');
            ls.set(LS_AUTO, '0');
            autoRun();
        } else if (containerList.length) {
            setStatus(`${containerList.length} container(s) restored`, '#3498db');
        }

        // Button handlers
        document.getElementById('dd-btn-load').onclick = () => {
            const ta = document.getElementById('dd-ta');
            containerList = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
            doneSet = new Set();
            currentIdx = 0;
            ls.set(LS_KEY, ta.value);
            clearState();
            renderList();
            setStatus(`${containerList.length} container(s) loaded`, '#27ae60');
        };
        document.getElementById('dd-btn-clear').onclick = () => {
            autoRunning = false;
            containerList = []; doneSet = new Set(); currentIdx = 0;
            document.getElementById('dd-ta').value = '';
            ls.set(LS_KEY, '');
            clearState();
            renderList();
            setStatus('Cleared', '#7f8c8d');
            document.getElementById('dd-btn-auto').style.display = '';
            document.getElementById('dd-btn-stop').style.display = 'none';
        };
        document.getElementById('dd-btn-auto').onclick = () => { if (!autoRunning) autoRun(); };
        document.getElementById('dd-btn-stop').onclick = () => {
            autoRunning = false; clearState(); setStatus('Stopped', '#e74c3c');
            document.getElementById('dd-btn-auto').style.display = '';
            document.getElementById('dd-btn-stop').style.display = 'none';
        };
        document.getElementById('dd-collapse').onclick = () => {
            const body = document.getElementById('dd-body');
            const btn = document.getElementById('dd-collapse');
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            btn.textContent = hidden ? '-' : '+';
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
