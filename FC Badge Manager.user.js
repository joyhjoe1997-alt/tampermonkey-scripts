// ==UserScript==
// @name         FC Badge Manager
// @version      2.0.0
// @description  Saves badge from FCResearch (all domains) and auto-populates barcode generator
// @author       @joyhjoe
// @match        http://fcresearch-na.aka.amazon.com/*
// @match        http://fcresearch-eu.aka.amazon.com/*
// @match        http://fcresearch-fe.aka.amazon.com/*
// @match        https://fcresearch-na.aka.amazon.com/*
// @match        https://fcresearch-eu.aka.amazon.com/*
// @match        https://fcresearch-fe.aka.amazon.com/*
// @match        https://qi-fcresearch-eu.corp.amazon.com/*
// @match        https://qi-fcresearch-na.corp.amazon.com/*
// @match        https://qi-fcresearch-fe.corp.amazon.com/*
// @match        https://qifcr.eu.aftx.amazonoperations.app/*
// @match        https://qifcr.na.aftx.amazonoperations.app/*
// @match        https://qifcr.fe.aftx.amazonoperations.app/*
// @match        http://localhost:5965/barcodegenerator*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const currentURL = window.location.href;
    const isFCResearch = /fcresearch|qifcr/i.test(currentURL);
    const isBarcodeGen = currentURL.includes('localhost:5965/barcodegenerator');

    // ═══════════════════════════════════════════════════════
    //  SHARED UI
    // ═══════════════════════════════════════════════════════

    function createPanel(badgeVal, loginVal, whidVal, status) {
        const existing = document.getElementById('fcr-badge-panel');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'fcr-badge-panel';

        const statusColors = {
            success: { bg: '#0f5132', border: '#198754', icon: '\u2705' },
            warning: { bg: '#664d03', border: '#ffc107', icon: '\u26A0\uFE0F' },
            error:   { bg: '#58151c', border: '#dc3545', icon: '\u274C' },
            info:    { bg: '#232f3e', border: '#ff9900', icon: '\uD83D\uDCCB' },
        };
        const s = statusColors[status] || statusColors.info;

        panel.style.cssText = `
            position:fixed;top:10px;right:10px;z-index:99999;
            background-color:${s.bg};color:#fff;
            font-family:'Segoe UI',Arial,sans-serif;font-size:12px;
            padding:10px 14px;border-radius:8px;
            border:1.5px solid ${s.border};
            box-shadow:0 4px 12px rgba(0,0,0,0.4);
            line-height:1.9;min-width:200px;max-width:280px;
            transition:opacity 0.3s;
        `;

        const statusMsg = {
            success: 'Badge captured successfully',
            warning: 'No badge found \u2014 open FCResearch first',
            error:   'Failed to detect badge',
            info:    'FC Badge Manager active',
        };

        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="font-size:14px;">${s.icon}</span>
                <span style="font-size:11px;color:#ccc;text-transform:uppercase;letter-spacing:1px;font-weight:600;">FC Badge Manager</span>
                <span id="fcr-panel-close" style="margin-left:auto;cursor:pointer;opacity:0.6;font-size:14px;" title="Close">\u2715</span>
            </div>
            <div style="font-size:11px;color:${s.border};margin-bottom:4px;">${statusMsg[status] || ''}</div>
            <div><span style="color:#aaa;">Badge:</span> <strong style="color:#ff9900;">${badgeVal || 'N/A'}</strong></div>
            <div><span style="color:#aaa;">Login:</span> <strong style="color:#fff;">${loginVal || 'N/A'}</strong></div>
            <div><span style="color:#aaa;">WHID:</span> <strong style="color:#fff;">${whidVal || 'N/A'}</strong></div>
            <div style="font-size:10px;color:#888;margin-top:6px;">Saved: ${new Date().toLocaleTimeString()}</div>
        `;

        document.body.appendChild(panel);

        // Close button
        document.getElementById('fcr-panel-close').onclick = () => {
            panel.style.opacity = '0';
            setTimeout(() => panel.remove(), 300);
        };

        // Auto-hide after 8 seconds on success
        if (status === 'success') {
            setTimeout(() => {
                if (panel.parentElement) {
                    panel.style.opacity = '0';
                    setTimeout(() => panel.remove(), 300);
                }
            }, 8000);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  FC RESEARCH: BADGE DETECTION
    // ═══════════════════════════════════════════════════════

    if (isFCResearch) {

        // --- Strategy 1: Cookies ---
        function getCookie(name) {
            const cookies = document.cookie.split(';');
            for (const cookie of cookies) {
                const trimmed = cookie.trim();
                if (trimmed.startsWith(name + '=')) {
                    return decodeURIComponent(trimmed.substring(name.length + 1));
                }
            }
            return '';
        }

        function readFromCookies() {
            const id    = getCookie('fcmenu-employeeId');
            const login = getCookie('fcmenu-employeeLogin');
            const whid  = getCookie('fcmenu-warehouseId');
            if (id) {
                console.log('[FC Badge Manager] Found via cookies:', { id, login, whid });
                return { id, login, whid };
            }
            return null;
        }

        // --- Strategy 2: Window/global JS variables ---
        function readFromPageVars() {
            const candidates = [
                window.fcBadgeId,
                window.badgeId,
                window.employeeId,
                window.fcmenu?.employeeId,
                window.FCMenu?.employeeId,
                window.userInfo?.badgeId,
                window.userInfo?.employeeId,
                window.session?.employeeId,
                window.session?.badgeId,
            ];
            for (const val of candidates) {
                if (val && /^\d{4,12}$/.test(String(val))) {
                    console.log('[FC Badge Manager] Found via window variable:', val);
                    return { id: String(val), login: '', whid: '' };
                }
            }
            return null;
        }

        // --- Strategy 3: localStorage/sessionStorage ---
        function readFromStorage() {
            const keys = ['badgeId', 'employeeId', 'badge_id', 'employee_id', 'fcmenu-employeeId'];
            for (const storage of [localStorage, sessionStorage]) {
                for (const key of keys) {
                    const val = storage.getItem(key);
                    if (val && /^\d{4,12}$/.test(val.trim())) {
                        console.log('[FC Badge Manager] Found via storage key:', key, '=', val);
                        return { id: val.trim(), login: '', whid: '' };
                    }
                }
            }
            return null;
        }

        // --- Strategy 4: DOM scan (targeted then broad) ---
        function readFromDOM() {
            // Targeted selectors for known FC menu elements
            const selectors = [
                '[id*="employeeId" i]',
                '[id*="employee-id" i]',
                '[id*="badgeId" i]',
                '[id*="badge-id" i]',
                '[data-employee-id]',
                '[data-badge-id]',
                '#fcmenu-user',
                '#fc-menu-user',
                '.fcmenu-user',
                '.fc-menu-user',
                '[id*="fcmenu" i]',
                '[class*="fcmenu" i]',
            ];

            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const id =
                        el.getAttribute('data-employee-id') ||
                        el.getAttribute('data-badge-id') ||
                        el.getAttribute('data-id') ||
                        el.textContent.trim();
                    if (id && /^\d{4,12}$/.test(id.replace(/\s/g, ''))) {
                        console.log('[FC Badge Manager] Found via DOM selector:', sel, '=', id);
                        return { id: id.trim(), login: '', whid: '' };
                    }
                }
            }

            // Broader scan — limit to header/nav area first, then full page
            const searchAreas = [
                document.querySelector('.aui-nav-row, header, nav, [role="banner"]'),
                document.body,
            ];

            for (const area of searchAreas) {
                if (!area) continue;
                const elements = area.querySelectorAll('span, div, p, li, td, th, a');
                for (const el of elements) {
                    const text = el.textContent.trim();
                    if (text.length > 100) continue; // skip large text blocks
                    const match = text.match(/(?:badge|employee[\s_-]?id)[:\s#]+(\d{4,12})/i);
                    if (match) {
                        console.log('[FC Badge Manager] Found via text scan:', match[1]);
                        return { id: match[1], login: '', whid: '' };
                    }
                }
                // If found in header, don't scan the whole body
                if (area !== document.body) break;
            }

            return null;
        }

        // --- Strategy 5: URL parameters (some FC tools pass badge in URL) ---
        function readFromURL() {
            const params = new URLSearchParams(window.location.search);
            const candidates = ['badge', 'badgeId', 'employeeId', 'employee_id'];
            for (const key of candidates) {
                const val = params.get(key);
                if (val && /^\d{4,12}$/.test(val)) {
                    console.log('[FC Badge Manager] Found via URL param:', key, '=', val);
                    return { id: val, login: '', whid: '' };
                }
            }
            return null;
        }

        // --- Main detection logic ---
        function trySaveBadge() {
            const result =
                readFromCookies() ||
                readFromPageVars() ||
                readFromStorage() ||
                readFromURL() ||
                readFromDOM();

            if (result && result.id) {
                const prev = GM_getValue('BADGE_ID', '');
                GM_setValue('BADGE_ID',    result.id);
                GM_setValue('BADGE_LOGIN', result.login || '');
                GM_setValue('BADGE_WHID',  result.whid || '');
                GM_setValue('BADGE_TIME',  Date.now());

                console.log('[FC Badge Manager] Saved:', result);

                // Only show panel if badge is new or changed (not on every refresh)
                if (!prev || prev !== result.id) {
                    createPanel(result.id, result.login, result.whid, 'success');
                    console.log('[FC Badge Manager] Badge changed from', prev || '(none)', 'to', result.id);
                }
                return true;
            }
            return false;
        }

        function initFCR() {
            console.log('[FC Badge Manager] FCResearch detected:', currentURL);

            // Try immediately
            if (trySaveBadge()) return;

            // Poll for up to 15s
            let attempts = 0;
            const maxAttempts = 50; // 50 x 300ms = 15s
            const pollInterval = setInterval(() => {
                attempts++;
                if (trySaveBadge()) {
                    clearInterval(pollInterval);
                } else if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    console.warn('[FC Badge Manager] Could not find badge after 15s.');
                    createPanel('', '', '', 'error');
                }
            }, 300);
        }

        initFCR();
    }

    // ═══════════════════════════════════════════════════════
    //  BARCODE GENERATOR: AUTO-POPULATE
    // ═══════════════════════════════════════════════════════

    if (isBarcodeGen) {
        const bgBadge = GM_getValue('BADGE_ID',    '');
        const bgLogin = GM_getValue('BADGE_LOGIN', '');
        const bgWhid  = GM_getValue('BADGE_WHID',  '');
        const bgTime  = GM_getValue('BADGE_TIME',  0);

        console.log('[FC Badge Manager] Barcode page. Badge:', bgBadge, '| Login:', bgLogin);

        function fillField(field, value) {
            // Set value using native setter for framework compatibility
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(field, value);
            } else {
                field.value = value;
            }

            // Style as auto-filled
            field.readOnly = true;
            field.style.backgroundColor = '#e8f5e9';
            field.style.border = '2px solid #4caf50';
            field.style.cursor = 'not-allowed';
            field.style.color = '#1b5e20';
            field.style.fontWeight = '700';
            field.title = `Auto-filled by FC Badge Manager (${value})`;

            // Dispatch events for all frameworks
            field.dispatchEvent(new Event('input',  { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            field.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
            field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        }

        function findBadgeField() {
            const selectors = [
                'input[id*="badge" i]',
                'input[name*="badge" i]',
                'input[placeholder*="badge" i]',
                'input[placeholder*="scan" i]',
                'input[id*="employee" i]',
                'input[name*="employee" i]',
                'input[id*="badgeid" i]',
                'input[name*="badgeid" i]',
                'input[aria-label*="badge" i]',
                'input[type="text"]:first-of-type', // last resort — first text input
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            return null;
        }

        function tryPopulate() {
            const field = findBadgeField();
            if (field && bgBadge) {
                fillField(field, bgBadge);
                console.log('[FC Badge Manager] Field populated:', bgBadge);

                // Show how old the badge data is
                const age = bgTime ? Math.round((Date.now() - bgTime) / 60000) : 0;
                const ageStr = age < 1 ? 'just now' : age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                createPanel(bgBadge, bgLogin, bgWhid, 'success');
                return true;
            }
            return false;
        }

        function initBG() {
            if (!bgBadge) {
                console.warn('[FC Badge Manager] No badge saved. Visit FCResearch first.');
                createPanel('', '', '', 'warning');
                return;
            }

            // Try immediately
            if (tryPopulate()) return;

            // Poll + MutationObserver
            let found = false;
            const pollInterval = setInterval(() => {
                if (tryPopulate()) {
                    found = true;
                    clearInterval(pollInterval);
                    observer.disconnect();
                }
            }, 300);

            const observer = new MutationObserver(() => {
                if (!found && tryPopulate()) {
                    found = true;
                    clearInterval(pollInterval);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // Give up after 10s
            setTimeout(() => {
                if (!found) {
                    clearInterval(pollInterval);
                    observer.disconnect();
                    console.warn('[FC Badge Manager] Could not find badge input after 10s.');
                    createPanel(bgBadge, bgLogin, bgWhid, 'error');
                }
            }, 10000);
        }

        initBG();
    }

})();
