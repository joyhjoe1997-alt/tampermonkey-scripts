// ==UserScript==
// @name         Idle Time Dashboard
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Standalone idle time dashboard — time-aware metrics (only flags phases that have started), new fields: Clock In, First Scan, First Scan After Break 1, Last Scan
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
// @connect      adapt-iad.amazon.com
// @connect      roboscout.amazon.com
// @connect      staffingcommandcenter-na.aka.amazon.com
// @connect      staffingcommandcenter-eu.aka.amazon.com
// @connect      inbound-flow-svc-iad-prod.amazon.com
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // SECTION 1: CONFIGURATION & DEFAULTS
    // ═══════════════════════════════════════════════════════════════

    const VERSION = '3.6';
    const BASE_URL = location.origin; // Auto-detect: works on both fclm-portal.amazon.com and fclm-portal-dub.dub.proxy.amazon.com

    // ── Enrichment config (login + station lookup, ported from Track4) ──
    const ENRICH_LOGIN_CACHE_KEY = 'IdleDash_LoginCache_v1';
    const ENRICH_STATION_CACHE_KEY = 'IdleDash_StationCache_v1';
    const ENRICH_LOGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const ENRICH_STATION_TTL_MS = 5 * 60 * 1000;         // 5 minutes
    const ENRICH_SCC_REGIONS = ['na', 'eu'];

    const DEFAULT_SETTINGS = {
        shiftDate: '',          // '' = auto-detect from current date/time
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

        // Auto-detect from current URL params (works on any FCLM intraday page)
        const params = new URLSearchParams(location.search);
        if (params.get('warehouseId')) settings.warehouseId = params.get('warehouseId');
        if (params.get('startHourIntraday') && params.get('startMinuteIntraday')) {
            settings.shiftStart = String(params.get('startHourIntraday')).padStart(2, '0') + ':' + String(params.get('startMinuteIntraday')).padStart(2, '0');
        }
        if (params.get('endHourIntraday') && params.get('endMinuteIntraday')) {
            settings.shiftEnd = String(params.get('endHourIntraday')).padStart(2, '0') + ':' + String(params.get('endMinuteIntraday')).padStart(2, '0');
        }
        // Parse the shift start date from the URL (format: YYYY/MM/DD or YYYY%2FMM%2FDD)
        const rawDate = params.get('startDateIntraday');
        if (rawDate) {
            // URL decode and normalise separators to dash
            const normalised = decodeURIComponent(rawDate).replace(/\//g, '-');
            if (/^\d{4}-\d{2}-\d{2}$/.test(normalised)) {
                settings.shiftDate = normalised;
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
                onload(r) {
                    if (r.status >= 200 && r.status < 300) {
                        resolve(r.responseText);
                    } else if (r.status === 0) {
                        // Status 0 in GM context means success with no explicit code (common for same-origin)
                        resolve(r.responseText);
                    } else {
                        reject(new Error(`HTTP ${r.status} for ${url}`));
                    }
                },
                onerror(e) { reject(new Error('Network error: ' + (e.error || e.statusText || 'connection failed'))); },
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
        // Parse "HH:MM" to {h, m} object — safe fallback if value is missing
        if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return { h: 0, m: 0 };
        const [h, m] = timeStr.split(':').map(Number);
        return { h: isNaN(h) ? 0 : h, m: isNaN(m) ? 0 : m };
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
        // Build start/end Date objects accounting for overnight shift.
        // If settings.shiftDate is set (YYYY-MM-DD), use that as the base date
        // for the shift start; otherwise auto-detect from the current time.
        const shiftStart = parseTime(settings.shiftStart);
        const shiftEnd = parseTime(settings.shiftEnd);

        let startDate, endDate;

        if (settings.shiftDate && /^\d{4}-\d{2}-\d{2}$/.test(settings.shiftDate)) {
            // Explicit date override: parse as local date.
            const [y, mo, d] = settings.shiftDate.split('-').map(Number);
            startDate = new Date(y, mo - 1, d, shiftStart.h, shiftStart.m, 0, 0);
            endDate = new Date(y, mo - 1, d, shiftEnd.h, shiftEnd.m, 0, 0);
            // Overnight: end is next calendar day.
            if (shiftEnd.h * 60 + shiftEnd.m <= shiftStart.h * 60 + shiftStart.m) {
                endDate.setDate(endDate.getDate() + 1);
            }
        } else {
            // Auto-detect from current time using minute-accurate comparison.
            const now  = new Date();
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const startMinutes = shiftStart.h * 60 + shiftStart.m;
            const endMinutes   = shiftEnd.h   * 60 + shiftEnd.m;

            if (nowMinutes >= startMinutes) {
                // We're in the evening portion of the shift (or between shifts daytime)
                startDate = new Date(now);
                endDate   = new Date(now);
                endDate.setDate(endDate.getDate() + 1);
            } else if (endMinutes > nowMinutes) {
                // We're in the early-morning portion (after midnight, before shift end)
                startDate = new Date(now);
                startDate.setDate(startDate.getDate() - 1);
                endDate   = new Date(now);
            } else {
                // Between shift end and shift start — default to upcoming night shift
                startDate = new Date(now);
                endDate   = new Date(now);
                endDate.setDate(endDate.getDate() + 1);
            }

            startDate.setHours(shiftStart.h, shiftStart.m, 0, 0);
            endDate.setHours(shiftEnd.h, shiftEnd.m, 0, 0);
        }

        return { startDate, endDate };
    }

    // Human-readable label for the active scanning window (for the UI banner).
    function getShiftWindowLabel() {
        const { startDate, endDate } = getShiftDates();
        const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const fmtTime = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        if (fmtDate(startDate) === fmtDate(endDate)) {
            return `${fmtDate(startDate)}  ${fmtTime(startDate)} – ${fmtTime(endDate)}`;
        }
        return `${fmtDate(startDate)} ${fmtTime(startDate)} – ${fmtDate(endDate)} ${fmtTime(endDate)}`;
    }

    // Returns which shift phases have already started/completed as of right now.
    // Used to suppress metrics that haven't happened yet during live scans.
    //
    // Logic:
    //   - If the shift end has already passed → all phases are active (historical scan).
    //   - Otherwise, a phase is active only if its start window has been reached.
    //
    // Returns: { fastStart, break1, break2, strongFinish }  (each boolean)
    function getActivePhases() {
        const now = Date.now();
        const { startDate, endDate } = getShiftDates();
        const breakWindows = getBreakWindows();

        // If we're past the shift end, everything is relevant (historical data).
        const shiftComplete = now >= endDate.getTime();
        if (shiftComplete) {
            return { fastStart: true, break1: true, break2: true, strongFinish: true };
        }

        // Fast Start window begins at shift start — always active once the scan runs
        // (you'd only run the script during or after the shift).
        const fastStart = now >= startDate.getTime();

        // Break phases become relevant once the break window has started.
        const break1 = now >= breakWindows.break1.windowStart.getTime();
        const break2 = now >= breakWindows.break2.windowStart.getTime();

        // Strong Finish is only relevant once we're close to shift end — use
        // the strong finish start time (shift end minus 30 min) as the threshold.
        // Since we don't have an explicit "strongStart" setting here, derive it
        // as 30 minutes before shift end.
        const strongFinishThreshold = endDate.getTime() - 30 * 60000;
        const strongFinish = now >= strongFinishThreshold;

        return { fastStart, break1, break2, strongFinish };
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
    // SECTION 3A: PROCESS PAGE SCANNER
    //   Scans the live DOM for function/process tables and returns
    //   a list of {id, name, tableEl} objects representing each
    //   detectable process on the current functionRollup page.
    // ═══════════════════════════════════════════════════════════════

    // Try to extract a human-readable process name from the table or its
    // nearest heading.  Falls back to the table id.
    function getTableProcessName(table) {
        // Strategy 1: look for a <caption> element
        const caption = table.querySelector('caption');
        if (caption) return caption.textContent.trim();

        // Strategy 2: look for a heading immediately before the table
        let el = table.previousElementSibling;
        while (el) {
            const tag = el.tagName.toLowerCase();
            if (/^h[1-6]$/.test(tag) || tag === 'div' || tag === 'p') {
                const txt = el.textContent.trim();
                if (txt.length > 0 && txt.length < 80) return txt;
            }
            el = el.previousElementSibling;
        }

        // Strategy 3: look for a heading inside a common parent container
        const parent = table.closest('.function-container, .report-section, [id*="function"]') || table.parentElement;
        if (parent) {
            const h = parent.querySelector('h1,h2,h3,h4,h5,h6');
            if (h) return h.textContent.trim();
        }

        // Strategy 4: derive from the table id (e.g. "functionTable-Pick-123")
        return table.id ? table.id.replace(/^function[-_]?/i, '').replace(/[-_]/g, ' ').trim() : 'Unknown Process';
    }

    // Return detected processes from the current page.
    // Each entry: { name, tableId, tableEl }
    function detectPageProcesses() {
        const tables = Array.from(document.querySelectorAll('table[id^=function]'));
        return tables.map(table => ({
            name: getTableProcessName(table),
            tableId: table.id,
            tableEl: table
        })).filter(p => p.tableEl.querySelector('tbody tr a[href*="employeeId"]'));
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3B: LOGIN + STATION ENRICHMENT (ported from Track4)
    //   Provides login (adapt-iad) and station/Location (SCC + RoboScout
    //   + IFC) lookups. Results are cached via GM storage.
    // ═══════════════════════════════════════════════════════════════

    function enrichReadJson(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (raw == null) return fallback;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            return fallback;
        }
    }

    function enrichWriteJson(key, value) {
        try {
            GM_setValue(key, JSON.stringify(value));
        } catch (e) {
            try { GM_setValue(key, value); } catch (_) {}
        }
    }

    function enrichChunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    function enrichUniq(values) {
        return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
    }

    function enrichGmRequest(method, url, { data = null, headers = {}, timeout = 30000, responseType = 'text' } = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                data,
                headers,
                timeout,
                responseType,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP ${response.status} for ${url}`));
                    }
                },
                onerror: (err) => reject(new Error(`Network error for ${url}: ${err && err.error ? err.error : 'request failed'}`)),
                ontimeout: () => reject(new Error(`Timeout for ${url}`))
            });
        });
    }

    async function enrichGetJson(url, timeout = 30000, headers = {}) {
        const response = await enrichGmRequest('GET', url, { timeout, headers });
        const text = response.responseText || '';
        return typeof text === 'object' ? text : JSON.parse(text);
    }

    async function enrichPostJson(url, payload, headers = {}, timeout = 30000) {
        const response = await enrichGmRequest('POST', url, {
            data: JSON.stringify(payload),
            headers,
            timeout
        });
        const text = response.responseText || '';
        return typeof text === 'object' ? text : JSON.parse(text);
    }

    function enrichNormalizeProfile(profile) {
        if (!profile || typeof profile !== 'object') return null;
        return {
            employeeId: profile.employeeId != null ? String(profile.employeeId) : '',
            login: profile.login != null ? String(profile.login) : '',
            shiftCode: profile.shiftCode != null ? String(profile.shiftCode) : '',
            badgeBarcodeId: profile.badgeBarcodeId != null ? String(profile.badgeBarcodeId) : '',
            timestamp: Date.now()
        };
    }

    async function ensureProfiles(identifiers) {
        const wanted = enrichUniq(identifiers);
        const cache = enrichReadJson(ENRICH_LOGIN_CACHE_KEY, {});
        const now = Date.now();
        const missing = [];
        wanted.forEach((id) => {
            const cached = cache[id];
            if (!cached || !cached.timestamp || (now - cached.timestamp) > ENRICH_LOGIN_TTL_MS) {
                missing.push(id);
            }
        });
        for (const batch of enrichChunk(missing, 100)) {
            const url = `https://adapt-iad.amazon.com/api/employee-profile-svc/GetEmployeeProfiles?employeeLogins=${encodeURIComponent(JSON.stringify(batch))}`;
            try {
                const data = await enrichGetJson(url, 45000);
                Object.keys(data || {}).forEach((key) => {
                    const profile = enrichNormalizeProfile(data[key]);
                    if (!profile) return;
                    if (key) cache[String(key)] = profile;
                    if (profile.employeeId) cache[profile.employeeId] = profile;
                    if (profile.login) cache[profile.login] = profile;
                });
            } catch (e) {
                console.warn('[IdleDash] profile lookup failed for batch:', batch, e);
            }
        }
        enrichWriteJson(ENRICH_LOGIN_CACHE_KEY, cache);
        const result = {};
        wanted.forEach((id) => {
            result[id] = cache[id] || null;
        });
        return result;
    }

    function enrichApplyStation(target, station, employeeId = '', login = '') {
        const cleanStation = String(station || '').trim();
        if (!cleanStation) return;
        if (employeeId) target.stationsById[String(employeeId)] = cleanStation;
        if (login) target.stationsByLogin[String(login)] = cleanStation;
    }

    async function enrichFetchStationsFromSCC(warehouseId, processName, bucket) {
        let latest = null;
        let regionUsed = null;
        for (const region of ENRICH_SCC_REGIONS) {
            try {
                latest = await enrichGetJson(`https://staffingcommandcenter-${region}.aka.amazon.com/getLatestGeneratedPlanRecord/${warehouseId}`, 30000);
                if (latest && latest.planId) {
                    regionUsed = region;
                    break;
                }
            } catch (e) {}
        }
        if (!latest || !latest.planId || !regionUsed) return;
        let intervals = [];
        try {
            intervals = await enrichGetJson(`https://staffingcommandcenter-${regionUsed}.aka.amazon.com/getPlanIntervals/${latest.planId}/${warehouseId}/${processName}`, 30000);
        } catch (e) {
            return;
        }
        if (!Array.isArray(intervals) || !intervals.length) return;
        const now = Date.now();
        let interval = null;
        let bestStart = -Infinity;
        intervals.forEach((candidate) => {
            const start = Number(candidate && candidate.startTime ? candidate.startTime : 0) * 1000;
            if (start && start <= now && start > bestStart) {
                bestStart = start;
                interval = candidate;
            }
        });
        if (!interval) interval = intervals[0];
        if (!interval) return;
        let plan = null;
        try {
            plan = await enrichPostJson(
                `https://staffingcommandcenter-${regionUsed}.aka.amazon.com/getStaffingPlansForWorkInterval/${latest.planId}/${processName}`,
                interval,
                { 'Accept': '*/*', 'content-type': 'application/json' },
                45000
            );
        } catch (e) {
            return;
        }
        const map = plan && plan.employeeIdToStationsMap ? plan.employeeIdToStationsMap : {};
        Object.keys(map).forEach((employeeId) => {
            const station = map[employeeId] && map[employeeId][0] && map[employeeId][0].scannableId ? map[employeeId][0].scannableId : '';
            enrichApplyStation(bucket, station, employeeId, '');
        });
    }

    async function enrichFetchStationsFromRobo(warehouseId, bucket) {
        const urls = [2078, 2080, 2081, 2079].map((instanceId) =>
            `https://roboscout.amazon.com/view_plot_data/?sites=(${warehouseId})&instance_id=${instanceId}&object_id=20672&BrowserTZ=America%2FNew_York&app_name=RoboScout`
        );
        const loginToStation = {};
        for (const url of urls) {
            try {
                const data = await enrichGetJson(url, 45000);
                const temp = {};
                (data && Array.isArray(data.data) ? data.data : []).forEach((entry) => {
                    if (!entry || !['Station_Id', 'Associate Login', 'StationType', 'Floor'].includes(entry.key)) return;
                    if (!temp[entry.xValue]) temp[entry.xValue] = {};
                    let value = String(entry.yValue || '');
                    if (value.includes('>')) value = value.split('>')[1].split('<')[0];
                    temp[entry.xValue][entry.key] = value;
                });
                Object.keys(temp).forEach((key) => {
                    const row = temp[key] || {};
                    const login = String(row['Associate Login'] || '').trim();
                    const stationId = String(row['Station_Id'] || '').trim();
                    if (!login || !stationId) return;
                    const floor = String(row['Floor'] || '').replace('paKiva', '').trim();
                    const stationType = String(row['StationType'] || '').trim();
                    const station = `${floor ? floor + ' - ' : ''}${stationType ? stationType[0] : ''}${stationId}`.trim();
                    if (station) loginToStation[login] = station;
                });
            } catch (e) {}
        }
        const logins = Object.keys(loginToStation);
        if (!logins.length) return;
        const profiles = await ensureProfiles(logins);
        logins.forEach((login) => {
            const profile = profiles[login] || null;
            enrichApplyStation(bucket, loginToStation[login], profile && profile.employeeId ? profile.employeeId : '', login);
        });
    }

    async function enrichFetchStationsFromIFC(warehouseId, bucket) {
        try {
            const payload = { warehouseId };
            const headers = {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Cache-Control': 'no-cache',
                'X-Amz-Date': new Date(Date.now()).toUTCString(),
                'X-Amz-Target': 'AFTInboundFlowControlService.GetFcFlowSnapshot',
                'Accept-Language': 'en-US,en;q=0.5',
                'Content-Type': 'application/x-amz-json-1.0'
            };
            const response = await enrichPostJson('https://inbound-flow-svc-iad-prod.amazon.com/', payload, headers, 45000);
            const root = response && response.warehouse && Array.isArray(response.warehouse.locations) ? response.warehouse.locations : [];
            const loginStations = {};
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                const children = Array.isArray(node.childLocations) ? node.childLocations : [];
                const employees = Array.isArray(node.employees) ? node.employees : [];
                if (employees.length && !children.length && node.id) {
                    employees.forEach((emp) => {
                        if (emp && emp.id) loginStations[String(emp.id)] = String(node.id);
                    });
                }
                children.forEach(walk);
            };
            root.forEach(walk);
            const logins = Object.keys(loginStations);
            if (!logins.length) return;
            const profiles = await ensureProfiles(logins);
            logins.forEach((login) => {
                const profile = profiles[login] || null;
                enrichApplyStation(bucket, loginStations[login], profile && profile.employeeId ? profile.employeeId : '', login);
            });
        } catch (e) {}
    }

    async function getStationsForWarehouse(warehouseId) {
        const cache = enrichReadJson(ENRICH_STATION_CACHE_KEY, {});
        const cached = cache[warehouseId];
        const now = Date.now();
        if (cached && cached.timestamp && (now - cached.timestamp) <= ENRICH_STATION_TTL_MS) {
            return cached;
        }
        const bucket = { timestamp: now, stationsById: {}, stationsByLogin: {} };
        await Promise.allSettled([
            enrichFetchStationsFromSCC(warehouseId, 'PPAFE1', bucket),
            enrichFetchStationsFromSCC(warehouseId, 'PPAFE2', bucket),
            enrichFetchStationsFromSCC(warehouseId, 'Singles', bucket),
            enrichFetchStationsFromRobo(warehouseId, bucket),
            enrichFetchStationsFromIFC(warehouseId, bucket)
        ]);
        cache[warehouseId] = bucket;
        enrichWriteJson(ENRICH_STATION_CACHE_KEY, cache);
        return bucket;
    }

    async function decorateRowsWithLoginStation(rows, warehouseId, idKey = 'employeeId') {
        const ids = enrichUniq((rows || []).map((row) => row && row[idKey] ? row[idKey] : ''));
        const profiles = ids.length ? await ensureProfiles(ids) : {};
        const stationBundle = await getStationsForWarehouse(warehouseId);
        (rows || []).forEach((row) => {
            if (!row || !row[idKey]) {
                row.login = row && row.login ? row.login : '';
                row.station = row && row.station ? row.station : '';
                return;
            }
            const key = String(row[idKey]);
            const profile = profiles[key] || null;
            const employeeId = profile && profile.employeeId ? profile.employeeId : key;
            const login = row.login || (profile && profile.login ? profile.login : '');
            row.login = login || '';
            row.station = row.station || stationBundle.stationsById[employeeId] || (login ? stationBundle.stationsByLogin[login] : '') || '';
        });
        return rows;
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 3C: PPA ATTENDANCE (CLOCK-IN / CLOCK-OUT)  (ported from Track4)
    //   Fetches real clock punches so Fast Start / Strong Finish can be
    //   measured against actual clock-in/out rather than activity gaps.
    //   Header-based column detection with fixed-index fallback. Non-fatal.
    // ═══════════════════════════════════════════════════════════════

    // Minimal CSV parser (dashboard does not @require PapaParse).
    // Handles quoted fields and embedded commas/quotes.
    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (s[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(field); field = '';
            } else if (ch === '\n') {
                row.push(field); rows.push(row); row = []; field = '';
            } else if (ch === '\r') {
                // ignore; handled by \n
            } else {
                field += ch;
            }
        }
        if (field.length || row.length) { row.push(field); rows.push(row); }
        return rows.filter(r => r.length && !(r.length === 1 && r[0].trim() === ''));
    }

    // Fixed-index fallbacks (Track4 defaults)
    const PPA_EMP_ID_INDEX = 0;
    const PPA_PUNCH_TYPE_INDEX = 4;
    const PPA_PUNCH_TIME_INDEX = 5;

    function ppaColumnIndices(headerRow) {
        const idx = { id: PPA_EMP_ID_INDEX, type: PPA_PUNCH_TYPE_INDEX, time: PPA_PUNCH_TIME_INDEX };
        if (!Array.isArray(headerRow)) return idx;
        const lower = headerRow.map(h => String(h || '').trim().toLowerCase());
        const find = (preds) => lower.findIndex(h => preds.some(p => h.includes(p)));
        const idCol = find(['employee id', 'emp id', 'employeeid', 'badge']);
        const typeCol = find(['punch type', 'type', 'direction', 'in/out']);
        const timeCol = find(['punch time', 'time', 'timestamp', 'clock']);
        if (idCol >= 0) idx.id = idCol;
        if (typeCol >= 0) idx.type = typeCol;
        if (timeCol >= 0) idx.time = timeCol;
        return idx;
    }

    // Returns Map<employeeId, {clockIn: Date|null, clockOut: Date|null}>
    async function fetchPpaAttendance() {
        const map = new Map();
        try {
            const { startDate, endDate } = getShiftDates();
            const fmtDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const url =
                `${BASE_URL}/reports/ppaAttendance?reportFormat=CSV` +
                `&warehouseId=${encodeURIComponent(settings.warehouseId)}` +
                `&startDateDay=${fmtDay(startDate)}` +
                `&maxIntradayDays=30&spanType=Intraday` +
                `&startDateIntraday=${fmtDay(startDate)}` +
                `&startHourIntraday=${startDate.getHours()}&startMinuteIntraday=${startDate.getMinutes()}` +
                `&endDateIntraday=${fmtDay(endDate)}` +
                `&endHourIntraday=${endDate.getHours()}&endMinuteIntraday=${endDate.getMinutes()}`;
            const csv = await gmFetch(url, 90000);
            const parsed = parseCsv(csv.trim());
            if (parsed.length < 2) return map;
            const idxCols = ppaColumnIndices(parsed[0]);
            const dataRows = parsed.slice(1);
            dataRows.forEach(cells => {
                const empId = String(cells[idxCols.id] || '').trim();
                if (!empId || /^employee/i.test(empId)) return;
                const punchType = String(cells[idxCols.type] || '').trim().toLowerCase();
                const rawTime = String(cells[idxCols.time] || '').trim();
                if (!rawTime || !punchType) return;
                let t = new Date(rawTime);
                if (isNaN(t)) t = new Date(rawTime.replace(/\u202f/g, ' '));
                if (isNaN(t)) return;
                let entry = map.get(empId);
                if (!entry) { entry = { clockIn: null, clockOut: null }; map.set(empId, entry); }
                if (punchType.includes('in')) {
                    if (!entry.clockIn || t < entry.clockIn) entry.clockIn = t;
                } else if (punchType.includes('out')) {
                    if (!entry.clockOut || t > entry.clockOut) entry.clockOut = t;
                }
            });
        } catch (e) {
            console.warn('[IdleDash] PPA attendance fetch failed (non-fatal):', e);
        }
        return map;
    }

    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    // SECTION 4: FETCH AA LIST + JPH FROM functionRollup
    // ═══════════════════════════════════════════════════════════════

    // null = scan all detected tables; Set<string> = only scan tables whose
    // id is in the set.  Populated by the process selector panel.
    let selectedProcessIds = null;

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
            html = await gmFetch(url, 45000);
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');

        let tables = Array.from(doc.querySelectorAll('table[id^=function]'));
        if (tables.length === 0) {
            throw new Error('No function tables found on functionRollup page. Check shift times and warehouse ID.');
        }

        // Filter to selected processes if a specific selection is active.
        if (selectedProcessIds && selectedProcessIds.size > 0) {
            tables = tables.filter(t => selectedProcessIds.has(t.id));
            if (!tables.length) {
                throw new Error('None of the selected processes were found on the page. Try refreshing.');
            }
        }

        const aaList = [];
        const seen = new Set();

        tables.forEach(table => {
            const processLabel = getTableProcessName(table) || table.id || 'Unknown';
            // The functionRollup table has a TWO-ROW header: row 1 has group
            // headers (e.g. "Paid Hours" with colspan), row 2 has the leaf
            // sub-headers ("Small","Medium","Large","HeavyBulky","Total").
            // Only the LAST header row aligns 1:1 with body <td> cells, so we
            // must use that row's index positions for column detection.
            const headerRows = table.querySelectorAll('thead tr');
            const groupRow = headerRows.length > 1 ? headerRows[headerRows.length - 2] : null;
            const leafRow  = headerRows.length ? headerRows[headerRows.length - 1] : null;
            const leafCells = leafRow ? leafRow.querySelectorAll('th, td') : [];

            let jphColIdx    = -1;
            let mgrColIdx    = -1;
            let funcColIdx   = -1;
            let paidColIdx   = -1;

            // Determine the column-index range spanned by the "Paid Hours" group
            // header (if present) so we can find its "Total" leaf column.
            let paidGroupStart = -1, paidGroupEnd = -1;
            if (groupRow) {
                let colCursor = 0;
                groupRow.querySelectorAll('th, td').forEach(cell => {
                    const span = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
                    const gtext = cell.textContent.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                    if (gtext.includes('paid') && gtext.includes('hour')) {
                        paidGroupStart = colCursor;
                        paidGroupEnd = colCursor + span - 1;
                    }
                    colCursor += span;
                });
            }

            leafCells.forEach((th, idx) => {
                const text = th.textContent.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                if (text === 'jph' || text === 'uph' || text.includes('jobs per hour') || text.includes('units per hour')) {
                    jphColIdx = idx;
                }
                if (text === 'manager' || text.includes('manager') || text.includes('supervisor')) {
                    mgrColIdx = idx;
                }
                if (text.includes('function') || text.includes('process') || text.includes('activity')) {
                    funcColIdx = idx;
                }
                // "Total" leaf column that falls within the Paid Hours group span
                if (text === 'total' && paidColIdx === -1 &&
                    paidGroupStart >= 0 && idx >= paidGroupStart && idx <= paidGroupEnd) {
                    paidColIdx = idx;
                }
            });
            // Fallback 1: any "total" leaf column that comes before JPH (paid hours
            // total sits left of the units/jobs columns on the functionRollup report)
            if (paidColIdx === -1) {
                leafCells.forEach((th, idx) => {
                    const text = th.textContent.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                    if (text === 'total' && paidColIdx === -1 && (jphColIdx === -1 || idx < jphColIdx)) {
                        paidColIdx = idx;
                    }
                });
            }
            // Fallback 2: first "total" leaf column of any kind
            if (paidColIdx === -1) {
                leafCells.forEach((th, idx) => {
                    const text = th.textContent.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                    if (text === 'total' && paidColIdx === -1) paidColIdx = idx;
                });
            }

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
                let manager = '';
                let functionName = processLabel;
                let paidHours = null;

                const cells = row.querySelectorAll('td');
                if (jphColIdx >= 0 && cells[jphColIdx]) {
                    jph = parseFloat(cells[jphColIdx].textContent.trim()) || 0;
                }
                if (mgrColIdx >= 0 && cells[mgrColIdx]) {
                    manager = cells[mgrColIdx].textContent.trim();
                }
                if (funcColIdx >= 0 && cells[funcColIdx]) {
                    const fn = cells[funcColIdx].textContent.trim();
                    if (fn) functionName = fn;
                }
                if (paidColIdx >= 0 && cells[paidColIdx]) {
                    const v = parseFloat(cells[paidColIdx].textContent.trim());
                    if (!isNaN(v)) paidHours = v;
                }

                // Build timeDetails href for direct linking
                const timeDetailsHref = href.includes('timeDetails') ? href : null;

                aaList.push({ employeeId, name, jph, manager, functionName, paidHours, timeDetailsHref });
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

    // Parses the NON-EDITABLE (on-task / active) rows from a timeDetails page.
    // These rows represent periods when the associate was actually scanning —
    // the complement of idle segments. Used to find first/last actual scans
    // relative to break windows.
    // Returns array of { start: Date, end: Date } objects.
    function parseActivitySegments(html) {
        if (!html) return [];
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const shiftDates = getShiftDates();
        const activityRows = [];

        // Patterns that identify non-task rows to SKIP:
        // OffClock/Unpaid  = break / unpaid time
        // OnClock/Paid     = the shift wrapper row (not a task)
        // Empty process    = header/footer rows
        const SKIP_PROCESS = /^(OffClock|OnClock|Off\s*Clock|On\s*Clock)/i;

        const allRows = doc.querySelectorAll('tr');
        allRows.forEach(row => {
            // Skip editable (idle) rows and already-edited rows
            if (row.querySelector('.editable')) return;
            if (row.classList.contains('edited')) return;

            // Must have at least one timestamp
            const rowText = row.textContent || '';
            if (!rowText.match(/\d{2}\/\d{2}-\d{2}:\d{2}:\d{2}/)) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;

            // cells[0] is the process/task name — skip clock-in/out and break rows
            const processName = (cells[0] ? cells[0].textContent.trim() : '');
            if (!processName) return;
            if (SKIP_PROCESS.test(processName)) return;

            // Collect timestamps from ALL cells — FCLM puts start and end in
            // separate columns, so a single-cell search finds only one timestamp.
            const allTs = [];
            cells.forEach(cell => {
                const m = cell.textContent.match(/(\d{2}\/\d{2}-\d{2}:\d{2}:\d{2})/g);
                if (m) allTs.push(...m);
            });
            if (!allTs.length) return;

            const startTime = timestampToDate(allTs[0], shiftDates);
            if (!startTime || isNaN(startTime)) return;

            const endTime = allTs.length >= 2
                ? timestampToDate(allTs[1], shiftDates)
                : new Date(startTime.getTime() + 60000);

            if (endTime && !isNaN(endTime)) {
                activityRows.push({ start: startTime, end: endTime, process: processName });
            }
        });

        return activityRows;
    }


    // Parses OffClock/UnPaid rows from a timeDetails page to get the AA's
    // actual break times (which may differ from the configured break window).
    // Returns array of { start: Date, end: Date } sorted by start time.
    function parseBreakSegments(html) {
        if (!html) return [];
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const shiftDates = getShiftDates();
        const breaks = [];

        // A real break must be INSIDE the shift window and short (≤ 90 min).
        // This filters out pre-shift idle (e.g. 332 min before clock-in) and
        // post-shift unpaid time (e.g. 196 min after last scan).
        const MAX_BREAK_MINUTES = 90;

        const allRows = doc.querySelectorAll('tr');
        allRows.forEach(row => {
            // Do NOT skip .editable rows — OffClock/UnPaid rows can be editable.
            if (row.classList.contains('edited')) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 2) return;
            const processName = (cells[0] ? cells[0].textContent.trim() : '');
            if (!/^OffClock/i.test(processName)) return;

            // Collect timestamps from ALL cells — start and end are in separate columns.
            const allTs = [];
            cells.forEach(cell => {
                const m = cell.textContent.match(/(\d{2}\/\d{2}-\d{2}:\d{2}:\d{2})/g);
                if (m) allTs.push(...m);
            });
            if (allTs.length < 2) return;

            const startTime = timestampToDate(allTs[0], shiftDates);
            const endTime   = timestampToDate(allTs[1], shiftDates);
            if (!startTime || !endTime || isNaN(startTime) || isNaN(endTime)) return;

            // Filter: must be inside the shift window
            if (startTime < shiftDates.startDate) return;
            if (endTime > shiftDates.endDate) return;

            // Filter: must be a realistic break duration (not pre/post-shift unpaid blocks)
            const durationMinutes = (endTime - startTime) / 60000;
            if (durationMinutes > MAX_BREAK_MINUTES) return;

            breaks.push({ start: startTime, end: endTime });
        });

        return breaks.sort((a, b) => a.start - b.start);
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

    function analyzeBreaks(segments, ppa, activitySegments, breakSegments) {
        const breakWindows = getBreakWindows();
        const threshold = settings.breakMisuseThreshold;
        const shiftDates = getShiftDates();

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

                // For timestamp recording, only include this idle segment if it
                // falls substantially outside BOTH break windows (break 1 & break 2).
                // We check that the segment's non-break portion is meaningful — i.e.
                // the idle time isn't mostly accounted for by a break window.
                const isInsideBreak1 = overlap1 / segDuration > 0.5;
                const isInsideBreak2 = overlap2 / segDuration > 0.5;
                if (!isInsideBreak1 && !isInsideBreak2) {
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

        // Clock punches (when available) give a more accurate first/last reference.
        const clockIn  = ppa && ppa.clockIn  ? ppa.clockIn  : null;
        const clockOut = ppa && ppa.clockOut ? ppa.clockOut : null;

        // ── Actual break boundaries ────────────────────────────────────
        // Use the AA's detected OffClock/UnPaid row as break 1.
        // Fall back to configured break window if none found.
        // A break must start at or after the AA's clock-in time — filter out
        // pre-shift OffClock/UnPaid rows (e.g. 18:15–19:15 before a 19:15 clock-in).
        const actualBreaks = (Array.isArray(breakSegments) ? breakSegments : [])
            .filter(b => b.start >= (clockIn || shiftDates.startDate));
        const actualBreak1 = actualBreaks.length > 0 ? actualBreaks[0] : null;
        const break1Start = actualBreak1 ? actualBreak1.start : breakWindows.break1.breakStart;
        const break1End   = actualBreak1 ? actualBreak1.end   : breakWindows.break1.breakEnd;

        // Break 2 always uses the configured window (02:15–02:45 by default)
        const break2Start = breakWindows.break2.breakStart;
        const break2End   = breakWindows.break2.breakEnd;

        // Did the AA actually take break 1? Only then do we compute the
        // "before/after break 1" scan fields. If they clocked in at break time
        // or skipped break 1, these stay blank while First Scan / Last Scan /
        // Break 2 fields still populate normally.
        const tookBreak1 = !!actualBreak1;

        // ── Timing fields ──────────────────────────────────────────────
        // All scan times are derived directly from activitySegments (the real
        // non-editable on-task rows from the timeDetails page). These are the
        // actual task rows — no inference from idle gaps needed.
        //
        // Rules:
        //   firstScan            = start of the FIRST activity row that is within
        //                          the clocked-in window (>= clockIn if available)
        //   lastScan             = end   of the LAST  activity row that is within
        //                          the clocked-in window (<= clockOut if available)
        //   lastScanBeforeBreak1 = end   of the LAST  activity row whose end is
        //                          at or before break1Start
        //   firstScanAfterBreak1 = start of the FIRST activity row whose start is
        //                          at or after break1End

        let firstScan             = null;
        let lastScan              = null;
        let firstScanAfterBreak1  = null;
        let lastScanBeforeBreak1  = null;
        let firstScanAfterBreak2  = null;
        let lastScanBeforeBreak2  = null;

        const acts = Array.isArray(activitySegments) ? activitySegments : [];

        // Effective shift boundaries: prefer real clock punches, fall back to
        // configured shift window.
        const shiftStartRef = clockIn  || shiftDates.startDate;
        const shiftEndRef   = clockOut || shiftDates.endDate;

        if (acts.length > 0) {
            // Sort activity rows by start time for predictable iteration
            const sorted = acts.slice().sort((a, b) => a.start - b.start);

            sorted.forEach(act => {
                // Lower bound with a 5-min tolerance below clock-in to avoid
                // excluding the first real scan due to second-level rounding
                // between the PPA punch and the activity timestamp.
                // No upper bound — AAs who leave early keep their post-break rows.
                if (act.start.getTime() < shiftStartRef.getTime() - 5 * 60000) return;

                // firstScan: earliest activity start at or after clock-in
                if (!firstScan || act.start < firstScan) firstScan = act.start;

                // lastScan: latest activity end within clocked-in window
                if (!lastScan || act.end > lastScan) lastScan = act.end;

                // Break 1 scan fields — only if the AA actually took break 1
                if (tookBreak1) {
                    // lastScanBeforeBreak1: end of last activity finishing at/before break start
                    if (act.end <= break1Start) {
                        if (!lastScanBeforeBreak1 || act.end > lastScanBeforeBreak1) {
                            lastScanBeforeBreak1 = act.end;
                        }
                    }
                    // firstScanAfterBreak1: start of first activity beginning at/after break end
                    if (act.start >= break1End) {
                        if (!firstScanAfterBreak1 || act.start < firstScanAfterBreak1) {
                            firstScanAfterBreak1 = act.start;
                        }
                    }
                }

                // lastScanBeforeBreak2: end of last activity finishing at/before break2 start
                if (act.end <= break2Start) {
                    if (!lastScanBeforeBreak2 || act.end > lastScanBeforeBreak2) {
                        lastScanBeforeBreak2 = act.end;
                    }
                }

                // firstScanAfterBreak2: start of first activity beginning at/after break2 end
                if (act.start >= break2End) {
                    if (!firstScanAfterBreak2 || act.start < firstScanAfterBreak2) {
                        firstScanAfterBreak2 = act.start;
                    }
                }
            });
        } else {
            // Fallback when no activity rows: derive from idle segment boundaries.
            segments.forEach(seg => {
                if (!seg.start) return;
                // Lower bound only — same rationale as acts block above
                if (seg.end < shiftStartRef) return;
                if (!firstScan || seg.end < firstScan) firstScan = seg.end;
                if (seg.start >= shiftStartRef) {
                    if (!lastScan || seg.start > lastScan) lastScan = seg.start;
                }
                if (tookBreak1) {
                    if (seg.end <= break1Start) {
                        if (!lastScanBeforeBreak1 || seg.end > lastScanBeforeBreak1) {
                            lastScanBeforeBreak1 = seg.end;
                        }
                    }
                    if (seg.start >= break1End) {
                        if (!firstScanAfterBreak1 || seg.start < firstScanAfterBreak1) {
                            firstScanAfterBreak1 = seg.start;
                        }
                    }
                }
                if (seg.end <= break2Start) {
                    if (!lastScanBeforeBreak2 || seg.end > lastScanBeforeBreak2) {
                        lastScanBeforeBreak2 = seg.end;
                    }
                }
                if (seg.start >= break2End) {
                    if (!firstScanAfterBreak2 || seg.start < firstScanAfterBreak2) {
                        firstScanAfterBreak2 = seg.start;
                    }
                }
            });
        }

        // Keep firstActivity/lastActivity names for internal Fast/Strong Finish use
        const firstActivity = firstScan;
        const lastActivity  = lastScan;

        // ── Phase awareness ────────────────────────────────────────────
        // Only flag metrics for phases that have actually happened yet.
        const phases = getActivePhases();

        // Missed Fast Start = first activity begins more than 15 min after the
        // reference start. Prefer real clock-in; fall back to configured shift start.
        const FAST_START_TOLERANCE_MS = 15 * 60000;
        const fastRef = clockIn || shiftDates.startDate;
        const missedFastStart = phases.fastStart && !!firstActivity &&
            (firstActivity.getTime() - fastRef.getTime()) > FAST_START_TOLERANCE_MS;

        // Missed Strong Finish = last activity ends before the reference end.
        // Prefer real clock-out; fall back to configured shift end.
        const strongRef = clockOut || shiftDates.endDate;
        const missedStrongFinish = phases.strongFinish && !!lastActivity &&
            lastActivity.getTime() < strongRef.getTime();

        // Break abuse only counts if the break window has passed.
        const isBreakAbuse = (phases.break1 && break1Misuse) || (phases.break2 && break2Misuse);
        const isIdleTime = nonBreakIdleMinutes > threshold;

        // ── Behavioral Type (only include phases that have started) ────
        const behaviors = [];
        if (isBreakAbuse)       behaviors.push('Break Abuse');
        if (isIdleTime)         behaviors.push('Idle Time');
        if (missedFastStart)    behaviors.push('Missed Fast Start');
        if (missedStrongFinish) behaviors.push('Missed Strong Finish');
        const behavioralType = behaviors.length ? behaviors.join(' / ') : 'Normal';

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
            firstActivity,
            lastActivity,
            clockIn,
            clockOut,
            firstScan,
            lastScan,
            lastScanBeforeBreak1,
            firstScanAfterBreak1,
            lastScanBeforeBreak2,
            firstScanAfterBreak2,
            actualBreak1Start: actualBreak1 ? actualBreak1.start : null,
            actualBreak1End:   actualBreak1 ? actualBreak1.end   : null,
            missedFastStart,
            missedStrongFinish,
            behavioralType,
            // Phase-aware individual break abuse flags (for per-break filter cards)
            break1Abuse: phases.break1 && break1Misuse,
            break2Abuse: phases.break2 && break2Misuse,
            isIdleTime,
            isBreakOffender: (phases.break1 && break1Misuse) || (phases.break2 && break2Misuse) || nonBreakIdleMinutes > threshold
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
            min-width: 320px;
            max-height: 90vh;
            background: #fff;
            border: 2px solid #2c3e50;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,.2);
            font: 12px 'Segoe UI', sans-serif;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            resize: both;
        }
        #idle-dash-panel.expanded {
            width: min(1400px, 95vw);
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
            max-height: calc(100% - 50px);
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
            max-height: 420px;
            overflow-y: auto;
            border: 1px solid #e3ebf5;
            border-radius: 10px;
            box-shadow: 0 6px 18px rgba(44,62,80,.06);
        }
        .idash-table {
            width: 100%;
            border-collapse: collapse;
            font: 11px 'Segoe UI';
        }
        .idash-table th {
            background: linear-gradient(180deg, #eef4fc 0%, #dfe9f7 100%);
            padding: 8px 10px;
            text-align: left;
            font-weight: 800;
            color: #234678;
            border-bottom: 2px solid #cdd9ec;
            position: sticky;
            top: 0;
            z-index: 2;
            cursor: pointer;
            white-space: nowrap;
            user-select: none;
        }
        .idash-table th:hover { background: linear-gradient(180deg, #e4eefb 0%, #d3e2f5 100%); }
        .idash-table td {
            padding: 6px 10px;
            border-bottom: 1px solid #eef2f7;
            white-space: nowrap;
        }
        .idash-table tbody tr:nth-child(even) td { background: #fafcff; }
        .idash-table tr:hover td { background: #eef6ff; }
        .idash-table tr.row-bottom-jph td { background: #fde2e2; }
        .idash-table tr.row-break-offender td { background: #fff3e0; }
        .idash-table tr.row-both td { background: #fce4ec; }

        /* ── Manager Filter (live, adapted from Track4) ── */
        .idash-manager-filter-host { margin-bottom: 10px; display: none; }
        #idash-manager-filter {
            background: linear-gradient(180deg, #ffffff 0%, #f6faff 100%);
            border: 1px solid #dde7f5;
            border-radius: 10px;
            padding: 10px;
            box-shadow: 0 6px 16px rgba(44,62,80,.06);
        }
        .idash-mgr-head {
            display: flex; align-items: flex-start; justify-content: space-between;
            gap: 8px; margin-bottom: 8px;
        }
        .idash-mgr-title { font: 800 14px 'Segoe UI'; color: #234678; }
        .idash-mgr-caption { font: 500 10px 'Segoe UI'; color: #7f8c8d; margin-top: 1px; }
        .idash-mgr-badge {
            white-space: nowrap; padding: 4px 10px; border-radius: 999px;
            background: rgba(52,152,219,.12); color: #2980b9;
            font: 800 10px 'Segoe UI'; border: 1px solid rgba(52,152,219,.2);
        }
        .idash-mgr-toolbar {
            display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap;
        }
        .idash-mgr-search {
            flex: 1 1 200px; min-width: 160px;
            border: 1px solid #cfdcef; border-radius: 8px; padding: 6px 10px;
            font: 11px 'Segoe UI'; color: #2c3e50; background: #fff;
        }
        .idash-mgr-search:focus {
            outline: none; border-color: #3498db;
            box-shadow: 0 0 0 3px rgba(52,152,219,.15);
        }
        .idash-mgr-controls { display: flex; gap: 6px; }
        .idash-mgr-btn {
            border: 1px solid transparent; border-radius: 8px; padding: 6px 12px;
            font: 800 10px 'Segoe UI'; cursor: pointer; transition: all .14s;
        }
        .idash-mgr-btn.is-primary { background: linear-gradient(135deg, #3498db, #2471a3); color: #fff; }
        .idash-mgr-btn.is-secondary { background: #fff; color: #234678; border-color: #cfdcef; }
        .idash-mgr-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 14px rgba(44,62,80,.12); }
        .idash-mgr-summary { font: 700 10px 'Segoe UI'; color: #445; margin-bottom: 8px; }
        .idash-mgr-list {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 5px; max-height: 150px; overflow-y: auto; padding-right: 4px;
        }
        .idash-mgr-chip {
            display: flex; align-items: center; gap: 6px; padding: 6px 9px;
            border: 1px solid #dfe7f3; border-radius: 8px; cursor: pointer;
            background: linear-gradient(180deg, #fff 0%, #fbfdff 100%);
            font: 700 10px 'Segoe UI'; color: #334155; transition: all .12s;
        }
        .idash-mgr-chip:hover { border-color: #bcd2ee; box-shadow: 0 4px 10px rgba(44,62,80,.08); }
        .idash-mgr-chip.is-selected {
            background: linear-gradient(180deg, #f4f9ff 0%, #e9f3ff 100%); border-color: #9ec4ec;
        }
        .idash-mgr-chip input { accent-color: #3498db; cursor: pointer; }
        .idash-mgr-chip span { word-break: break-word; }
        .idash-summary {
            display: grid;
            grid-template-columns: repeat(6, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }
        .idash-summary-card {
            background: linear-gradient(180deg, #ffffff 0%, #f4f8fd 100%);
            border: 1px solid #e3ebf5;
            border-radius: 10px;
            padding: 10px 8px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(44,62,80,.05);
        }
        .idash-summary-card .num {
            font: 800 20px 'Segoe UI';
            color: #2c3e50;
            line-height: 1.1;
        }
        .idash-summary-card .label {
            font: 600 10px 'Segoe UI';
            color: #7f8c8d;
            margin-top: 2px;
            text-transform: uppercase;
            letter-spacing: .03em;
        }
        .idash-card-clickable {
            cursor: pointer;
            transition: transform .12s ease, box-shadow .12s ease;
        }
        .idash-card-clickable:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(44,62,80,.12);
        }
        .idash-summary-card.is-active {
            box-shadow: 0 0 0 2px #3498db, 0 8px 20px rgba(52,152,219,.2);
            border-color: #3498db;
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
                        <div id="idash-shift-date-badge" style="margin-bottom:8px;padding:5px 9px;border-radius:8px;background:linear-gradient(180deg,rgba(52,152,219,.1),rgba(52,152,219,.05));border:1px solid rgba(52,152,219,.2);font:600 11px 'Segoe UI';color:#2471a3;">
                            📅 Shift date: <span id="idash-date-display">${settings.shiftDate ? settings.shiftDate : 'auto-detect from page URL'}</span>
                        </div>
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
                    <div class="idash-manager-filter-host" id="idash-manager-filter"></div>
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
            try {
                readSettingsFromUI();
                saveSettings();
            } catch (e) {
                console.error('[IdleDash] Error reading settings:', e);
                setStatus('Settings error: ' + e.message, '#e74c3c');
                return;
            }
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
        // Helper: safely read a value from an element — returns fallback if element is null
        const val = (id, fallback = '') => {
            const el = document.getElementById(id);
            return el ? el.value : fallback;
        };
        settings.warehouseId          = val('idash-warehouse', 'EMA4').trim() || 'EMA4';
        // shiftDate is read from the FCLM page URL in loadSettings — not editable in the UI
        settings.shiftStart           = val('idash-shift-start', '18:15').trim() || '18:15';
        settings.shiftEnd             = val('idash-shift-end', '04:45').trim() || '04:45';
        settings.break1Start          = val('idash-break1-start', '22:15').trim() || '22:15';
        settings.break1End            = val('idash-break1-end', '22:45').trim() || '22:45';
        settings.break2Start          = val('idash-break2-start', '02:15').trim() || '02:15';
        settings.break2End            = val('idash-break2-end', '02:45').trim() || '02:45';
        settings.bufferMinutes        = parseInt(val('idash-buffer', '3'))        || 3;
        settings.breakMisuseThreshold = parseInt(val('idash-threshold', '15'))    || 15;
        settings.percentileThreshold  = parseInt(val('idash-percentile', '8'))    || 8;
        settings.concurrencyLimit     = parseInt(val('idash-concurrency', '10'))  || 10;
        settings.shiftPreset          = val('idash-preset', 'night');
    }

    function populateSettingsUI() {
        const el = id => document.getElementById(id);
        // Update the read-only shift date badge
        const dateBadge = el('idash-date-display');
        if (dateBadge) dateBadge.textContent = settings.shiftDate || 'auto-detect from page URL';
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

        const startBtn  = document.getElementById('idash-start-btn');
        const stopBtn   = document.getElementById('idash-stop-btn');
        const exportBtn = document.getElementById('idash-export-btn');

        try {
            // Safely update button states INSIDE the try block so isScanning
            // is always reset in finally even if DOM elements are missing.
            if (startBtn)  startBtn.disabled  = true;
            if (stopBtn)   stopBtn.disabled   = false;
            if (exportBtn) exportBtn.disabled = true;
            resetProgress();

            const resultsDiv = document.getElementById('idash-results');
            if (resultsDiv) resultsDiv.style.display = 'none';
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
                    aa.activitySegments = parseActivitySegments(result.html);
                    aa.breakSegments = parseBreakSegments(result.html);
                } else {
                    aa.segments = [];
                    aa.activitySegments = [];
                    aa.breakSegments = [];
                }
            });
            if (!isScanning) return;

            // Step 3b: Fetch PPA clock punches (non-fatal). Used to measure
            // Fast Start / Strong Finish against real clock-in/out.
            setStatus('Loading clock-in / clock-out punches...', '#2980b9');
            let ppaMap = new Map();
            try {
                ppaMap = await fetchPpaAttendance();
            } catch (ppaErr) {
                console.warn('[IdleDash] PPA fetch failed, using activity times:', ppaErr);
            }
            if (!isScanning) return;

            // Step 4: Analyze breaks for each AA (pass clock punches when available)
            setStatus('Analyzing break patterns...', '#e67e22');
            aaList.forEach(aa => {
                const ppa = ppaMap.get(String(aa.employeeId)) || null;
                aa.analysis = analyzeBreaks(aa.segments, ppa, aa.activitySegments || [], aa.breakSegments || []);
            });
            if (!isScanning) return;

            // Step 5: Enrich with login + station (Location). Non-fatal: on
            // failure, login/station stay blank and the scan still completes.
            setStatus('Enriching login & station...', '#16a085');
            try {
                await decorateRowsWithLoginStation(aaList, settings.warehouseId, 'employeeId');
            } catch (enrichErr) {
                console.warn('[IdleDash] Enrichment failed, continuing without login/station:', enrichErr);
                aaList.forEach(aa => {
                    if (aa.login == null) aa.login = '';
                    if (aa.station == null) aa.station = '';
                });
            }
            if (!isScanning) return;

            // Step 6: Calculate thresholds
            setStatus('Calculating thresholds...', '#8e44ad');
            const thresholds = calculateThresholds(aaList);

            // Step 7: Render results (reset manager filter for the new scan)
            scanResults = aaList;
            selectedManagers = null;
            managerSearchTerm = '';
            currentFilter = 'all';
            bottomPctActive = false;
            renderResults(aaList, thresholds);

            setStatus(`Scan complete — ${aaList.length} associates analyzed`, '#27ae60');
            if (exportBtn) exportBtn.disabled = false;

        } catch (error) {
            console.error('[IdleDash] Pipeline error:', error);
            setStatus('Error: ' + (error && error.message ? error.message : String(error)), '#e74c3c');
        } finally {
            isScanning = false;
            if (startBtn)  startBtn.disabled  = false;
            if (stopBtn)   stopBtn.disabled   = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SECTION 13: RENDER RESULTS (TABLES, SUMMARY, FILTERS)
    // ═══════════════════════════════════════════════════════════════

    let currentFilter = 'all';
    let bottomPctActive = false; // "Bottom N%" toggle — intersects with the active card
    let currentSort = { col: 'idle15', dir: 'desc' };
    // Manager filter state: null = all managers shown; otherwise a Set of
    // manager names that are currently selected.
    let selectedManagers = null;
    let managerSearchTerm = '';

    // Managers present in the current scan (sorted, unique, non-empty).
    function getManagerNames(aaList) {
        const set = new Set();
        (aaList || []).forEach(aa => {
            const m = (aa.manager || '').trim();
            if (m) set.add(m);
        });
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    // Rows passing the active filter button (category), before manager filter.
    function applyCategoryFilter(aaList) {
        switch (currentFilter) {
            case 'bottomJPH':         return aaList.filter(a => a.isBottomJPH);
            case 'idleTime':          return aaList.filter(a => a.analysis && a.analysis.isIdleTime);
            case 'missedFastStart':   return aaList.filter(a => a.analysis && a.analysis.missedFastStart);
            case 'break1Abuse':       return aaList.filter(a => a.analysis && a.analysis.break1Abuse);
            case 'break2Abuse':       return aaList.filter(a => a.analysis && a.analysis.break2Abuse);
            case 'missedStrongFinish':return aaList.filter(a => a.analysis && a.analysis.missedStrongFinish);
            case 'breakOffenders':    return aaList.filter(a => a.analysis && a.analysis.isBreakOffender);
            case 'flagged':           return aaList.filter(a => a.isHighlighted);
            default:                  return [...aaList];
        }
    }

    // Given a set of rows, return the bottom N% by idle time (highest idle = worst).
    // "Bottom 8%" = the worst-performing 8% by non-break idle minutes.
    function applyBottomPct(rows) {
        if (!bottomPctActive || !rows.length) return rows;
        const pct = (settings.percentileThreshold || 8) / 100;
        const n = Math.max(1, Math.ceil(rows.length * pct));
        // Sort by non-break idle descending (worst first) and take top N
        const sorted = rows.slice().sort((a, b) => {
            const ia = (a.analysis && a.analysis.nonBreakIdleMinutes) || 0;
            const ib = (b.analysis && b.analysis.nonBreakIdleMinutes) || 0;
            return ib - ia;
        });
        return sorted.slice(0, n);
    }

    // Rows visible after category filter + bottom% + manager filter.
    // Used by both the table renderer and the CSV export so they stay in sync.
    function getVisibleRows(aaList) {
        let rows = applyCategoryFilter(aaList);
        rows = applyBottomPct(rows);
        if (selectedManagers) {
            rows = rows.filter(aa => {
                const m = (aa.manager || '').trim();
                // Rows without a manager stay visible (can't be filtered out).
                return !m || selectedManagers.has(m);
            });
        }
        return rows;
    }

    function renderResults(aaList, thresholds) {
        const resultsDiv = document.getElementById('idash-results');
        resultsDiv.style.display = 'block';

        // Metric counts for the summary cards
        const idleCount   = aaList.filter(a => a.analysis && a.analysis.isIdleTime).length;
        const missedFS    = aaList.filter(a => a.analysis && a.analysis.missedFastStart).length;
        const brk1Count   = aaList.filter(a => a.analysis && a.analysis.break1Abuse).length;
        const brk2Count   = aaList.filter(a => a.analysis && a.analysis.break2Abuse).length;
        const missedSF    = aaList.filter(a => a.analysis && a.analysis.missedStrongFinish).length;

        // All cards are clickable toggles. Total resets to "all".
        const cardCls = (f) => 'idash-summary-card idash-card-clickable' + (currentFilter === f ? ' is-active' : '');
        document.getElementById('idash-summary').innerHTML = `
            <div class="${cardCls('all')}" data-filter="all" title="Show all">
                <div class="num">${aaList.length}</div>
                <div class="label">Total AAs</div>
            </div>
            <div class="${cardCls('idleTime')}" data-filter="idleTime" title="Click to filter">
                <div class="num" style="color:#e74c3c">${idleCount}</div>
                <div class="label">Idle Time</div>
            </div>
            <div class="${cardCls('missedFastStart')}" data-filter="missedFastStart" title="Click to filter">
                <div class="num" style="color:#8e44ad">${missedFS}</div>
                <div class="label">Missed Fast Start</div>
            </div>
            <div class="${cardCls('break1Abuse')}" data-filter="break1Abuse" title="Click to filter">
                <div class="num" style="color:#e67e22">${brk1Count}</div>
                <div class="label">1st Break Abuse</div>
            </div>
            <div class="${cardCls('break2Abuse')}" data-filter="break2Abuse" title="Click to filter">
                <div class="num" style="color:#d35400">${brk2Count}</div>
                <div class="label">2nd Break Abuse</div>
            </div>
            <div class="${cardCls('missedStrongFinish')}" data-filter="missedStrongFinish" title="Click to filter">
                <div class="num" style="color:#2980b9">${missedSF}</div>
                <div class="label">Missed Strong Finish</div>
            </div>
        `;

        // Wire card clicks — toggle: click active card to go back to All
        document.querySelectorAll('.idash-card-clickable').forEach(card => {
            card.onclick = () => {
                const f = card.dataset.filter;
                currentFilter = (currentFilter === f) ? 'all' : f;
                renderResults(aaList, thresholds);
            };
        });

        // Bottom N% toggle — intersects with whichever card is selected.
        // e.g. select "Idle Time" + Bottom 8% = worst 8% by idle among idle-flagged AAs.
        const pct = settings.percentileThreshold || 8;
        document.getElementById('idash-filters').innerHTML = `
            <button class="idash-filter-btn ${bottomPctActive ? 'active' : ''}" id="idash-bottom-pct-btn">
                ${bottomPctActive ? '\u2713 ' : ''}Bottom ${pct}% (worst by idle)
            </button>
            <span style="font:11px 'Segoe UI';color:#7f8c8d;align-self:center;margin-left:6px">
                ${bottomPctActive ? 'Showing worst ' + pct + '% of the selected group' : 'Toggle to show only the worst ' + pct + '%'}
            </span>
        `;
        const bottomBtn = document.getElementById('idash-bottom-pct-btn');
        if (bottomBtn) {
            bottomBtn.onclick = () => {
                bottomPctActive = !bottomPctActive;
                renderResults(aaList, thresholds);
            };
        }

        // Manager filter panel
        renderManagerFilter(aaList, thresholds);

        // Render table
        renderTable(aaList);
    }

    // ── Live Manager Filter (adapted from Track4) ──
    function renderManagerFilter(aaList, thresholds) {
        const host = document.getElementById('idash-manager-filter');
        if (!host) return;
        const managers = getManagerNames(aaList);
        if (!managers.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
        host.style.display = 'block';

        // Initialize selection to "all" the first time.
        if (selectedManagers === null) selectedManagers = new Set(managers);

        const selCount = managers.filter(m => selectedManagers.has(m)).length;
        let summaryText;
        if (selCount === managers.length) summaryText = `Showing all managers (${managers.length})`;
        else if (selCount === 0) summaryText = 'No managers selected';
        else summaryText = `Showing ${selCount} of ${managers.length} managers`;

        const term = managerSearchTerm.trim().toLowerCase();
        const chips = managers.map(m => {
            const checked = selectedManagers.has(m);
            const hidden = term && !m.toLowerCase().includes(term);
            return `<label class="idash-mgr-chip ${checked ? 'is-selected' : ''}" data-mgr="${escapeHtml(m)}" style="${hidden ? 'display:none' : ''}">
                <input type="checkbox" ${checked ? 'checked' : ''} data-mgr-cb="${escapeHtml(m)}">
                <span>${escapeHtml(m)}</span>
            </label>`;
        }).join('');

        host.innerHTML = `
            <div class="idash-mgr-head">
                <div>
                    <div class="idash-mgr-title">Manager Filter</div>
                    <div class="idash-mgr-caption">Filter results by manager instantly — no rescan</div>
                </div>
                <div class="idash-mgr-badge">${managers.length} managers</div>
            </div>
            <div class="idash-mgr-toolbar">
                <input type="text" class="idash-mgr-search" placeholder="Search manager name..." value="${escapeHtml(managerSearchTerm)}">
                <div class="idash-mgr-controls">
                    <button class="idash-mgr-btn is-primary" data-mgr-action="all">All</button>
                    <button class="idash-mgr-btn is-secondary" data-mgr-action="clear">Clear</button>
                </div>
            </div>
            <div class="idash-mgr-summary">${summaryText}</div>
            <div class="idash-mgr-list">${chips}</div>
        `;

        // Wire search (preserve caret by only re-rendering chips visibility)
        const search = host.querySelector('.idash-mgr-search');
        search.oninput = () => {
            managerSearchTerm = search.value;
            const t = managerSearchTerm.trim().toLowerCase();
            host.querySelectorAll('.idash-mgr-chip').forEach(chip => {
                const name = (chip.getAttribute('data-mgr') || '').toLowerCase();
                chip.style.display = (!t || name.includes(t)) ? '' : 'none';
            });
        };

        host.querySelectorAll('[data-mgr-cb]').forEach(cb => {
            cb.onchange = () => {
                const name = cb.getAttribute('data-mgr-cb');
                if (cb.checked) selectedManagers.add(name);
                else selectedManagers.delete(name);
                renderManagerFilter(aaList, thresholds);
                renderTable(aaList);
            };
        });

        host.querySelector('[data-mgr-action="all"]').onclick = () => {
            selectedManagers = new Set(managers);
            renderManagerFilter(aaList, thresholds);
            renderTable(aaList);
        };
        host.querySelector('[data-mgr-action="clear"]').onclick = () => {
            selectedManagers = new Set();
            renderManagerFilter(aaList, thresholds);
            renderTable(aaList);
        };
    }

    function renderTable(aaList) {
        // Apply category + manager filters
        let filtered = getVisibleRows(aaList);

        // Determine which phases are active so we can dim/hide irrelevant columns.
        const phases = getActivePhases();

        // Column definitions. type: 'string' -> localeCompare; 'number' -> numeric; 'time' -> numeric (ms).
        const columns = [
            { key: 'login',                  label: 'Login',                    type: 'string' },
            { key: 'manager',                label: 'Logging Manager',          type: 'string' },
            { key: 'behavioralType',         label: 'Behavioral Type',          type: 'string' },
            { key: 'idleTime',               label: 'Idle Time (min)',          type: 'number' },
            { key: 'paidHours',              label: 'Hours Worked',             type: 'number' },
            { key: 'location',               label: 'Location',                 type: 'string' },
            { key: 'idle15',                 label: 'Instances >15 min',        type: 'number' },
            { key: 'idle30',                 label: 'Instances >30 min',        type: 'number' },
            { key: 'clockIn',                label: 'Clock In',                  type: 'time',   phase: 'fastStart' },
            { key: 'firstScan',              label: 'First Scan',                type: 'time',   phase: 'fastStart' },
            { key: 'break1Time',             label: 'Break 1',                   type: 'string', phase: 'break1' },
            { key: 'lastScanBeforeBreak1',   label: 'Last Scan Before Break 1',  type: 'time',   phase: 'break1' },
            { key: 'firstScanAfterBreak1',   label: 'First Scan After Break 1',  type: 'time',   phase: 'break1' },
            { key: 'lastScanBeforeBreak2',   label: 'Last Scan Before Break 2',  type: 'time',   phase: 'break2' },
            { key: 'firstScanAfterBreak2',   label: 'First Scan After Break 2',  type: 'time',   phase: 'break2' },
            { key: 'lastScan',               label: 'Last Scan',                 type: 'time',   phase: 'strongFinish' }
        ];

        // Filter out columns whose phase hasn't started yet.
        const activeColumns = columns.filter(c => !c.phase || phases[c.phase]);

        const colValue = (aa, key) => {
            const a = aa.analysis || {};
            switch (key) {
                case 'login':                return aa.login || '';
                case 'manager':              return aa.manager || '';
                case 'behavioralType':       return a.behavioralType || '';
                case 'location':             return aa.station || '';
                case 'idleTime':             return a.nonBreakIdleMinutes || 0;
                case 'paidHours':            return aa.paidHours != null ? aa.paidHours : -1;
                case 'idle15':               return a.idleTimestamps15?.length || 0;
                case 'idle30':               return a.idleTimestamps30?.length || 0;
                case 'break1Time':           return a.actualBreak1Start ? a.actualBreak1Start.getTime() : 0;
                case 'clockIn':              return a.clockIn  ? a.clockIn.getTime()  : 0;
                case 'firstScan':            return a.firstScan ? a.firstScan.getTime() : 0;
                case 'lastScanBeforeBreak1': return a.lastScanBeforeBreak1 ? a.lastScanBeforeBreak1.getTime() : 0;
                case 'firstScanAfterBreak1': return a.firstScanAfterBreak1 ? a.firstScanAfterBreak1.getTime() : 0;
                case 'lastScanBeforeBreak2': return a.lastScanBeforeBreak2 ? a.lastScanBeforeBreak2.getTime() : 0;
                case 'firstScanAfterBreak2': return a.firstScanAfterBreak2 ? a.firstScanAfterBreak2.getTime() : 0;
                case 'lastScan':             return a.lastScan  ? a.lastScan.getTime()  : 0;
                default: return '';
            }
        };

        const sortCol = activeColumns.find(c => c.key === currentSort.col)
            || columns.find(c => c.key === currentSort.col);
        const sortType = sortCol ? sortCol.type : 'number';

        // Apply sort
        filtered.sort((a, b) => {
            const va = colValue(a, currentSort.col);
            const vb = colValue(b, currentSort.col);
            if (sortType === 'string') {
                const sa = String(va), sb = String(vb);
                return currentSort.dir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
            }
            return currentSort.dir === 'asc' ? va - vb : vb - va;
        });

        const arrow = (col) => {
            if (currentSort.col !== col) return '';
            return `<span class="sort-arrow">${currentSort.dir === 'asc' ? '\u25B2' : '\u25BC'}</span>`;
        };

        let html = '<table class="idash-table"><thead><tr>';
        activeColumns.forEach(col => {
            html += `<th data-sort="${col.key}">${col.label}${arrow(col.key)}</th>`;
        });
        html += '</tr></thead><tbody>';

        filtered.forEach(aa => {
            const a = aa.analysis || {};
            let rowClass = '';
            if (aa.isBottomJPH && aa.isTopBreakOffender) rowClass = 'row-both';
            else if (aa.isBottomJPH) rowClass = 'row-bottom-jph';
            else if (aa.isTopBreakOffender) rowClass = 'row-break-offender';

            // Login cell — link to timeDetails when we have a href.
            const loginText = aa.login || aa.employeeId || '\u2013';
            const loginCell = aa.timeDetailsHref
                ? `<a href="${escapeHtml(aa.timeDetailsHref)}" target="_blank" title="${escapeHtml(aa.name || '')}">${escapeHtml(loginText)}</a>`
                : `<span title="${escapeHtml(aa.name || '')}">${escapeHtml(loginText)}</span>`;

            const behavioralType = a.behavioralType || 'Normal';
            const isNormal = behavioralType === 'Normal';

            // Instances with hover timestamps
            const idle15Count = a.idleTimestamps15?.length || 0;
            const idle30Count = a.idleTimestamps30?.length || 0;
            const buildTitle = (list) => (list || []).map(t =>
                `${formatTimeShort(t.start)}\u2192${formatTimeShort(t.end)} (${t.duration.toFixed(0)}m)`
            ).join('\n');
            const idle15Title = buildTitle(a.idleTimestamps15);
            const idle30Title = buildTitle(a.idleTimestamps30);

            // Build cells for each active column
            const cells = activeColumns.map(col => {
                switch (col.key) {
                    case 'login':
                        return `<td>${loginCell}</td>`;
                    case 'manager':
                        return `<td>${escapeHtml(aa.manager || '\u2013')}</td>`;
                    case 'behavioralType':
                        return `<td style="color:${isNormal ? '#27ae60' : '#e74c3c'};font-weight:600">${escapeHtml(behavioralType)}</td>`;
                    case 'idleTime':
                        return `<td>${(a.nonBreakIdleMinutes || 0).toFixed(1)}</td>`;
                    case 'paidHours':
                        return aa.paidHours != null
                            ? `<td style="font-weight:600;color:#27ae60">${aa.paidHours.toFixed(2)}</td>`
                            : `<td>\u2013</td>`;
                    case 'location':
                        return `<td>${escapeHtml(aa.station || '\u2013')}</td>`;
                    case 'idle15':
                        return `<td title="${escapeHtml(idle15Title)}" style="color:${idle15Count > 0 ? '#e74c3c' : '#27ae60'}">${idle15Count > 0 ? idle15Count : '\u2713'}</td>`;
                    case 'idle30':
                        return `<td title="${escapeHtml(idle30Title)}" style="color:${idle30Count > 0 ? '#e74c3c' : '#27ae60'}">${idle30Count > 0 ? idle30Count : '\u2713'}</td>`;
                    case 'break1Time':
                        return a.actualBreak1Start && a.actualBreak1End
                            ? `<td style="color:#e67e22;font-weight:600">${formatTimeShort(a.actualBreak1Start)}\u2013${formatTimeShort(a.actualBreak1End)}</td>`
                            : `<td>\u2013</td>`;
                    case 'clockIn':
                        return `<td>${a.clockIn ? formatTimeShort(a.clockIn) : '\u2013'}</td>`;
                    case 'firstScan':
                        return `<td>${a.firstScan ? formatTimeShort(a.firstScan) : '\u2013'}</td>`;
                    case 'lastScanBeforeBreak1':
                        return `<td>${a.lastScanBeforeBreak1 ? formatTimeShort(a.lastScanBeforeBreak1) : '\u2013'}</td>`;
                    case 'firstScanAfterBreak1':
                        return `<td>${a.firstScanAfterBreak1 ? formatTimeShort(a.firstScanAfterBreak1) : '\u2013'}</td>`;
                    case 'lastScanBeforeBreak2':
                        return `<td>${a.lastScanBeforeBreak2 ? formatTimeShort(a.lastScanBeforeBreak2) : '\u2013'}</td>`;
                    case 'firstScanAfterBreak2':
                        return `<td>${a.firstScanAfterBreak2 ? formatTimeShort(a.firstScanAfterBreak2) : '\u2013'}</td>`;
                    case 'lastScan':
                        return `<td>${a.lastScan ? formatTimeShort(a.lastScan) : '\u2013'}</td>`;
                    default:
                        return '<td>\u2013</td>';
                }
            }).join('');

            html += `<tr class="${rowClass}">${cells}</tr>`;
        });

        html += '</tbody></table>';

        document.getElementById('idash-table-wrap').innerHTML = html;

        // Wire sorting
        document.querySelectorAll('.idash-table th[data-sort]').forEach(th => {
            th.onclick = () => {
                const col = th.dataset.sort;
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

        const phases = getActivePhases();

        const headers = ['Login', 'Employee ID', 'Logging Manager', 'Behavioral Type',
            'Idle Time (min)', 'Hours Worked', 'Location', 'Instances >15 min', 'Instances >30 min',
            'Gaps >15m Timestamps'];

        // Add timing columns only for phases that have started.
        if (phases.fastStart) headers.push('Clock In', 'First Scan');
        if (phases.break1)    headers.push('Break 1', 'Last Scan Before Break 1', 'First Scan After Break 1');
        if (phases.break2)    headers.push('Last Scan Before Break 2', 'First Scan After Break 2');
        if (phases.strongFinish) headers.push('Last Scan');

        // Export only the rows currently visible (respects category + manager filters).
        const visibleRows = getVisibleRows(scanResults);
        if (!visibleRows.length) {
            setStatus('No visible rows to export (check filters)', '#e74c3c');
            return;
        }

        const rows = visibleRows.map(aa => {
            const a = aa.analysis || {};
            const ts15 = (a.idleTimestamps15 || []).map(t =>
                `${formatTimeShort(t.start)}-${formatTimeShort(t.end)}(${t.duration.toFixed(0)}m)`
            ).join('; ');
            const row = [
                aa.login || '',
                aa.employeeId || '',
                aa.manager || '',
                a.behavioralType || 'Normal',
                (a.nonBreakIdleMinutes || 0).toFixed(1),
                aa.station || '',
                aa.paidHours != null ? aa.paidHours.toFixed(2) : '',
                (a.idleTimestamps15 || []).length,
                (a.idleTimestamps30 || []).length,
                ts15
            ];
            if (phases.fastStart) {
                row.push(a.clockIn   ? formatTimeShort(a.clockIn)   : '');
                row.push(a.firstScan ? formatTimeShort(a.firstScan) : '');
            }
            if (phases.break1) {
                row.push(a.actualBreak1Start && a.actualBreak1End
                    ? `${formatTimeShort(a.actualBreak1Start)}-${formatTimeShort(a.actualBreak1End)}`
                    : '');
                row.push(a.lastScanBeforeBreak1  ? formatTimeShort(a.lastScanBeforeBreak1)  : '');
                row.push(a.firstScanAfterBreak1  ? formatTimeShort(a.firstScanAfterBreak1)  : '');
            }
            if (phases.break2) {
                row.push(a.lastScanBeforeBreak2  ? formatTimeShort(a.lastScanBeforeBreak2)  : '');
                row.push(a.firstScanAfterBreak2  ? formatTimeShort(a.firstScanAfterBreak2)  : '');
            }
            if (phases.strongFinish) {
                row.push(a.lastScan ? formatTimeShort(a.lastScan) : '');
            }
            return row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
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

        // (Transfer miss tracking removed — summary modal no longer shown)

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

    // Night Shift quick-fill button — fills the FCLM date/time form fields
    // with 18:15 → 04:45 and auto-detects the correct start/end date based
    // on the current time. Shows on all matched FCLM pages.
    function createNightShiftButton() {
        // Don't add twice
        if (document.getElementById('idash-night-shift-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'idash-night-shift-btn';
        btn.textContent = '\uD83C\uDF19 Night Shift (18:15 \u2192 04:45)';
        btn.style.cssText = [
            'position:fixed', 'bottom:24px', 'right:24px',
            'background:linear-gradient(135deg,#1a1a2e,#16213e)',
            'color:#fff', 'border:none', 'border-radius:8px',
            'padding:10px 16px', 'cursor:pointer', 'z-index:999998',
            'font:700 13px "Segoe UI",sans-serif',
            'box-shadow:0 4px 14px rgba(0,0,0,.35)',
            'transition:transform .12s ease,box-shadow .12s ease'
        ].join(';');
        btn.onmouseenter = () => {
            btn.style.transform = 'translateY(-2px)';
            btn.style.boxShadow = '0 8px 20px rgba(0,0,0,.4)';
        };
        btn.onmouseleave = () => {
            btn.style.transform = '';
            btn.style.boxShadow = '0 4px 14px rgba(0,0,0,.35)';
        };

        btn.onclick = () => {
            const now = new Date();
            const hour = now.getHours();
            let startDate, endDate;

            // 18:00–23:59 → tonight starting, ends tomorrow morning
            // 00:00–04:59 → started last night, ends today
            // Otherwise (daytime) → default to upcoming night shift
            if (hour >= 18) {
                startDate = new Date(now);
                endDate   = new Date(now);
                endDate.setDate(endDate.getDate() + 1);
            } else if (hour < 5) {
                startDate = new Date(now);
                startDate.setDate(startDate.getDate() - 1);
                endDate = new Date(now);
            } else {
                startDate = new Date(now);
                endDate   = new Date(now);
                endDate.setDate(endDate.getDate() + 1);
            }

            const fmt = d =>
                d.getFullYear() + '/' +
                String(d.getMonth() + 1).padStart(2, '0') + '/' +
                String(d.getDate()).padStart(2, '0');

            // Select Intraday span type if the radio exists
            const intradayRadio = document.querySelector('input[name="spanType"][value="Intraday"]');
            if (intradayRadio) { intradayRadio.checked = true; intradayRadio.click(); }

            // Fill start date/hour/minute
            const sdEl = document.getElementById('startDateIntraday');
            const shEl = document.getElementById('startHourIntraday');
            const smEl = document.getElementById('startMinuteIntraday');
            if (sdEl) sdEl.value = fmt(startDate);
            if (shEl) shEl.value = '18';
            if (smEl) smEl.value = '15';

            // Fill end date/hour/minute
            const edEl = document.getElementById('endDateIntraday');
            const ehEl = document.getElementById('endHourIntraday');
            const emEl = document.getElementById('endMinuteIntraday');
            if (edEl) edEl.value = fmt(endDate);
            if (ehEl) ehEl.value = '4';
            if (emEl) emEl.value = '45';

            // Visual feedback
            const original = btn.textContent;
            btn.textContent = `\u2713 Set! (${fmt(startDate)} \u2192 ${fmt(endDate)})`;
            btn.style.background = 'linear-gradient(135deg,#27ae60,#1e8449)';
            setTimeout(() => {
                btn.textContent = original;
                btn.style.background = 'linear-gradient(135deg,#1a1a2e,#16213e)';
            }, 3000);
        };

        document.body.appendChild(btn);
    }

    // Run the in-page enhancement (auto on functionRollup page)
    function runInPageEnhancement() {
        if (!location.pathname.includes('/reports/functionRollup')) return;
        if (document.querySelector('th[data-custom]')) return; // already injected
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
        // Night shift quick-fill button appears on ALL matched FCLM pages,
        // including individual AA timeDetails pages.
        try { createNightShiftButton(); } catch (e) { console.error('[IdleDash] night shift btn error:', e); }

        // Don't show the full dashboard panel on individual AA timeDetails pages —
        // it's irrelevant there and clutters the view.
        if (location.pathname.includes('/employee/timeDetails')) return;

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
