// ==UserScript==
// @name         SIM Resolved By Export
// @namespace    joyhjoe/sim-resolved-by-export
// @version      3.0
// @description  On a SIM search page: scans all result pages and downloads an Excel file with Ticket ID, Resolved Date, Resolved By. Automation resolvers (aws:sts…) are replaced by the real AA from the ticket's communication thread ("… on behalf of <login>").
// @match        https://t.corp.amazon.com/*
// @grant        GM_xmlhttpRequest
// @connect      sim-ticketing-graphql-fleet.corp.amazon.com
// ==/UserScript==

// Read-only: scrapes the visible SIM list and, for aws:sts resolutions, reads the ticket thread
// (issueOverview + threadComments). Nothing is written to SIM.

(function () {
    'use strict';

    const SIM_GQL_URL = 'https://sim-ticketing-graphql-fleet.corp.amazon.com/graphql';
    const SIM_ORIGIN = 'https://t.corp.amazon.com';
    const TICKET_ID_RE = /\b[A-Za-z]\d{6,}\b/;          // V2435547834, D569435344, …
    const RESOLVER_CACHE_KEY = 'sim_resolver_cache_v1';  // per-ticket AA cache (resolver never changes)
    const RESOLVER_CACHE_MAX = 5000;
    const CONCURRENCY = 20;   // parallel AA lookups; rate-limit errors still back off and retry
    const MAX_RETRIES = 4;
    const RETRY_BASE_MS = 1500;
    const MAX_PAGES = 2000;
    const BTN_LABEL = '📥 Export Resolved By';

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isMachine = s => /^(aws:|arn:)/i.test(String(s || '').trim());
    const isResolvedStatus = s => /\b(Resolved|Closed)\b/i.test(String(s || ''));

    // --- Column detection (SIM's data-focus-id first, header text as fallback) ---
    function getColumns() {
        const ths = Array.from(document.querySelectorAll('th'));
        const headers = ths.map(th => (th.innerText || '').trim());
        const fids = ths.map(th => th.getAttribute('data-focus-id') || '');
        const byFid = re => fids.findIndex(f => re.test(f));
        const byText = res => { for (const re of res) { const i = headers.findIndex(h => re.test(h)); if (i > -1) return i; } return -1; };
        const pick = (fidRe, textRes) => { const i = byFid(fidRe); return i > -1 ? i : byText(textRes); };
        return {
            ticket: pick(/^header-alias$/i, [/Short ID/i, /^Key$/i, /Ticket/i, /^ID$/i]),
            status: pick(/^header-status$/i, [/^Status$/i, /Status/i]),
            resolvedBy: pick(/resolvedby/i, [/^Resolved By$/i, /Resolved By/i]),
            resolvedDate: pick(/resolveddate|resolutiondate/i, [/^Resolved Date$/i, /Resolved Date/i, /Resolution Date/i])
        };
    }

    function cellText(cells, idx) {
        return (idx > -1 && cells[idx]) ? (cells[idx].innerText || '').trim().split('\n')[0].trim() : '';
    }

    function scrapePage(cols) {
        const out = [];
        document.querySelectorAll('tbody tr').forEach(row => {
            const cells = row.querySelectorAll('td');
            const m = cellText(cells, cols.ticket).match(TICKET_ID_RE);
            if (!m) return;
            out.push({
                id: m[0],
                status: cellText(cells, cols.status),
                resolvedByRaw: cellText(cells, cols.resolvedBy),
                resolvedDate: cellText(cells, cols.resolvedDate)
            });
        });
        return out;
    }

    function firstTicketId(cols) {
        for (const row of document.querySelectorAll('tbody tr')) {
            const m = cellText(row.querySelectorAll('td'), cols.ticket).match(TICKET_ID_RE);
            if (m) return m[0];
        }
        return null;
    }

    function nextPageButton() {
        return Array.from(document.querySelectorAll('button'))
            .filter(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('next page'))
            .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0)
            .pop() || null;
    }

    // --- SIM GraphQL (same operations the SIM UI uses) ---
    const QUERY_ISSUE = 'query issueOverview($issueId: String!) {\n  issue(id: $issueId) {\n    id\n    shortId\n    alias\n    title\n    status\n    __typename\n  }\n}';
    const QUERY_THREAD = 'query threadComments($threadId: String!, $start: Int, $rows: Int, $sort: CommentSortOrder) {\n' +
        '  thread(id: $threadId) {\n    id\n    totalCount\n    conversation(start: $start, rows: $rows, sort: $sort) {\n      ...ThreadComment\n      __typename\n    }\n    __typename\n  }\n}\n\n' +
        'fragment ThreadComment on Comment {\n  id\n  message\n  contentType\n  messageType\n  messageClassification\n  lastUpdatedDate\n  createDate\n' +
        '  author {\n    id\n    name\n    protocol\n    __typename\n  }\n  submitter {\n    id\n    name\n    protocol\n    __typename\n  }\n' +
        '  mentions\n  metadata {\n    id\n    value\n    __typename\n  }\n  __typename\n}\n';

    function gql(operationName, query, variables) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST', url: SIM_GQL_URL, anonymous: false, timeout: 30000,
                headers: { 'Content-Type': 'application/json', 'Accept': '*/*', 'Origin': SIM_ORIGIN, 'Referer': SIM_ORIGIN + '/' },
                data: JSON.stringify({ operationName, query, variables }),
                onload: r => {
                    if (r.status === 429) return resolve({ ok: false, error: 'rate exceeded', rate: true });
                    if (r.status !== 200) return resolve({ ok: false, error: 'HTTP ' + r.status });
                    try {
                        const json = JSON.parse(r.responseText);
                        if (json.errors && json.errors.length) {
                            const em = json.errors.map(e => e.message || String(e)).join('; ');
                            return resolve({ ok: false, error: em, rate: /rate exceeded|too many/i.test(em) });
                        }
                        resolve({ ok: true, data: json.data });
                    } catch (e) { resolve({ ok: false, error: 'not logged in (Midway)?' }); }
                },
                onerror: () => resolve({ ok: false, error: 'network' }),
                ontimeout: () => resolve({ ok: false, error: 'timeout' })
            });
        });
    }

    async function gqlRetry(op, q, v) {
        for (let attempt = 0; ; attempt++) {
            const res = await gql(op, q, v);
            if (res.ok || !res.rate || attempt >= MAX_RETRIES) return res;
            await sleep(RETRY_BASE_MS * (attempt + 1));
        }
    }

    // Identity → plain login; '' for role/machine identities.
    function toLogin(ident) {
        if (!ident) return '';
        let raw = String(ident.id || ident.name || '').trim();
        const proto = String(ident.protocol || '').toLowerCase();
        if (!raw || /^aws:|^arn:|assumed-role|^role:/i.test(raw) || proto === 'aws' || proto === 'iam') return '';
        raw = raw.replace(/^(kerberos|midway|amazon|ldap|posix):/i, '').replace(/@.*$/, '');
        return /^[a-z0-9._-]{2,}$/i.test(raw) ? raw.toLowerCase() : '';
    }

    const RESOLUTION_MSG_RE = /(^|\n)\s*(Answers\s*:|Resolution\s*:|Expiry Date Flip\s*:|Employee ID\s*:)/i;

    // Newest resolution-style comment → the human behind it ("<role> on behalf of <login>").
    async function lookupAa(ticketId) {
        const r1 = await gqlRetry('issueOverview', QUERY_ISSUE, { issueId: ticketId });
        if (!r1.ok) return '';
        const iss = r1.data && r1.data.issue;
        if (!iss) return '';
        const r2 = await gqlRetry('threadComments', QUERY_THREAD, { threadId: 'updates:' + iss.id, start: 0, rows: 1000, sort: 'newest_first' });
        if (!r2.ok) return '';
        const list = (r2.data && r2.data.thread && r2.data.thread.conversation) || [];
        const c = list.find(x => RESOLUTION_MSG_RE.test(x.message || '')) || list.find(x => toLogin(x.author) || toLogin(x.submitter));
        if (!c) return '';
        const onBehalf = ((c.message || '').match(/on behalf of\s+([a-z0-9._-]+)/i) || [])[1] || '';
        return toLogin(c.author) || toLogin(c.submitter) || onBehalf.toLowerCase();
    }

    function loadCache() {
        try { const c = JSON.parse(localStorage.getItem(RESOLVER_CACHE_KEY)); return (c && typeof c === 'object') ? c : {}; }
        catch (e) { return {}; }
    }
    function saveCache(cache) {
        try {
            const keys = Object.keys(cache);
            if (keys.length > RESOLVER_CACHE_MAX) {
                keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
                keys.slice(0, keys.length - RESOLVER_CACHE_MAX).forEach(k => delete cache[k]);
            }
            localStorage.setItem(RESOLVER_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {}
    }

    // --- Excel output (CSV with BOM → opens directly in Excel) ---
    function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

    function downloadExcel(rows) {
        const lines = ['Ticket ID,Resolved Date,Resolved By'].concat(rows.map(r => [r.id, r.resolvedDate, r.resolvedBy].map(csvCell).join(',')));
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'SIM_Resolved_By_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // --- Main run ---
    let running = false, cancel = false;

    async function run(btn) {
        if (running) { cancel = true; btn.textContent = 'Cancelling…'; return; }
        const cols = getColumns();
        if (cols.ticket === -1) { alert('Could not find the Short ID column on this page.'); return; }
        if (cols.resolvedBy === -1 || cols.resolvedDate === -1) {
            if (!confirm('The "Resolved By" and/or "Resolved Date" column is not shown in this SIM view.\n\nAdd them via the table settings for best results.\n\nContinue anyway? (missing values will be blank / looked up)')) return;
        }
        running = true; cancel = false;
        try {
            // 1) Scan every page.
            const tickets = new Map();
            let page = 0, stalls = 0;
            while (page < MAX_PAGES && !cancel) {
                page++;
                btn.textContent = `Page ${page} (${tickets.size}) — click to cancel`;
                const before = tickets.size;
                scrapePage(cols).forEach(t => { if (!tickets.has(t.id)) tickets.set(t.id, t); });
                stalls = tickets.size === before ? stalls + 1 : 0;
                if (stalls >= 2) break;
                const next = nextPageButton();
                if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') break;
                const first = firstTicketId(cols);
                next.click();
                for (let w = 0; w < 20 && !cancel; w++) {
                    await sleep(500);
                    const now = firstTicketId(cols);
                    if (now && now !== first) break;
                }
            }

            // 2) Keep resolved tickets only (status Resolved/Closed, or has a Resolved Date).
            const rows = Array.from(tickets.values()).filter(t => isResolvedStatus(t.status) || t.resolvedDate || (cols.status === -1 && t.resolvedByRaw));

            // 3) Resolved By: human from list as-is; aws:sts/empty → AA from the thread.
            const cache = loadCache();
            const pending = [];
            rows.forEach(t => {
                if (t.resolvedByRaw && !isMachine(t.resolvedByRaw)) t.resolvedBy = t.resolvedByRaw.toLowerCase();
                else if (cache[t.id] && cache[t.id].login) t.resolvedBy = cache[t.id].login;
                else pending.push(t);
            });
            let next = 0, done = 0;
            async function worker() {
                while (next < pending.length && !cancel) {
                    const t = pending[next++];
                    let login = '';
                    try { login = await lookupAa(t.id); } catch (e) {}
                    t.resolvedBy = login || t.resolvedByRaw || '';   // fall back to raw value if no AA found
                    if (login) cache[t.id] = { login, ts: Date.now() };
                    done++;
                    btn.textContent = `Resolving AA ${done}/${pending.length} — click to cancel`;
                    await sleep(250);
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
            saveCache(cache);
            rows.forEach(t => { if (t.resolvedBy == null) t.resolvedBy = t.resolvedByRaw || ''; });

            if (!rows.length) { alert('No resolved tickets found in this search.'); return; }
            downloadExcel(rows);
        } catch (e) {
            console.error('[SIM Resolved By Export]', e);
            alert('Export failed — see console for details.');
        } finally {
            running = false; cancel = false;
            btn.textContent = BTN_LABEL;
        }
    }

    // --- Button (only on pages with a SIM results table) ---
    function injectButton() {
        let btn = document.getElementById('tm-resolved-by-export');
        const valid = getColumns().ticket !== -1 && document.querySelector('tbody tr');
        if (!valid) { if (btn && !running) btn.style.display = 'none'; return; }
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'tm-resolved-by-export';
            btn.textContent = BTN_LABEL;
            btn.style.cssText = 'position:fixed;bottom:32px;left:32px;z-index:2147483647;padding:12px 20px;background:#232F3E;color:#fff;' +
                'border:none;border-radius:100px;font:600 14px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);';
            btn.addEventListener('click', () => run(btn));
            document.documentElement.appendChild(btn);
        }
        btn.style.display = 'block';
    }

    let t = null;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(injectButton, 300); })
        .observe(document.body, { childList: true, subtree: true });
    injectButton();
})();
