// ==UserScript==
// @name         Idle Time Dashboard
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Standalone idle time dashboard for FCLM portal — tracks AA idle time, break misuse, bottom 8% JPH, top 8% break offenders with timestamps
// @author       joyhjoe
// @match        https://fclm-portal-dub.dub.proxy.amazon.com/*
// @match        https://fclm-portal.amazon.com/*
// @icon         https://cdn-icons-png.flaticon.com/512/1827/1827379.png
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      fclm-portal-dub.dub.proxy.amazon.com
// @connect      fclm-portal.amazon.com
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: CONFIGURATION & DEFAULTS
    // ═══════════════════════════════════════════════════════════════

    const VERSION = '1.0';
    const BASE_URL = location.origin; // Auto-detect: works on both fclm-portal.amazon.com and fclm-portal-dub.dub.proxy.amazon.com

    const DEFAULT_SETTINGS = {
        shiftStart: '18:15',
        shiftEnd: '04:45',
        break1Start: '22:15',
        break1End: '22:45',
        break2Start: '02:15',
        break2End: '02:45',
        bufferMinutes: 3,
        breakMisuseThreshold: 15,
        percentileThreshold: 8,
        concurrencyLimit: 10,
        warehouseId: 'EMA4',
        shiftPreset: 'night'
    };

    let settings = {};
    let scanResults = [];
    let isScanning = false;

    // ═══════════════════════════════════════════════════════════════
    // SECTION 2: SETTINGS PERSISTENCE
    // ═══════════════════════════════════════════════════════════════

    function loadSettings() {
        try {
            const saved = GM_getValue('idleDashSettings', null);
            settings = saved ? JSON.parse(saved) : { ...DEFAULT_SETTINGS };
        } catch {
            settings = { ...DEFAULT_SETTINGS };
        }

        // Auto-detect from current URL params if on functionRollup page
        if (location.pathname.includes('/reports/functionRollup')) {
            const params = new URLSearchParams(location.search);
            if (params.get('warehouseId')) settings.warehouseId = params.get('warehouseId');
            if (params.get('startHourIntraday') && params.get('startMinuteIntraday')) {
                settings.shiftStart = String(params.get('startHourIntraday')).padStart(2, '0') + ':' + String(params.get('startMinuteIntraday')).padStart(2, '0');
            }
            if (params.get('endHourIntraday') && params.get('endMinuteIntraday')) {
                settings.shiftEnd = String(params.get('endHourIntraday')).padStart(2, '0') + ':' + String(params.get('endMinuteIntraday')).padStart(2, '0');
            }
        }
    }

    function saveSettings() {
        GM_setValue('idleDashSettings', JSON.stringify(settings));
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3: UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function gmFetch(url, timeout = 10000) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Cache-Control': 'no-cache'
                },
                timeout: timeout,
                onload(r) { resolve(r.responseText); },
                onerror(e) { reject(new Error('Network error: ' + (e.statusText || 'unknown'))); },
                ontimeout() { reject(new Error('Request timed out')); }
            });
        });
    }

    async function fetchWithConcurrency(tasks, limit) {
        const results = [];
        let index = 0;
        let completed = 0;
        const total = tasks.length;

        async function worker() {
            while (index < tasks.length) {
                const i = index++;
                try {
                    results[i] = await tasks[i]();
                } catch (e) {
                    results[i] = null;
                }
                completed++;
                updateProgress(completed, total);
            }
        }

        const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
        await Promise.all(workers);
        return results;
    }

    function parseTime(timeStr) {
        // Parse "HH:MM" to {h, m} object
        const [h, m] = timeStr.split(':').map(Number);
        return { h, m };
    }

    function timeToMinutes(timeStr) {
        const { h, m } = parseTime(timeStr);
        return h * 60 + m;
    }

    function minutesToTimeStr(totalMin) {
        const h = Math.floor(totalMin / 60) % 24;
        const m = totalMin % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    function normalizeMinutes(min) {
        // Normalize to 0-1440 range relative to shift start for overnight handling
        return ((min % 1440) + 1440) % 1440;
    }

    function getShiftDates() {
        // Build start/end Date objects accounting for overnight shift
        const now = new Date();
        const hour = now.getHours();
        const shiftStart = parseTime(settings.shiftStart);
        const shiftEnd = parseTime(settings.shiftEnd);

        let startDate, endDate;

        if (hour >= shiftStart.h) {
            // Currently in evening portion of shift
            startDate = new Date(now);
            endDate = new Date(now);
            endDate.setDate(endDate.getDate() + 1);
        } else if (hour < shiftEnd.h + 1) {
            // Currently in early morning portion of shift
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 1);
            endDate = new Date(now);
        } else {
            // Daytime — default to upcoming night shift
            startDate = new Date(now);
            endDate = new Date(now);
            endDate.setDate(endDate.getDate() + 1);
        }

        startDate.setHours(shiftStart.h, shiftStart.m, 0, 0);
        endDate.setHours(shiftEnd.h, shiftEnd.m, 0, 0);

        return { startDate, endDate };
    }

    function formatDateForUrl(date) {
        // Format: YYYY/MM/DD HH:MM (URL encoded)
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        return `${y}/${mo}/${d} ${h}:${mi}`;
    }

    function timestampToDate(tsStr, shiftDates) {
        // Parse "MM/DD-HH:MM:SS" format from timeDetails page
        const match = tsStr.match(/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})/);
        if (!match) return null;
        const [, month, day, hour, minute, second] = match.map(Number);

        const year = hour >= parseTime(settings.shiftStart).h
            ? shiftDates.startDate.getFullYear()
            : shiftDates.endDate.getFullYear();

        return new Date(year, month - 1, day, hour, minute, second);
    }

    function parseDuration(durationStr) {
        // Parse "MM:SS" or "H:MM:SS" to minutes
        if (!durationStr || !durationStr.includes(':')) return 0;
        const parts = durationStr.trim().split(':').map(Number);
        if (parts.length === 3) {
            return parts[0] * 60 + parts[1] + parts[2] / 60;
        } else if (parts.length === 2) {
            return parts[0] + parts[1] / 60;
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: FETCH AA LIST + JPH FROM functionRollup
    // ═══════════════════════════════════════════════════════════════

    async function fetchAAList() {
        setStatus('Fetching AA list from functionRollup...', '#3498db');

        let html;

        // If we're already on functionRollup, use current page DOM directly
        if (location.pathname.includes('/reports/functionRollup') && document.querySelector('table[id^=function]')) {
            html = document.documentElement.outerHTML;
        } else {
            const { startDate, endDate } = getShiftDates();
            const startStr = encodeURIComponent(formatDateForUrl(startDate));
            const endStr = encodeURIComponent(formatDateForUrl(endDate));
            const url = `${BASE_URL}/reports/functionRollup?warehouseId=${settings.warehouseId}&spanType=Intraday&startTime=${startStr}&endTime=${endStr}`;
            html = await gmFetch(url, 15000);
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');

        const tables = doc.querySelectorAll('table[id^=function]');
        if (tables.length === 0) {
            throw new Error('No function tables found on functionRollup page. Check shift times and warehouse ID.');
        }

        const aaList = [];
        const seen = new Set();

        tables.forEach(table => {
            // Find JPH column index from header
            const headers = table.querySelectorAll('thead th, thead td');
            let jphColIdx = -1;
            headers.forEach((th, idx) => {
                const text = th.textContent.trim().toLowerCase();
                if (text === 'jph' || text === 'uph' || text.includes('jobs per hour') || text.includes('units per hour')) {
                    jphColIdx = idx;
                }
            });

            const rows = table.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const link = row.querySelector('a[href*="employeeId"]') || row.querySelector('td:nth-child(2) a');
                if (!link) return;

                const href = link.href || link.getAttribute('href') || '';
                const eidMatch = href.match(/employeeId=([^&]+)/);
                if (!eidMatch) return;

                const employeeId = eidMatch[1];
                if (seen.has(employeeId)) return;
                seen.add(employeeId);

                const name = link.textContent.trim();
                let jph = 0;

                if (jphColIdx >= 0) {
                    const cells = row.querySelectorAll('td');
                    if (cells[jphColIdx]) {
                        jph = parseFloat(cells[jphColIdx].textContent.trim()) || 0;
                    }
                }

                // Also try to extract from the timeDetails link for later use
                const timeDetailsHref = href.includes('timeDetails') ? href : null;

                aaList.push({ employeeId, name, jph, timeDetailsHref });
            });
        });

        if (aaList.length === 0) {
            throw new Error('No associates found in functionRollup tables.');
        }

        setStatus(`Found ${aaList.length} associates`, '#27ae60');
        return aaList;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 5: CONCURRENT timeDetails FETCHER
    // ═══════════════════════════════════════════════════════════════

    async function fetchAllTimeDetails(aaList) {
        setStatus(`Fetching time details for ${aaList.length} associates...`, '#3498db');
        showProgress(0, aaList.length);

        const { startDate, endDate } = getShiftDates();
        const startStr = encodeURIComponent(formatDateForUrl(startDate));
        const endStr = encodeURIComponent(formatDateForUrl(endDate));

        const tasks = aaList.map(aa => {
            return async () => {
                const url = aa.timeDetailsHref
                    ? (aa.timeDetailsHref.startsWith('http') ? aa.timeDetailsHref : BASE_URL + aa.timeDetailsHref)
                    : `${BASE_URL}/employee/timeDetails?employeeId=${aa.employeeId}&warehouseId=${settings.warehouseId}&startTime=${startStr}&endTime=${endStr}`;

                try {
                    const html = await gmFetch(url, 12000);
                    return { employeeId: aa.employeeId, html };
                } catch (e) {
                    console.warn(`[IdleDash] Failed to fetch timeDetails for ${aa.employeeId}:`, e.message);
                    return { employeeId: aa.employeeId, html: null };
                }
            };
        });

        return await fetchWithConcurrency(tasks, settings.concurrencyLimit);
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 6: PARSE IDLE SEGMENTS FROM timeDetails HTML
    // ═══════════════════════════════════════════════════════════════

    function parseIdleSegments(html) {
        if (!html) return [];

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const segments = [];
        const shiftDates = getShiftDates();

        // Parse .editable rows — these are idle/indirect segments
        const editableElements = doc.querySelectorAll('.editable');

        editableElements.forEach(item => {
            const row = item.closest('tr') || item.parentNode?.parentNode;
            if (!row) return;
            if (row.classList.contains('edited')) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 4) return;

            // Column 0: Process/function name
            const process = cells[0] ? cells[0].textContent.trim() : '';

            // Column 2 (or 1): Time range — contains "MM/DD-HH:MM:SS to MM/DD-HH:MM:SS" or similar
            let timeCell = null;
            for (let i = 1; i < cells.length; i++) {
                const text = cells[i].textContent.trim();
                if (text.match(/\d{2}\/\d{2}-\d{2}:\d{2}:\d{2}/)) {
                    timeCell = cells[i];
                    break;
                }
            }

            // Duration from .rightAlign cell
            const durationCell = row.querySelector('.rightAlign');
            const durationStr = durationCell ? durationCell.textContent.trim() : '';
            const durationMinutes = parseDuration(durationStr);

            if (durationMinutes <= 0) return;

            // Parse start/end times
            let startTime = null, endTime = null;
            if (timeCell) {
                const timeText = timeCell.textContent.trim();
                const timestamps = timeText.match(/(\d{2}\/\d{2}-\d{2}:\d{2}:\d{2})/g);
                if (timestamps && timestamps.length >= 1) {
                    startTime = timestampToDate(timestamps[0], shiftDates);
                    if (timestamps.length >= 2) {
                        endTime = timestampToDate(timestamps[1], shiftDates);
                    }
                }
            }

            // If we have start but no end, calculate from duration
            if (startTime && !endTime) {
                endTime = new Date(startTime.getTime() + durationMinutes * 60000);
            }

            if (startTime && endTime && durationMinutes > 0) {
                segments.push({
                    start: startTime,
                    end: endTime,
                    duration: durationMinutes,
                    process: process
                });
            }
        });

        return segments;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 7: BREAK EXCLUSION + BREAK MISUSE DETECTION
    // ═══════════════════════════════════════════════════════════════

    function getBreakWindows() {
        const { startDate, endDate } = getShiftDates();
        const buf = settings.bufferMinutes;

        function buildBreakWindow(breakStartStr, breakEndStr) {
            const bs = parseTime(breakStartStr);
            const be = parseTime(breakEndStr);

            // Determine if break is before or after midnight
            let breakStartDate, breakEndDate;
            if (bs.h >= parseTime(settings.shiftStart).h) {
                breakStartDate = new Date(startDate);
            } else {
                breakStartDate = new Date(endDate);
            }
            if (be.h >= parseTime(settings.shiftStart).h) {
                breakEndDate = new Date(startDate);
            } else {
                breakEndDate = new Date(endDate);
            }

            breakStartDate.setHours(bs.h, bs.m, 0, 0);
            breakEndDate.setHours(be.h, be.m, 0, 0);

            // Apply buffer
            const windowStart = new Date(breakStartDate.getTime() - buf * 60000);
            const windowEnd = new Date(breakEndDate.getTime() + buf * 60000);

            // Actual break times (without buffer) for misuse calculation
            return {
                windowStart,
                windowEnd,
                breakStart: breakStartDate,
                breakEnd: breakEndDate,
                scheduledDuration: (breakEndDate - breakStartDate) / 60000 // e.g. 30 min
            };
        }

        return {
            break1: buildBreakWindow(settings.break1Start, settings.break1End),
            break2: buildBreakWindow(settings.break2Start, settings.break2End)
        };
    }

    function segmentOverlap(segStart, segEnd, winStart, winEnd) {
        // Returns the overlap in minutes between two time ranges
        const overlapStart = Math.max(segStart.getTime(), winStart.getTime());
        const overlapEnd = Math.min(segEnd.getTime(), winEnd.getTime());
        if (overlapEnd <= overlapStart) return 0;
        return (overlapEnd - overlapStart) / 60000;
    }

    function analyzeBreaks(segments) {
        const breakWindows = getBreakWindows();
        const threshold = settings.breakMisuseThreshold;

        let totalIdleMinutes = 0;
        let break1IdleMinutes = 0;
        let break2IdleMinutes = 0;
        let nonBreakIdleMinutes = 0;

        // Track timestamps of idle segments >15 min (non-break)
        const idleTimestamps15 = [];
        const idleTimestamps30 = [];

        // Track break misuse details
        let break1ReturnTime = null;
        let break2ReturnTime = null;
        let break1Excess = 0;
        let break2Excess = 0;

        segments.forEach(seg => {
            const segDuration = seg.duration;
            totalIdleMinutes += segDuration;

            // Calculate overlap with each break window
            const overlap1 = segmentOverlap(seg.start, seg.end, breakWindows.break1.windowStart, breakWindows.break1.windowEnd);
            const overlap2 = segmentOverlap(seg.start, seg.end, breakWindows.break2.windowStart, breakWindows.break2.windowEnd);

            break1IdleMinutes += overlap1;
            break2IdleMinutes += overlap2;

            const nonBreakPortion = segDuration - overlap1 - overlap2;
            if (nonBreakPortion > 0) {
                nonBreakIdleMinutes += nonBreakPortion;

                // Track non-break idle segments exceeding thresholds
                if (nonBreakPortion > 15) {
                    idleTimestamps15.push({
                        start: seg.start,
                        end: seg.end,
                        duration: nonBreakPortion,
                        process: seg.process
                    });
                }
                if (nonBreakPortion > 30) {
                    idleTimestamps30.push({
                        start: seg.start,
                        end: seg.end,
                        duration: nonBreakPortion,
                        process: seg.process
                    });
                }
            }

            // Check for break misuse — if segment ends after break window end, that's the return time
            if (overlap1 > 0 && seg.end > breakWindows.break1.windowEnd) {
                const returnAfter = (seg.end - breakWindows.break1.breakEnd) / 60000;
                if (returnAfter > 0 && (!break1ReturnTime || seg.end > break1ReturnTime)) {
                    break1ReturnTime = seg.end;
                    break1Excess = returnAfter;
                }
            }
            if (overlap2 > 0 && seg.end > breakWindows.break2.windowEnd) {
                const returnAfter = (seg.end - breakWindows.break2.breakEnd) / 60000;
                if (returnAfter > 0 && (!break2ReturnTime || seg.end > break2ReturnTime)) {
                    break2ReturnTime = seg.end;
                    break2Excess = returnAfter;
                }
            }
        });

        // Break misuse: if total break idle exceeds scheduled break + buffer threshold
        const break1Misuse = break1IdleMinutes > (breakWindows.break1.scheduledDuration + settings.bufferMinutes + threshold);
        const break2Misuse = break2IdleMinutes > (breakWindows.break2.scheduledDuration + settings.bufferMinutes + threshold);

        // Also check: if idle during break window is > threshold minutes beyond scheduled break
        const break1ExcessTotal = Math.max(0, break1IdleMinutes - breakWindows.break1.scheduledDuration);
        const break2ExcessTotal = Math.max(0, break2IdleMinutes - breakWindows.break2.scheduledDuration);

        return {
            totalIdleMinutes: Math.round(totalIdleMinutes * 100) / 100,
            break1IdleMinutes: Math.round(break1IdleMinutes * 100) / 100,
            break2IdleMinutes: Math.round(break2IdleMinutes * 100) / 100,
            nonBreakIdleMinutes: Math.round(nonBreakIdleMinutes * 100) / 100,
            break1Misuse,
            break2Misuse,
            break1ReturnTime,
            break2ReturnTime,
            break1Excess: Math.round(break1ExcessTotal * 100) / 100,
            break2Excess: Math.round(break2ExcessTotal * 100) / 100,
            idleTimestamps15,
            idleTimestamps30,
            isBreakOffender: break1Misuse || break2Misuse || nonBreakIdleMinutes > threshold
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 8: CALCULATE THRESHOLDS (Bottom 8% JPH, Top 8% Offenders)
    // ═══════════════════════════════════════════════════════════════

    function calculateThresholds(aaList) {
        const count = aaList.length;
        const pct = settings.percentileThreshold / 100;
        const bottomN = Math.max(1, Math.ceil(count * pct));

        // Bottom 8% by JPH (lowest JPH)
        const byJPH = [...aaList].filter(a => a.jph !== undefined).sort((a, b) => a.jph - b.jph);
        const bottomJPH = byJPH.slice(0, bottomN);
        const jphCutoff = bottomJPH.length > 0 ? bottomJPH[bottomJPH.length - 1].jph : 0;

        // Top 8% break offenders (highest non-break idle)
        const byIdle = [...aaList]
            .filter(a => a.analysis && a.analysis.nonBreakIdleMinutes > settings.breakMisuseThreshold)
            .sort((a, b) => b.analysis.nonBreakIdleMinutes - a.analysis.nonBreakIdleMinutes);
        const topBreakOffenders = byIdle.slice(0, Math.max(1, Math.ceil(byIdle.length * pct)));
        const breakCutoff = topBreakOffenders.length > 0
            ? topBreakOffenders[topBreakOffenders.length - 1].analysis.nonBreakIdleMinutes
            : 0;

        // Tag each AA
        const bottomIds = new Set(bottomJPH.map(a => a.employeeId));
        const offenderIds = new Set(topBreakOffenders.map(a => a.employeeId));

        aaList.forEach(aa => {
            aa.isBottomJPH = bottomIds.has(aa.employeeId);
            aa.isTopBreakOffender = offenderIds.has(aa.employeeId);
            aa.isHighlighted = aa.isBottomJPH || aa.isTopBreakOffender;
        });

        return { bottomJPH, topBreakOffenders, jphCutoff, breakCutoff, bottomN };
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 9: STYLES
    // ═══════════════════════════════════════════════════════════════

    GM_addStyle(`
        #idle-dash-panel {
            position: fixed;
            top: 60px;
            right: 20px;
            z-index: 999999;
            width: 420px;
            max-height: 90vh;
            background: #fff;
            border: 2px solid #2c3e50;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,.2);
            font: 12px 'Segoe UI', sans-serif;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        #idle-dash-panel.expanded {
            width: 900px;
        }
        /* Collapsed = compact pill so it does not cover the page UI */
        #idle-dash-panel.collapsed {
            width: 230px;
            max-height: 44px;
            border-radius: 22px;
        }
        #idle-dash-panel.collapsed #idle-dash-body { display: none !important; }
        #idle-dash-panel.collapsed #idle-dash-hdr { border-radius: 20px; padding: 9px 14px; cursor: pointer; }
        #idle-dash-panel.collapsed #idash-expand-btn { display: none; }
        #idle-dash-hdr {
            background: linear-gradient(135deg, #2c3e50, #34495e);
            color: #fff;
            padding: 10px 14px;
            font: 700 14px 'Segoe UI', sans-serif;
            cursor: move;
            user-select: none;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        #idle-dash-hdr .title-area { display: flex; align-items: center; gap: 8px; }
        #idle-dash-hdr .btn-area { display: flex; gap: 6px; }
        #idle-dash-hdr button {
            background: rgba(255,255,255,.15);
            border: none;
            color: #fff;
            border-radius: 4px;
            padding: 3px 8px;
            cursor: pointer;
            font: 12px 'Segoe UI';
        }
        #idle-dash-hdr button:hover { background: rgba(255,255,255,.3); }
        #idle-dash-body {
            padding: 10px 12px;
            overflow-y: auto;
            max-height: calc(90vh - 50px);
            flex: 1;
        }
        .idash-section { margin-bottom: 10px; }
        .idash-section-title {
            font: 700 12px 'Segoe UI';
            color: #2c3e50;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
        }
        .idash-section-title:hover { color: #3498db; }
        .idash-settings-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .idash-settings-grid label {
            display: flex;
            flex-direction: column;
            font: 11px 'Segoe UI';
            color: #555;
        }
        .idash-settings-grid input, .idash-settings-grid select {
            padding: 4px 6px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font: 11px monospace;
            margin-top: 2px;
        }
        .idash-btn {
            padding: 8px 14px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font: 600 12px 'Segoe UI';
            transition: all .2s;
        }
        .idash-btn-primary { background: #27ae60; color: #fff; }
        .idash-btn-primary:hover { background: #219a52; }
        .idash-btn-secondary { background: #3498db; color: #fff; }
        .idash-btn-secondary:hover { background: #2980b9; }
        .idash-btn-danger { background: #e74c3c; color: #fff; }
        .idash-btn-small { padding: 4px 8px; font-size: 10px; }
        .idash-btn:disabled { opacity: .5; cursor: not-allowed; }
        #idle-dash-status {
            padding: 6px 10px;
            border-radius: 5px;
            font: 600 11px 'Segoe UI';
            text-align: center;
            background: #f8f9fa;
            color: #7f8c8d;
            margin-bottom: 8px;
        }
        #idle-dash-progress {
            height: 4px;
            background: #ecf0f1;
            border-radius: 2px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        #idle-dash-progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #3498db, #2ecc71);
            width: 0%;
            transition: width .3s;
        }
        .idash-table-wrap {
            overflow-x: auto;
            max-height: 400px;
            overflow-y: auto;
            border: 1px solid #eee;
            border-radius: 6px;
        }
        .idash-table {
            width: 100%;
            border-collapse: collapse;
            font: 11px 'Segoe UI';
        }
        .idash-table th {
            background: #f8f9fa;
            padding: 6px 8px;
            text-align: left;
            font-weight: 700;
            border-bottom: 2px solid #ddd;
            position: sticky;
            top: 0;
            cursor: pointer;
            white-space: nowrap;
            user-select: none;
        }
        .idash-table th:hover { background: #e8f4fd; }
        .idash-table td {
            padding: 5px 8px;
            border-bottom: 1px solid #f0f0f0;
            white-space: nowrap;
        }
        .idash-table tr:hover td { background: #f0f8ff; }
        .idash-table tr.row-bottom-jph td { background: #fde2e2; }
        .idash-table tr.row-break-offender td { background: #fff3e0; }
        .idash-table tr.row-both td { background: #fce4ec; }
        .idash-summary {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            margin-bottom: 10px;
        }
        .idash-summary-card {
            background: #f8f9fa;
            border-radius: 6px;
            padding: 8px;
            text-align: center;
        }
        .idash-summary-card .num {
            font: 700 18px 'Segoe UI';
            color: #2c3e50;
        }
        .idash-summary-card .label {
            font: 11px 'Segoe UI';
            color: #7f8c8d;
        }
        .idash-filters {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .idash-filter-btn {
            padding: 4px 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            background: #fff;
            cursor: pointer;
            font: 11px 'Segoe UI';
            transition: all .15s;
        }
        .idash-filter-btn:hover { border-color: #3498db; color: #3498db; }
        .idash-filter-btn.active { background: #3498db; color: #fff; border-color: #3498db; }
        .idash-timestamps {
            font: 10px monospace;
            color: #e74c3c;
            max-width: 180px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .idash-collapse { display: none; }
        .idash-collapse.show { display: block; }
        .idash-badge {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 3px;
            font: 600 9px 'Segoe UI';
            color: #fff;
        }
        .idash-badge-red { background: #e74c3c; }
        .idash-badge-orange { background: #f39c12; }
        .sort-arrow { font-size: 9px; margin-left: 3px; }

        /* ── In-page table enhancement styles (merged from idle-time.user.js) ── */
        .transfer-button {
            background-color: #0066cc; color: #fff; border: none; border-radius: 3px;
            padding: 1px 4px; cursor: pointer; margin-left: 3px; font-size: 11px;
            vertical-align: middle; min-width: 40px; font-weight: normal;
        }
        .idle-time-cell { font-size: 11px; vertical-align: middle; white-space: nowrap; }
        .transfer-time-cell { display: flex; align-items: center; white-space: nowrap; max-width: 120px; }
        .transfer-time-display { display: inline-block; margin-right: 3px; }
        .transfer-summary-button {
            position: fixed; top: 20px; right: 20px; background-color: #0066cc; color: #fff;
            border: none; border-radius: 5px; padding: 10px 20px; cursor: pointer;
            z-index: 1000; font-weight: bold;
        }
        .transfer-summary-modal {
            display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background-color: #fff; padding: 20px; border-radius: 5px; box-shadow: 0 2px 10px rgba(0,0,0,.2);
            z-index: 1000001; max-height: 80vh; overflow-y: auto; min-width: 600px;
        }
        .transfer-summary-modal.show { display: block; }
        .modal-backdrop {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,.5); z-index: 1000000;
        }
        .modal-backdrop.show { display: block; }
        .transfer-summary-header { font-size: 18px; font-weight: bold; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #ddd; }
        .transfer-summary-content { margin-bottom: 15px; }
        .transfer-detail-item { padding: 8px; border-bottom: 1px solid #eee; margin-bottom: 10px; }
        .transfer-detail-item:nth-child(odd) { background-color: #f9f9f9; }
        .transfer-miss { color: red; margin-left: 15px; padding: 3px 0; }
        .close-modal-button { position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 20px; cursor: pointer; }
        .total-misses { font-size: 16px; font-weight: bold; margin-bottom: 15px; padding: 10px; background-color: #f0f0f0; border-radius: 5px; text-align: center; }
        .manager-section { margin-bottom: 20px; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
        .manager-header { font-size: 16px; font-weight: bold; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 2px solid #0066cc; color: #0066cc; }
        .transfer-details {
            display: none; position: absolute; background-color: #fff; border: 1px solid #ddd;
            padding: 10px; box-shadow: 0 2px 5px rgba(0,0,0,.2); z-index: 1000; font-size: 12px; min-width: 150px;
        }
        .transfer-details.show { display: block; }
        .sort-button {
            background: none; border: none; cursor: pointer; font-weight: bold; padding: 5px;
            width: 100%; text-align: left; display: flex; align-items: center; justify-content: space-between; font-size: 11px;
        }
        .sort-button:hover { background-color: #f0f0f0; }
        .sort-button.active { color: #0066cc; }
        .sort-icon { display: inline-block; width: 12px; height: 12px; margin-left: 5px; }
        .sort-button.desc .sort-icon::after { content: '\\25BC'; }
        .sort-button.asc .sort-icon::after { content: '\\25B2'; }
    `);

    // ═══════════════════════════════════════════════════════════════
    // SECTION 10: UI CONSTRUCTION
    // ═══════════════════════════════════════════════════════════════

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'idle-dash-panel';
        panel.className = 'collapsed';
        panel.innerHTML = `
            <div id="idle-dash-hdr">
                <div class="title-area">
                    <span>\u23F1 Idle Time Dashboard v${VERSION}</span>
                </div>
                <div class="btn-area">
                    <button id="idash-expand-btn" title="Expand/Collapse width">\u2194</button>
                    <button id="idash-min-btn" title="Minimize">\u2212</button>
                </div>
            </div>
            <div id="idle-dash-body">
                <div id="idle-dash-status">Ready — Configure settings and click Start Scan</div>
                <div id="idle-dash-progress"><div id="idle-dash-progress-fill"></div></div>

                <!-- Settings Section -->
                <div class="idash-section">
                    <div class="idash-section-title" id="idash-settings-toggle">\u2699 Settings <span style="font-weight:400;font-size:10px">(click to toggle)</span></div>
                    <div class="idash-collapse" id="idash-settings-content">
                        <div class="idash-settings-grid">
                            <label>Shift Preset
                                <select id="idash-preset">
                                    <option value="night">Night (18:15–04:45)</option>
                                    <option value="custom">Custom</option>
                                </select>
                            </label>
                            <label>Warehouse ID
                                <input id="idash-warehouse" type="text" value="${settings.warehouseId}">
                            </label>
                            <label>Shift Start
                                <input id="idash-shift-start" type="text" value="${settings.shiftStart}" placeholder="HH:MM">
                            </label>
                            <label>Shift End
                                <input id="idash-shift-end" type="text" value="${settings.shiftEnd}" placeholder="HH:MM">
                            </label>
                            <label>Break 1 Start
                                <input id="idash-break1-start" type="text" value="${settings.break1Start}" placeholder="HH:MM">
                            </label>
                            <label>Break 1 End
                                <input id="idash-break1-end" type="text" value="${settings.break1End}" placeholder="HH:MM">
                            </label>
                            <label>Break 2 Start
                                <input id="idash-break2-start" type="text" value="${settings.break2Start}" placeholder="HH:MM">
                            </label>
                            <label>Break 2 End
                                <input id="idash-break2-end" type="text" value="${settings.break2End}" placeholder="HH:MM">
                            </label>
                            <label>Buffer (min)
                                <input id="idash-buffer" type="number" value="${settings.bufferMinutes}" min="0" max="15">
                            </label>
                            <label>Idle Threshold (min)
                                <input id="idash-threshold" type="number" value="${settings.breakMisuseThreshold}" min="1" max="60">
                            </label>
                            <label>Percentile (%)
                                <input id="idash-percentile" type="number" value="${settings.percentileThreshold}" min="1" max="50">
                            </label>
                            <label>Concurrency
                                <input id="idash-concurrency" type="number" value="${settings.concurrencyLimit}" min="1" max="30">
                            </label>
                        </div>
                        <div style="margin-top:8px;display:flex;gap:6px">
                            <button class="idash-btn idash-btn-secondary idash-btn-small" id="idash-save-settings">Save Settings</button>
                            <button class="idash-btn idash-btn-small" id="idash-reset-settings" style="background:#95a5a6;color:#fff">Reset Defaults</button>
                        </div>
                    </div>
                </div>

                <!-- Action Buttons -->
                <div style="display:flex;gap:8px;margin-bottom:10px">
                    <button class="idash-btn idash-btn-primary" id="idash-start-btn">\u25B6 Start Scan</button>
                    <button class="idash-btn idash-btn-danger" id="idash-stop-btn" disabled>\u25A0 Stop</button>
                    <button class="idash-btn idash-btn-secondary idash-btn-small" id="idash-export-btn" disabled>\u{1F4CB} CSV</button>
                </div>

                <!-- Results Section -->
                <div id="idash-results" style="display:none">
                    <div class="idash-summary" id="idash-summary"></div>
                    <div class="idash-filters" id="idash-filters"></div>
                    <div class="idash-table-wrap" id="idash-table-wrap"></div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        setupPanelInteractions(panel);
    }

    function setupPanelInteractions(panel) {
        // Draggable
        const hdr = document.getElementById('idle-dash-hdr');
        let dragging = false, dx = 0, dy = 0;
        hdr.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            dx = e.clientX - panel.offsetLeft;
            dy = e.clientY - panel.offsetTop;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - dx) + 'px';
            panel.style.top = (e.clientY - dy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // Minimize / expand toggle (collapsed pill <-> full panel)
        document.getElementById('idash-min-btn').onclick = (e) => {
            e.stopPropagation();
            const btn = document.getElementById('idash-min-btn');
            const isCollapsed = panel.classList.toggle('collapsed');
            btn.textContent = isCollapsed ? '+' : '\u2212';
        };

        // Clicking the collapsed pill header opens the panel
        document.getElementById('idle-dash-hdr').addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                document.getElementById('idash-min-btn').textContent = '\u2212';
            }
        });

        // Expand toggle
        document.getElementById('idash-expand-btn').onclick = () => {
            panel.classList.toggle('expanded');
        };

        // Settings toggle
        document.getElementById('idash-settings-toggle').onclick = () => {
            document.getElementById('idash-settings-content').classList.toggle('show');
        };

        // Save settings
        document.getElementById('idash-save-settings').onclick = () => {
            readSettingsFromUI();
            saveSettings();
            setStatus('Settings saved!', '#27ae60');
        };

        // Reset defaults
        document.getElementById('idash-reset-settings').onclick = () => {
            settings = { ...DEFAULT_SETTINGS };
            saveSettings();
            populateSettingsUI();
            setStatus('Settings reset to defaults', '#f39c12');
        };

        // Start scan
        document.getElementById('idash-start-btn').onclick = () => {
            if (isScanning) return;
            readSettingsFromUI();
            saveSettings();
            runPipeline();
        };

        // Stop scan
        document.getElementById('idash-stop-btn').onclick = () => {
            isScanning = false;
            setStatus('Scan stopped by user', '#e74c3c');
            document.getElementById('idash-start-btn').disabled = false;
            document.getElementById('idash-stop-btn').disabled = true;
        };

        // Export CSV
        document.getElementById('idash-export-btn').onclick = exportCSV;

        // Preset change
        document.getElementById('idash-preset').onchange = (e) => {
            if (e.target.value === 'night') {
                settings.shiftStart = '18:15';
                settings.shiftEnd = '04:45';
                settings.break1Start = '22:15';
                settings.break1End = '22:45';
                settings.break2Start = '02:15';
                settings.break2End = '02:45';
                populateSettingsUI();
            }
        };
    }

    function readSettingsFromUI() {
        settings.warehouseId = document.getElementById('idash-warehouse').value.trim() || 'EMA4';
        settings.shiftStart = document.getElementById('idash-shift-start').value.trim() || '18:15';
        settings.shiftEnd = document.getElementById('idash-shift-end').value.trim() || '04:45';
        settings.break1Start = document.getElementById('idash-break1-start').value.trim() || '22:15';
        settings.break1End = document.getElementById('idash-break1-end').value.trim() || '22:45';
        settings.break2Start = document.getElementById('idash-break2-start').value.trim() || '02:15';
        settings.break2End = document.getElementById('idash-break2-end').value.trim() || '02:45';
        settings.bufferMinutes = parseInt(document.getElementById('idash-buffer').value) || 3;
        settings.breakMisuseThreshold = parseInt(document.getElementById('idash-threshold').value) || 15;
        settings.percentileThreshold = parseInt(document.getElementById('idash-percentile').value) || 8;
        settings.concurrencyLimit = parseInt(document.getElementById('idash-concurrency').value) || 10;
        settings.shiftPreset = document.getElementById('idash-preset').value;
    }

    function populateSettingsUI() {
        const el = id => document.getElementById(id);
        if (el('idash-warehouse')) el('idash-warehouse').value = settings.warehouseId;
        if (el('idash-shift-start')) el('idash-shift-start').value = settings.shiftStart;
        if (el('idash-shift-end')) el('idash-shift-end').value = settings.shiftEnd;
        if (el('idash-break1-start')) el('idash-break1-start').value = settings.break1Start;
        if (el('idash-break1-end')) el('idash-break1-end').value = settings.break1End;
        if (el('idash-break2-start')) el('idash-break2-start').value = settings.break2Start;
        if (el('idash-break2-end')) el('idash-break2-end').value = settings.break2End;
        if (el('idash-buffer')) el('idash-buffer').value = settings.bufferMinutes;
        if (el('idash-threshold')) el('idash-threshold').value = settings.breakMisuseThreshold;
        if (el('idash-percentile')) el('idash-percentile').value = settings.percentileThreshold;
        if (el('idash-concurrency')) el('idash-concurrency').value = settings.concurrencyLimit;
        if (el('idash-preset')) el('idash-preset').value = settings.shiftPreset || 'night';
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 11: STATUS & PROGRESS HELPERS
    // ═══════════════════════════════════════════════════════════════

    function setStatus(msg, color) {
        const el = document.getElementById('idle-dash-status');
        if (el) {
            el.textContent = msg;
            el.style.color = color || '#7f8c8d';
            el.style.background = color ? color + '18' : '#f8f9fa';
        }
    }

    function showProgress(current, total) {
        const fill = document.getElementById('idle-dash-progress-fill');
        if (fill) {
            const pct = total > 0 ? (current / total * 100) : 0;
            fill.style.width = pct + '%';
        }
        setStatus(`Processing ${current} / ${total} associates...`, '#3498db');
    }

    function updateProgress(current, total) {
        showProgress(current, total);
    }

    function resetProgress() {
        const fill = document.getElementById('idle-dash-progress-fill');
        if (fill) fill.style.width = '0%';
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 12: MAIN PIPELINE
    // ═══════════════════════════════════════════════════════════════

    async function runPipeline() {
        if (isScanning) return;
        isScanning = true;

        const startBtn = document.getElementById('idash-start-btn');
        const stopBtn = document.getElementById('idash-stop-btn');
        const exportBtn = document.getElementById('idash-export-btn');
        startBtn.disabled = true;
        stopBtn.disabled = false;
        exportBtn.disabled = true;
        resetProgress();

        document.getElementById('idash-results').style.display = 'none';

        try {
            // Step 1: Fetch AA list
            const aaList = await fetchAAList();
            if (!isScanning) return;

            // Step 2: Fetch all timeDetails
            const timeDetailsResults = await fetchAllTimeDetails(aaList);
            if (!isScanning) return;

            // Step 3: Parse idle segments for each AA
            setStatus('Parsing idle segments...', '#9b59b6');
            aaList.forEach((aa, idx) => {
                const result = timeDetailsResults[idx];
                if (result && result.html) {
                    aa.segments = parseIdleSegments(result.html);
                } else {
                    aa.segments = [];
                }
            });
            if (!isScanning) return;

            // Step 4: Analyze breaks for each AA
            setStatus('Analyzing break patterns...', '#e67e22');
            aaList.forEach(aa => {
                aa.analysis = analyzeBreaks(aa.segments);
            });
            if (!isScanning) return;

            // Step 5: Calculate thresholds
            setStatus('Calculating thresholds...', '#8e44ad');
            const thresholds = calculateThresholds(aaList);

            // Step 6: Render results
            scanResults = aaList;
            renderResults(aaList, thresholds);

            setStatus(`Scan complete — ${aaList.length} associates analyzed`, '#27ae60');
            exportBtn.disabled = false;

        } catch (error) {
            console.error('[IdleDash] Pipeline error:', error);
            setStatus('Error: ' + error.message, '#e74c3c');
        } finally {
            isScanning = false;
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 13: RENDER RESULTS (TABLES, SUMMARY, FILTERS)
    // ═══════════════════════════════════════════════════════════════

    let currentFilter = 'all';
    let currentSort = { col: 'nonBreakIdle', dir: 'desc' };

    function renderResults(aaList, thresholds) {
        const resultsDiv = document.getElementById('idash-results');
        resultsDiv.style.display = 'block';

        // Summary cards
        const avgJPH = aaList.reduce((s, a) => s + (a.jph || 0), 0) / aaList.length;
        const flaggedCount = aaList.filter(a => a.isHighlighted).length;
        const breakOffenders = aaList.filter(a => a.analysis && a.analysis.isBreakOffender).length;

        document.getElementById('idash-summary').innerHTML = `
            <div class="idash-summary-card"><div class="num">${aaList.length}</div><div class="label">Total AAs</div></div>
            <div class="idash-summary-card"><div class="num">${avgJPH.toFixed(1)}</div><div class="label">Avg JPH</div></div>
            <div class="idash-summary-card"><div class="num" style="color:#e74c3c">${thresholds.bottomJPH.length}</div><div class="label">Bottom ${settings.percentileThreshold}% JPH</div></div>
            <div class="idash-summary-card"><div class="num" style="color:#f39c12">${breakOffenders}</div><div class="label">Break Offenders</div></div>
        `;

        // Filters
        document.getElementById('idash-filters').innerHTML = `
            <button class="idash-filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">All (${aaList.length})</button>
            <button class="idash-filter-btn ${currentFilter === 'bottomJPH' ? 'active' : ''}" data-filter="bottomJPH">Bottom ${settings.percentileThreshold}% JPH (${thresholds.bottomJPH.length})</button>
            <button class="idash-filter-btn ${currentFilter === 'breakOffenders' ? 'active' : ''}" data-filter="breakOffenders">Break Offenders (${breakOffenders})</button>
            <button class="idash-filter-btn ${currentFilter === 'flagged' ? 'active' : ''}" data-filter="flagged">Flagged (${flaggedCount})</button>
        `;

        document.querySelectorAll('.idash-filter-btn').forEach(btn => {
            btn.onclick = () => {
                currentFilter = btn.dataset.filter;
                renderResults(aaList, thresholds);
            };
        });

        // Render table
        renderTable(aaList);
    }

    function renderTable(aaList) {
        // Apply filter
        let filtered;
        switch (currentFilter) {
            case 'bottomJPH': filtered = aaList.filter(a => a.isBottomJPH); break;
            case 'breakOffenders': filtered = aaList.filter(a => a.analysis && a.analysis.isBreakOffender); break;
            case 'flagged': filtered = aaList.filter(a => a.isHighlighted); break;
            default: filtered = [...aaList];
        }

        // Apply sort
        filtered.sort((a, b) => {
            let va, vb;
            switch (currentSort.col) {
                case 'name': va = a.name || ''; vb = b.name || ''; return currentSort.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                case 'jph': va = a.jph || 0; vb = b.jph || 0; break;
                case 'totalIdle': va = a.analysis?.totalIdleMinutes || 0; vb = b.analysis?.totalIdleMinutes || 0; break;
                case 'nonBreakIdle': va = a.analysis?.nonBreakIdleMinutes || 0; vb = b.analysis?.nonBreakIdleMinutes || 0; break;
                case 'break1Excess': va = a.analysis?.break1Excess || 0; vb = b.analysis?.break1Excess || 0; break;
                case 'break2Excess': va = a.analysis?.break2Excess || 0; vb = b.analysis?.break2Excess || 0; break;
                case 'idle15': va = a.analysis?.idleTimestamps15?.length || 0; vb = b.analysis?.idleTimestamps15?.length || 0; break;
                default: va = 0; vb = 0;
            }
            if (typeof va === 'string') return 0;
            return currentSort.dir === 'asc' ? va - vb : vb - va;
        });

        const columns = [
            { key: 'name', label: 'Name' },
            { key: 'jph', label: 'JPH' },
            { key: 'nonBreakIdle', label: 'Idle (min)' },
            { key: 'break1Excess', label: 'Break 1 Misuse' },
            { key: 'break2Excess', label: 'Break 2 Misuse' },
            { key: 'idle15', label: '>15m Gaps' },
            { key: 'flags', label: 'Flags' }
        ];

        const arrow = (col) => {
            if (currentSort.col !== col) return '';
            return `<span class="sort-arrow">${currentSort.dir === 'asc' ? '\u25B2' : '\u25BC'}</span>`;
        };

        let html = '<table class="idash-table"><thead><tr>';
        columns.forEach(col => {
            html += `<th data-sort="${col.key}">${col.label}${arrow(col.key)}</th>`;
        });
        html += '</tr></thead><tbody>';

        filtered.forEach(aa => {
            const a = aa.analysis || {};
            let rowClass = '';
            if (aa.isBottomJPH && aa.isTopBreakOffender) rowClass = 'row-both';
            else if (aa.isBottomJPH) rowClass = 'row-bottom-jph';
            else if (aa.isTopBreakOffender) rowClass = 'row-break-offender';

            // Format break misuse columns
            const break1Str = a.break1Excess > 0
                ? `${a.break1Excess.toFixed(1)}m ${a.break1ReturnTime ? '(back ' + formatTimeShort(a.break1ReturnTime) + ')' : ''}`
                : '\u2713';
            const break2Str = a.break2Excess > 0
                ? `${a.break2Excess.toFixed(1)}m ${a.break2ReturnTime ? '(back ' + formatTimeShort(a.break2ReturnTime) + ')' : ''}`
                : '\u2713';

            // Format >15m gaps with timestamps
            const idle15Count = a.idleTimestamps15?.length || 0;
            let idle15Str = idle15Count > 0 ? `${idle15Count}` : '\u2713';
            let idle15Title = '';
            if (a.idleTimestamps15 && a.idleTimestamps15.length > 0) {
                idle15Title = a.idleTimestamps15.map(t =>
                    `${formatTimeShort(t.start)}\u2192${formatTimeShort(t.end)} (${t.duration.toFixed(0)}m)`
                ).join('\n');
                idle15Str += ` <span class="idash-timestamps" title="${escapeHtml(idle15Title)}">${formatTimeShort(a.idleTimestamps15[0].start)}</span>`;
            }

            // Flags
            let flags = '';
            if (aa.isBottomJPH) flags += '<span class="idash-badge idash-badge-red">LOW JPH</span> ';
            if (aa.isTopBreakOffender) flags += '<span class="idash-badge idash-badge-orange">BRK</span> ';

            html += `<tr class="${rowClass}">
                <td title="${escapeHtml(aa.employeeId)}">${escapeHtml(aa.name || aa.employeeId)}</td>
                <td>${(aa.jph || 0).toFixed(1)}</td>
                <td>${(a.nonBreakIdleMinutes || 0).toFixed(1)}</td>
                <td style="color:${a.break1Excess > 0 ? '#e74c3c' : '#27ae60'}">${break1Str}</td>
                <td style="color:${a.break2Excess > 0 ? '#e74c3c' : '#27ae60'}">${break2Str}</td>
                <td title="${escapeHtml(idle15Title)}" style="color:${idle15Count > 0 ? '#e74c3c' : '#27ae60'}">${idle15Str}</td>
                <td>${flags}</td>
            </tr>`;
        });

        html += '</tbody></table>';

        document.getElementById('idash-table-wrap').innerHTML = html;

        // Wire sorting
        document.querySelectorAll('.idash-table th[data-sort]').forEach(th => {
            th.onclick = () => {
                const col = th.dataset.sort;
                if (col === 'flags') return;
                if (currentSort.col === col) {
                    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.col = col;
                    currentSort.dir = 'desc';
                }
                renderTable(aaList);
            };
        });
    }

    function formatTimeShort(date) {
        if (!date) return '';
        if (!(date instanceof Date)) date = new Date(date);
        return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 14: CSV EXPORT
    // ═══════════════════════════════════════════════════════════════

    function exportCSV() {
        if (!scanResults || scanResults.length === 0) {
            setStatus('No data to export', '#e74c3c');
            return;
        }

        const headers = ['Name', 'Employee ID', 'JPH', 'Total Idle (min)', 'Non-Break Idle (min)',
            'Break 1 Idle (min)', 'Break 1 Excess (min)', 'Break 1 Return Time',
            'Break 2 Idle (min)', 'Break 2 Excess (min)', 'Break 2 Return Time',
            'Gaps >15m Count', 'Gaps >15m Timestamps', 'Gaps >30m Count',
            'Bottom JPH Flag', 'Break Offender Flag'];

        const rows = scanResults.map(aa => {
            const a = aa.analysis || {};
            const ts15 = (a.idleTimestamps15 || []).map(t =>
                `${formatTimeShort(t.start)}-${formatTimeShort(t.end)}(${t.duration.toFixed(0)}m)`
            ).join('; ');
            return [
                aa.name || '',
                aa.employeeId || '',
                (aa.jph || 0).toFixed(1),
                (a.totalIdleMinutes || 0).toFixed(1),
                (a.nonBreakIdleMinutes || 0).toFixed(1),
                (a.break1IdleMinutes || 0).toFixed(1),
                (a.break1Excess || 0).toFixed(1),
                a.break1ReturnTime ? formatTimeShort(a.break1ReturnTime) : '',
                (a.break2IdleMinutes || 0).toFixed(1),
                (a.break2Excess || 0).toFixed(1),
                a.break2ReturnTime ? formatTimeShort(a.break2ReturnTime) : '',
                (a.idleTimestamps15 || []).length,
                ts15,
                (a.idleTimestamps30 || []).length,
                aa.isBottomJPH ? 'YES' : '',
                aa.isTopBreakOffender ? 'YES' : ''
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
        });

        const csv = headers.join(',') + '\n' + rows.join('\n');

        // Copy to clipboard
        navigator.clipboard.writeText(csv).then(() => {
            setStatus('CSV copied to clipboard!', '#27ae60');
        }).catch(() => {
            // Fallback: create download
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `idle-time-dashboard-${settings.warehouseId}-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            setStatus('CSV downloaded!', '#27ae60');
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 16: IN-PAGE TABLE ENHANCEMENTS (merged from idle-time.user.js)
    //   Injects columns directly into the FCLM functionRollup table:
    //   Total Idle, Idle %, Fast Start, Transfer, Idle >15m, Idle >30m
    //   Plus Transfer Misses Summary modal + Night Shift quick-fill button.
    // ═══════════════════════════════════════════════════════════════

    const employeeMisses = new Map();
    const processedLogins = new Set();

    // Department definitions (process -> department mapping)
    const departments = {
        P2R: { name: 'P2R', processes: [
            'Pack Multis\u2666Pack Kaizen 1','Pack Singles\u2666Pack Kaizen 1','Pack Multis\u2666Pack Kaizen 2',
            'Pack Singles\u2666Pack Kaizen 2','Pack Multis\u2666Pack Merge','Pack Singles\u2666Pack Merge',
            'Pick\u2666Pick To Rebin','Pack Support\u2666P2R Waterspider','Process Guide PackMu',
            'Pack Support\u2666Process Guide PackMu' ] },
        ArsawPick: { name: 'ARSAW', processes: [
            'Pick\u2666MultiFlow Picking','Pick\u2666RF Pick Singles','Pick\u2666RF Pick',
            'Transfer Out Pick\u2666RF Pick Transship','Pick Support\u2666Tote Replenishment' ] },
        Stow: { name: 'Stow', processes: [
            'Each Transfer In\u2666Stow Each Nike','Stow to Prime\u2666Stow Each Nike','Stow to Prime\u2666Stow Each Nike Light',
            'Each Transfer In\u2666Stow Each Nike Light','Pack Support\u2666Buffer Operator','Buffer Operator',
            'Transfer In Support\u2666Cart/Pallet Builder','Facility\u2666Tote Prep' ] },
        Dock: { name: 'DOCK', processes: [
            'Container Load\u2666Container Loader','Fluid Load\u2666Fluid Loader','Container Build\u2666Auto Cont. Builder',
            'Container Move\u2666Flat Waterspider','Container Move\u2666Flat Wing','Pallet Banding',
            'I Induct\u2666Flat Inductor','Process Guide Ship','Ship Dock Support\u2666Process Guide Ship',
            'Ship Dock Support\u2666FSRI Operator','FSRI Operator','Dock Pallet Loader',
            'Container Build\u2666Manual Cont. Builder' ] },
        Problemsolve: { name: 'PS', processes: [
            'Pack Multis\u2666Scan Packages','Pack Support\u2666SLAM Kickout','OB Problem Solve\u2666POPS Check In',
            'OB Problem Solve\u2666Pack from POPS','OB Problem Solve\u2666POPS Collector','OB Problem Solve\u2666POPS Runner',
            'OB Problem Solve\u2666POPS Overage' ] },
        Singlepack: { name: 'SM', processes: [
            'Pack Singles\u2666Scan Verify SIOC','Chuting\u2666Scan Verify AFE','Buffer Operator',
            'Pack Support\u2666Buffer Operator','SLAM Operator','Pack Support\u2666SLAM Operator',
            'Gift-Wrap\u2666Pack HandTape','Gift-Wrap\u2666Pack Multis HandTape','Custom Packaging\u2666Pack Multis HandTape',
            'Pack Singles\u2666Scan Verify Medium','Pack Singles\u2666Scan Verify','Sort-Flow\u2666AFE 1 Rebin',
            'Pack Singles\u2666Scan Verify Large','Pack Singles\u2666Slam At Pack','Pack Singles\u2666SLAP Mix',
            'Sort-Flow\u2666AFE1 Induct' ] },
        Icqa: { name: 'ICQA', processes: [
            'IC-QA-CS\u2666SBC - Other','IC-QA-CS\u2666Other Other','IC-QA-CS\u2666Simple Record Count',
            'IC-QA-CS\u2666Amnesty','Amnesty','IC-QA-CS\u2666Damage Processing','IC-QA-CS\u2666Andon Bin Chk WAVE',
            'IB Problem Solve\u2666Stow to Prime PSolve' ] },
        Receive: { name: 'REC', processes: [
            'Facility\u2666Tote Prep','Transfer In Dock\u2666Decant','RSR Support\u2666Decant',
            'Receive-Support\u2666Decant Non-TI','Transfer In Support\u2666Line Load Injection',
            'Each-Receive\u2666Receive Medium A','Transfer In Dock\u2666Pallet_decant_split',
            'Prep Recorder\u2666Prep Receive','Transfer In Support\u2666TransferIn Transport' ] }
    };

    function ip_createCell(content, backgroundColor, textColor = '', isIdleTime = false) {
        const cell = document.createElement('td');
        cell.textContent = content;
        if (backgroundColor) cell.style.backgroundColor = backgroundColor;
        if (textColor) cell.style.color = textColor;
        if (isIdleTime) cell.classList.add('idle-time-cell');
        cell.setAttribute('data-custom', 'true');
        return cell;
    }

    function ip_getIdleTimeColor(pct) {
        if (pct > 10) return '#ffc7ce';
        if (pct >= 8) return '#ffeb9c';
        return '#c6efce';
    }

    function ip_getGapColor(count) {
        if (count >= 3) return '#ffc7ce';
        if (count >= 1) return '#ffeb9c';
        return '#c6efce';
    }

    function ip_parseTransferTimeToMinutes(timeStr) {
        if (!timeStr) return 0;
        try {
            if (timeStr.includes(':')) {
                const [m, s] = timeStr.split(':').map(Number);
                return m + (s / 60);
            }
            return parseFloat(timeStr) || 0;
        } catch { return 0; }
    }

    function ip_formatMinutesToTime(totalMinutes) {
        const minutes = Math.floor(totalMinutes);
        const seconds = Math.round((totalMinutes % 1) * 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    function ip_calculateIdlePercentage(idleTime, paidTimeSegments) {
        let totalTime = 0;
        paidTimeSegments.forEach((row) => {
            const tds = row.querySelectorAll('td');
            if (tds.length >= 4) {
                const timeText = tds[3].innerText;
                const [hours, minutes] = timeText.split(':').map(Number);
                totalTime += hours + (minutes / 60);
            }
        });
        return totalTime > 0 ? (idleTime / totalTime * 100) : 0;
    }

    function ip_checkForTransfer(currentProcess, nextProcess) {
        let fromDepartment = null, toDepartment = null;
        for (let dept in departments) {
            if (departments[dept].processes.includes(currentProcess)) fromDepartment = departments[dept].name;
            if (departments[dept].processes.includes(nextProcess)) toDepartment = departments[dept].name;
        }
        if (fromDepartment && toDepartment && fromDepartment !== toDepartment) {
            return { from: fromDepartment, to: toDepartment, fromProcess: currentProcess, toProcess: nextProcess };
        }
        return null;
    }

    // Sorting for injected columns
    function ip_getColumnValue(row, columnType) {
        const cells = row.querySelectorAll('td[data-custom]');
        let value = 0, text, minutes, seconds, transferCell;
        switch (columnType) {
            case 'idle': text = cells[0]?.textContent || '0'; value = parseFloat(text.replace(/[^\d.]/g, '')) || 0; break;
            case 'idlePercentage': text = cells[1]?.textContent || '0%'; value = parseFloat(text.replace('%', '')) || 0; break;
            case 'fast': text = cells[2]?.textContent || ''; value = text === '\u2713' ? 0 : parseInt(text.replace(/[^\d.]/g, '')) || 0; break;
            case 'transfer':
                transferCell = cells[3]?.querySelector('.transfer-time-display');
                if (!transferCell || transferCell.textContent === '-') { value = 0; }
                else { [minutes, seconds] = (transferCell.textContent || '0:00').split(':').map(Number); value = (minutes || 0) + ((seconds || 0) / 60); }
                break;
            case 'idle15': text = cells[4]?.textContent || '0'; value = text === '\u2713' ? 0 : parseInt(text) || 0; break;
            case 'idle30': text = cells[5]?.textContent || '0'; value = text === '\u2713' ? 0 : parseInt(text) || 0; break;
            default: value = 0;
        }
        return value;
    }

    function ip_sortTableByColumn(table, columnType, ascending = false) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row, index) => row.setAttribute('data-original-order', index));
        rows.sort((a, b) => {
            const va = ip_getColumnValue(a, columnType), vb = ip_getColumnValue(b, columnType);
            if (va === vb) return (parseInt(a.getAttribute('data-original-order')) - parseInt(b.getAttribute('data-original-order')));
            return ascending ? va - vb : vb - va;
        });
        tbody.innerHTML = '';
        rows.forEach(row => tbody.appendChild(row));
    }

    function ip_createTransferCell(transfers, login, row) {
        const cell = document.createElement('td');
        cell.classList.add('transfer-time-cell');
        cell.setAttribute('data-custom', 'true');
        if (!transfers || transfers.length === 0) { cell.textContent = '-'; return cell; }

        let totalMinutes = 0, missCount = 0;
        const validTransfers = transfers.filter(t => t && t.from && t.to && t.idleTime && ip_parseTransferTimeToMinutes(t.idleTime) > 10);
        validTransfers.forEach(t => { totalMinutes += ip_parseTransferTimeToMinutes(t.idleTime); missCount++; });

        const loginCell = row.querySelector('td:nth-child(6)');
        const loginName = loginCell ? loginCell.textContent.trim() : 'Unknown';
        const managerCell = row.querySelector('td:nth-child(4)');
        const manager = managerCell ? managerCell.textContent.trim() : 'Unknown';

        if (loginName && missCount > 0 && !processedLogins.has(loginName)) {
            employeeMisses.set(loginName, {
                loginName, missCount, totalTime: totalMinutes, manager,
                details: validTransfers.map(t => ({ from: t.from, to: t.to, time: t.idleTime, minutes: ip_parseTransferTimeToMinutes(t.idleTime) }))
            });
            processedLogins.add(loginName);
        }

        const timeDisplay = document.createElement('span');
        timeDisplay.textContent = missCount > 0 ? ip_formatMinutesToTime(totalMinutes) : '-';
        timeDisplay.classList.add('transfer-time-display');
        cell.appendChild(timeDisplay);

        if (validTransfers.length > 0) {
            const detailsButton = document.createElement('button');
            detailsButton.textContent = 'Details';
            detailsButton.className = 'transfer-button';
            cell.appendChild(detailsButton);

            const detailsDiv = document.createElement('div');
            detailsDiv.className = 'transfer-details';
            validTransfers.forEach(t => {
                const detail = document.createElement('div');
                detail.textContent = `${t.from} \u2192 ${t.to} (${t.idleTime})`;
                detail.style.color = 'red';
                detailsDiv.appendChild(detail);
            });
            detailsButton.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.transfer-details').forEach(d => { if (d !== detailsDiv) d.classList.remove('show'); });
                detailsDiv.classList.toggle('show');
            };
            document.addEventListener('click', (e) => {
                if (!detailsDiv.contains(e.target) && e.target !== detailsButton) detailsDiv.classList.remove('show');
            });
            cell.appendChild(detailsDiv);
        }
        cell.style.backgroundColor = missCount > 0 ? '#ffc7ce' : '#c6efce';
        return cell;
    }

    function ip_addColumnHeaders() {
        const tables = document.querySelectorAll("table[id^=function]");
        tables.forEach(table => {
            const headerRow = table.querySelector("thead tr");
            if (!headerRow) return;
            headerRow.querySelectorAll('th[data-custom]').forEach(h => h.remove());
            const newHeaders = [
                { text: 'Total Idle', type: 'idle' },
                { text: 'Idle %', type: 'idlePercentage' },
                { text: 'Fast Start', type: 'fast' },
                { text: 'Transfer', type: 'transfer' },
                { text: 'Idle >15m', type: 'idle15' },
                { text: 'Idle >30m', type: 'idle30' }
            ];
            newHeaders.forEach(({ text, type }) => {
                const th = document.createElement('th');
                th.setAttribute('data-custom', 'true');
                const button = document.createElement('button');
                button.className = 'sort-button';
                button.innerHTML = `${text}<span class="sort-icon"></span>`;
                button.setAttribute('data-sort-type', type);
                let ascending = false;
                button.addEventListener('click', function (e) {
                    e.preventDefault(); e.stopPropagation();
                    document.querySelectorAll('.sort-button').forEach(btn => btn.classList.remove('active', 'asc', 'desc'));
                    ascending = !ascending;
                    this.classList.add('active', ascending ? 'asc' : 'desc');
                    const parentTable = this.closest('table');
                    if (parentTable) ip_sortTableByColumn(parentTable, type, ascending);
                });
                th.appendChild(button);
                headerRow.appendChild(th);
            });
        });
    }

    function ip_createTransferSummaryButton() {
        const button = document.createElement('button');
        button.className = 'transfer-summary-button';
        button.textContent = 'Transfer Misses Summary';
        const modal = document.createElement('div');
        modal.className = 'transfer-summary-modal';
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const closeButton = document.createElement('button');
        closeButton.className = 'close-modal-button';
        closeButton.textContent = '\u00d7';
        modal.appendChild(closeButton);
        const header = document.createElement('div');
        header.className = 'transfer-summary-header';
        header.textContent = 'Transfer Misses Summary';
        modal.appendChild(header);
        const content = document.createElement('div');
        content.className = 'transfer-summary-content';
        modal.appendChild(content);
        button.onclick = ip_updateAndShowModal;
        closeButton.onclick = () => { modal.classList.remove('show'); backdrop.classList.remove('show'); };
        backdrop.onclick = closeButton.onclick;
        document.body.appendChild(button);
        document.body.appendChild(modal);
        document.body.appendChild(backdrop);
    }

    function ip_updateAndShowModal() {
        const modal = document.querySelector('.transfer-summary-modal');
        const backdrop = document.querySelector('.modal-backdrop');
        const content = modal.querySelector('.transfer-summary-content');
        content.innerHTML = '';
        const managerGroups = new Map();
        employeeMisses.forEach((data) => {
            const manager = data.manager;
            if (!managerGroups.has(manager)) managerGroups.set(manager, []);
            managerGroups.get(manager).push({ ...data });
        });
        let totalMisses = 0;
        employeeMisses.forEach(data => { totalMisses += data.missCount; });
        const totalMissesDiv = document.createElement('div');
        totalMissesDiv.className = 'total-misses';
        totalMissesDiv.textContent = `Total Transfer Misses: ${totalMisses}`;
        content.appendChild(totalMissesDiv);
        const sortedManagers = Array.from(managerGroups.entries()).sort((a, b) => {
            const ma = a[1].reduce((s, e) => s + e.missCount, 0), mb = b[1].reduce((s, e) => s + e.missCount, 0);
            return mb - ma;
        });
        const wh = settings.warehouseId || 'EMA4';
        sortedManagers.forEach(([manager, employees]) => {
            const managerSection = document.createElement('div');
            managerSection.className = 'manager-section';
            const managerHeader = document.createElement('div');
            managerHeader.className = 'manager-header';
            managerHeader.textContent = `Manager: ${manager}`;
            managerSection.appendChild(managerHeader);
            employees.sort((a, b) => b.totalTime - a.totalTime);
            employees.forEach(({ loginName, missCount, details, totalTime }) => {
                if (missCount <= 0) return;
                const detailItem = document.createElement('div');
                detailItem.className = 'transfer-detail-item';
                let detailsHtml = `
                    <strong>Login:</strong> <a href="${BASE_URL}/employee/timeDetails?warehouseId=${wh}&employeeId=${loginName}" target="_blank">${loginName}</a><br>
                    <strong>Total Misses:</strong> ${missCount}<br>
                    <strong>Total Transfer Time:</strong> ${ip_formatMinutesToTime(totalTime)}<br>
                    <strong>Transfer Details:</strong>`;
                details.filter(t => ip_parseTransferTimeToMinutes(t.time) > 10).forEach(t => {
                    detailsHtml += `<div class="transfer-miss">${t.from} \u2192 ${t.to} (${t.time})</div>`;
                });
                detailItem.innerHTML = detailsHtml;
                managerSection.appendChild(detailItem);
            });
            content.appendChild(managerSection);
        });
        modal.classList.add('show');
        backdrop.classList.add('show');
    }

    // Fetch + inject columns for one AA row (mirrors idle-time.user.js getTime)
    function ip_getTime(row, href) {
        GM_xmlhttpRequest({
            method: "GET",
            url: href,
            headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Cache-Control": "no-cache" },
            onload: function (response) {
                try {
                    const tempHtml = document.createElement('div');
                    tempHtml.innerHTML = response.responseText;
                    const editableElements = tempHtml.querySelectorAll('.editable');
                    const paidTimeSegments = tempHtml.querySelectorAll('.clock-seg.on-clock.paid');

                    let idleTime = 0, shiftStartIdleMinutes = 0, fastStartFound = false;
                    let transfers = [], idleOver15 = 0, idleOver30 = 0;

                    const shiftStartHM = parseTime(settings.shiftStart);

                    editableElements.forEach((item) => {
                        if (item.parentNode.parentNode.classList.contains('edited')) return;
                        const processRow = item.parentNode.parentNode;
                        const processCell = processRow.cells[0];
                        const currentProcess = processCell ? processCell.textContent.trim() : '';
                        const timeCell = processRow.querySelector('.rightAlign');
                        const idleTimeText = timeCell ? timeCell.textContent : '';

                        if (idleTimeText && idleTimeText.includes(':')) {
                            const [minutes, seconds] = idleTimeText.split(':').map(Number);
                            const gapMinutes = minutes + (seconds / 60);
                            idleTime += gapMinutes;
                            if (gapMinutes > 15) idleOver15++;
                            if (gapMinutes > 30) idleOver30++;

                            // Fast Start calculation using configured shift start
                            if (!fastStartFound) {
                                const previousRow = processRow.previousElementSibling;
                                const previousProcess = previousRow ? previousRow.cells[0].textContent.trim() : '';
                                if (previousProcess === 'OnClock/Paid') {
                                    const startEndTimes = processRow.querySelector('td:nth-child(3)');
                                    if (startEndTimes) {
                                        const timeMatch = startEndTimes.textContent.match(/\d{2}\/\d{2}-(\d{2}):(\d{2}):\d{2}/);
                                        if (timeMatch) {
                                            const endHour = parseInt(timeMatch[1]), endMin = parseInt(timeMatch[2]);
                                            const activityStartMinutes = (endHour * 60) + endMin;
                                            const shiftStartMinutes = (shiftStartHM.h * 60) + shiftStartHM.m;
                                            const toleranceMinutes = 10;
                                            const timeDifference = activityStartMinutes - shiftStartMinutes;
                                            shiftStartIdleMinutes = timeDifference <= toleranceMinutes ? 0 : timeDifference - toleranceMinutes;
                                            fastStartFound = true;
                                        }
                                    }
                                }
                            }
                        }

                        // Transfers
                        const nextRow = processRow.nextElementSibling;
                        if (nextRow && currentProcess) {
                            const nextProcess = nextRow.cells[0] ? nextRow.cells[0].textContent.trim() : '';
                            const transfer = ip_checkForTransfer(currentProcess, nextProcess);
                            if (transfer && idleTimeText && idleTimeText.includes(':')) {
                                transfers.push({ from: transfer.from, to: transfer.to, idleTime: idleTimeText });
                            }
                        }
                    });

                    const idlePercentage = ip_calculateIdlePercentage(idleTime, paidTimeSegments);
                    const roundedPercentage = Math.round(idlePercentage * 100) / 100;
                    const color = ip_getIdleTimeColor(roundedPercentage);

                    const newCells = [
                        ip_createCell(Math.round(idleTime * 100) / 100, color, '', true),
                        ip_createCell(roundedPercentage + '%', color, '', true),
                        ip_createCell(shiftStartIdleMinutes > 0 ? shiftStartIdleMinutes + ' min' : '\u2713',
                            shiftStartIdleMinutes > 0 ? '#800080' : '#c6efce', shiftStartIdleMinutes > 0 ? '#FFFFFF' : '#006100'),
                        ip_createTransferCell(transfers, null, row),
                        ip_createCell(idleOver15 > 0 ? idleOver15 : '\u2713', ip_getGapColor(idleOver15), idleOver15 > 0 ? '' : '#006100', true),
                        ip_createCell(idleOver30 > 0 ? idleOver30 : '\u2713', ip_getGapColor(idleOver30), idleOver30 > 0 ? '' : '#006100', true)
                    ];
                    newCells.forEach(cell => { cell.setAttribute('data-custom', 'true'); row.appendChild(cell); });
                } catch (error) {
                    console.error('[IdleDash] ip_getTime error:', error);
                }
            },
            onerror: function (error) { console.error('[IdleDash] ip_getTime request error:', error); }
        });
    }

    // Run the in-page enhancement (auto on functionRollup page)
    function runInPageEnhancement() {
        if (!location.pathname.includes('/reports/functionRollup')) return;
        if (document.querySelector('th[data-custom]')) return; // already injected
        employeeMisses.clear();
        processedLogins.clear();
        ip_createTransferSummaryButton();
        ip_addColumnHeaders();

        const tables = document.querySelectorAll("table[id^=function]");
        if (tables.length === 0) return;
        tables.forEach((table) => {
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach((row) => {
                try {
                    const link = row.querySelector('td:nth-child(2) a');
                    if (link) ip_getTime(row, link.href);
                } catch (e) { console.error('[IdleDash] row error:', e); }
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 15: INITIALIZATION
    // ═══════════════════════════════════════════════════════════════

    function init() {
        loadSettings();
        buildPanel();
        populateSettingsUI();
        // Auto-populate the FCLM table with idle-time columns on the functionRollup page
        try { runInPageEnhancement(); } catch (e) { console.error('[IdleDash] enhancement error:', e); }
        console.log('[IdleDash] Idle Time Dashboard v' + VERSION + ' loaded');
    }

    // Wait for DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 500);
    }

})();
