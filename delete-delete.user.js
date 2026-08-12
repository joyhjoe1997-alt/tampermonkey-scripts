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
    //  ACTION LOG
    // =========================================================================

    const LOG_KEY = 'dd_action_log';

    function log(action, details = '') {
        const entries = getLog();
        entries.unshift({
            time: new Date().toLocaleString('en-GB', { hour12: false }),
            action,
            details: typeof details === 'object' ? JSON.stringify(details) : String(details),
        });
        if (entries.length > 200) entries.length = 200;
        ls.set(LOG_KEY, JSON.stringify(entries));
    }

    function getLog() {
        try { return JSON.parse(ls.get(LOG_KEY, '[]')); } catch { return []; }
    }

    function clearLog() { ls.set(LOG_KEY, '[]'); }

    function showLog() {
        const entries = getLog();
        const rows = entries.length ? entries.map(e => {
            const color = e.action.includes('SKIP') || e.action.includes('EMPTY') ? '#f39c12'
                : e.action.includes('STOP') || e.action.includes('ERROR') ? '#e74c3c'
                : e.action.includes('DONE') || e.action.includes('DELETED') ? '#27ae60' : '#2c3e50';
            return `<tr><td style="font-size:11px;color:#888;white-space:nowrap;padding:4px 8px">${e.time}</td><td style="font:700 12px Segoe UI;color:${color};padding:4px 8px">${e.action}</td><td style="font-size:12px;color:#555;padding:4px 8px">${e.details}</td></tr>`;
        }).join('') : '<tr><td colspan="3" style="text-align:center;padding:20px;color:#aaa">No log entries</td></tr>';

        document.getElementById('dd-log-dialog')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'dd-log-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:Segoe UI,sans-serif';
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:14px;width:700px;max-width:95vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 16px 50px rgba(0,0,0,.35);overflow:hidden">
                <div style="background:linear-gradient(135deg,#c0392b,#2c3e50);color:#fff;padding:14px 18px;font:700 16px Segoe UI;display:flex;justify-content:space-between;align-items:center">
                    <span>Delete Log (${entries.length})</span>
                    <span style="display:flex;gap:8px">
                        <button id="dd-log-clear" style="padding:5px 12px;border:none;border-radius:6px;font:600 11px Segoe UI;cursor:pointer;background:rgba(255,255,255,.2);color:#fff">Clear</button>
                        <button id="dd-log-close" style="padding:5px 12px;border:none;border-radius:6px;font:600 11px Segoe UI;cursor:pointer;background:rgba(255,255,255,.2);color:#fff">Close</button>
                    </span>
                </div>
                <div style="overflow-y:auto;flex:1;padding:8px">
                    <table style="width:100%;border-collapse:collapse">
                        <thead><tr style="background:#f4f6f8"><th style="padding:6px 8px;text-align:left;font-size:11px;border-bottom:1px solid #ddd">Time</th><th style="padding:6px 8px;text-align:left;font-size:11px;border-bottom:1px solid #ddd">Action</th><th style="padding:6px 8px;text-align:left;font-size:11px;border-bottom:1px solid #ddd">Details</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('dd-log-close').onclick = () => overlay.remove();
        document.getElementById('dd-log-clear').onclick = () => { clearLog(); overlay.remove(); showLog(); };
    }

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

    function getPageTitle() {
        const h1 = document.querySelector('#workflow h1');
        return h1 ? h1.textContent.trim() : '';
    }

    function isOnScanPage() { return getPageTitle().includes('Scan container'); }
    function isOnSelectItemPage() { return getPageTitle().includes('Select Item to Delete'); }
    function isOnSelectTypePage() { return getPageTitle().includes('Select deletion type'); }
    function isOnConfirmPage() { return getPageTitle().includes('Confirm the deletion'); }

    function getError() {
        const err = document.querySelector('.a-alert-inline-error .a-alert-content');
        return err ? err.textContent.trim() : '';
    }

    function getScanInput() {
        return document.querySelector('#workflow form input[type="text"]');
    }

    function getSubmitBtn() {
        return document.querySelector('#workflow form .a-button-primary input[type="submit"]');
    }

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
                <div style="margin:8px 0">
                    <label style="font:600 12px Segoe UI;color:#555">Deletion Type:</label>
                    <select id="dd-del-type" style="width:100%;padding:6px 8px;border:2px solid #e0e0e0;border-radius:6px;font:12px Segoe UI;margin-top:4px">
                        <option value="MISSING">Sweeping out (Missing)</option>
                        <option value="THEFT">Known theft</option>
                    </select>
                </div>
                <div style="font-size:11px;color:#95a5a6;margin:5px 0 10px">Auto-deletes ALL items in each container</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
                    <button id="dd-btn-load" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#c0392b;color:#fff">Load List</button>
                    <button id="dd-btn-clear" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#f0f0f0;color:#555">Clear</button>
                    <button id="dd-btn-auto" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#27ae60;color:#fff">Auto-Run</button>
                    <button id="dd-btn-stop" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#e74c3c;color:#fff;display:none">Stop</button>
                    <button id="dd-btn-log" style="padding:8px;border:none;border-radius:8px;cursor:pointer;font:600 12px Segoe UI;background:#8e44ad;color:#fff;grid-column:span 2">View Log</button>
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

        const deletionType = document.getElementById('dd-del-type')?.value || 'MISSING';

        while (autoRunning && currentIdx < containerList.length) {
            const containerId = containerList[currentIdx];
            const idx = currentIdx;

            // --- Step 1: Wait for Scan container page ---
            setStatus(`[${idx + 1}/${containerList.length}] Waiting for scan page...`, '#3498db');
            await waitUntil(isOnScanPage);
            if (!autoRunning) break;

            // --- Step 2: Enter container ID and submit ---
            const input = getScanInput();
            if (!input) continue;
            setStatus(`[${idx + 1}/${containerList.length}] Scanning: ${containerId}`, '#c0392b');
            log('SCAN', `Container ${idx + 1}/${containerList.length}: ${containerId}`);
            setNativeValue(input, containerId);
            renderList();

            const submitBtn = getSubmitBtn();
            if (submitBtn) submitBtn.click();

            // --- Step 3: Wait for next page ---
            await waitUntil(() => isOnSelectItemPage() || isOnSelectTypePage() || getError().length > 0, 15000);

            // Check for empty/error
            const error = getError();
            if (error.includes('is empty')) {
                setStatus(`[${idx + 1}] Empty - skipping`, 'orange');
                log('EMPTY', `${containerId} is empty - skipped`);
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                const inp = getScanInput();
                if (inp) setNativeValue(inp, '');
                continue;
            }
            if (error && !isOnSelectItemPage() && !isOnSelectTypePage()) {
                setStatus(`[${idx + 1}] Error: ${error.substring(0, 40)}`, '#e74c3c');
                log('ERROR', `${containerId}: ${error}`);
                doneSet.add(idx);
                currentIdx++;
                saveState();
                renderList();
                continue;
            }

            // --- Step 4: Delete all items loop ---
            let itemCount = 0;
            while (autoRunning) {
                // Page A: "Select Item to Delete" - select first radio, click Continue
                if (isOnSelectItemPage()) {
                    itemCount++;
                    setStatus(`[${idx + 1}] Selecting item ${itemCount}...`, '#c0392b');
                    const radio = document.querySelector('#workflow input[type="radio"]');
                    if (radio) radio.checked = true;
                    const btn = getSubmitBtn();
                    if (btn) btn.click();
                    await waitUntil(() => !isOnSelectItemPage() || isOnSelectTypePage() || isOnConfirmPage(), 15000);
                    continue;
                }

                // Page B: "Select deletion type" - select the configured type, click Continue
                if (isOnSelectTypePage()) {
                    setStatus(`[${idx + 1}] Selecting deletion type...`, '#c0392b');
                    const radio = document.querySelector(`#workflow input[type="radio"][value="${deletionType}"]`);
                    if (radio) { radio.checked = true; radio.click(); }
                    const btn = getSubmitBtn();
                    if (btn) btn.click();
                    await waitUntil(() => !isOnSelectTypePage() || isOnConfirmPage(), 15000);
                    continue;
                }

                // Page C: "Confirm the deletion" - click "Delete items [Enter]"
                if (isOnConfirmPage()) {
                    setStatus(`[${idx + 1}] Confirming deletion ${itemCount}...`, '#c0392b');
                    const btn = document.querySelector('[data-click-action*="Confirm"] input[type="submit"]');
                    if (btn) btn.click();
                    await waitUntil(() => !isOnConfirmPage() || isOnSelectItemPage() || isOnScanPage(), 15000);
                    continue;
                }

                // If back on scan page, this container is done
                if (isOnScanPage()) break;

                // Safety: wait for any page change
                await waitUntil(() => isOnSelectItemPage() || isOnSelectTypePage() || isOnConfirmPage() || isOnScanPage(), 10000);
                if (isOnScanPage()) break;
            }

            // --- Step 5: If still on item page, click Change Container ---
            if (isOnSelectItemPage() || isOnSelectTypePage() || isOnConfirmPage()) {
                const changeBtn = getChangeContainerBtn();
                if (changeBtn) {
                    changeBtn.click();
                    await waitUntil(isOnScanPage, 10000);
                }
            }

            // --- Step 6: Mark done ---
            setStatus(`[${idx + 1}] Done - ${itemCount} item(s) deleted`, '#27ae60');
            log('DELETED', `${containerId}: ${itemCount} item(s) deleted`);
            doneSet.add(idx);
            currentIdx++;
            saveState();
            renderList();
        }

        // --- Finished ---
        if (autoRunning && currentIdx >= containerList.length) {
            setStatus(`All ${containerList.length} containers processed!`, '#27ae60');
            log('ALL_DONE', `All ${containerList.length} containers processed`);
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
        document.getElementById('dd-btn-log').onclick = () => showLog();
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
