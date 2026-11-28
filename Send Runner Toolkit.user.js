// ==UserScript==
// @name         Send Runner Toolkit (Barcode + Opened + CPT + ASIN/Floor)
// @namespace    send-runner-toolkit
// @author       dmitrijk (edited by joyhjoe)
// @version      10.28
// @updateURL     https://raw.githubusercontent.com/joyhjoe1997-alt/tampermonkey-scripts/main/Send%20Runner%20Toolkit.user.js
// @downloadURL   https://raw.githubusercontent.com/joyhjoe1997-alt/tampermonkey-scripts/main/Send%20Runner%20Toolkit.user.js
// @description  Send Runner helper for POPS (aft-pops-dub). LIST: hides cards in non-pickable locations (tsX, tsp, tsAFE, st, chAFE_Ovg); each card shows one compact strip - item picture, CPT from Rodeo (yellow when due within 30 min, red when overdue, urgent cards first), floor (P1/P2/P3/P4), the bin to pick, its POD and the ASIN (tap to copy); cards on the floor chosen in "My floor" come next; bins are taken from the item's POPS location list once seen, otherwise from FCResearch (pick bins with Consumer UNOWNED and Disposition SELLABLE only), floor and POD from roboscout (max 10 new bin lookups per ASIN). SCAN BAR at the bottom of the list: scan a location (P-...) and the matching item opens; the script selects exactly that location and confirms "Scan Pick Bin" with the same scan, then the associate scans the item and AUTOFINISH scans the floor's collection tote (tsXpsfpick11/22/33/44) and presses Continue. OTHER SCREENS: item picture (200 px) on every step, first bin on your floor with barcode + Print on "Select location", barcode and Printmon Print button next to bin IDs. BOXES under the top bar: Bin / SKU barcode, Trolley barcode, My floor (paKivaA01-04), Click history (10 h, with picture, ASIN, location, floor, POD and barcodes). Rodeo is read when the page opens, when the tab or the list is shown again, and for new bins. Rows tinted green when opened / red when new; that history clears at shift change (08:00 / 18:30).
// @match        https://aft-pops-dub.aka.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addElement
// @run-at       document-start
// @connect      amazon.com
// @connect      rodeo-dub.amazon.com
// @connect      localhost
// @connect      roboscout.amazon.com
// @connect      fcresearch-eu.aka.amazon.com
// ==/UserScript==

// Change history (short): 7.x barcode, OPENED tracker, CPT, ASIN, floor/POD, pictures; 8.x My floor, click history,
// location box, scan bar, auto steps; 9.0 pre-loading removed (it assigned one-location items); 9.1 FCResearch bins;
// 9.2 compact card strip; 9.4-9.7 on-screen auto steps; 9.8 boxes in the page, stable pictures; 9.9 UNOWNED + SELLABLE only;
// 10.0 author dmitrijk, own Tamarin update URL, dead code removed, page listener report-only, Rodeo read on open instead of every 20 s;
// 10.1 picture during auto steps, wider/bolder card strip, autofinish (tote + Continue);
// 10.2 roboscout's floor wins over POPS's floor everywhere (POPS can be out of date), floor re-check once a day;
// 10.3 one stable item picture box at the top of every item step, auto-steps picture centred and never doubled, autofinish for every item;
// 10.4 a scanned location no longer on the list copies a "vanished from SR" report (location, floor, POD, ASIN, title, last seen);
// 10.5 auto-steps picture box starts clean for every item (no piled-up barcodes/CPT), item picture falls back to the card opened last, card's own location text hidden;
// 10.6 "Barcode gen" box, barcodes edge to edge (open box takes the full row, history barcodes full width), item picture also at the bottom of the page;
// 10.7 card's original location always checked too (11th) and preferred, P-1-B bins always P1 (no lookup), pre-scan of the item during the auto steps;
// 10.8 vanished report wording; 10.9 floor question at the start of each shift;
// 10.10 several units of one item: OPENED tracked per pick, and each unit gets its own bin;
// 10.11 card shows the location's barcode and a "Pick This Location" button (selects that location in POPS, then stops);
// 10.12 Pick This Location now runs in the background, the screen stays on the list;
// 10.13 page listener also catches relative 'wf/...' addresses, built-in SEND_RUNNER_BUTTON start request;
// 10.14 list-screen headings hidden; 10.15 Pick This Location falls back to a POPS-listed bin on your floor and the card follows it, identical units open without asking;
// 10.16 card barcode only shown after a confirmed (green) Pick This Location, for the bin really picked;
// 10.17 Pick This Location button and barcode only on cards whose bin is on the associate's floor;
// 10.18 Pick This Location always uses a POPS location on your floor (up to 3 tried), errors name the step, cards hidden while their locations are checked.
// 10.19 P1 floor support; isMyFloor compares floor numbers (fixes "your floor" never matching roboscout floors); isP1Bin covers all P-1-x bins; nextPageUrl » regex fixed; renderBarcode128SVG memoized; pickedLocs TTL guards non-number values; checkSince pruned each scan; bgBusy cleared on pick error; fcrImgBudget log cached in memory; leafCache set inside leafElements.
// 10.28 merged the new original script (dmitrijk's own "10.19": "Select location" shows only the location list, scanner picture hidden, no barcode/CPT decoration on that screen); every edit from 10.19 to 10.27 below is kept.
// 10.27 fewer roboscout lookups: no extra bins (and no ASIN lookup) for a card whose own bin is on your floor (single units only); extra bins of an ASIN stop being looked up, and queued ones are dropped, once enough bins on your floor are known; cards on screen (IntersectionObserver) are looked up before the ones below.
// 10.26 FCResearch "bins holding this ASIN" lookups run 4 at a time instead of 2.
// 10.25 header: author line now reads "dmitrijk (edited by joyhjoe)".
// 10.24 sorting: cards inside each group (urgent / your floor / other floors) are sorted by CPT, soonest first; the sort also works when the cards sit in more than one container.
// 10.23 faster list: cards show at once (dimmed, floor "P…") instead of being hidden up to 20 s; each card's own bin is looked up first; 5 roboscout lookups at a time; no POPS-list floor shown while checking (stops P3 -> P2 jumps); barcode walk skipped on the list; repaint every 700 ms instead of 400.
// 10.22 roboscout "Unknown" floor/POD answers are treated as no answer (they showed as "P?" / "POD Unknown" and blocked the FCResearch fallback); cached Unknown entries purged.
// 10.21 floor falls back to FCResearch Container Details when roboscout has no answer (floor only, roboscout asked again after 30 min); P1 bins use paKivaA01 so they match "My floor" P1.
// 10.20 two-pass rendering: list cards shown immediately (pass 1), card strips/CPT/barcodes/picture deferred one frame (pass 2) so the list is visible before heavy decoration runs.

(function () {
    'use strict';

    // =========================================================================
    // SECTION 1: Onscreen Barcode Fallback
    // Draws a Code 39 barcode under every bin ID on the page. The wrapper
    // carries a marker class so the other sections can ignore it.
    // =========================================================================

    // Standard Code 39 widths table: 9 elements per character
    // (bar, space, bar, space, bar, space, bar, space, bar), 1 = narrow, 2 = wide.
    var CODE39 = {
        '0': [1,1,1,2,2,1,2,1,1], '1': [2,1,1,2,1,1,1,1,2], '2': [1,1,2,2,1,1,1,1,2],
        '3': [2,1,2,2,1,1,1,1,1], '4': [1,1,1,2,2,1,1,1,2], '5': [2,1,1,2,2,1,1,1,1],
        '6': [1,1,2,2,2,1,1,1,1], '7': [1,1,1,2,1,1,2,1,2], '8': [2,1,1,2,1,1,2,1,1],
        '9': [1,1,2,2,1,1,2,1,1], 'A': [2,1,1,1,1,2,1,1,2], 'B': [1,1,2,1,1,2,1,1,2],
        'C': [2,1,2,1,1,2,1,1,1], 'D': [1,1,1,1,2,2,1,1,2], 'E': [2,1,1,1,2,2,1,1,1],
        'F': [1,1,2,1,2,2,1,1,1], 'G': [1,1,1,1,1,2,2,1,2], 'H': [2,1,1,1,1,2,2,1,1],
        'I': [1,1,2,1,1,2,2,1,1], 'J': [1,1,1,1,2,2,2,1,1], 'K': [2,1,1,1,1,1,1,2,2],
        'L': [1,1,2,1,1,1,1,2,2], 'M': [2,1,2,1,1,1,1,2,1], 'N': [1,1,1,1,2,1,1,2,2],
        'O': [2,1,1,1,2,1,1,2,1], 'P': [1,1,2,1,2,1,1,2,1], 'Q': [1,1,1,1,1,1,2,2,2],
        'R': [2,1,1,1,1,1,2,2,1], 'S': [1,1,2,1,1,1,2,2,1], 'T': [1,1,1,1,2,1,2,2,1],
        'U': [2,2,1,1,1,1,1,1,2], 'V': [1,2,2,1,1,1,1,1,2], 'W': [2,2,2,1,1,1,1,1,1],
        'X': [1,2,1,1,2,1,1,1,2], 'Y': [2,2,1,1,2,1,1,1,1], 'Z': [1,2,2,1,2,1,1,1,1],
        '-': [1,2,1,1,1,1,2,1,2], '.': [2,2,1,1,1,1,2,1,1], ' ': [1,2,2,1,1,1,2,1,1],
        '$': [1,2,1,2,1,2,1,1,1], '/': [1,2,1,2,1,1,1,2,1], '+': [1,2,1,1,1,2,1,2,1],
        '%': [1,1,1,2,1,2,1,2,1], '*': [1,2,1,1,2,1,2,1,1]
    };

    function isBinLocationStrict(code) {
        return /^P-\d+-[A-Z0-9]+$/.test(code);
    }

    // ---- Code 128B renderer (supports lowercase, unlike Code 39) ------------
    // Trolley codes like "tsXpsfpick34" are case-sensitive and contain
    // lowercase, which Code 39 cannot represent. Code 128B covers ASCII 32-126
    // including lowercase, so the scanned value comes back EXACTLY as typed.
    // 1.2x. Applied by scaling the SVG, not the module width.
    var BARCODE_SCALE = 1.2;
    var CODE128_PATTERNS = [
        '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
        '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
        '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
        '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
        '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
        '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
        '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
        '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
        '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
        '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
        '114131','311141','411131','211412','211214','211232','2331112'
    ];
    // Returns the module-width string for the whole symbol, or null if any
    // character is outside Code 128B's range.
    function code128Bmodules(text) {
        var codes = [104]; // Start B
        for (var i = 0; i < text.length; i++) {
            var v = text.charCodeAt(i) - 32;
            if (v < 0 || v > 94) return null;
            codes.push(v);
        }
        var sum = 104;
        for (var j = 1; j < codes.length; j++) sum += codes[j] * j;
        codes.push(sum % 103); // checksum
        codes.push(106);       // Stop
        var out = '';
        for (var k = 0; k < codes.length; k++) out += CODE128_PATTERNS[codes[k]];
        return out;
    }
    // 10.6: stretch a drawn barcode to the full width of its box (edge to edge,
    // the white quiet zone included) so it can always be scanned
    function fitBarcode(container) {
        var s = container && container.querySelector('svg');
        if (!s) return;
        s.style.width = '100%';
        s.style.height = 'auto';
        s.style.maxWidth = 'none';
        s.style.display = 'block';
        s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        container.style.overflow = 'visible';
    }
    function svgText(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function renderBarcode128SVG(text) {
        if (svgMemo[text]) return svgMemo[text];
        var modules = code128Bmodules(text);
        if (!modules) return null;
        var moduleWidth = 2;
        var height = 40;
        var quietZone = 10 * moduleWidth;
        var totalWidth = 0;
        for (var m = 0; m < modules.length; m++) totalWidth += parseInt(modules[m], 10) * moduleWidth;
        var svgWidth = totalWidth + quietZone * 2;
        var x = quietZone;
        var isBar = true;
        var bars = [];
        for (var i = 0; i < modules.length; i++) {
            var w = parseInt(modules[i], 10) * moduleWidth;
            if (isBar) {
                bars.push('<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '" fill="#000"/>');
            }
            x += w;
            isBar = !isBar;
        }
        // Rendered at BARCODE_SCALE via a viewBox. SVG is vector, so scaling
        // keeps the bar edges sharp - unlike raising the module width, which
        // would need whole-pixel steps and jump the size too far.
        var vbH = height + 16;
        var svg128 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + svgWidth + ' ' + vbH + '" ' +
            'width="' + Math.round(svgWidth * BARCODE_SCALE) + '" height="' + Math.round(vbH * BARCODE_SCALE) + '">' +
            bars.join('') +
            '<text x="' + (svgWidth / 2) + '" y="' + (height + 13) + '" font-size="12" text-anchor="middle" font-family="monospace">' + svgText(text) + '</text>' +
            '</svg>';
        if (svgMemoCount > 2000) { svgMemo = {}; svgMemoCount = 0; }
        svgMemo[text] = svg128; svgMemoCount++;
        return svg128;
    }

    function code39Widths(text) {
        var seq = ['*'].concat(text.toUpperCase().split('').filter(function (c) { return CODE39[c]; })).concat(['*']);
        var widths = [];
        seq.forEach(function (ch, i) {
            widths = widths.concat(CODE39[ch]);
            if (i < seq.length - 1) widths.push(1); // narrow inter-character gap
        });
        return widths;
    }

    // The same bins come round again every time the page re-renders its
    // cards, so each code is encoded once and the SVG string reused (7.1).
    var svgMemo = {}, svgMemoCount = 0;
    function renderBarcodeSVG(text) {
        if (svgMemo[text]) return svgMemo[text];
        var out = buildBarcodeSVG(text);
        if (svgMemoCount > 2000) { svgMemo = {}; svgMemoCount = 0; }
        svgMemo[text] = out; svgMemoCount++;
        return out;
    }
    function buildBarcodeSVG(text) {
        var moduleWidth = 2;   // px per narrow module
        var height = 40;
        var quietZone = 10 * moduleWidth;
        var widths = code39Widths(text);
        var totalWidth = widths.reduce(function (a, w) { return a + w * moduleWidth; }, 0);
        var svgWidth = totalWidth + quietZone * 2;

        var x = quietZone;
        var isBar = true;
        var bars = [];
        widths.forEach(function (w) {
            var barWidth = w * moduleWidth;
            if (isBar) {
                bars.push('<rect x="' + x + '" y="0" width="' + barWidth + '" height="' + height + '" fill="#000"/>');
            }
            x += barWidth;
            isBar = !isBar;
        });

        var vbH = height + 16;
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + svgWidth + ' ' + vbH + '" ' +
            'width="' + Math.round(svgWidth * BARCODE_SCALE) + '" height="' + Math.round(vbH * BARCODE_SCALE) + '">' +
            bars.join('') +
            '<text x="' + (svgWidth / 2) + '" y="' + (height + 13) + '" font-size="12" text-anchor="middle" font-family="monospace">' + svgText(text) + '</text>' +
            '</svg>';
    }

    // One walk of the page's leaf elements per scan, shared by the barcode and
    // CPT scans (7.1: each used to walk the whole page on its own).
    var LEAF_SELECTOR = 'h1, h2, h3, h4, div, span, p, td, b, strong';
    var leafCache = null;
    function leafElements() {
        if (leafCache) return leafCache;
        var out = [];
        var all = document.querySelectorAll(LEAF_SELECTOR);
        for (var i = 0; i < all.length; i++) if (all[i].children.length === 0) out.push(all[i]);
        leafCache = out;
        return out;
    }
    function withLeafCache(fn) {
        leafCache = leafElements();
        try { fn(); } finally { leafCache = null; }
    }

    function barcodeScan() {
        leafElements().forEach(function (el) {
            if (/^(B|STRONG)$/.test(el.tagName)) return;   // barcode scan never drew under these
            if (el.dataset.popsBarcodeAdded && el.closest && el.closest('button.item')) {   // 9.2: remove old list-card barcodes
                var ow = el.nextElementSibling;
                if (ow && ow.classList && ow.classList.contains('pops-barcode-fallback-wrap')) ow.remove();
                delete el.dataset.popsBarcodeAdded;
                return;
            }
            var code = el.textContent.trim();
            if (el.dataset.popsBarcodeAdded === code) return;
            if (el.dataset.popsBarcodeAdded) {
                // same element, different bin: redraw
                var oldWrap = el.nextElementSibling;
                if (oldWrap && oldWrap.classList && oldWrap.classList.contains('pops-barcode-fallback-wrap')) oldWrap.remove();
                delete el.dataset.popsBarcodeAdded;
            }
            // never treat our own wrapper or badges as a candidate leaf
            if (el.classList.contains('pops-barcode-fallback-wrap')) return;
            if (el.closest && el.closest('#pops-loc-pick, #pops-alerts, #pops-barcode-tools, #pops-auto-pic, #pops-item-pic, #pops-item-pic-bottom, #pops-scan-bar, .page-type-accordion-selection')) return;   // 8.3/8.7: our own boxes draw their own
            if (el.closest && el.closest('button.item')) {                  // 9.2: no barcode on the list cards
                var lw = el.nextElementSibling;
                if (lw && lw.classList && lw.classList.contains('pops-barcode-fallback-wrap')) lw.remove();
                delete el.dataset.popsBarcodeAdded;
                return;
            }
            if (el.classList.contains('pops-cpt-badge')) return;
            if (el.classList.contains('pops-opened-badge')) return;
            if (el.classList.contains('pops-info-badge')) return;

            if (!isBinLocationStrict(code)) return;

            el.dataset.popsBarcodeAdded = code;
            var wrapper = document.createElement('div');
            // Marker class: the Opened Tracker's title walk skips this wrapper,
            // otherwise the barcode's own label text (a second copy of the bin)
            // would leak into the item-identity key.
            wrapper.className = 'pops-barcode-fallback-wrap';
            wrapper.style.cssText = 'margin-top:4px;';
            wrapper.innerHTML = renderBarcodeSVG(code);
            el.insertAdjacentElement('afterend', wrapper);
        });
    }

    // =========================================================================
    // SECTION 1B: CPT next to each item on the Send Runner list
    //
    // CPT comes from Rodeo's ProblemSolving ItemList, fetched on load and every
    // 20s regardless of which screen is showing; painting self-limits to rows
    // that carry a P- bin, which only exist on the item list. Columns are read
    // by header name from the data table itself, the time by pattern match,
    // and every page of the list is followed ("Next >>"), so a large pool can
    // not cut the map short. Known entries are merged across fetches with a
    // per-entry TTL, so a bin missing from one response keeps its value.
    // Cards with a CPT inside 30 min get a yellow outline, overdue ones red,
    // and both move to the top of the list.
    // (The floors feature from 6.x was removed in 7.0: too heavy for the laptops.)
    // =========================================================================

    var CPT_LOG = '[FP POPS CPT]';

    // One repaint per burst of replies, with the page observer held off while
    // our own badges change - otherwise every badge update re-triggered a full
    // three-way scan of the page (the loop that made v6.9 heavy).
    var repaintTimer = null;
    var quietPaint = function (fn) { fn(); };          // replaced in Section 3 once the observer exists
    function repaintSoon() {
        if (repaintTimer) return;
        repaintTimer = setTimeout(function () {
            repaintTimer = null;
            try { quietPaint(function () { cptScan(); try { paintLocStep(); } catch (e) {} try { paintItemPic(); } catch (e) {} }); } catch (e) { console.log(CPT_LOG, 'repaint error:', e); }
        }, 700);   // 10.23: was 400 - while many lookups answer one after another, repaint less often
    }

    var FC_KEY = 'pops_fc';
    var DEFAULT_FC = 'EMA4'; // from the user's own Rodeo URL (rodeo-dub.../EMA4/ExSD)

    function getFC() {
        try {
            var v = (localStorage.getItem(FC_KEY) || '').trim().toUpperCase();
            if (/^[A-Z]{3,4}\d$/.test(v)) return v;
        } catch (e) {}
        return DEFAULT_FC;
    }

    // 8.0: the associate's chosen floor (e.g. "paKivaA03"), '' = no preference.
    var MY_FLOOR_KEY = 'pops_my_floor';
    function getMyFloor() {
        try { return (localStorage.getItem(MY_FLOOR_KEY) || '').trim(); } catch (e) { return ''; }
    }
    function isMyFloor(floor) {
        var mine = getMyFloor();
        if (!mine || !floor) return false;
        // Compare the floor NUMBER only: roboscout returns "P01" / "3", the
        // stored preference is "paKivaA01" etc. - extract the trailing digit(s).
        var mineNum = /(\d+)\s*$/.exec(mine);
        var floorNum = /(\d+)\s*$/.exec(String(floor));
        if (mineNum && floorNum) return String(+mineNum[1]) === String(+floorNum[1]);
        return String(floor).toLowerCase() === mine.toLowerCase();
    }

    // 8.3: each item's location list (floor/mod groups of bins) as seen on its
    // "Select location" step, kept per item title for 3 hours.
    var LOCS_KEY = 'pops_item_locs', LOCS_TTL_MS = 20 * 60 * 1000, LOCS_MAX = 300;   // 10.1: was 3 h - pods move between floors
    var itemLocs = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(LOCS_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (o[k] && o[k].t && now - o[k].t < LOCS_TTL_MS) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    function saveItemLocs() {
        try {
            var keys = Object.keys(itemLocs);
            if (keys.length > LOCS_MAX) {
                keys.sort(function (a, b) { return itemLocs[a].t - itemLocs[b].t; });
                keys.slice(0, keys.length - LOCS_MAX).forEach(function (k) { delete itemLocs[k]; });
            }
            localStorage.setItem(LOCS_KEY, JSON.stringify(itemLocs));
        } catch (e) {}
    }
    // "paKivaA03" -> { mod: 'A', floor: '3' }
    function parseMyFloor() {
        var m = /([a-z])0*(\d+)\s*$/i.exec(getMyFloor());
        return m ? { mod: m[1].toUpperCase(), floor: String(+m[2]) } : null;
    }
    // First bin on the associate's floor (PickBin groups first); if the item
    // has none there, the first bin of the first group.
    // 10.7: preferBin (the card's original location) wins whenever it is on
    // the chosen floor (or, with no floor match, when it is in the first group),
    // so the card does not jump between bins.
    function pickBin(groups, preferBin) {
        var withBins = (groups || []).filter(function (g) { return g.bins && g.bins.length; });
        if (!withBins.length) return null;
        function prefer(g) { return preferBin && g.bins.indexOf(preferBin) !== -1 ? preferBin : g.bins[0]; }
        var me = parseMyFloor();
        if (me) {
            var mine = withBins.filter(function (g) { return g.floor === me.floor && (!g.mod || g.mod === me.mod); });
            mine = mine.filter(function (g) { return /pickbin/i.test(g.type); }).concat(mine.filter(function (g) { return !/pickbin/i.test(g.type); }));
            var withPref = mine.filter(function (g) { return preferBin && g.bins.indexOf(preferBin) !== -1; })[0];
            if (withPref) return { bin: preferBin, group: withPref, onMyFloor: true, chosen: true };
            if (mine.length) return { bin: mine[0].bins[0], group: mine[0], onMyFloor: true, chosen: true };
        }
        var pg = withBins.filter(function (g) { return preferBin && g.bins.indexOf(preferBin) !== -1; })[0];
        if (pg) return { bin: preferBin, group: pg, onMyFloor: false, chosen: !!me };
        return { bin: prefer(withBins[0]), group: withBins[0], onMyFloor: false, chosen: !!me };
    }
    // 10.7: P-1-B bins are always on P1 - never looked up in roboscout.
    function isP1Bin(b) { return /^P-1-/i.test(String(b || '')); }
    function knownInfo(b) {
        if (isP1Bin(b)) {
            // 10.21: 'paKivaA01', not 'P01': the mod letter A is what "My floor" paKivaA01 matches
            if (!binInfo[b] || binInfo[b].floor !== 'paKivaA01') binInfo[b] = { floor: 'paKivaA01', pod: (binInfo[b] && binInfo[b].pod) || '', at: Date.now(), fixed: true };
            return binInfo[b];
        }
        return binInfo[b];
    }
    // 10.2: POPS's "Select location" list groups bins by the floor POPS holds
    // for them, and that can be out of date (a bin listed under P3 that was
    // really on P2). Before choosing, every bin is put under its ROBOSCOUT
    // floor when roboscout knows it; POPS's floor is only the fallback. Per
    // item at most 10 bins roboscout does not know yet are looked up - the
    // bins POPS lists on the associate's floor first, since those decide.
    function effectiveGroups(groups, holder, extraBin, opts) {
        opts = opts || {};                                  // 10.27: { noExtras, units }
        if (!groups || !groups.length) return groups;
        if (holder && !holder.check && !opts.noExtras) {
            var me = parseMyFloor(), first = [], rest = [];
            groups.forEach(function (g) {
                var onMine = me && g.floor === me.floor && (!g.mod || g.mod === me.mod);
                (g.bins || []).forEach(function (b) { if (!knownInfo(b)) (onMine ? first : rest).push(b); });
            });
            holder.check = first.concat(rest).slice(0, ASIN_BIN_CHECK_MAX);
        }
        if (holder && holder.check) {
            if (opts.noExtras) dropQueuedBins(holder.check);          // own bin is on your floor: forget the waiting extras
            else queueBinChecks(holder.check, opts.units);
        }
        // 10.7: the card's original location is always checked as well (the 11th)
        // and taken into account, so the floor shown does not change under the user
        if (extraBin) binInfoFor(extraBin);
        var out = {}, order = [];
        var all = groups.slice();
        var inList = groups.some(function (g) { return (g.bins || []).indexOf(extraBin) !== -1; });
        var ei = extraBin ? knownInfo(extraBin) : null;
        if (extraBin && !inList && ei && ei.floor) all.push({ label: 'original location', type: 'PickBin', floor: '', mod: '', bins: [extraBin] });
        all.forEach(function (g) {
            (g.bins || []).forEach(function (b) {
                var fl = g.floor, mod = g.mod, inf = knownInfo(b);
                var m = inf && inf.floor ? /([a-z])0*(\d+)\s*$/i.exec(inf.floor) : null;
                if (m) { fl = String(+m[2]); mod = m[1].toUpperCase(); }
                var k = fl + '|' + mod + '|' + (g.type || '');
                if (!out[k]) { out[k] = { label: g.label, type: g.type, floor: fl, mod: mod, bins: [] }; order.push(k); }
                out[k].bins.push(b);
            });
        });
        return order.map(function (k) { return out[k]; });
    }
    // 10.10: the picks of the list in screen order (from POPS's list reply)
    var lastListItems = [];
    // 10.11: locations chosen with "Pick This Location" (bin -> time), kept 12 h
    var PICKED_KEY = 'pops_picked_locs';
    var pickedLocs = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(PICKED_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (typeof o[k] === 'number' && now - o[k] < 12 * 3600 * 1000) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    // 10.15: the location actually picked for a card (card key -> {bin, title, at}), 12 h
    var PICKED_FOR_KEY = 'pops_picked_for';
    var pickedFor = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(PICKED_FOR_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (o[k] && now - o[k].at < 12 * 3600 * 1000) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    function setPickedFor(key, bin, title) {
        pickedFor[key] = { bin: bin, title: normT(title), at: Date.now() };
        try { localStorage.setItem(PICKED_FOR_KEY, JSON.stringify(pickedFor)); } catch (e) {}
    }
    function markPicked(bin) {
        pickedLocs[bin] = Date.now();
        try { localStorage.setItem(PICKED_KEY, JSON.stringify(pickedLocs)); } catch (e) {}
    }
    // 10.10: choose while leaving out bins already given to another unit of
    // the same item; when every bin is taken, the normal choice is used
    function pickBinAvoiding(groups, preferBin, avoid) {
        if (avoid && groups) {
            var left = groups.map(function (g) {
                var c = {}; for (var k in g) c[k] = g[k];
                c.bins = (g.bins || []).filter(function (b) { return !avoid[b]; });
                return c;
            });
            var pk = pickBin(left, avoid[preferBin] ? null : preferBin);
            if (pk) return pk;
        }
        return pickBin(groups, preferBin);
    }
    function pickForItem(title, origBin, avoid, opts) {
        if (!title) return null;
        var e = itemLocs[normT(title)];
        if (!e || Date.now() - e.t > LOCS_TTL_MS) return null;
        return pickBinAvoiding(effectiveGroups(e.groups, e, origBin, opts), origBin, avoid);
    }

    function rodeoItemListUrl() {
        return 'https://rodeo-dub.amazon.com/' + getFC() +
            '/ItemList?_enabledColumns=on' +
            '&enabledColumns=OUTER_SCANNABLE_ID' +
            '&WorkPool=ProblemSolving' +
            '&Fracs=NON_FRACS' +
            '&shipmentType=CUSTOMER_SHIPMENTS';
    }

    // Small helpers shared by the parsers.
    function gmGet(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('no GM'));
            try {
                GM_xmlhttpRequest({ method: 'GET', url: url, nocache: true, timeout: timeoutMs || 20000,
                    onload: resolve, onerror: function () { reject(new Error('network')); }, ontimeout: function () { reject(new Error('timeout')); },
                    onabort: function () { reject(new Error('abort')); } });
            } catch (e) { reject(e); }
        });
    }

    // Cache the last known map so a new page paints CPT IMMEDIATELY from
    // storage instead of waiting for the Rodeo round-trip. The background
    // fetch still runs and merges fresh data into it as soon as it lands.
    var CPT_CACHE_KEY = 'pops_cpt_map_cache';
    // storage left by the 6.x floors feature is cleared once
    try { ['pops_bin_floor_cache', 'pops_item_floors_cache', 'pops_bin_sku_cache'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
    var CPT_ENTRY_TTL_MS = 30 * 60 * 1000;   // how long one bin's CPT stays usable

    // binCptMap holds { bin: { cpt: "HH:MM", cptAt: <epoch ms>, seen: <epoch ms> } }.
    // Each entry carries its OWN timestamp so entries are MERGED across
    // fetches rather than replaced: a bin that drops out of the ProblemSolving
    // pool for one cycle keeps its CPT until the TTL expires.
    var binCptMap = (function () {
        try {
            var raw = localStorage.getItem(CPT_CACHE_KEY);
            if (!raw) return {};
            var o = JSON.parse(raw);
            var now = Date.now();
            var out = {};
            var src = o.map || {};
            Object.keys(src).forEach(function (b) {
                var e = src[b];
                if (typeof e === 'string') { if (o.ts && (now - o.ts) <= CPT_ENTRY_TTL_MS) out[b] = { cpt: e, seen: o.ts }; return; }
                if (e && e.cpt && e.seen && (now - e.seen) <= CPT_ENTRY_TTL_MS) out[b] = e;
            });
            return out;
        } catch (e) { return {}; }
    })();

    function binEntry(bin) {
        var e = binCptMap[bin];
        if (!e) return undefined;
        if ((Date.now() - e.seen) > CPT_ENTRY_TTL_MS) { delete binCptMap[bin]; return undefined; }
        return e;
    }
    function cptFor(bin) { var e = binEntry(bin); return e ? e.cpt : undefined; }
    function cptAtFor(bin) { var e = binEntry(bin); return e ? e.cptAt : undefined; }

    // ---- 7.4: ASIN + floor ----------------------------------------------------
    // ASINs come from the SAME Rodeo reply as CPT (no extra requests), merged
    // and cached the same way. Floor is read straight from the bin ID
    // (P-<floor>-...), so it shows instantly and costs nothing.
    var ASIN_CACHE_KEY = 'pops_asin_map_cache';
    var binAsinMap = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(ASIN_CACHE_KEY) || '{}'), now = Date.now(), out = {};
            Object.keys(o).forEach(function (b) { var e = o[b]; if (e && e.asins && e.seen && (now - e.seen) <= CPT_ENTRY_TTL_MS) out[b] = e; });
            return out;
        } catch (e) { return {}; }
    })();
    function asinsFor(bin) {
        var e = binAsinMap[bin];
        if (!e) return [];
        if ((Date.now() - e.seen) > CPT_ENTRY_TTL_MS) { delete binAsinMap[bin]; return []; }
        return e.asins;
    }
    // 7.5: floor + POD from roboscout get_neighboring_bins, as in iakolali's
    // "Rodeo Bin Info - floor + POD" script. The bin ID's own number is NOT the
    // floor, which is why 7.4 showed wrong floors.
    // 10.1: pods DO move between floors (a P3 bin was found on P2), so a floor
    // is no longer kept for good: each answer is stamped and looked up again
    // after BININFO_TTL_MS; until the new answer arrives the old one is shown.
    // A floor POPS itself reports on "Select location" also corrects the cache.
    var BININFO_KEY = 'pops_bin_info_cache';
    var BININFO_TTL_MS = 24 * 3600 * 1000;   // 10.2: pods move rarely - one re-check a day is enough
    var binInfo = (function () { try { return JSON.parse(localStorage.getItem(BININFO_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    // 10.22: drop cached "Unknown" answers saved by earlier versions, so those bins are looked up again
    Object.keys(binInfo).forEach(function (k) { if (!binInfo[k] || !/\d/.test(String(binInfo[k].floor || ''))) delete binInfo[k]; });
    var binInfoPending = {}, binInfoFails = {}, binInfoQueue = [], binInfoActive = 0;
    var BININFO_TRIES = 2, BININFO_CONC = 5, binInfoSaveT = null;   // 10.23: 5 at a time (was 3; the browser allows 6 per host)
    function saveBinInfo() {
        if (binInfoSaveT) return;
        binInfoSaveT = setTimeout(function () { binInfoSaveT = null; try { localStorage.setItem(BININFO_KEY, JSON.stringify(binInfo)); } catch (e) {} }, 500);
    }
    // 10.21: FCResearch fallback for the floor, used only when roboscout gave no
    // answer. FCResearch's "Container Details" lists "Location: Floor: 1, Aisle: 203,
    // Shelf: A, Slot: 410". It gives the floor only (no POD), so the entry is marked
    // src 'fcr' and roboscout is asked again after 30 minutes.
    var FCR_FLOOR_RETRY_MS = 30 * 60 * 1000, fcrFloorTried = {};
    function fcrFloorFallback(bin, cb) {
        var last = fcrFloorTried[bin];
        if (typeof GM_xmlhttpRequest !== 'function' || (last && Date.now() - last < FCR_FLOOR_RETRY_MS)) return cb(null);
        fcrFloorTried[bin] = Date.now();
        gmGet('https://fcresearch-eu.aka.amazon.com/' + getFC() + '/results/container-hierarchy?s=' + encodeURIComponent(bin)).then(function (res) {
            if (res.status !== 200) { console.log(CPT_LOG, 'FCResearch floor: HTTP ' + res.status + ' for ' + bin); return cb(null); }
            var txt = '';
            try { txt = new DOMParser().parseFromString(res.responseText || '', 'text/html').body.textContent || ''; } catch (e) {}
            var m = /Floor:\s*(\d+)\s*,\s*Aisle/i.exec(txt) || /Floor:\s*(\d+)/i.exec(txt);
            if (!m) { console.log(CPT_LOG, 'FCResearch floor: no "Floor:" in Container Details for', bin); return cb(null); }
            console.log(CPT_LOG, 'FCResearch floor for ' + bin + ': ' + m[1] + ' (roboscout had none)');
            cb({ floor: 'paKivaA' + ('0' + m[1]).slice(-2), pod: '', src: 'fcr' });
        }, function () { console.log(CPT_LOG, 'FCResearch floor request failed for', bin); cb(null); });
    }
    function pumpBinInfo() {
        while (binInfoActive < BININFO_CONC && binInfoQueue.length) {
            var b = binInfoQueue.shift();
            binInfoActive++;
            (function (bin) {
                function finish(info, fromFcr) {
                    binInfoActive--; delete binInfoPending[bin];
                    if (info) {
                        var old = binInfo[bin];
                        if (old && old.floor && info.floor && old.floor !== info.floor) console.log(CPT_LOG, 'floor check: ' + bin + ' moved ' + old.floor + ' -> ' + info.floor + (fromFcr ? ' (FCResearch)' : ' (roboscout)'));
                        // FCResearch floors count as stale after 30 min, so roboscout is asked again
                        info.at = fromFcr ? Date.now() - BININFO_TTL_MS + FCR_FLOOR_RETRY_MS : Date.now();
                        binInfo[bin] = info; saveBinInfo(); repaintSoon();
                        if (!fromFcr) delete fcrFloorTried[bin];
                    }
                    else binInfoFails[bin] = (binInfoFails[bin] || 0) + 1;
                    pumpBinInfo();
                }
                // roboscout first; when it gives nothing, FCResearch (the bin stays "pending" meanwhile)
                function done(info) {
                    if (info) return finish(info, false);
                    var had = binInfo[bin];
                    if (had && had.floor && had.src !== 'fcr') return finish(null, false);   // keep the older roboscout answer
                    fcrFloorFallback(bin, function (fi) { finish(fi, !!fi); });
                }
                if (typeof GM_xmlhttpRequest !== 'function') return done(null);
                GM_xmlhttpRequest({
                    method: 'GET', nocache: true, timeout: 20000,
                    url: 'https://roboscout.amazon.com/ipa/kpps/get_neighboring_bins/?building=' + encodeURIComponent(getFC()) + '&bin_id=' + encodeURIComponent(bin),
                    onload: function (res) {
                        var info = null;
                        try {
                            var j = JSON.parse(res.responseText || '{}'), e = j[bin];
                            // 10.22: roboscout answers floor "Unknown" / pod_id "Unknown" for bins it does not know.
                            // A real floor has a number; anything else counts as "no answer" so the FCResearch fallback runs.
                            var rf = e ? String(e.floor || '') : '', rp = e ? String(e.pod_id || '') : '';
                            if (!/\d/.test(rf)) rf = '';
                            if (/unknown/i.test(rp)) rp = '';
                            if (rf) info = { floor: rf, pod: rp };
                        } catch (err) {}
                        if (!info) console.log(CPT_LOG, 'roboscout: no floor/POD for', bin, (res.responseText || '').slice(0, 150));
                        done(info);
                    },
                    onerror: function () { console.log(CPT_LOG, 'roboscout request failed for', bin, '- signed in to roboscout?'); done(null); },
                    ontimeout: function () { done(null); }
                });
            })(b);
        }
    }
    // 10.27: fewer roboscout lookups.
    // (a) A card whose OWN bin is already known to be on your floor needs no extra bins: the picker
    //     keeps the card's own bin whenever it is on your floor. Not used for several units of one item,
    //     which each need their own bin.
    function ownBinOnMyFloor(bin) {
        if (!parseMyFloor()) return false;
        var i = knownInfo(bin);
        return !!(i && i.floor && isMyFloor(i.floor));
    }
    // (b) Once enough bins of an item are known to be on your floor (one per unit), the other bins
    //     of that item are not looked up any more and the ones still waiting in the queue are dropped.
    var cardOwnBins = {};   // bins of the cards on screen (never dropped from the queue), set by cptScan
    function dropQueuedBins(list) {
        list.forEach(function (b) {
            if (!binInfoPending[b] || cardOwnBins[b]) return;
            var qi = binInfoQueue.indexOf(b);
            if (qi >= 0) { binInfoQueue.splice(qi, 1); delete binInfoPending[b]; }   // still waiting: not sent yet
        });
    }
    function queueBinChecks(list, units) {
        if (parseMyFloor()) {
            var mineKnown = 0;
            list.forEach(function (b) { var i = knownInfo(b); if (i && i.floor && isMyFloor(i.floor)) mineKnown++; });
            if (mineKnown >= (units || 1)) { dropQueuedBins(list); return true; }   // enough: stop looking
        }
        list.forEach(function (b) { binInfoFor(b); });
        return false;
    }
    function binInfoFor(bin, urgent) {
        if (isP1Bin(bin)) return knownInfo(bin);        // 10.7: always P1, no lookup
        var e = binInfo[bin];
        var stale = !e || !e.at || (Date.now() - e.at) > BININFO_TTL_MS;
        if (stale && !binInfoPending[bin]) {
            // a stale entry may be refreshed again, even after earlier failed tries
            if (e && binInfoFails[bin] && (!e.retryAt || Date.now() > e.retryAt)) { binInfoFails[bin] = 0; e.retryAt = Date.now() + BININFO_TTL_MS; }
            if ((binInfoFails[bin] || 0) < BININFO_TRIES) { binInfoPending[bin] = true; if (urgent) binInfoQueue.unshift(bin); else binInfoQueue.push(bin); pumpBinInfo(); }
        } else if (urgent && binInfoPending[bin]) {
            // already waiting in the queue (queued earlier as an extra bin): move it to the front
            var qi = binInfoQueue.indexOf(bin);
            if (qi > 0) { binInfoQueue.splice(qi, 1); binInfoQueue.unshift(bin); }
        }
        return e || null;
    }
    // 10.2: compares POPS's "Select location" floors with roboscout's and logs
    // every difference. It does NOT change anything: roboscout (where the pod
    // really is) wins - see effectiveGroups(). (10.1 wrongly let POPS win.)
    function learnFloorsFromPops(groups) {
        var checked = 0, differ = [];
        (groups || []).forEach(function (g) {
            if (!g.floor || !/^\d+$/.test(g.floor)) return;
            (g.bins || []).forEach(function (b) {
                var e = binInfo[b];
                if (!e || !e.floor) return;
                checked++;
                var m = /(\d+)\s*$/.exec(e.floor);
                if (m && String(+m[1]) !== g.floor) differ.push(b + ' POPS P' + g.floor + ' / roboscout ' + floorShort(e.floor));
            });
        });
        if (checked) {
            console.log(CPT_LOG, 'floor check, POPS vs roboscout: ' + checked + ' bin(s) compared, ' +
                (differ.length ? differ.length + ' differ (roboscout used): ' + differ.join(', ') : 'all floors match'));
        }
    }
    function floorFor(bin) { var i = binInfoFor(bin); return i ? i.floor : ''; }
    function podFor(bin) { var i = binInfo[bin]; return i ? i.pod : ''; }

    // 7.6: ASIN fallback from FCResearch. Rodeo's ProblemSolving ItemList does
    // not carry an ASIN column, so 7.4/7.5 showed "ASIN: -". FCResearch's
    // inventory page for the bin lists ASIN + title for everything in it; the
    // card's own title picks the right row. Cached 30 min, 3 lookups at a time.
    var FCR_TTL_MS = 30 * 60 * 1000;
    var fcrRows = {}, fcrPending = {}, fcrFails = {}, fcrQueue = [], fcrActive = 0;
    var normT = function (t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    function pumpFcr() {
        while (fcrActive < 3 && fcrQueue.length) {
            var b = fcrQueue.shift(); fcrActive++;
            (function (bin) {
                function done(rows) {
                    fcrActive--; delete fcrPending[bin];
                    if (rows) { fcrRows[bin] = { rows: rows, at: Date.now() }; repaintSoon(); }
                    else fcrFails[bin] = (fcrFails[bin] || 0) + 1;
                    pumpFcr();
                }
                gmGet('https://fcresearch-eu.aka.amazon.com/' + getFC() + '/results/inventory?s=' + encodeURIComponent(bin)).then(function (res) {
                    if (res.status !== 200) { console.log(CPT_LOG, 'FCResearch HTTP ' + res.status + ' for ' + bin + ' - open FCResearch once to sign in'); return done(null); }
                    var doc = new DOMParser().parseFromString(res.responseText || '', 'text/html'), rows = [];
                    var tables = doc.querySelectorAll('table');
                    for (var i = 0; i < tables.length && !rows.length; i++) {
                        var h = [].map.call(tables[i].querySelectorAll('th'), function (t) { return t.textContent.trim().toLowerCase(); });
                        var ai = h.findIndex(function (x) { return x === 'asin'; });
                        var fi = h.findIndex(function (x) { return x.indexOf('fnsku') !== -1 || x.indexOf('fn sku') !== -1; });
                        if (ai < 0 && fi < 0) continue;
                        var ti = h.findIndex(function (x) { return x.indexOf('title') !== -1; });
                        tables[i].querySelectorAll('tbody tr').forEach(function (tr) {
                            var c = tr.querySelectorAll('td');
                            var asin = ai >= 0 && c[ai] ? c[ai].textContent.trim() : '';
                            var fn = fi >= 0 && c[fi] ? c[fi].textContent.trim() : '';
                            var v = (asin || fn).match(/[A-Z0-9]{10}/i);
                            if (v) rows.push({ asin: v[0].toUpperCase(), title: ti >= 0 && c[ti] ? c[ti].textContent.trim() : '' });
                        });
                    }
                    if (!rows.length) console.log(CPT_LOG, 'FCResearch: no ASIN rows for', bin);
                    done(rows.length ? rows : null);
                }, function () { console.log(CPT_LOG, 'FCResearch request failed for', bin); done(null); });
            })(b);
        }
    }
    function fcrAsinsFor(bin, title) {
        var e = fcrRows[bin];
        if (!e || (Date.now() - e.at) > FCR_TTL_MS) {
            if (!fcrPending[bin] && (fcrFails[bin] || 0) < 2) { fcrPending[bin] = true; fcrQueue.push(bin); pumpFcr(); }
            return e ? e.rows.map(function (r) { return r.asin; }) : [];
        }
        var t = normT(title);
        if (t) {
            var hit = e.rows.filter(function (r) { var rt = normT(r.title); return rt && (t.indexOf(rt.slice(0, 25)) !== -1 || rt.indexOf(t.slice(0, 25)) !== -1); });
            if (hit.length) return hit.map(function (r) { return r.asin; }).filter(function (a, i, arr) { return arr.indexOf(a) === i; });
        }
        return e.rows.map(function (r) { return r.asin; }).filter(function (a, i, arr) { return arr.indexOf(a) === i; });
    }

    // ---- 9.1: every bin holding the card's ASIN, from FCResearch ---------------
    // Read-only replacement for the removed pre-loading: FCResearch's inventory
    // search by ASIN lists the bins holding the item. Only P- pick bins with a
    // quantity above 0 are kept. Their floor comes from roboscout, but per ASIN
    // at most ASIN_BIN_CHECK_MAX bins that are not already cached are ever
    // looked up (bins whose floor is already known cost nothing and always
    // count). The list is kept 30 min; 2 FCResearch lookups at a time.
    var ASIN_BINS_KEY = 'pops_asin_bins_v2', ASIN_BINS_TTL_MS = 30 * 60 * 1000, ASIN_BIN_CHECK_MAX = 10;
    var asinBins = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(ASIN_BINS_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (o[k] && o[k].at && now - o[k].at < ASIN_BINS_TTL_MS) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    var ASIN_BINS_CONC = 4;   // 10.26: FCResearch "bins holding this ASIN" lookups at a time (was 2)
    var asinBinsPending = {}, asinBinsFails = {}, asinBinsQueue = [], asinBinsActive = 0, asinBinsSaveT = null;
    function saveAsinBins() {
        if (asinBinsSaveT) return;
        asinBinsSaveT = setTimeout(function () {
            asinBinsSaveT = null;
            try {
                var keys = Object.keys(asinBins);
                if (keys.length > 300) {
                    keys.sort(function (a, b) { return asinBins[a].at - asinBins[b].at; });
                    keys.slice(0, keys.length - 300).forEach(function (k) { delete asinBins[k]; });
                }
                localStorage.setItem(ASIN_BINS_KEY, JSON.stringify(asinBins));
            } catch (e) {}
        }, 500);
    }
    function parseFcrAsinBins(html) {
        // 9.9: only bins whose stock is free to pick - Consumer UNOWNED and
        // Disposition SELLABLE, quantity above 0. Stock already given to a
        // customer (CUSTOMER_SHIPMENT), PENDING_RESEARCH, damaged stock etc.
        // can still sit in a P- bin and is left out. Columns are found by name.
        var doc = new DOMParser().parseFromString(html || '', 'text/html'), out = [], seen = {};
        doc.querySelectorAll('table').forEach(function (table) {
            var h = [].map.call(table.querySelectorAll('th'), function (t) { return t.textContent.replace(/\s+/g, ' ').trim().toLowerCase(); });
            var qi = h.findIndex(function (x) { return /^(quantity|qty)\b/.test(x); });
            var ci = h.findIndex(function (x) { return x === 'container' || /^container\b/.test(x); });
            var coi = h.findIndex(function (x) { return x === 'consumer'; });
            var di = h.findIndex(function (x) { return x === 'disposition'; });
            table.querySelectorAll('tr').forEach(function (tr) {
                var c = tr.querySelectorAll('td');
                if (!c.length) return;
                var bin = null;
                if (ci >= 0 && c[ci]) {
                    var mc = (c[ci].textContent || '').trim().match(/^P-\d+-[A-Z0-9]+$/i);
                    if (mc) bin = mc[0].toUpperCase();
                } else {
                    for (var i = 0; i < c.length && !bin; i++) {
                        var m = (c[i].textContent || '').match(/\bP-\d+-[A-Z0-9]+\b/i);
                        if (m) bin = m[0].toUpperCase();
                    }
                }
                if (!bin) return;
                if (coi >= 0 && c[coi] && (c[coi].textContent || '').trim().toUpperCase() !== 'UNOWNED') return;
                if (di >= 0 && c[di] && (c[di].textContent || '').trim().toUpperCase() !== 'SELLABLE') return;
                if (qi >= 0 && c[qi]) {
                    var q = parseInt((c[qi].textContent || '').replace(/[^\d-]/g, ''), 10);
                    if (!isNaN(q) && q <= 0) return;
                }
                if (!seen[bin]) { seen[bin] = true; out.push(bin); }
            });
        });
        return out;
    }
    function pumpAsinBins() {
        while (asinBinsActive < ASIN_BINS_CONC && asinBinsQueue.length) {
            var a = asinBinsQueue.shift(); asinBinsActive++;
            (function (asin) {
                function done(bins) {
                    asinBinsActive--; delete asinBinsPending[asin];
                    if (bins) { asinBins[asin] = { at: Date.now(), bins: bins }; saveAsinBins(); repaintSoon(); }
                    else asinBinsFails[asin] = (asinBinsFails[asin] || 0) + 1;
                    pumpAsinBins();
                }
                gmGet('https://fcresearch-eu.aka.amazon.com/' + getFC() + '/results/inventory?s=' + encodeURIComponent(asin)).then(function (res) {
                    if (res.status !== 200) { console.log(CPT_LOG, 'FCResearch HTTP ' + res.status + ' for ASIN ' + asin); return done(null); }
                    var bins = parseFcrAsinBins(res.responseText);
                    console.log(CPT_LOG, 'FCResearch: ' + bins.length + ' pick bin(s) hold ' + asin);
                    done(bins);
                }, function () { done(null); });
            })(a);
        }
    }
    // Floor groups (same shape as the "Select location" list) for an ASIN, or null.
    function fcrGroupsFor(asin, extraBin, opts) {
        opts = opts || {};                                  // 10.27: { noExtras, units }
        if (opts.noExtras && extraBin) {
            // the card's own bin is on your floor: no "bins holding this ASIN" lookup, no extra bins
            var oi = knownInfo(extraBin), om = oi && oi.floor ? /([a-z])0*(\d+)\s*$/i.exec(oi.floor) : null;
            var oe = asin ? asinBins[asin] : null;
            if (oe && oe.check) dropQueuedBins(oe.check);              // forget extras queued before the own bin was known
            if (oi && oi.floor) return [{ label: oi.floor, type: 'PickBin', floor: om ? String(+om[2]) : '', mod: om ? om[1].toUpperCase() : '', bins: [extraBin] }];
        }
        if (!asin) return null;
        var e = asinBins[asin];
        if (!e || Date.now() - e.at > ASIN_BINS_TTL_MS) {
            if (!asinBinsPending[asin] && (asinBinsFails[asin] || 0) < 2) { asinBinsPending[asin] = true; asinBinsQueue.push(asin); pumpAsinBins(); }
            if (!e) return null;
        }
        // which bins may be checked is fixed the first time: all already-known
        // bins plus the first ASIN_BIN_CHECK_MAX unknown ones
        if (!e.check) {
            var known = e.bins.filter(function (b) { return !!knownInfo(b); });
            var unknown = e.bins.filter(function (b) { return !knownInfo(b); }).slice(0, ASIN_BIN_CHECK_MAX);
            e.check = known.concat(unknown);
            saveAsinBins();
        }
        // 10.7: plus the card's original location, always (the 11th check)
        var list = e.check.slice();
        if (extraBin && list.indexOf(extraBin) === -1) list.push(extraBin);
        var groups = {}, order = [];
        // 10.27: queue the lookups for this ASIN's bins - or none, once enough bins on your floor are known
        var enough = queueBinChecks(list, opts.units);
        list.forEach(function (b) {
            var inf = (isP1Bin(b) || enough) ? knownInfo(b) : binInfoFor(b);   // queues the lookup if not known yet
            if (!inf || !inf.floor) return;
            var m = /([a-z])0*(\d+)\s*$/i.exec(inf.floor);
            var key = inf.floor;
            if (!groups[key]) {
                groups[key] = { label: inf.floor, type: 'PickBin', floor: m ? String(+m[2]) : '', mod: m ? m[1].toUpperCase() : '', bins: [] };
                order.push(key);
            }
            groups[key].bins.push(b);
        });
        return order.length ? order.map(function (k) { return groups[k]; }) : null;
    }
    // Best bin for a list card from FCResearch, or null.
    function fcrPickForCard(bin, title, avoid, opts) {
        var asin = '';
        var a = asinsFor(bin);
        if (!a.length) a = fcrAsinsFor(bin, title);
        if (a.length) asin = a[0];
        var g = fcrGroupsFor(asin, bin, opts);
        var pk = g ? pickBinAvoiding(g, bin, avoid) : null;
        if (pk) pk.src = 'fcr';
        return pk;
    }

    // ---- 7.8: item picture next to the ASIN ------------------------------------
    // Free first: ecx serves a picture straight from the ASIN for many items
    // (and a 1x1 blank when it has none). Only on an ecx miss is FCResearch's
    // product page asked - ONE request at a time, only for ASINs of bins that
    // are actually on screen. Every answer (picture or none) is cached per
    // ASIN in localStorage, so an item is looked up once, not on every
    // refresh, and a rolling cap shared by all tabs keeps FCResearch picture
    // lookups to IMG_FCR_MAX_PER_HOUR.
    var IMG_CACHE_KEY = 'pops_img_cache', IMG_FCR_LOG_KEY = 'pops_img_fcr_log';
    var IMG_MISS_TTL_MS = 1 * 3600 * 1000;   // "no picture" is re-checked after this (9.8: was 6 h)
    var IMG_RETRY_MS = 3 * 60 * 1000;        // after a failed / capped lookup (9.8: was 10 min)
    var IMG_FCR_MAX_PER_HOUR = 300;          // 9.8: was 30, which ran out on a busy list and left cards blank
    var IMG_CACHE_MAX = 3000;
    // 9.8: picture per item TITLE as well. The card's ASIN can change between
    // lookups (Rodeo, FCResearch title match, FN SKU vs ASIN); the title does
    // not, so once any picture is known for an item it sticks to its card.
    // POPS's own picture (imageUrl in its replies) always wins.
    var TITLE_IMG_KEY = 'pops_title_img', TITLE_IMG_MAX = 3000, TITLE_IMG_TTL_MS = 14 * 24 * 3600 * 1000;
    var titleImg = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(TITLE_IMG_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (o[k] && o[k].u && now - (o[k].t || 0) < TITLE_IMG_TTL_MS) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    var titleImgSaveT = null;
    function titleKey(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80); }
    function titleImgFor(title) { var e = title ? titleImg[titleKey(title)] : null; return e ? e.u : ''; }
    function titleImgSet(title, url, strong) {
        var k = titleKey(title);
        if (!k || !url) return;
        var e = titleImg[k];
        if (e && e.u === url) return;
        if (e && e.s && !strong) return;                  // keep POPS's own picture
        titleImg[k] = { u: url, t: Date.now(), s: !!strong };
        if (titleImgSaveT) return;
        titleImgSaveT = setTimeout(function () {
            titleImgSaveT = null;
            try {
                var keys = Object.keys(titleImg);
                if (keys.length > TITLE_IMG_MAX) {
                    keys.sort(function (a, b) { return (titleImg[a].t || 0) - (titleImg[b].t || 0); });
                    keys.slice(0, keys.length - TITLE_IMG_MAX).forEach(function (x) { delete titleImg[x]; });
                }
                localStorage.setItem(TITLE_IMG_KEY, JSON.stringify(titleImg));
            } catch (err) {}
        }, 500);
    }
    var imgCache = (function () { try { return JSON.parse(localStorage.getItem(IMG_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    var imgBusy = {}, imgFcrQueue = [], imgFcrActive = false, imgSaveT = null, imgCapLogged = false;
    // A real ASIN starts with B or a digit; X00... FNSkus have no ecx picture.
    function isRealAsin(a) { return /^[B0-9][0-9A-Z]{9}$/.test(a); }
    function saveImgCache() {
        if (imgSaveT) return;
        imgSaveT = setTimeout(function () {
            imgSaveT = null;
            try {
                var keys = Object.keys(imgCache);
                if (keys.length > IMG_CACHE_MAX) {
                    keys.sort(function (a, b) { return (imgCache[a].t || 0) - (imgCache[b].t || 0); });
                    keys.slice(0, keys.length - IMG_CACHE_MAX).forEach(function (k) { delete imgCache[k]; });
                }
                localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(imgCache));
            } catch (e) {}
        }, 500);
    }
    // url '' = no picture. A miss is re-checked after retryAfterMs
    // (default: the full IMG_MISS_TTL_MS).
    function imgSet(asin, url, retryAfterMs) {
        var now = Date.now();
        imgCache[asin] = url ? { u: url, t: now } : { u: '', t: now - IMG_MISS_TTL_MS + (retryAfterMs || IMG_MISS_TTL_MS) };
        delete imgBusy[asin];
        saveImgCache();
        if (url) { repaintSoon(); try { if (typeof renderHistory === 'function') renderHistory(); } catch (e) {} }
    }
    // Picture URL for an ASIN if known; otherwise starts a lookup and returns ''.
    function imgFor(asin) {
        if (!asin) return '';
        var e = imgCache[asin];
        if (e && e.u) return e.u;
        if (e && (Date.now() - e.t) < IMG_MISS_TTL_MS) return '';
        if (imgBusy[asin]) return '';
        imgBusy[asin] = true;
        if (isRealAsin(asin)) {
            var url = 'https://ecx.images-amazon.com/images/P/' + asin + '.jpg';
            var probe = new Image();
            probe.referrerPolicy = 'no-referrer';
            probe.onload = function () { if (probe.naturalWidth > 1) imgSet(asin, url); else queueFcrImg(asin); };
            probe.onerror = function () { queueFcrImg(asin); };
            probe.src = url;
        } else {
            queueFcrImg(asin);
        }
        return '';
    }
    // Rolling one-hour budget for FCResearch picture lookups, shared by all tabs.
    var fcrImgLog = null;   // in-memory cache; reloaded from storage only when stale
    function fcrImgBudget() {
        var now = Date.now();
        if (!fcrImgLog) {
            try { fcrImgLog = JSON.parse(localStorage.getItem(IMG_FCR_LOG_KEY) || '[]') || []; } catch (e) { fcrImgLog = []; }
        }
        fcrImgLog = fcrImgLog.filter(function (t) { return now - t < 3600 * 1000; });
        if (fcrImgLog.length >= IMG_FCR_MAX_PER_HOUR) return false;
        fcrImgLog.push(now);
        try { localStorage.setItem(IMG_FCR_LOG_KEY, JSON.stringify(fcrImgLog)); } catch (e) {}
        return true;
    }
    function queueFcrImg(asin) { imgFcrQueue.push(asin); pumpFcrImg(); }
    // FCResearch product page: <img alt="" src="https://m.media-amazon.com/images/I/31KZgRg-92L._SCLZZZZZZZ__.jpg"/>
    function extractFcrImage(html) {
        var m = String(html || '').match(/<img\b[^>]*\bsrc\s*=\s*["']((?:https?:)?\/\/[^"']*(?:media-amazon\.com|images-amazon\.com)\/images\/I\/[^"']+)["']/i);
        if (!m) return '';
        return m[1].indexOf('//') === 0 ? 'https:' + m[1] : m[1];
    }
    function pumpFcrImg() {
        if (imgFcrActive || !imgFcrQueue.length) return;
        var asin = imgFcrQueue.shift();
        if (!fcrImgBudget()) {
            if (!imgCapLogged) { imgCapLogged = true; console.log(CPT_LOG, 'picture lookups paused: ' + IMG_FCR_MAX_PER_HOUR + '/hour FCResearch cap reached'); }
            imgSet(asin, '', IMG_RETRY_MS);
            pumpFcrImg();
            return;
        }
        imgFcrActive = true;
        function done(url, retryMs) { imgFcrActive = false; imgSet(asin, url, retryMs); pumpFcrImg(); }
        gmGet('https://fcresearch-eu.aka.amazon.com/' + getFC() + '/results/product?s=' + encodeURIComponent(asin)).then(function (res) {
            var body = res.responseText || '';
            // Not a product page (login page, error): try again later, not "no picture".
            if (res.status !== 200 || !/a-keyvalue|data-row-id/.test(body)) {
                console.log(CPT_LOG, 'FCResearch picture lookup failed for', asin, '(HTTP ' + res.status + ') - open FCResearch once to sign in');
                return done('', IMG_RETRY_MS);
            }
            done(extractFcrImage(body), IMG_MISS_TTL_MS);
        }, function () { done('', IMG_RETRY_MS); });
    }

    // ---- 7.9: picture element -----------------------------------------------
    // On the list cards the picture sits OUTSIDE the card, to its right (the
    // empty space beside the list). It is positioned against the card itself,
    // so it moves with the card when urgent cards are re-ordered. On the
    // detail screens it stays small, inside the dark info label.
    function makePic(extraCss) {
        var pic = document.createElement('img');
        pic.className = 'pops-asin-img';
        pic.alt = '';
        pic.referrerPolicy = 'no-referrer';
        pic.style.cssText = 'display:none;background:#fff;border-radius:3px;object-fit:contain;' + extraCss;
        pic.addEventListener('error', function () {
            pic.style.display = 'none';
            if (pic.dataset.asin) imgSet(pic.dataset.asin, '', IMG_MISS_TTL_MS);
        });
        return pic;
    }
    // 8.5: one picture size on every Send Runner screen.
    var PIC_H = 200;
    // The page's own item picture (detail screens), from m.media-amazon.com.
    var PAGE_IMG_SEL = 'img[src*="/images/I/"]:not(.pops-asin-img), img[src*="images-amazon.com/images/"]:not(.pops-asin-img)';
    function pageHasItemImage() {
        var imgs = document.querySelectorAll(PAGE_IMG_SEL);
        for (var i = 0; i < imgs.length; i++) if (!(imgs[i].closest && imgs[i].closest('#pops-loc-pick, #pops-barcode-tools'))) return true;
        return false;
    }
    (function enlargePageImages() {
        try {
            var st = document.createElement('style');
            st.id = 'pops-img-style';
            var parentSel = PAGE_IMG_SEL.split(', ').map(function (s) { return ':has(> ' + s + ')'; }).join(', ');
            st.textContent = PAGE_IMG_SEL + ' { height:' + PIC_H + 'px !important; width:auto !important; ' +
                'max-width:100% !important; max-height:none !important; object-fit:contain !important; }\n' +
                // the box around the page's picture must grow with it
                parentSel + ' { height:auto !important; max-height:none !important; min-width:' + PIC_H + 'px; }\n' +
                // 10.5: the list card's own location text is hidden - the card's
                // strip shows the bin to go to (it can differ, and two looked confusing)
                'button.item .item-location { display:none !important; }\n' +
                // 10.18: a card stays hidden while its locations are being checked
                // 10.23: shown straight away but dimmed (was hidden up to 20 s); its floor shows "P…"
                // and its Pick button stays off until the lookups are done
                'button.item.pops-checking { opacity:.6; }\n' +
                // original 10.19: "Select location" screen shows only the location list (and
                // Cancel): no title, CPT time, item line, instruction or picture.
                // A one-location item skips this screen, so its "Scan Pick Bin"
                // screen keeps everything (barcode, ASIN, Print).
                '.sectionshadowNone:has(.page-type-accordion-selection) .page-type-text,\n' +
                '.sectionshadowNone:has(.page-type-accordion-selection) .page-type-cpt-time,\n' +
                '.sectionshadowNone:has(.page-type-accordion-selection) .page-type-item { display:none !important; }\n' +
                'body:has(.page-type-accordion-selection) #pops-item-pic, body:has(.page-type-accordion-selection) #pops-item-pic-bottom,\n' +
                'body:has(.page-type-accordion-selection) #pops-loc-pick { display:none !important; }\n' +
                // original 10.19: the scanner picture ("barcode with a laser") is hidden on every screen
                'img[src*="scanner.png"] { display:none !important; }\n' +
                // 10.14: on the list screen only, the "Send Runner Items" and
                // "Select Item to Pick" lines and the area name (psPOPS_AFE) are hidden
                '.sectionshadowNone:has(send-runner-list-component) .page-type-text { display:none !important; }\n' +
                'send-runner-area-component .area-title { display:none !important; }';
            (document.head || document.documentElement).appendChild(st);
        } catch (e) {}
    })();

    // 7.7: copy that works on the floor laptops - Tampermonkey's own clipboard
    // first (no page permission needed), then the browser API, then the old
    // hidden-textbox method.
    function copyText(text, cb) {
        try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return cb(true); } } catch (e) {}
        function legacy() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text; ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
                document.body.appendChild(ta); ta.select();
                var ok = document.execCommand('copy'); ta.remove(); cb(!!ok);
            } catch (e) { cb(false); }
        }
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { cb(true); }, legacy);
        else legacy();
    }
    function paintInfo(anchorEl, container, bin, asChild) {
        var label = asChild
            ? container.querySelector(':scope > .pops-info-badge')
            : (function () {
                var p = anchorEl.parentNode; if (!p) return null;
                for (var i = 0; i < p.children.length; i++) {
                    var c = p.children[i];
                    if (c.classList && c.classList.contains('pops-info-badge') && c.dataset.bin === bin) return c;
                }
                return null;
            })();
        var floor = floorFor(bin), pod = podFor(bin), asins = asinsFor(bin);
        if (!asins.length) {
            var cardTitle = '';
            try { if (asChild) cardTitle = rowText(container).replace(/P-\d+-[A-Z0-9]+/gi, ' ').replace(/\b(NEW|OPENED)\b/g, ' ').replace(/\s+/g, ' ').trim(); } catch (e) {}
            asins = fcrAsinsFor(bin, cardTitle);
        }
        if (!floor && !pod && !asins.length) {
            if (label) label.remove();
            if (asChild) { var oldPic = container.querySelector(':scope > .pops-asin-img'); if (oldPic) oldPic.remove(); }
            return;
        }
        if (!label) {
            label = document.createElement(asChild ? 'div' : 'span');
            label.className = 'pops-info-badge';
            label.style.cssText = (asChild ? 'margin:2px auto 2px;display:block;width:fit-content;' : 'margin-left:8px;display:inline-block;') +
                'padding:3px 10px;background:#232f3e;color:#fff;border-radius:3px;' +
                'font:bold 16px Arial,sans-serif;cursor:pointer;user-select:none;';
            // 7.7: two parts - floor/POD text, and a separate ASIN chip that copies.
            label.style.cursor = 'default';
            // 7.8: item picture in front (hidden until one is found).
            // 7.9: only on the detail screens; list cards get it beside the card.
            // 8.5: same 200 px size as everywhere else, on its own line above the text.
            if (!asChild) label.appendChild(makePic('margin:2px auto 6px;height:' + PIC_H + 'px;max-width:300px;width:auto;'));
            var infoTxt = document.createElement('span'); infoTxt.className = 'pops-info-txt';
            var chip = document.createElement('span'); chip.className = 'pops-asin-chip';
            chip.style.cssText = 'margin-left:6px;padding:1px 8px;background:#ff9900;color:#000;border-radius:3px;cursor:pointer;';
            label.appendChild(infoTxt); label.appendChild(chip);
            // block the card from reacting to presses on the chip (POPS opens items on press/click)
            ['pointerdown', 'mousedown', 'touchstart', 'mouseup', 'pointerup'].forEach(function (evn) {
                chip.addEventListener(evn, function (ev) { ev.stopPropagation(); }, true);
            });
            chip.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                var a = label.dataset.asins || '';
                if (!a) return;
                copyText(a, function (ok) {
                    var keep = chip.textContent;
                    chip.textContent = ok ? '\u2713 Copied' : 'copy failed';
                    chip.style.background = ok ? '#067d62' : '#c0392b'; chip.style.color = '#fff';
                    chip.dataset.flash = '1';
                    setTimeout(function () { chip.dataset.flash = ''; chip.textContent = keep; chip.style.background = '#ff9900'; chip.style.color = '#000'; }, 1200);
                });
            }, true);
            if (asChild) container.appendChild(label);
            else {
                var after = anchorEl, n = anchorEl.nextElementSibling;
                while (n && n.classList && (n.classList.contains('pops-cpt-badge') || n.classList.contains('pops-print-btn'))) { after = n; n = n.nextElementSibling; }
                after.insertAdjacentElement('afterend', label);
            }
        }
        label.dataset.bin = bin;
        label.dataset.asins = asins.join(', ');
        // 7.8: picture for the first (title-matched) ASIN.
        var picEl = asChild ? null : label.querySelector('.pops-asin-img');
        if (picEl) {
            var picAsin = asins.length ? asins[0] : '';
            var picUrl = picAsin ? imgFor(picAsin) : '';
            // 8.5: on the detail screens the page often shows its own item
            // picture (now enlarged, see Section 2E) - then ours is not repeated.
            if (!asChild && (pageHasItemImage() || document.getElementById('pops-item-pic'))) picUrl = '';
            if (picUrl) {
                if (picEl.getAttribute('src') !== picUrl) { picEl.dataset.asin = picAsin; picEl.src = picUrl; }
                if (picEl.title !== picAsin) picEl.title = picAsin;
                var wantDisp = asChild ? 'inline-block' : 'block';
                if (picEl.style.display !== wantDisp) picEl.style.display = wantDisp;
            } else if (picEl.style.display !== 'none') {
                picEl.style.display = 'none';
            }
        }
        var asinTxt = asins.length ? (asins.length > 2 ? asins[0] + ' +' + (asins.length - 1) : asins.join(', ')) : '\u2013';
        var infoT = (floor ? (isMyFloor(floor) ? '\u2605 ' : '') + 'Floor ' + floor + '  \u00b7  ' : '') + (pod ? 'POD ' + pod + '  \u00b7  ' : '') + 'ASIN:';
        var it = label.querySelector('.pops-info-txt'), ch = label.querySelector('.pops-asin-chip');
        if (it && it.textContent !== infoT) it.textContent = infoT;
        var chipT = asins.length ? asinTxt + ' \u2398' : '\u2013';
        if (ch && ch.dataset.flash !== '1' && ch.textContent !== chipT) ch.textContent = chipT;
        if (ch) { ch.title = asins.length ? 'Click to copy: ' + asins.join(', ') : 'ASIN not found yet'; ch.style.cursor = asins.length ? 'pointer' : 'default'; }
        label.title = (floor || pod ? 'Floor ' + (floor || '?') + ' / POD ' + (pod || '?') + ' (roboscout)\n' : '') + (asins.length ? 'ASIN(s) in ' + bin + ':\n' + asins.join('\n') + '\n(click to copy)' : 'ASIN not in Rodeo ProblemSolving yet for ' + bin);
    }

    // A Rodeo table cell can hold several values on separate lines, e.g.
    //     P-5-B874B424
    //     paKivaA04 : 101396459
    // textContent flattens those with NO separator, so rebuild the cell with
    // real line breaks so each value can be matched on its own.
    function cellLines(td) {
        var out = [];
        (function walk(node) {
            for (var i = 0; i < node.childNodes.length; i++) {
                var n = node.childNodes[i];
                if (n.nodeType === 3) { out.push(n.nodeValue); }
                else if (n.nodeName === 'BR') { out.push('\n'); }
                else if (n.nodeType === 1) { out.push('\n'); walk(n); out.push('\n'); }
            }
        })(td);
        return out.join('');
    }

    // Rodeo's table as a GRID honouring rowspan/colspan (Rodeo merges cells
    // when a container holds several items - the later rows have fewer cells).
    function tableGrid(table) {
        var grid = [], span = {};
        var trs = table.querySelectorAll('tr');
        for (var r = 0; r < trs.length; r++) {
            var cells = trs[r].children, row = [], c = 0;
            for (var k = 0; k < cells.length; k++) {
                while (span[r + ',' + c]) { row[c] = span[r + ',' + c]; c++; }
                var cell = cells[k];
                var rs = parseInt(cell.getAttribute('rowspan'), 10) || 1;
                var cs = parseInt(cell.getAttribute('colspan'), 10) || 1;
                for (var x = 0; x < cs; x++) {
                    row[c] = cell;
                    for (var y = 1; y < rs; y++) span[(r + y) + ',' + c] = cell;
                    c++;
                }
            }
            while (span[r + ',' + c]) { row[c] = span[r + ',' + c]; c++; }
            grid.push(row);
        }
        return grid;
    }

    function headerIndex(grid, names) {
        for (var r = 0; r < grid.length; r++) {
            var cells = grid[r];
            if (!cells.some(function (x) { return x && x.tagName === 'TH'; })) continue;
            for (var c = 0; c < cells.length; c++) {
                var t = ((cells[c] && cells[c].textContent) || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (names.indexOf(t) !== -1) return c;
            }
        }
        return -1;
    }

    function nextPageUrl(doc, baseUrl) {
        var links = doc.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
            var t = (links[i].textContent || '').replace(/\s+/g, ' ').trim();
            if (/next/i.test(t) && />>|»/.test(t) || /^next$/i.test(t)) {
                var href = links[i].getAttribute('href');
                if (!href || href === '#' || /^javascript:/i.test(href)) return null;
                try { return new URL(href, baseUrl).href; } catch (e) { return null; }
            }
        }
        return null;
    }

    // Rodeo ItemList HTML -> { map: { "P-7-H676R453": { cpt: "21:15", cptAt: <ms> } }, next, stats }
    // Column indices come from the header row of the DATA TABLE and rows are
    // read from that same table: numbering every <th> in the document breaks
    // on Rodeo's extra filter/summary tables.
    function parseRodeoBinCpt(html, baseUrl) {
        var cut = html.indexOf('<body');
        if (cut > 0) html = html.slice(cut);
        var doc = new DOMParser().parseFromString(html, 'text/html');

        var SID = ['scannable id', 'scannbare id'];
        // The CPT is the "Expected Ship Date" column. Rodeo also has a
        // "Last ExSD" column, which sits BEFORE it and is often blank or stale;
        // 6.x-7.1 accepted either name and so read Last ExSD by mistake - items
        // with a blank Last ExSD got no CPT at all (fixed in 7.2). It is now
        // only a fallback for a page that has no Expected Ship Date column.
        var EXSD = ['expected ship date', 'erwartetes versanddatum'];
        var EXSD_FALLBACK = ['last exsd', 'exsd'];
        // 7.4: ASIN column if Rodeo shows one, else FN SKU (for retail stock the FN SKU is the ASIN).
        var ASIN_H = ['asin'];
        var FNSKU_H = ['fn sku', 'fnsku', 'fn-sku'];

        var table = null, grid = null, colSid = -1, colCpt = -1, colAsin = -1, colFn = -1, allHeaderTexts = [];
        var tables = doc.querySelectorAll('table');
        for (var i = 0; i < tables.length && !table; i++) {
            var g = tableGrid(tables[i]);
            var s = headerIndex(g, SID), x = headerIndex(g, EXSD);
            if (s !== -1 && x === -1) x = headerIndex(g, EXSD_FALLBACK);
            g.forEach(function (row) { row.forEach(function (c) { if (c && c.tagName === 'TH') allHeaderTexts.push(c.textContent.trim()); }); });
            if (s !== -1 && x !== -1) { table = tables[i]; grid = g; colSid = s; colCpt = x; colAsin = headerIndex(g, ASIN_H); colFn = headerIndex(g, FNSKU_H); }
        }

        var stats = { rows: 0, bins: 0, headerFound: !!table, headers: allHeaderTexts };
        var next = nextPageUrl(doc, baseUrl);
        if (!table) return { map: {}, asinMap: {}, next: next, stats: stats };

        var map = {}, asinMap = {};
        grid.forEach(function (cells) {
            if (cells.some(function (c) { return c && c.tagName === 'TH'; })) return;
            if (!cells[colSid]) return;
            stats.rows++;
            var sidCell = cellLines(cells[colSid]);
            var cptCell = cells[colCpt] ? cells[colCpt].textContent : '';

            var binMatch = sidCell.match(/(^|[\s])(P-\d+-[A-Z0-9]+)(?=[\s]|$)/i);
            if (!binMatch) return;
            // 7.4: ASIN for this bin (read before the CPT check, so a row without a CPT still gives its ASIN)
            try {
                var aCell = colAsin !== -1 ? cells[colAsin] : (colFn !== -1 ? cells[colFn] : null);
                var aTxt = aCell ? (aCell.textContent || '').trim() : '';
                var aM = aTxt.match(/\b(B0[A-Z0-9]{8}|X0[A-Z0-9]{8}|\d{9}[0-9X])\b/i);
                if (aM) {
                    var aBin = binMatch[2].toUpperCase(), aVal = aM[1].toUpperCase();
                    var list = asinMap[aBin] || (asinMap[aBin] = []);
                    if (list.indexOf(aVal) === -1) list.push(aVal);
                }
            } catch (e) {}
            var timeMatch = cptCell.match(/(\d{1,2}):(\d{2})/);
            if (!timeMatch) return;

            var bin = binMatch[2].toUpperCase();
            var entry = map[bin] || { cpt: ('0' + timeMatch[1]).slice(-2) + ':' + timeMatch[2] };
            // the full date too, so a CPT tomorrow at this time is never read as overdue today
            var dm = cptCell.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
            if (dm && !entry.cptAt) entry.cptAt = new Date(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], 0, 0).getTime();
            if (!map[bin]) stats.bins++;
            map[bin] = entry;
        });
        doc = null;
        return { map: map, asinMap: asinMap, next: next, stats: stats };
    }

    // A small, dismissible banner so an auth problem is visible on the page
    // instead of only in the console.
    function showAuthBanner(msg, loginUrl) {
        if (document.getElementById('pops-cpt-auth')) return;
        if (!document.body) return;
        var bar = document.createElement('div');
        bar.id = 'pops-cpt-auth';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
            'background:#c0392b;color:#fff;font:bold 14px Arial;padding:8px 12px;text-align:center;';
        bar.textContent = msg + '  ';
        if (loginUrl) {
            var a = document.createElement('a');
            a.href = loginUrl; a.target = '_blank'; a.textContent = 'Open login';
            a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:6px;';
            bar.appendChild(a);
        }
        var x = document.createElement('span');
        x.textContent = '  ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢';
        x.style.cssText = 'cursor:pointer;margin-left:12px;';
        x.onclick = function () { bar.remove(); };
        bar.appendChild(x);
        document.body.appendChild(bar);
    }
    function clearAuthBanner() {
        var b = document.getElementById('pops-cpt-auth');
        if (b) b.remove();
    }

    var cptFetching = false, cptGen = 0;
    var RODEO_MAX_PAGES = 15;   // 7.3: was 8; a console warning now says when the cap is hit

    function loadCptData() {
        if (cptFetching) return;
        if (document.hidden) return;                 // a hidden tab leaves Rodeo alone; it refreshes when shown again
        // Without the GM API (grant missing, script pasted without its header)
        // CPT simply stays off - the barcode and tracker features carry on.
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.log(CPT_LOG, 'GM_xmlhttpRequest unavailable - CPT disabled; barcode and tracker unaffected.');
            return;
        }
        cptFetching = true;
        // Each fetch has a generation number: only the CURRENT fetch may clear
        // the flag or merge results, so a slow one that outlives the watchdog
        // cannot clobber the one that replaced it.
        var gen = ++cptGen;
        var released = false;
        function release() { released = true; if (gen === cptGen) cptFetching = false; }
        setTimeout(function () { if (!released) { release(); console.log(CPT_LOG, 'request watchdog fired - will retry next cycle'); } }, 60000);

        var pages = 0, merged = {}, mergedAsin = {}, totalRows = 0, totalBins = 0;

        function fetchPage(url) {
            gmGet(url).then(function (res) {
              if (gen !== cptGen) return;              // superseded by a newer fetch
              try {
                if (res.status < 200 || res.status >= 300) {
                    release();
                    console.log(CPT_LOG, 'ERROR: HTTP ' + res.status + ' - if this is a login redirect, open Rodeo in another tab, sign in, then reload this page.');
                    return;
                }
                // An expired Midway / FC Menu session comes back as HTTP 200 with
                // a login page as the body, so the body is checked too.
                var body = res.responseText || '';
                if (body.indexOf('You should authenticate (may use mwinit)') !== -1) {
                    release();
                    console.log(CPT_LOG, 'NOT AUTHENTICATED to Midway. Log in at https://midway-auth.amazon.com/login then reload this page.');
                    showAuthBanner('Midway login needed for CPT', 'https://midway-auth.amazon.com/login');
                    return;
                }
                if (body.indexOf('<h1>Scan your badge to sign in</h1>') !== -1) {
                    release();
                    console.log(CPT_LOG, 'NOT AUTHENTICATED to FC Menu. Sign in (badge scan) then reload this page.');
                    showAuthBanner('FC Menu login needed for CPT', null);
                    return;
                }
                clearAuthBanner();

                var out = parseRodeoBinCpt(body, url);
                body = null; res = null;
                pages++;

                if (!out.stats.headerFound) {
                    if (pages > 1) {
                        // 7.3: a later page without the table (empty last page, odd
                        // layout) no longer throws away the pages already read.
                        console.log(CPT_LOG, 'page ' + pages + ' had no results table - keeping the ' + (pages - 1) + ' page(s) already read.');
                        finish();
                        return;
                    }
                    release();
                    console.log(CPT_LOG, 'ERROR: could not find "Scannable ID" / "Expected Ship Date" headers.',
                        'Headers seen:', out.stats.headers.join(' | ') || '(none - response may not be the item list)');
                    return;
                }

                totalRows += out.stats.rows; totalBins += out.stats.bins;
                if (out.next && out.next !== url && pages >= RODEO_MAX_PAGES) {
                    console.log(CPT_LOG, 'WARNING: page cap (' + RODEO_MAX_PAGES + ') hit - the pool has more pages; bins past it get no CPT.');
                }
                Object.keys(out.map).forEach(function (b) { merged[b] = out.map[b]; });
                Object.keys(out.asinMap || {}).forEach(function (b) {
                    var l = mergedAsin[b] || (mergedAsin[b] = []);
                    out.asinMap[b].forEach(function (a) { if (l.indexOf(a) === -1) l.push(a); });
                });

                if (out.next && out.next !== url && pages < RODEO_MAX_PAGES) {
                    setTimeout(function () { fetchPage(out.next); }, 100);
                    return;
                }
                finish();
              } catch (e) {
                release();
                console.log(CPT_LOG, 'parse error:', e);
              }
            }, function (e) {
                release();
                console.log(CPT_LOG, 'request FAILED (blocked, offline, or not authorised to Rodeo):', e && e.message);
            });
        }

        function finish() {
            // MERGE, do not replace: a bin missing from this particular response
            // keeps its previously known values until they expire.
            var nowMs = Date.now();
            Object.keys(merged).forEach(function (b) {
                var prev = binCptMap[b] || {};
                binCptMap[b] = { cpt: merged[b].cpt, cptAt: merged[b].cptAt || prev.cptAt, seen: nowMs };
            });
            Object.keys(binCptMap).forEach(function (b) {
                if ((nowMs - binCptMap[b].seen) > CPT_ENTRY_TTL_MS) delete binCptMap[b];
            });
            Object.keys(mergedAsin).forEach(function (b) { binAsinMap[b] = { asins: mergedAsin[b], seen: nowMs }; });
            Object.keys(binAsinMap).forEach(function (b) { if ((nowMs - binAsinMap[b].seen) > CPT_ENTRY_TTL_MS) delete binAsinMap[b]; });
            try { localStorage.setItem(ASIN_CACHE_KEY, JSON.stringify(binAsinMap)); } catch (e) {}
            cptEverLoaded = true;
            Object.keys(askedFor).forEach(function (b) { if (merged[b]) delete askedFor[b]; });
            try { localStorage.setItem(CPT_CACHE_KEY, JSON.stringify({ ts: nowMs, map: binCptMap })); } catch (e) {}
            console.log(CPT_LOG, 'OK. pages:', pages, '| data rows:', totalRows, '| bins with CPT:', totalBins, '| bins with ASIN:', Object.keys(mergedAsin).length);
            // 7.3 diagnostics: which bins on screen did this reply NOT cover?
            try {
                var missing = [];
                document.querySelectorAll('button.item').forEach(function (btn) {
                    var b = findBinInRow(btn);
                    if (b && !merged[b]) missing.push(b + (binCptMap[b] ? ' (using older value ' + binCptMap[b].cpt + ')' : ' (NO CPT)'));
                });
                if (missing.length) console.log(CPT_LOG, 'on-screen bins not in this Rodeo reply:', missing.join(', '));
            } catch (e) {}
            if (totalBins === 0) console.log(CPT_LOG, 'NOTE: no P- bins in the ProblemSolving pool at the moment.');
            release();
            repaintSoon();
        }

        fetchPage(rodeoItemListUrl());
    }

    // Build a row's text with real separators, skipping our own badges.
    // textContent concatenates with NO separator, so once a badge lives inside
    // the button the row reads "...P-7-H676R453CPT: 21:15" and a greedy
    // /P-\d+-[A-Z0-9]+/ captures "P-7-H676R453CPT".
    function isOurBadge(n) {
        return n.nodeType === 1 && n.classList && (n.classList.contains('pops-cpt-badge') || n.classList.contains('pops-print-btn') ||
            n.classList.contains('pops-opened-badge') || n.classList.contains('pops-info-badge') ||
            n.classList.contains('pops-asin-img') || n.classList.contains('pops-loc-chip') || n.classList.contains('pops-card-strip') ||
            n.classList.contains('pops-barcode-fallback-wrap'));
    }
    function rowText(root) {
        var parts = [];
        (function walk(node) {
            for (var i = 0; i < node.childNodes.length; i++) {
                var n = node.childNodes[i];
                if (isOurBadge(n)) continue;
                if (n.nodeType === 3) parts.push(n.nodeValue);
                else if (n.nodeType === 1) { parts.push(' '); walk(n); parts.push(' '); }
            }
        })(root);
        return parts.join(' ');
    }

    function findBinInRow(btn) {
        // 1) Preferred: an element whose ENTIRE text is the bin.
        var found = null;
        btn.querySelectorAll('div, span, p, td, b, strong').forEach(function (el) {
            if (found || el.children.length > 0) return;
            if (isOurBadge(el) || (el.closest && el.closest('.pops-barcode-fallback-wrap, .pops-card-strip'))) return;
            var t = (el.textContent || '').trim();
            if (/^P-\d+-[A-Z0-9]+$/i.test(t)) found = t.toUpperCase();
        });
        if (found) return found;
        // 2) Fallback: the whole row, over badge-free separated text.
        var m = rowText(btn).match(/P-\d+-[A-Z0-9]+/i);
        return m ? m[0].toUpperCase() : null;
    }

    // Minutes from now until the CPT. With the full timestamp (cptAt) this is
    // exact; from "HH:MM" alone the nearest occurrence is assumed (Ãƒâ€šÃ‚Â±12h wrap).
    function minutesUntil(hhmm, cptAt) {
        if (cptAt) return Math.round((cptAt - Date.now()) / 60000);
        var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
        if (!m) return null;
        var now = new Date();
        var t = new Date(now);
        t.setHours(+m[1], +m[2], 0, 0);
        var diff = Math.round((t.getTime() - now.getTime()) / 60000);
        if (diff < -720) diff += 1440;   // CPT is tomorrow
        if (diff > 720) diff -= 1440;    // CPT was yesterday
        return diff;
    }

    var CPT_WARN_MINUTES = 30;
    // Urgent = CPT within CPT_WARN_MINUTES, or already passed (up to 2h ago -
    // a missed CPT is the most urgent of all, not something to hide).
    // Two levels: 'soon' (inside 30 min) = yellow, 'overdue' (CPT passed) = red.
    function cptUrgency(cpt, cptAt) {
        var mins = minutesUntil(cpt, cptAt);
        if (mins === null) return { urgent: false, level: '', mins: null };
        if (mins < 0 && mins >= -120) return { urgent: true, level: 'overdue', mins: mins };
        if (mins >= 0 && mins <= CPT_WARN_MINUTES) return { urgent: true, level: 'soon', mins: mins };
        return { urgent: false, level: '', mins: mins };
    }
    // Overdue is solid red with white text, and a dark thick outline: a NEW
    // row is already pink, so a pale red badge would sink into it.
    var URGENT_COLOUR = { soon: '#f0ad00', overdue: '#8e0000' };
    var URGENT_BG     = { soon: '#fff8e1', overdue: '#c0392b' };

    function paintBadge(anchorEl, container, cpt, asChild, cptAt) {
        // A3: a standalone bin's badge is ONLY the one right after it - several
        // bins can share a parent (the bins page), so the parent's first badge
        // may belong to another bin.
        var label = asChild
            ? container.querySelector(':scope > .pops-cpt-badge')
            : ((anchorEl.nextElementSibling && anchorEl.nextElementSibling.classList &&
                anchorEl.nextElementSibling.classList.contains('pops-cpt-badge')) ? anchorEl.nextElementSibling : null);
        if (!cpt) { if (label) label.remove(); return; }
        if (!label) {
            label = document.createElement(asChild ? 'div' : 'span');
            label.className = 'pops-cpt-badge';
            label.style.cssText = (asChild ? 'margin:4px auto 2px;display:inline-block;' : 'margin-left:8px;') +
                'padding:3px 10px;background:#fff;border:1px solid #999;border-radius:3px;' +
                'font-weight:bold;font-size:22px;color:#555;';
            if (asChild) container.appendChild(label);
            else anchorEl.insertAdjacentElement('afterend', label);
        }
        // Yellow once the CPT is within CPT_WARN_MINUTES, red once it has passed.
        var u = cptUrgency(cpt, cptAt);
        var txt = 'CPT: ' + cpt + (u.level === 'overdue' ? '  OVERDUE ' + (-u.mins) + 'm' : '');
        if (label.textContent !== txt) label.textContent = txt;
        var wantBorder = u.urgent ? '3px solid ' + URGENT_COLOUR[u.level] : '1px solid #999';
        var wantBg = u.urgent ? URGENT_BG[u.level] : '#fff';
        var wantColor = u.level === 'overdue' ? '#fff' : '#555';
        if (label.style.border !== wantBorder) label.style.border = wantBorder;
        if (label.style.background !== wantBg) label.style.background = wantBg;
        if (label.style.color !== wantColor) label.style.color = wantColor;
    }

    // ON-DEMAND REFRESH: a bin that appears between scheduled fetches has no
    // CPT yet, so its row would sit without a badge for up to 20s. Ask Rodeo
    // straight away the first time an unknown bin is seen - once per bin, and
    // never two such fetches closer than the cooldown.
    var ON_DEMAND_COOLDOWN_MS = 2000;
    var lastOnDemand = 0;
    var cptEverLoaded = false;  // set once a fetch has actually returned a table
    var onDemandRetry = null;   // pending re-check for when the cooldown expires
    var askedFor = {};          // bins we have already spent an on-demand fetch on
    function maybeFetchForUnknown(bins) {
        if (!bins.length) return;
        if (!cptEverLoaded) return;      // before the first fetch every bin looks unknown
        bins = bins.filter(function (b) { return !askedFor[b]; });
        if (!bins.length) return;        // nothing new to ask about - no retry loop while a fetch runs
        if (cptFetching) {
            // the reply in flight may not contain a row that appeared after it was sent
            if (!onDemandRetry) onDemandRetry = setTimeout(function () { onDemandRetry = null; repaintSoon(); }, 600);
            return;
        }
        var fresh = bins.filter(function (b) { return !askedFor[b]; });
        if (!fresh.length) return;
        var now = Date.now();
        if (now - lastOnDemand < ON_DEMAND_COOLDOWN_MS) {
            if (!onDemandRetry) {
                var wait = ON_DEMAND_COOLDOWN_MS - (now - lastOnDemand) + 50;
                onDemandRetry = setTimeout(function () { onDemandRetry = null; repaintSoon(); }, wait);
            }
            return;
        }
        lastOnDemand = now;
        fresh.forEach(function (b) { askedFor[b] = true; });
        console.log(CPT_LOG, 'unknown bin(s) on screen (' + fresh.slice(0, 3).join(', ') +
            (fresh.length > 3 ? ', +' + (fresh.length - 3) + ' more' : '') + ') - fetching now');
        safeLoadCptData();
    }

    // URGENT CARDS (v6.3). A card whose CPT is within CPT_WARN_MINUTES gets the
    // same yellow (or red when overdue) outline as its CPT badge, and urgent cards are moved to the
    // TOP of the list, soonest CPT first. The move is done with CSS flex order
    // on the cards' container, not by moving DOM nodes, so the page's own
    // rendering is never disturbed.
    function markUrgentCard(btn, cptVal, cptAt, onMyFloor) {
        var u = cptVal ? cptUrgency(cptVal, cptAt) : { urgent: false, level: '', mins: null };
        var wantOutline = u.urgent ? (u.level === 'overdue' ? '6px' : '4px') + ' solid ' + URGENT_COLOUR[u.level] : '';
        if (btn.style.outline !== wantOutline) { btn.style.outline = wantOutline; btn.style.outlineOffset = u.urgent ? (u.level === 'overdue' ? '-6px' : '-4px') : ''; }
        // order: urgent cards get NEGATIVE orders (passed CPTs first) so they rise
        // above everything, including page headers and cards without a bin,
        // which keep their natural order of 0
        // 8.0: cards on the associate's chosen floor come next (-5000), above
        // all other cards but below urgent ones.
        // 10.24: inside each group the cards are now sorted by CPT, soonest first. Before, all cards on
        // your floor shared one order (-5000) and all other cards shared 0, so within a group they stayed
        // in the page's own order, which looked like a random sort. Groups (top to bottom):
        //   urgent (overdue first, then due within 30 min)   -10120 .. -9970
        //   your floor, by CPT                                -6000 .. -2000   (no CPT: last)
        //   other floors, by CPT                                  0 .. 6000    (no CPT: last)
        function clampMin(m, lo, hi) { return Math.max(lo, Math.min(hi, m)); }
        var wantOrder;
        if (u.urgent) wantOrder = String(u.mins - 10000);
        else if (onMyFloor) wantOrder = String(-5000 + (u.mins === null ? 3000 : clampMin(u.mins, -1000, 3000)));
        else wantOrder = String(u.mins === null ? 7000 : 1000 + clampMin(u.mins, -1000, 5000));
        if (btn.style.order !== wantOrder) btn.style.order = wantOrder;
        return u.urgent;
    }
    function prioritiseUrgent(buttons, anyUrgent) {
        if (!buttons.length) return;
        // 10.24: every container is handled on its own. Before, if the cards sat in more than one
        // container (e.g. two areas on the list) the whole sort was silently skipped.
        var parents = [];
        buttons.forEach(function (b) { var p = b.parentElement; if (p && parents.indexOf(p) === -1) parents.push(p); });
        parents.forEach(function (parent) {
            if (/^(TABLE|TBODY|TR|UL|OL)$/.test(parent.tagName)) return;                            // leave tables/lists alone
            if (anyUrgent) {
                if (parent.dataset.popsFlexed !== '1') {
                    parent.dataset.popsFlexed = '1';
                    parent.dataset.popsPrevDisplay = parent.style.display || '';
                    parent.style.display = 'flex'; parent.style.flexDirection = 'column';
                }
            } else if (parent.dataset.popsFlexed === '1') {
                parent.style.display = parent.dataset.popsPrevDisplay || ''; parent.style.flexDirection = '';
                parent.dataset.popsFlexed = '0';
            }
        });
    }

    // ---- 9.2: one compact strip on each list card ------------------------------
    //   [picture] | CPT 21:15 (OVERDUE 73m)
    //             | P3   P-5-R987A410
    //             | ASIN B0D2J1M9W4 [copy]
    // Floor is shown as P + floor number (paKivaA03 -> P3). Location is the
    // first bin on the associate's floor when known, else the card's own bin.
    function floorShort(f) {
        var m = /(\d+)\s*$/.exec(String(f || ''));
        return m ? 'P' + (+m[1]) : '';
    }
    function paintCardStrip(btn, bin, cptVal, cptAt, pick) {
        // the 7.x-9.1 pieces this strip replaces
        btn.querySelectorAll(':scope > .pops-cpt-badge, :scope > .pops-info-badge, :scope > .pops-loc-chip, :scope > .pops-asin-img')
            .forEach(function (n) { n.remove(); });

        var title = btn.dataset.popsTitle || '';
        var locBin = pick ? pick.bin : bin;
        // 10.23: while the lookups run, POPS's own floor (can be out of date) is NOT shown and the card
        // is not "on your floor" yet - that is what made a card show P3 and then change to P2
        var checking = btn.classList.contains('pops-checking');
        var floorRaw = floorFor(locBin) || (!checking && pick && pick.group && pick.group.floor ? pick.group.floor : '');   // 10.2: roboscout first
        var fl = floorShort(floorRaw);
        var mine = !checking && (pick ? pick.onMyFloor : isMyFloor(floorFor(bin)));
        var e = title ? itemLocs[normT(title)] : null;
        var asin = (e && e.asin) || '';
        if (!asin) { var a = asinsFor(bin); if (!a.length) a = fcrAsinsFor(bin, title); asin = a[0] || ''; }
        // 9.8: the item's own remembered picture first, then the ASIN lookup;
        // a found picture is remembered for the item
        var picUrl = titleImgFor(title);
        if (!picUrl && asin) { picUrl = imgFor(asin); if (picUrl) titleImgSet(title, picUrl); }
        else if (asin) imgFor(asin);

        var s = btn.querySelector(':scope > .pops-card-strip');
        if (!s) {
            s = document.createElement('div');
            s.className = 'pops-card-strip';
            s.style.cssText = 'display:flex;align-items:center;gap:18px;margin:8px auto 2px;width:fit-content;min-width:min(620px,100%);max-width:100%;box-sizing:border-box;' +
                'padding:8px 18px 8px 8px;background:#fff;border:2px solid #232f3e;border-radius:8px;' +
                'box-shadow:0 1px 3px rgba(0,0,0,.15);font-family:Arial,sans-serif;color:#111;text-align:left;cursor:default;';
            s.innerHTML =
                '<div class="pcs-pic" style="flex:0 0 auto;width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:4px;">' +
                    '<img class="pops-asin-img" referrerpolicy="no-referrer" alt="" style="max-width:150px;max-height:150px;object-fit:contain;display:none;"></div>' +
                '<div style="display:flex;flex-direction:column;gap:6px;">' +
                    '<div class="pcs-cpt" style="font:900 28px Arial,sans-serif;padding:2px 10px;border-radius:4px;width:fit-content;"></div>' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                        '<span class="pcs-floor" style="font:900 26px Arial,sans-serif;padding:2px 12px;border-radius:4px;"></span>' +
                        '<span class="pcs-loc" style="font:900 26px monospace;"></span>' +
                    '</div>' +
                    '<div class="pcs-pod" style="font:bold 21px Arial,sans-serif;color:#222;"></div>' +
                    '<div style="display:flex;align-items:center;gap:8px;font-size:15px;">' +
                        '<span style="color:#555;">ASIN</span>' +
                        '<span class="pcs-asin" title="Click to copy" style="font:900 20px monospace;padding:3px 10px;background:#ff9900;color:#000;border-radius:3px;cursor:pointer;"></span>' +
                    '</div>' +
                    // 10.11: barcode of the location + "Pick This Location"
                    '<div class="pcs-pick" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px;">' +
                        '<div class="pcs-bc" style="width:280px;max-width:100%;background:#fff;"></div>' +
                        '<button type="button" class="pcs-pickbtn" style="padding:10px 16px;font:900 18px Arial,sans-serif;background:#067d62;color:#fff;' +
                            'border:0;border-radius:6px;cursor:pointer;">Pick This Location</button>' +
                    '</div>' +
                '</div>';
            var img = s.querySelector('img');
            img.addEventListener('error', function () {
                img.style.display = 'none'; img.dataset.broken = '1';
                if (img.dataset.asin) imgSet(img.dataset.asin, '', IMG_RETRY_MS);
                // a broken remembered picture is forgotten so the next pass looks again
                var tk = img.dataset.title; if (tk && titleImg[tk] && titleImg[tk].u === img.getAttribute('src')) delete titleImg[tk];
            });
            var chip = s.querySelector('.pcs-asin');
            // pressing the ASIN copies it and must not open the item
            ['pointerdown', 'mousedown', 'touchstart', 'mouseup', 'pointerup'].forEach(function (evn) {
                chip.addEventListener(evn, function (ev) { ev.stopPropagation(); }, true);
            });
            chip.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                var v = chip.dataset.asin;
                if (!v) return;
                copyText(v, function (ok) {
                    chip.dataset.flash = '1';
                    chip.textContent = ok ? '\u2713 Copied' : 'copy failed';
                    setTimeout(function () { chip.dataset.flash = ''; chip.textContent = chip.dataset.asin || '\u2013'; }, 1200);
                });
            }, true);
            // 10.11: "Pick This Location" - must not open the card by itself
            var pbtn = s.querySelector('.pcs-pickbtn');
            ['pointerdown', 'mousedown', 'touchstart', 'mouseup', 'pointerup'].forEach(function (evn) {
                pbtn.addEventListener(evn, function (ev) { ev.stopPropagation(); }, true);
            });
            pbtn.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
                var target = (s.querySelector('.pcs-loc').textContent || '').trim().toUpperCase();
                if (!BIN_ONLY_RE.test(target)) return;
                // 10.17: never for a bin that is not on the associate's floor (checked again at the press)
                var row = s.querySelector('.pcs-pick');
                if (!row || row.dataset.onFloor !== '1' || !isMyFloor(floorFor(target))) {
                    pickStatus(btn, 'Not on your floor - pick this one by hand', '#c0392b', 8000);
                    return;
                }
                pickThisLocation(btn, target);
            }, true);
            btn.appendChild(s);
        }

        // picture
        var im = s.querySelector('img');
        // 9.8: sticky - a picture already shown for THIS item stays while a
        // later lookup is still running or briefly comes back empty
        if (!picUrl && im.dataset.title === titleKey(title) && im.getAttribute('src') && im.dataset.broken !== '1') picUrl = im.getAttribute('src');
        if (picUrl) {
            if (im.getAttribute('src') !== picUrl) { im.dataset.asin = asin; im.dataset.broken = ''; im.src = picUrl; }
            im.dataset.title = titleKey(title);
            if (im.style.display !== 'block') im.style.display = 'block';
        } else if (im.style.display !== 'none') im.style.display = 'none';
        var pc = s.querySelector('.pcs-pic');
        // the picture space is always kept, so the card does not jump when it arrives
        var wantPc = 'flex';
        if (pc.style.display !== wantPc) pc.style.display = wantPc;

        // CPT
        var cptEl = s.querySelector('.pcs-cpt');
        var u = cptVal ? cptUrgency(cptVal, cptAt) : { urgent: false, level: '', mins: null };
        var cptTxt = cptVal ? 'CPT ' + cptVal + (u.level === 'overdue' ? '  OVERDUE ' + (-u.mins) + 'm' : '') : 'CPT \u2013';
        if (cptEl.textContent !== cptTxt) cptEl.textContent = cptTxt;
        var cBg = u.level === 'overdue' ? '#c0392b' : (u.level === 'soon' ? '#fff3c4' : '#f1f1f1');
        var cFg = u.level === 'overdue' ? '#fff' : '#222';
        if (cptEl.style.background !== cBg) { cptEl.style.background = cBg; cptEl.style.color = cFg; }

        // floor + location
        var flEl = s.querySelector('.pcs-floor');
        var flTxt = fl || (checking ? 'P\u2026' : 'P?');
        if (flEl.textContent !== flTxt) flEl.textContent = flTxt;
        var fBg = mine ? '#067d62' : '#e3e6e8', fFg = mine ? '#fff' : '#333';
        if (flEl.style.background !== fBg) { flEl.style.background = fBg; flEl.style.color = fFg; }
        flEl.title = mine ? 'Your floor' : (floorRaw ? 'Floor ' + floorRaw : 'Floor not known yet');
        var locEl = s.querySelector('.pcs-loc');
        if (locEl.textContent !== locBin) locEl.textContent = locBin;
        // 9.3: POD of that location (roboscout, cached)
        var podEl = s.querySelector('.pcs-pod');
        var pod = podFor(locBin);
        var podTxt = 'POD ' + (pod || '\u2026');
        if (podEl.textContent !== podTxt) podEl.textContent = podTxt;
        // 10.11: barcode of the location shown, and the "Pick This Location" button
        var pickRow = s.querySelector('.pcs-pick');
        if (pickRow) {
            var isBinLoc = BIN_ONLY_RE.test(locBin || '');
            // 10.17: SAFETY - button and barcode only when the bin shown is on the
            // associate's own floor; otherwise the pick is left to be done by hand
            var onFloorNow = isBinLoc && !!mine;
            pickRow.style.display = onFloorNow ? 'flex' : 'none';
            pickRow.dataset.onFloor = onFloorNow ? '1' : '';
            // 10.16: SAFETY - the barcode only appears once "Pick This Location"
            // has succeeded (green) for this card, and only for the bin that was
            // really picked, so a pod can never be called for a bin POPS did not assign
            var bcEl = s.querySelector('.pcs-bc');
            var pfx = btn.dataset.popsKey ? pickedFor[btn.dataset.popsKey] : null;
            var confirmed = isBinLoc && pfx && pfx.bin === locBin;
            if (confirmed) {
                if (bcEl.dataset.bin !== locBin) {
                    bcEl.dataset.bin = locBin;
                    bcEl.innerHTML = renderBarcode128SVG(locBin) || '';
                    fitBarcode(bcEl);
                }
                bcEl.style.display = '';
            } else {
                if (bcEl.dataset.bin) { bcEl.dataset.bin = ''; bcEl.innerHTML = ''; }
                bcEl.style.display = 'none';
            }
            var pb = s.querySelector('.pcs-pickbtn');
            if (+(pb.dataset.statusUntil || 0) <= Date.now()) {          // 10.12: unless a pick result is being shown
                var done = pickedLocs[locBin];
                var pTxt = done ? '\u2713 Location picked ' + ('0' + new Date(done).getHours()).slice(-2) + ':' + ('0' + new Date(done).getMinutes()).slice(-2) : 'Pick This Location';
                if (pb.textContent !== pTxt) pb.textContent = pTxt;
                var pBg = done ? '#5a6b7b' : '#067d62';
                if (pb.style.background !== pBg) pb.style.background = pBg;
                pb.title = done ? 'Already picked on this laptop - press again to try again' : 'Selects ' + locBin + ' for this pick in POPS in the background (stock is assigned to the order), then you can call the pod';
            }
        }

        // ASIN
        var ch = s.querySelector('.pcs-asin');
        ch.dataset.asin = asin;
        if (ch.dataset.flash !== '1' && ch.textContent !== (asin || '\u2013')) ch.textContent = asin || '\u2013';
    }

    // 10.18: is a card still waiting for its location checks?
    var CHECK_HIDE_MS = 20 * 1000, checkSince = {};
    function cardChecking(bin, title, pick) {
        if (pick && pick.src === 'picked') return false;              // already picked: nothing to wait for
        if (fcrPending[bin]) return true;                             // ASIN of the bin still being looked up
        var a = asinsFor(bin); if (!a.length) a = fcrAsinsFor(bin, title);
        var asin = a[0] || '';
        if (asin && asinBinsPending[asin]) return true;               // bins holding the ASIN still being looked up
        var e = asin ? asinBins[asin] : null;
        if (e && e.check && e.check.some(function (b) { return binInfoPending[b]; })) return true;   // roboscout floors
        if (binInfoPending[bin]) return true;
        if (pick && pick.bin && binInfoPending[pick.bin]) return true;
        return false;
    }
    function markChecking(btn, bin, pick) {
        var key = btn.dataset.popsKey || bin;
        var waiting = cardChecking(bin, btn.dataset.popsTitle || '', pick);
        var now = Date.now();
        if (waiting) { if (!checkSince[key]) checkSince[key] = now; if (now - checkSince[key] > CHECK_HIDE_MS) waiting = false; }
        else delete checkSince[key];
        if (btn.classList.contains('pops-checking') !== waiting) btn.classList.toggle('pops-checking', waiting);
        if (waiting) setTimeout(repaintSoon, 1500);                  // look again shortly
    }
    // 10.27: is a list card on screen (or within 300 px of it)? The browser's IntersectionObserver keeps
    // data-pops-vis up to date while scrolling; until it has reported, the position is measured directly.
    var cardIO = null;
    function cardVisible(btn) {
        var v = btn.dataset.popsVis;
        if (v === '1') return true;
        if (v === '0') return false;
        try { var r = btn.getBoundingClientRect(); return r.bottom > -300 && r.top < (window.innerHeight || 800) + 300; } catch (e) { return true; }
    }
    function watchCard(btn) {
        if (btn.dataset.popsIo || typeof IntersectionObserver !== 'function') return;
        if (!cardIO) {
            cardIO = new IntersectionObserver(function (entries) {
                var newlyVisible = false;
                entries.forEach(function (en) {
                    var v = en.isIntersecting ? '1' : '0';
                    if (en.target.dataset.popsVis !== v) { en.target.dataset.popsVis = v; if (v === '1') { newlyVisible = true; delete en.target.dataset.popsWarm; } }
                });
                if (newlyVisible) repaintSoon();   // their lookups are moved to the front on the next pass
            }, { rootMargin: '300px 0px' });
        }
        btn.dataset.popsIo = '1';
        cardIO.observe(btn);
    }
    function cptScan() {
        var unknown = [];
        var buttons = [], anyUrgent = false;
        // prune stale checkSince entries so the map does not grow unbounded
        var nowCheck = Date.now();
        Object.keys(checkSince).forEach(function (k) { if (nowCheck - checkSince[k] > CHECK_HIDE_MS * 2) delete checkSince[k]; });
        // Item rows on the list: CPT badge and urgency.
        // 10.10: decide every card's bin first, so several units of the same item
        // get DIFFERENT bins: each unit keeps its own original location when that
        // qualifies; the others are given the next free bins (on the chosen floor
        // first). Only when there are more units than bins is a bin repeated.
        // 8.3: an item's POPS location list is used when seen, otherwise (9.1)
        // the FCResearch bins for its ASIN.
        function choosePick(c, avoid) {
            // 10.15: a location already picked for this card stays on it
            var pf = c.btn.dataset.popsKey ? pickedFor[c.btn.dataset.popsKey] : null;
            if (pf && pf.bin) {
                var fi = knownInfo(pf.bin) || binInfoFor(pf.bin);
                var fm = fi && fi.floor ? /(\d+)\s*$/.exec(fi.floor) : null;
                return { bin: pf.bin, group: { floor: fm ? String(+fm[1]) : '', mod: '', bins: [pf.bin] }, onMyFloor: isMyFloor(fi && fi.floor), chosen: true, src: 'picked' };
            }
            var p = null;
            try { p = pickForItem(c.title, c.bin, avoid, c.opts); } catch (e) {}
            if (!p) { try { p = fcrPickForCard(c.bin, c.title, avoid, c.opts); } catch (e) {} }
            return p;
        }
        var cards = [], units = {};
        document.querySelectorAll('button.item').forEach(function (btn) {
            var bin = findBinInRow(btn);
            if (!bin) return;
            var c = { btn: btn, bin: bin, title: btn.dataset.popsTitle || '' };
            c.k = normT(c.title);
            units[c.k] = (units[c.k] || 0) + 1;
            cards.push(c);
        });
        // 10.27: which cards are on screen (the rest are looked up later), and which cards need the
        // extra bins at all (see ownBinOnMyFloor / queueBinChecks)
        cardOwnBins = {};
        cards.forEach(function (c) {
            cardOwnBins[c.bin] = true;
            try { watchCard(c.btn); } catch (e) {}
            c.vis = cardVisible(c.btn);
            c.opts = { units: units[c.k], noExtras: units[c.k] < 2 && ownBinOnMyFloor(c.bin) };
        });
        var visCards = cards.filter(function (c) { return c.vis; }), hidCards = cards.filter(function (c) { return !c.vis; });
        // 10.23/10.27: the floor of every card's OWN bin is looked up first, cards on screen first.
        // (unshift puts the last one handled at the front, so the list is walked backwards)
        var ownOrder = visCards.concat(hidCards);
        for (var ci = ownOrder.length - 1; ci >= 0; ci--) { try { binInfoFor(ownOrder[ci].bin, true); } catch (e) {} }
        // 10.27: the extra-bin lookups of the cards on screen are queued before those of the cards below
        // (once per card; the normal passes below then find them already queued)
        visCards.forEach(function (c) {
            if (c.btn.dataset.popsWarm === '1') return;
            c.btn.dataset.popsWarm = '1';
            try { choosePick(c, null); } catch (e) {}
        });
        var taken = {};
        cards.forEach(function (c) {                       // pass 1: units staying on their own bin
            if (units[c.k] < 2) return;
            var p = choosePick(c, null);
            if (p && p.bin === c.bin && !(taken[c.k] && taken[c.k][c.bin])) { c.pick = p; (taken[c.k] = taken[c.k] || {})[c.bin] = true; }
        });
        cards.forEach(function (c) {                       // pass 2: everyone else
            if (c.pick) return;
            if (units[c.k] < 2) { c.pick = choosePick(c, null); return; }
            c.pick = choosePick(c, taken[c.k] || {});
            if (c.pick) (taken[c.k] = taken[c.k] || {})[c.pick.bin] = true;
        });
        cards.forEach(function (c) {
            var btn = c.btn, bin = c.bin;
            var cptVal = cptFor(bin), cptAt = cptAtFor(bin);
            if (!cptVal) unknown.push(bin);
            buttons.push(btn);
            var locPick = c.pick || null;
            // 10.18/10.23: is the card still waiting for its location checks? (decided first, the strip uses it)
            try { markChecking(btn, bin, locPick); } catch (e) {}
            // 9.2: one compact strip per card - picture, CPT, floor, location, ASIN
            try { paintCardStrip(btn, bin, cptVal, cptAt, locPick); } catch (e) { console.log(CPT_LOG, 'card strip error:', e); }
            // 10.4: remember the card, for a later "vanished from SR" report
            try {
                var ca = asinsFor(bin); if (!ca.length) ca = fcrAsinsFor(bin, btn.dataset.popsTitle);
                rememberCard(bin, btn.dataset.popsTitle || '', ca.join(', '), cptVal || '');
            } catch (e) {}
            // not moved up to "your floor" while still checking (it would jump again)
            var onMyFloor = !btn.classList.contains('pops-checking') && (locPick ? locPick.onMyFloor : isMyFloor(floorFor(bin)));
            if (markUrgentCard(btn, cptVal, cptAt, onMyFloor)) anyUrgent = true;
            anyUrgent = true;   // 10.24: every card now has a sort order (floor / CPT), so the list is always flexed
        });
        try { prioritiseUrgent(buttons, anyUrgent); } catch (e) { console.log(CPT_LOG, 'prioritise error:', e); }
        // A bin is not always inside a button.item (the green bin row on the
        // detail screen is not): standalone bin elements get the CPT badge too.
        leafElements().forEach(function (el) {
            if (/^H[1-4]$/.test(el.tagName)) return;                         // headings never carry a bin
            if (!el.isConnected) return;
            var t = (el.textContent || '').trim();
            if (!/^P-\d+-[A-Z0-9]+$/i.test(t)) return;                      // cheap test first
            if (isOurBadge(el) || (el.closest && el.closest('.pops-barcode-fallback-wrap'))) return;
            if (el.closest && el.closest('button.item')) return;   // covered above
            if (el.closest && el.closest('#pops-loc-pick, #pops-alerts, #pops-barcode-tools, #pops-auto-pic, #pops-item-pic, #pops-item-pic-bottom, #pops-scan-bar, .page-type-accordion-selection')) return; // 8.3/8.7: our own boxes
            var b2 = t.toUpperCase();
            var cptVal2 = cptFor(b2);
            if (!cptVal2) unknown.push(b2);
            paintBadge(el, el.parentNode || el, cptVal2, false, cptAtFor(b2));
            try { paintPrintButton(el, b2); } catch (e) { console.log(CPT_LOG, 'print button error:', e); }
            try { paintInfo(el, el.parentNode || el, b2, false); } catch (e) { console.log(CPT_LOG, 'ASIN/floor paint error:', e); }
        });
        maybeFetchForUnknown(unknown);
    }

    // ---- PRINT (Printmon) -------------------------------------------------------
    //
    // A small Print button next to a bin ID on the detail screens (the green
    // bin row, the bins page) - NOT on the Send Runner list cards, which stay
    // clean. Printmon runs on the workstation at localhost:5965 and answers
    // "valid" (sent) or "invalid" (printer off/unplugged); anything else means
    // Printmon is not running there. Same call the FC Research helper uses.
    var PRINTMON = 'http://localhost:5965/printer';
    function asciihex(str) { var out = ''; for (var i = 0; i < str.length; i++) out += str.charCodeAt(i).toString(16); return out; }
    function cookieValue(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }
    var lastPrinted = '', lastPrintAt = 0;
    // One timer per button, always restoring the real label - two overlapping
    // flashes ("..." then "sent") once left the button reading "..." for good.
    function flashBtn(btn, color, label) {
        if (btn._flashT) clearTimeout(btn._flashT);
        btn.style.background = color; btn.textContent = label;
        btn._flashT = setTimeout(function () { btn._flashT = null; btn.textContent = btn.dataset.label || 'Print'; btn.style.background = '#f0ad00'; }, 1400);
    }
    function printBin(code, btn) {
        var now = Date.now();
        if (code === lastPrinted && now - lastPrintAt < 5000) { flashBtn(btn, '#fff4d6', 'dup'); return; }   // double-click guard
        var url = PRINTMON + '?action=print&type=barcode&data=' + asciihex(code) + '&text=' + asciihex(code) +
            '&quantity=1&badgeid=' + encodeURIComponent(cookieValue('fcmenu-employeeId')) + '&desc=&seq=' + String(Math.floor(Math.random() * 1e10));
        flashBtn(btn, '#e8f0fe', '\u2026');
        if (typeof GM_xmlhttpRequest !== 'function') { flashBtn(btn, '#ffd9d9', 'error'); return; }
        GM_xmlhttpRequest({ method: 'GET', url: url, timeout: 8000,
            onload: function (res) {
                var t = (res.responseText || '').trim();
                if (t === 'valid') { lastPrinted = code; lastPrintAt = now; flashBtn(btn, '#d4f7d4', 'sent'); }
                else if (t === 'invalid') { flashBtn(btn, '#ffd9d9', 'printer?'); alert('Barcode: ' + code + '\n\nFailed to print. Check the printer is plugged in and switched on.'); }
                else { flashBtn(btn, '#ffd9d9', 'no Printmon'); alert('Barcode: ' + code + '\n\nPrintmon is not running on this workstation, so nothing can be printed.'); }
            },
            onerror: function () { flashBtn(btn, '#ffd9d9', 'no Printmon'); },
            ontimeout: function () { flashBtn(btn, '#ffd9d9', 'timeout'); }
        });
    }
    function paintPrintButton(anchorEl, code) {
        // sits right after the CPT badge if there is one, else after the bin element
        var after = (anchorEl.nextElementSibling && anchorEl.nextElementSibling.classList && anchorEl.nextElementSibling.classList.contains('pops-cpt-badge'))
            ? anchorEl.nextElementSibling : anchorEl;
        // one button per bin element: the barcode wrapper may be inserted between
        // the bin and an earlier button, so look among the siblings, not just next
        var parent = anchorEl.parentNode;
        if (parent) {
            var sibs = parent.children;
            for (var i = 0; i < sibs.length; i++) {
                if (sibs[i].classList && sibs[i].classList.contains('pops-print-btn') && sibs[i].dataset.code === code) {
                    // keep it right after the CPT badge / bin even if a badge arrived later
                    if (after.nextElementSibling !== sibs[i]) after.insertAdjacentElement('afterend', sibs[i]);
                    return;
                }
            }
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pops-print-btn';
        b.dataset.code = code;
        b.dataset.label = 'Print';
        b.textContent = 'Print';
        b.title = 'Print a barcode label for ' + code;
        b.style.cssText = 'margin-left:8px;padding:2px 10px;font-size:13px;font-weight:bold;cursor:pointer;background:#f0ad00;' +
            'border:1px solid #c08f00;border-radius:3px;color:#000;vertical-align:middle;';
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); printBin(b.dataset.code, b); });
        after.insertAdjacentElement('afterend', b);
    }

    // Bootstrap. Everything CPT-related is wrapped so that no failure
    // here can abort the IIFE and take the barcode + OPENED tracker down with it.
    function safeLoadCptData() {
        try { loadCptData(); } catch (e) { console.log(CPT_LOG, 'load error (CPT only, rest unaffected):', e); }
    }
    try { console.log(CPT_LOG, 'CPT section loaded (v10.28) - FC ' + getFC()); } catch (e) {}
    // Paint straight away from the cached map, before anything else runs.
    try { cptScan(); } catch (e) { console.log(CPT_LOG, 'first paint skipped:', e); }
    // The first Rodeo fetch waits a moment (7.1): the cached map has already
    // painted, and parsing Rodeo's reply during the page's own loading only
    // slowed that loading down on the laptops.
    // It fires as soon as the page has finished its first draw (see Section 3),
    // or after 2s at the latest.
    var firstFetchDone = false;
    function firstFetch() { if (firstFetchDone) return; firstFetchDone = true; safeLoadCptData(); }
    setTimeout(firstFetch, 2000);
    // 10.0: no timed refresh any more. Rodeo is read when the page is opened,
    // when the tab comes back into view, each time the item list is shown
    // again (e.g. back from finishing an item), and straight away for a bin
    // the script has not seen before (on-demand fetch, above).
    document.addEventListener('visibilitychange', function () { if (!document.hidden) safeLoadCptData(); });
    var listWasShown = false;
    function rodeoOnListShown() {
        var onList = !!document.querySelector('button.item');
        if (onList && !listWasShown && firstFetchDone) safeLoadCptData();
        listWasShown = onList;
    }

    // =========================================================================
    // SECTION 2: OPENED Tracker
    // =========================================================================

    var STORAGE_KEY = 'pops_opened_ids';
    var SHIFT_KEY_STORAGE = 'pops_shift_reset_key';

    // How long an item must be ABSENT from the list before we forget we opened
    // it. Presence-based: an item you opened that is still in the list (or that
    // briefly drops off a busy list and returns) stays OPENED; it only reverts
    // to NEW once it has been gone continuously for this long.
    //
    // Set to 10 MINUTES. Long enough that a tote dropping off a busy list for
    // a couple of minutes and returning stays OPENED (no false revert while you
    // are still dealing with it), but short enough that the SAME product coming
    // back as a genuinely new task is forgotten and reads as NEW again. This is
    // the only line that controls the behaviour - change the 10 to adjust.
    var GONE_GRACE_MS = 10 * 60 * 1000;

    // Shift windows: day 08:00-18:30, night 18:30-05:00 (next day).
    // Returns the timestamp of the current shift's start - used purely as a
    // marker to detect "we've crossed into a new shift" between page loads.
    // =========================================================================
    // 10.9: FLOOR QUESTION at the start of each shift (day 08:00, night 18:30)
    // A box in the middle of the screen asks which floor the associate works
    // on; the answer sets "My floor". It comes up once per shift on a laptop -
    // so each associate is asked once a day - and only goes away with an
    // answer, so a floor left over from the previous shift is never used.
    // =========================================================================
    var FLOOR_ASKED_KEY = 'pops_floor_asked_shift';
    var ASK_FLOORS = ['paKivaA01', 'paKivaA02', 'paKivaA03', 'paKivaA04'];
    function askFloorOncePerShift() {
        if (!document.body || document.getElementById('pops-floor-ask')) return;
        var shiftKey = String(getCurrentShiftStart(Date.now()));
        var asked = '';
        try { asked = localStorage.getItem(FLOOR_ASKED_KEY) || ''; } catch (e) {}
        if (asked === shiftKey) return;
        var current = getMyFloor();
        var veil = document.createElement('div');
        veil.id = 'pops-floor-ask';
        veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#111;border-radius:12px;padding:24px 28px;max-width:520px;width:90vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        box.innerHTML = '<div style="font:bold 24px Arial,sans-serif;margin-bottom:6px;">Which floor are you working on?</div>' +
            '<div style="font-size:14px;color:#555;margin-bottom:18px;">Asked once at the start of each shift. Items on this floor come first, and autofinish uses its tote.</div>';
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;';
        ASK_FLOORS.forEach(function (fl) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = floorShort(fl);
            var was = current && current.toLowerCase() === fl.toLowerCase();
            b.title = fl + (was ? ' (set on this laptop before)' : '');
            b.style.cssText = 'min-width:110px;padding:18px 0;font:900 32px Arial,sans-serif;border-radius:10px;cursor:pointer;' +
                'background:#232f3e;color:#fff;border:3px solid ' + (was ? '#ff9900' : '#232f3e') + ';';
            b.addEventListener('click', function () {
                try { localStorage.setItem(MY_FLOOR_KEY, fl); localStorage.setItem(FLOOR_ASKED_KEY, shiftKey); } catch (e) {}
                var sel = document.getElementById('pops-floor-select');
                if (sel) { sel.value = fl; try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
                veil.remove();
                autoSay('floor set for this shift: ' + fl);
                repaintSoon();
            });
            row.appendChild(b);
        });
        box.appendChild(row);
        if (current) {
            var note = document.createElement('div');
            note.style.cssText = 'margin-top:14px;font-size:13px;color:#777;';
            note.textContent = 'Last set on this laptop: ' + floorShort(current) + ' (orange outline)';
            box.appendChild(note);
        }
        veil.appendChild(box);
        // keys pressed while the question is up do not reach the page
        ['keydown', 'keypress', 'keyup'].forEach(function (evn) { veil.addEventListener(evn, function (e) { e.stopPropagation(); }); });
        document.body.appendChild(veil);
    }
    function getCurrentShiftStart(now) {
        var d = new Date(now);
        var minutesNow = d.getHours() * 60 + d.getMinutes();
        var dayStart = 8 * 60;         // 08:00
        var nightStart = 18 * 60 + 30; // 18:30

        var shiftStart = new Date(d);
        if (minutesNow >= dayStart && minutesNow < nightStart) {
            shiftStart.setHours(8, 0, 0, 0);
        } else if (minutesNow >= nightStart) {
            shiftStart.setHours(18, 30, 0, 0);
        } else {
            // 00:00-07:59 - still inside the night shift that started yesterday.
            shiftStart.setDate(shiftStart.getDate() - 1);
            shiftStart.setHours(18, 30, 0, 0);
        }
        return shiftStart.getTime();
    }

    // Silently wipe the opened-history the first time the script runs in a
    // new shift window (page load or refresh), so nothing carries over from
    // a previous shift. No automatic reload - it just resets whenever the
    // page next loads on its own, so it can never interrupt a task in progress.
    (function resetIfNewShift() {
        // Wrapped: if localStorage is unavailable (blocked by browser policy,
        // private window, quota full) an unguarded call throws here and kills
        // the whole script - barcode included. Better to lose the tracker than
        // everything.
        try {
            var currentShiftKey = String(getCurrentShiftStart(Date.now()));
            var lastShiftKey = localStorage.getItem(SHIFT_KEY_STORAGE);
            if (currentShiftKey !== lastShiftKey) {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.setItem(SHIFT_KEY_STORAGE, currentShiftKey);
            }
        } catch (e) { /* tracker degrades, page still works */ }
    })();

    // Stored shape: { "<item title>": { lastSeen: <epoch ms> } }
    // Older versions stored plain `true`; those are migrated on load so an
    // upgrade doesn't wipe what you'd already opened this shift.
    function loadOpened() {
        try {
            var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            var now = Date.now();
            Object.keys(raw).forEach(function (k) {
                if (raw[k] === true) raw[k] = { lastSeen: now };
            });
            return raw;
        } catch (e) {
            return {};
        }
    }

    function saveOpened(obj) {
        // Synchronous, in-page write - completes before the click handler
        // returns, so it's saved even if the click also navigates away.
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch (e) { /* storage unavailable - tracking degrades, page is fine */ }
    }

    var opened = loadOpened();

    // MULTI-TAB SAFETY: this page is often open in more than one tab, and each
    // tab holds its own in-memory copy of `opened`. Writing that copy back
    // wholesale means the last tab to write wins and silently erases whatever
    // the other tab recorded - items would flip back to NEW at random. So
    // every write re-reads what is actually in storage first and merges into
    // it, rather than overwriting it.
    function mergeWithStored(mutate) {
        var stored = loadOpened();
        Object.keys(opened).forEach(function (k) {
            if (!stored[k] || (opened[k].lastSeen || 0) > (stored[k].lastSeen || 0)) {
                stored[k] = opened[k];
            }
        });
        mutate(stored);
        opened = stored;
        saveOpened(opened);
    }

    // 8.1: click history - every item the associate clicks on, kept for the
    // last 10 hours on this laptop (shared by all tabs). A second click on the
    // same item within a minute is not logged again.
    var HISTORY_KEY = 'pops_click_history';
    var HISTORY_MS = 10 * 3600 * 1000, HISTORY_MAX = 500;
    var renderHistory = function () {};               // replaced once the History box exists
    function loadHistory() {
        var now = Date.now(), list = [];
        try { list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') || []; } catch (e) {}
        return list.filter(function (h) { return h && h.t && now - h.t < HISTORY_MS; });
    }
    // 8.8: ASIN for a history row - from the item's location step if seen,
    // else from Rodeo / FCResearch for the card's bin.
    function historyAsin(title, bin) {
        try {
            var e = title ? itemLocs[normT(title)] : null;
            if (e && e.asin) return e.asin;
            if (bin) {
                var a = asinsFor(bin);
                if (!a.length) a = fcrAsinsFor(bin, title);
                if (a.length) return a[0];
            }
        } catch (err) {}
        return '';
    }
    function recordClick(title, code, shownBin) {
        var list = loadHistory(), now = Date.now();
        var last = list[list.length - 1];
        if (last && last.title === title && last.code === code && now - last.t < 60 * 1000) return;
        var bin = /^P-\d+-/i.test(code) ? code.toUpperCase() : '';
        // 8.4: POD of the card's bin, and the first bin on the associate's floor when known
        var pk = null;
        if (shownBin && /^P-\d+-/i.test(shownBin)) pk = { bin: shownBin.toUpperCase() };
        else { try { pk = pickForItem(title, bin); } catch (e) {} }
        if (pk) binInfoFor(pk.bin);   // start the floor/POD lookup for that bin
        list.push({ t: now, title: title, code: code,
            floor: bin && binInfo[bin] ? binInfo[bin].floor : '', pod: bin && binInfo[bin] ? binInfo[bin].pod : '',
            pick: pk ? pk.bin : '', asin: historyAsin(title, bin) });
        if (list.length > HISTORY_MAX) list = list.slice(list.length - HISTORY_MAX);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
        try { renderHistory(); } catch (e) {}
    }

    function markOpened(id) {
        if (opened[id]) return;
        mergeWithStored(function (store) {
            store[id] = { lastSeen: Date.now() };
        });
    }

    // Called once per scan with every item title currently rendered in the
    // list. Anything we opened that is still on screen has its lastSeen
    // refreshed, so it keeps its OPENED state indefinitely while it sits
    // there. Anything that has been missing longer than the grace period is
    // forgotten, so if it shows up again later it correctly reads as NEW.
    //
    // Only runs when the list is actually rendered (visibleTitles is non-empty)
    // - otherwise navigating to the item detail screen, where no rows exist,
    // would look like "everything disappeared" and wipe the whole history.
    // The heartbeat runs every 20s; background tabs may be throttled to ~60s.
    // A gap between two absent-observations longer than this means the list
    // was not on screen in between, so that gap is NOT counted as absence.
    var MAX_COUNTED_GAP_MS = 90 * 1000;

    function refreshPresence(visibleTitles) {
        // Only act when the list is actually rendered. With no rows on screen
        // (detail screen, other page, mid-navigation, machine asleep) there is
        // no evidence any item has left the list, so nothing is counted.
        if (!visibleTitles.length) return;

        var now = Date.now();
        var changed = false;

        // Merge in anything another tab has recorded since our last write.
        var stored = loadOpened();
        Object.keys(stored).forEach(function (k) {
            if (!opened[k] || (stored[k].lastSeen || 0) > (opened[k].lastSeen || 0)) {
                opened[k] = stored[k];
            }
        });

        var visible = {};
        visibleTitles.forEach(function (t) { visible[t] = true; });

        Object.keys(opened).forEach(function (k) {
            var rec = opened[k];
            if (visible[k]) {
                // On the list right now: alive; reset any accumulated absence.
                // Saved only when the stamp is more than a few seconds old, so a
                // scan on every page change does not rewrite storage each time.
                if (rec.absentMs || rec.absentTick) { delete rec.absentMs; delete rec.absentTick; changed = true; }
                if (now - (rec.lastSeen || 0) > 5000) { rec.lastSeen = now; changed = true; }
                return;
            }
            // Absent from a VISIBLE list. Accumulate only the time since the
            // previous absent-observation, and only if that observation was
            // recent (i.e. the list stayed on screen in between). A long gap
            // means we were elsewhere - count nothing for it.
            var delta = rec.absentTick ? (now - rec.absentTick) : 0;
            if (delta > 0 && delta <= MAX_COUNTED_GAP_MS) {
                rec.absentMs = (rec.absentMs || 0) + delta;
            }
            rec.absentTick = now;
            changed = true;
            if ((rec.absentMs || 0) > GONE_GRACE_MS) {
                // Genuinely gone for the whole grace period while we were
                // watching the list. Forget it so a later return reads as NEW.
                delete opened[k];
            }
        });

        if (changed) saveOpened(opened);
    }

    function isBinLocation(code) {
        return /^P-\d+-/.test(code);
    }

    // 7.9: locations nobody can pick from - totes / trolleys (tsX...) and
    // stations (st...). Cards showing one of these are hidden from the list.
    // 8.1: tsps... locations are excluded as well. 8.2: and tsAFE...
    var NOT_PICKABLE_RE = /^(tsx|tsp|tsafe|st|chafe_ovg)/i;   // 9.10: + chAFE_Ovg1-4

    // The item title text (product name), ignoring the location/tote code
    // and our own badge - stays identical for the same item on every screen,
    // even when the code shown next to it changes (bin vs tote, or reassigned).
    function extractTitle(itemBtn, locationEl) {
        var parts = [];
        function walk(node) {
            if (node === locationEl) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
                // skip everything this script added (badges, barcode wrapper)
                if (isOurBadge(node)) return;
                Array.prototype.forEach.call(node.childNodes, walk);
            } else if (node.nodeType === Node.TEXT_NODE) {
                parts.push(node.textContent);
            }
        }
        walk(itemBtn);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function openedScan() {
        var visibleTitles = [];
        var dupSeen = {};                     // 10.10: title|location -> how many cards so far

        document.querySelectorAll('button.item').forEach(function (itemBtn, cardIndex) {
            var locationEl = null;
            itemBtn.querySelectorAll('div').forEach(function (div) {
                if (locationEl) return;
                var cls = div.className || '';
                if (cls.indexOf('item-l') === 0 || cls.indexOf(' item-l') !== -1) {
                    locationEl = div;
                }
            });
            if (!locationEl) return;

            var code = locationEl.textContent.trim();
            if (!code) return;

            var title = extractTitle(itemBtn, locationEl);

            // Resetting is handled by presence (see refreshPresence): the row
            // keeps its OPENED state for as long as it stays in the list, and
            // is only forgotten once it has been gone for a while.
            // 10.10: one key PER PICK, not per title - several units of the same
            // item each have their own OPENED state. The pick's own id from
            // POPS's list (same order as the cards) is used when it matches;
            // otherwise title + location + which copy of it this card is.
            var key = '';
            var li = lastListItems[cardIndex];
            if (li && li.uuid && normT(li.title) === normT(title)) key = 'pick:' + li.uuid;
            if (!key) {
                var dk = (title || '') + '|' + code;
                var nth = dupSeen[dk] = (dupSeen[dk] || 0) + 1;
                key = dk + '#' + nth;
            }
            visibleTitles.push(key);

            // 7.9: hide cards in a non-pickable location (tsX / st). The page
            // can reuse a card element for another item, so a pickable card
            // is always shown again.
            // 8.5: the scan bar finds hidden cards by these too
            itemBtn.dataset.popsCode = code;
            itemBtn.dataset.popsTitle = title;
            var notPickable = NOT_PICKABLE_RE.test(code);
            var wantDisplay = notPickable ? 'none' : '';
            if (itemBtn.style.display !== wantDisplay) itemBtn.style.display = wantDisplay;
            if (notPickable) return;

            // Mark it opened the moment the associate clicks into the row,
            // on ANY screen - even one currently showing a tote code, since
            // this is what tracks the item's identity across screens.
            // (Capturing phase so this still fires even if the click also
            // navigates to the "Send Runner Items" detail screen.)
            itemBtn.dataset.popsKey = key;             // re-read on click, in case the element is reused for another item
            itemBtn.dataset.popsCode = code;
            itemBtn.dataset.popsTitle = title;
            if (!itemBtn.dataset.popsOpenedListener) {
                itemBtn.dataset.popsOpenedListener = '1';
                itemBtn.addEventListener('click', function (ev) {
                    // a click on one of our own badges/buttons does not open the item
                    if (ev.target && ev.target.closest && ev.target.closest('.pops-print-btn, .pops-cpt-badge, .pops-info-badge')) return;
                    markOpened(itemBtn.dataset.popsKey || key);
                    try { rememberOpenedCard(itemBtn); } catch (e) {}
                    try {
                        // 10.10: the bin this card shows (several units of one item each show their own)
                        var sl = itemBtn.querySelector('.pops-card-strip .pcs-loc');
                        recordClick(itemBtn.dataset.popsTitle || title, itemBtn.dataset.popsCode || code, sl ? (sl.textContent || '').trim() : '');
                    } catch (e) {}
                    quietPaint(openedScan);
                }, true);
            }

            // Totes (e.g. "tsX114c2n5t") are shared across multiple items, so
            // only show the badge on real bin locations (e.g. "P-5-M903U873").
            if (!isBinLocation(code)) return;

            var isOpened = !!opened[key];

            // Tint the whole row so the state is visible at a glance.
            itemBtn.style.borderLeft = isOpened ? '6px solid #196f3d' : '6px solid #c0392b';
            itemBtn.style.backgroundColor = isOpened ? '#eafaf1' : '#fdecea';

            // 9.2: the NEW / OPENED label is gone from the list (too much on the
            // card); the green / red tint above still shows the state.
            var badge = itemBtn.querySelector('.pops-opened-badge');
            if (badge) badge.remove();
        });

        // Keep anything still on the list alive, and forget anything that has
        // been gone long enough to count as a genuinely finished task.
        refreshPresence(visibleTitles);
    }

    // =========================================================================
    // SECTION 2C: Barcode boxes
    // Two small floating panels: type any bin/SKU code, or pick a trolley, and
    // get a Code 128 barcode on screen to scan (Code 128 keeps lower case, which
    // trolley ids need). A bin ID is only a shelf location, so generating it
    // doesn't bypass any item/identity verification.
    // =========================================================================
    function injectManualBarcodePanel() {
        if (document.getElementById('pops-barcode-tools')) return; // once only
        if (!document.body) return;

        // A single fixed wrapper at top-centre holding two SEPARATE collapsible
        // panels stacked vertically: one for a typed bin/SKU code, one for the
        // trolley dropdown. Each opens and closes on its own.
        var wrap = document.createElement('div');
        wrap.id = 'pops-barcode-tools';
        // 9.8: part of the page now (under the top bar), not floating over it -
        // the four boxes sit side by side and open downwards, pushing the page
        // down instead of covering it
        wrap.style.cssText = 'position:relative;z-index:5;margin:6px auto 8px;max-width:1170px;width:100%;box-sizing:border-box;padding:0 15px;' +
            'font-family:Arial,sans-serif;font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;';

        // Builds one collapsible panel with a dark header and a white body.
        function makePanel(label) {
            var panel = document.createElement('div');
            panel.style.cssText = 'flex:1 1 220px;min-width:200px;';

            var header = document.createElement('div');
            header.style.cssText = 'background:#232f3e;color:#fff;padding:7px 10px;' +
                'border-radius:6px;cursor:pointer;font-weight:bold;text-align:center;' +
                'user-select:none;';
            header.textContent = '\u25B6 ' + label;

            var body = document.createElement('div');
            body.style.cssText = 'display:none;background:#fff;border:1px solid #888;' +
                'border-top:none;border-radius:0 0 6px 6px;padding:10px;';

            header.addEventListener('click', function () {
                var open = body.style.display === 'none';
                body.style.display = open ? 'block' : 'none';
                header.textContent = (open ? '\u25BC ' : '\u25B6 ') + label;
                header.style.borderRadius = open ? '6px 6px 0 0' : '6px';
                // 10.6: an open box takes the whole row, so its barcode can be shown edge to edge
                panel.style.flex = open ? '1 1 100%' : '1 1 220px';
            });

            panel.appendChild(header);
            panel.appendChild(body);
            return { panel: panel, body: body, header: header };
        }

        // ---------- Panel 1: typed bin / SKU code ----------------------------
        var p1 = makePanel('Barcode gen');

        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Type a code, e.g. P-7-H676R453';
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:5px;' +
            'border:1px solid #aaa;border-radius:3px;font-family:monospace;';

        var out = document.createElement('div');
        out.style.cssText = 'margin-top:8px;text-align:center;min-height:20px;width:100%;overflow:auto;';

        var hint = document.createElement('div');
        hint.style.cssText = 'margin-top:4px;color:#c0392b;font-size:11px;min-height:14px;';

        input.addEventListener('input', function () {
            var code = input.value.trim();
            out.innerHTML = '';
            hint.textContent = '';
            if (!code) return;
            var svg = renderBarcode128SVG(code); // Code 128 keeps case exactly
            if (svg) { out.innerHTML = svg; fitBarcode(out); }
            else { hint.textContent = 'That code has a character the barcode can\'t encode.'; }
        });
        input.addEventListener('keydown', function (e) { e.stopPropagation(); });

        p1.body.appendChild(input);
        p1.body.appendChild(out);
        p1.body.appendChild(hint);

        // ---------- Panel 2: trolley dropdown --------------------------------
        var p2 = makePanel('Trolley barcode');

        var select = document.createElement('select');
        select.style.cssText = 'width:100%;box-sizing:border-box;padding:5px;' +
            'border:1px solid #aaa;border-radius:3px;font-family:monospace;';

        var TROLLEYS = ['tsXpsfpick22', 'tsXpsfpick33', 'tsXpsfpick44'];
        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '-- choose a trolley --';
        select.appendChild(placeholder);
        TROLLEYS.forEach(function (t) {
            var opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            select.appendChild(opt);
        });

        var trolleyOut = document.createElement('div');
        trolleyOut.style.cssText = 'margin-top:8px;text-align:center;min-height:20px;width:100%;overflow:auto;';

        select.addEventListener('change', function () {
            trolleyOut.innerHTML = '';
            if (!select.value) return;
            trolleyOut.innerHTML = renderBarcode128SVG(select.value) || '';
            fitBarcode(trolleyOut);
        });

        p2.body.appendChild(select);
        p2.body.appendChild(trolleyOut);

        // ---------- Panel 3: my floor (8.0) ----------------------------------
        // The associate picks their floor; cards on it move up the list.
        // The list holds the usual floors plus any floor already seen in a
        // roboscout reply, so a floor with another name still shows up.
        var p3 = makePanel('My floor');
        var DEFAULT_FLOORS = ['paKivaA01', 'paKivaA02', 'paKivaA03', 'paKivaA04'];
        var floorSelect = document.createElement('select');
        floorSelect.id = 'pops-floor-select';   // 10.9: the shift-start floor question updates it
        floorSelect.style.cssText = 'width:100%;box-sizing:border-box;padding:5px;' +
            'border:1px solid #aaa;border-radius:3px;font-family:monospace;';
        function fillFloors() {
            // only floors 1, 2, 3 and 4; an older saved choice outside them is cleared
            var list = DEFAULT_FLOORS.slice();
            var mine = getMyFloor();
            if (mine && list.indexOf(mine) === -1) {
                mine = '';
                try { localStorage.setItem(MY_FLOOR_KEY, ''); } catch (e) {}
            }
            floorSelect.innerHTML = '';
            var none = document.createElement('option');
            none.value = ''; none.textContent = '-- no floor preference --';
            floorSelect.appendChild(none);
            list.forEach(function (f) {
                var o = document.createElement('option');
                o.value = f; o.textContent = f;
                floorSelect.appendChild(o);
            });
            floorSelect.value = mine;
        }
        fillFloors();
        floorSelect.addEventListener('mousedown', function () { if (document.activeElement !== floorSelect) fillFloors(); });
        floorSelect.addEventListener('change', function () {
            try { localStorage.setItem(MY_FLOOR_KEY, floorSelect.value); } catch (e) {}
            setFloorHeader();
            repaintSoon();
        });
        function setFloorHeader() {
            var mine = getMyFloor();
            var open = p3.body.style.display !== 'none';
            p3.header.textContent = (open ? '\u25BC ' : '\u25B6 ') + 'My floor' + (mine ? ': ' + mine : '');
        }
        p3.header.addEventListener('click', setFloorHeader);   // runs after makePanel's own toggle
        setFloorHeader();
        var floorHint = document.createElement('div');
        floorHint.style.cssText = 'margin-top:6px;color:#555;font-size:11px;';
        floorHint.textContent = 'Items on this floor show first (after urgent CPTs), marked with \u2605.';
        p3.body.appendChild(floorSelect);
        p3.body.appendChild(floorHint);

        // ---------- Panel 4: click history (8.1) -----------------------------
        // Items this laptop clicked on in the last 10 hours, newest first.
        var p4 = makePanel('Click history (10 h)');
        var histList = document.createElement('div');
        histList.style.cssText = 'max-height:320px;overflow-y:auto;';
        p4.body.appendChild(histList);
        function pad2(n) { return ('0' + n).slice(-2); }
        function setHistHeader(count) {
            var open = p4.body.style.display !== 'none';
            p4.header.textContent = (open ? '\u25BC ' : '\u25B6 ') + 'Click history (10 h): ' + count;
        }
        renderHistory = function () {
            var list = loadHistory().reverse();
            setHistHeader(list.length);
            if (p4.body.style.display === 'none') return;   // only draw the list while it is open
            var keepScroll = histList.scrollTop;
            setTimeout(function () { histList.scrollTop = keepScroll; }, 0);
            histList.innerHTML = '';
            if (!list.length) {
                var empty = document.createElement('div');
                empty.style.cssText = 'color:#777;text-align:center;padding:6px;';
                empty.textContent = 'No items clicked in the last 10 hours.';
                histList.appendChild(empty);
                return;
            }
            list.forEach(function (h) {
                // 8.9: one card per click - picture on the left over all four lines,
                // then: location / floor / POD, title, ASIN + Copy, barcode(s).
                var d = new Date(h.t);
                var hb = /^P-\d+-/i.test(h.code || '') ? h.code.toUpperCase() : '';
                var hi = hb && binInfo[hb] ? binInfo[hb] : {};
                var hFloor = h.floor || hi.floor || '', hPod = h.pod || hi.pod || '';
                var hAsin = h.asin || historyAsin(h.title, hb);
                var hPic = titleImgFor(h.title) || (hAsin ? imgFor(hAsin) : '');

                var row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:84px 1fr;column-gap:10px;row-gap:3px;' +
                    'align-items:center;padding:6px 2px;border-bottom:1px solid #ddd;';

                var picCell = document.createElement('div');
                picCell.style.cssText = 'grid-column:1;grid-row:1 / span 4;align-self:start;width:84px;height:84px;' +
                    'display:flex;align-items:center;justify-content:center;background:#fff;border:1px solid #ddd;border-radius:3px;';
                var pic = document.createElement('img');
                pic.className = 'pops-asin-img';
                pic.referrerPolicy = 'no-referrer';
                pic.style.cssText = 'max-width:80px;max-height:80px;object-fit:contain;display:' + (hPic ? 'block' : 'none') + ';';
                if (hPic) pic.src = hPic;
                pic.addEventListener('error', function () { pic.style.display = 'none'; });
                picCell.appendChild(pic);

                // line 1: time, location, floor, POD (+ the bin on the associate's floor)
                var locLine = document.createElement('div');
                locLine.style.cssText = 'grid-column:2;font-family:monospace;font-size:13px;color:#c45500;line-height:1.4;';
                var tm = document.createElement('span');
                tm.style.cssText = 'color:#555;margin-right:8px;';
                tm.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
                locLine.appendChild(tm);
                locLine.appendChild(document.createTextNode((h.code || '') + (hFloor ? ' \u00b7 ' + hFloor : '') + (hPod ? ' \u00b7 POD ' + hPod : '')));
                if (h.pick && h.pick !== h.code) {
                    var pi = binInfo[h.pick] || {};
                    var pk2 = document.createElement('div');
                    pk2.textContent = '\u2192 ' + h.pick + (pi.floor ? ' \u00b7 ' + pi.floor : '') + (pi.pod ? ' \u00b7 POD ' + pi.pod : '');
                    locLine.appendChild(pk2);
                }

                // line 2: title
                var title = document.createElement('div');
                title.style.cssText = 'grid-column:2;color:#000;font-size:13px;line-height:1.3;';
                title.textContent = h.title || '(no title)';

                // line 3: ASIN + Copy
                var asinLine = document.createElement('div');
                asinLine.style.cssText = 'grid-column:2;font-size:12px;color:#333;';
                var av = document.createElement('b');
                av.style.fontFamily = 'monospace';
                av.textContent = 'ASIN ' + (hAsin || '\u2013');
                asinLine.appendChild(av);
                if (hAsin) asinLine.appendChild(copyBtn('Copy', (function (v) { return function () { return v; }; })(hAsin)));

                // line 4: barcode(s), half size
                var bcs = document.createElement('div');
                // 10.6: full width of the row (under the picture too), one barcode per line
                bcs.style.cssText = 'grid-column:1 / -1;display:flex;flex-direction:column;gap:8px;align-items:stretch;margin-top:4px;';
                var codes = [];
                if (h.code) codes.push(h.code);
                if (h.pick && h.pick !== h.code) codes.push(h.pick);
                codes.forEach(function (c) {
                    var one = document.createElement('div');
                    one.innerHTML = renderBarcode128SVG(c) || '';
                    var s = one.querySelector('svg');
                    if (s) fitBarcode(one);
                    bcs.appendChild(one);
                });

                row.appendChild(picCell); row.appendChild(locLine); row.appendChild(title); row.appendChild(asinLine); row.appendChild(bcs);
                histList.appendChild(row);
            });
        };
        p4.header.addEventListener('click', function () { renderHistory(); });   // after makePanel's own toggle
        renderHistory();

        wrap.appendChild(p1.panel);
        wrap.appendChild(p2.panel);
        wrap.appendChild(p3.panel);
        wrap.appendChild(p4.panel);

        // 9.8: no more dragging - the boxes are placed in the page itself,
        // right under the POPS top bar (or at the top of the page)
        placePanels(wrap);
    }
    function placePanels(wrap) {
        var top = document.querySelector('topbar-component');
        if (top && top.parentNode) top.parentNode.insertBefore(wrap, top.nextSibling);
        else document.body.insertBefore(wrap, document.body.firstChild);
    }

    // =========================================================================
    // SECTION 2D (8.3): "Select location" step - first bin on the picker's floor
    //
    // When an item is clicked, the page asks /wf/next and gets back the item's
    // location list, grouped as "[PickBin] - Floor: [ 3 ] - Mod: [ A ]". The
    // script only LISTENS to the page's own replies (it never sends workflow
    // requests itself, which would move the associate's screen on). From the
    // reply it shows a box under the item title with the first bin on the
    // floor chosen in "My floor" (barcode + Print), outlines that bin in the
    // page's list (opening its floor group if it is closed), and remembers the
    // list so the item's card says which bin to go to next time.
    // =========================================================================
    var currentLoc = null, locExpandedFor = '';

    function parseLocStep(j) {
        var list = j && j.componentDataList;
        if (!list || !list.length) return null;
        var item = null, acc = null;
        list.forEach(function (c) {
            if (!c) return;
            if (c.componentType === 'type-item' && !item) item = c;
            if (c.componentType === 'type-accordion-selection' && !acc) acc = c;
        });
        if (!acc || !acc.accordionEntries) return null;
        var groups = acc.accordionEntries.map(function (e) {
            var lbl = String(e.displayValue || '');
            var fm = /Floor:\s*\[\s*([^\]]*?)\s*\]/i.exec(lbl), mm = /Mod:\s*\[\s*([^\]]*?)\s*\]/i.exec(lbl), tm = /^\s*\[([^\]]+)\]/.exec(lbl);
            var f = fm ? fm[1] : '';
            if (/^\d+$/.test(f)) f = String(+f);
            return {
                label: lbl.trim(), type: tm ? tm[1] : '', floor: f, mod: mm ? mm[1].toUpperCase() : '',
                bins: (e.selectionEntries || []).map(function (s) { return String(s.identifier || s.displayValue || ''); }).filter(Boolean)
            };
        });
        return { title: item ? String(item.title || '') : '', asin: item ? String(item.asin || '') : '', groups: groups };
    }

    function onWorkflowStep(j) {
        var p = parseLocStep(j);
        currentLoc = p; locExpandedFor = '';
        if (p && p.title) { itemLocs[normT(p.title)] = { t: Date.now(), asin: p.asin, groups: p.groups }; saveItemLocs(); }
        if (p && p.groups) { try { learnFloorsFromPops(p.groups); } catch (e) {} }
        // 10.1: what the current screen is made of, for autofinish
        try {
            var ks = [], ims = [];
            ((j && j.componentDataList) || []).forEach(function (c) {
                if (!c) return;
                if (c.textLmsKey) ks.push(String(c.textLmsKey));
                if (c.imageUrl) ims.push(String(c.imageUrl));
            });
            lastStep = { keys: ks, imgs: ims, at: Date.now() };
            // 10.3: the pick bin of any item (Scan Pick Bin shows it in a box)
            ((j && j.componentDataList) || []).forEach(function (c) {
                if (c && c.componentType === 'type-box-text' && /^P-\d+-[A-Z0-9]+$/i.test(String(c.boxText || ''))) { lastPickBin = String(c.boxText).toUpperCase(); lastPickAt = Date.now(); }
            });
        } catch (e) {}
        // 10.10: the list's picks in screen order, each with its own id
        try {
            var lst = null;
            ((j && j.componentDataList) || []).forEach(function (c) { if (c && c.componentType === 'type-send-runner-list' && !lst) lst = c; });
            if (lst) {
                var items = [];
                (lst.sendRunnerAreas || []).forEach(function (a) {
                    (a.items || []).forEach(function (it) { items.push({ title: String(it.title || ''), location: String(it.location || ''), uuid: String(it.userActionUUID || '') }); });
                });
                lastListItems = items;
            }
        } catch (e) {}
        // 9.5: remember the item of every step, for its picture on every screen
        try {
            var itm = null, isList = false;
            ((j && j.componentDataList) || []).forEach(function (c) {
                if (c && c.componentType === 'type-item' && !itm) itm = c;
                if (c && c.componentType === 'type-send-runner-list') isList = true;
            });
            if (itm) {
                curItem = { asin: String(itm.asin || ''), imageUrl: itm.imageUrl || '', title: String(itm.title || '') };
                // 9.8: POPS's own picture is remembered for the item and its ASIN
                if (curItem.imageUrl) {
                    titleImgSet(curItem.title, curItem.imageUrl, true);
                    if (curItem.asin && !(imgCache[curItem.asin] && imgCache[curItem.asin].u)) imgSet(curItem.asin, curItem.imageUrl);
                }
            }
            else if (isList) curItem = null;
        } catch (e) {}

        setTimeout(function () { try { quietPaint(paintLocStep); } catch (e) {} }, 300);
        repaintSoon();
    }

    // 10.0: listener inside the page. Tampermonkey runs this script in its own
    // separate copy of the browser's JavaScript, so a small piece is put into
    // the page itself. It only REPORTS the page's workflow replies to the
    // script (for the location box, the location lists and the pictures) via
    // the "pops-wf" DOM event. It never changes, delays or sends a request.
    var pageInstanceId = '';
    function popsPageHook() {
        if (window.__popsHooked) return;
        window.__popsHooked = true;
        var root = document.documentElement;
        root.setAttribute('data-pops-hooked', '1');
        function send(type, payload) {
            try { root.dispatchEvent(new CustomEvent('pops-wf', { detail: JSON.stringify({ type: type, payload: payload }) })); } catch (e) {}
        }
        function report(url, text) { send('reply', { url: url, text: text }); }
        // 10.12: the page's own "start" request (body + headers) is reported
        // too, so the script can open its own background copy of the list
        function reportStart(url, body, headers) { send('start', { url: url, body: body, headers: headers || {} }); }
        function plainHdrs(h) {
            var out = {};
            try {
                if (!h) return out;
                if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[k] = v; });
                else if (Array.isArray(h)) h.forEach(function (p) { out[p[0]] = p[1]; });
                else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
            } catch (e) {}
            return out;
        }
        try {
            var XP = XMLHttpRequest.prototype, oOpen = XP.open, oSend = XP.send, oHdr = XP.setRequestHeader;
            XP.open = function (m, u) { this.__popsUrl = String(u || ''); this.__popsHdrs = {}; return oOpen.apply(this, arguments); };
            XP.setRequestHeader = function (k, v) { try { if (this.__popsHdrs) this.__popsHdrs[k] = v; } catch (e) {} return oHdr.apply(this, arguments); };
            XP.send = function (body) {
                var x = this, u = x.__popsUrl || '';
                if (/(^|\/)wf\/start/.test(u) && typeof body === 'string') reportStart(u, body, x.__popsHdrs);
                if (/(^|\/)wf\//.test(u)) {
                    x.addEventListener('load', function () {
                        try {
                            var t = (x.responseType === '' || x.responseType === 'text') ? x.responseText : (x.responseType === 'json' ? JSON.stringify(x.response) : '');
                            if (t) report(u, t);
                        } catch (e) {}
                    });
                }
                return oSend.apply(this, arguments);
            };
        } catch (e) {}
        var origFetch = window.fetch;
        try {
            window.fetch = function (input, init) {
                var u = typeof input === 'string' ? input : ((input && input.url) || '');
                if (/(^|\/)wf\/start/.test(u) && init && typeof init.body === 'string') reportStart(u, init.body, plainHdrs(init.headers));
                var p = origFetch.apply(window, arguments);
                if (/(^|\/)wf\//.test(u)) {
                    p.then(function (r) { r.clone().text().then(function (t) { report(u, t); }, function () {}); }, function () {});
                }
                return p;
            };
        } catch (e) {}
        // 10.12: requests the SCRIPT sends for "Pick This Location". They go
        // out from the page itself (same sign-in), through the browser's
        // original fetch, so their replies are never mistaken for the page's.
        root.addEventListener('pops-req', function (ev) {
            var m = null;
            try { m = JSON.parse(ev.detail); } catch (e) { return; }
            if (!m || !m.id) return;
            var hdrs = m.headers || {};
            if (!Object.keys(hdrs).some(function (k) { return k.toLowerCase() === 'content-type'; })) hdrs['Content-Type'] = 'application/json';
            origFetch.call(window, m.url, { method: 'POST', credentials: 'include', headers: hdrs, body: m.body })
                .then(function (r) { return r.text().then(function (t) { send('resp', { id: m.id, status: r.status, text: t }); }); },
                      function () { send('resp', { id: m.id, status: 0, text: '' }); });
        });
    }

    // The script's side: every workflow reply the page receives, the page's
    // start request, and the answers to the script's own requests.
    var START_REQ_KEY = 'pops_start_req';
    var pageStartReq = (function () { try { return JSON.parse(localStorage.getItem(START_REQ_KEY) || 'null'); } catch (e) { return null; } })();
    var bgPending = {}, bgSeq = 0;
    document.documentElement.addEventListener('pops-wf', function (ev) {
        var m = null;
        try { m = JSON.parse(ev.detail); } catch (e) { return; }
        if (!m || !m.payload) return;
        if (m.type === 'start') {
            pageStartReq = m.payload;
            try { localStorage.setItem(START_REQ_KEY, JSON.stringify(m.payload)); } catch (e) {}
            return;
        }
        if (m.type === 'resp') {
            var cb = bgPending[m.payload.id];
            if (cb) { delete bgPending[m.payload.id]; cb(m.payload); }
            return;
        }
        if (m.type !== 'reply') return;
        try {
            if (!/(^|\/)wf\/(next|start)/.test(m.payload.url || '')) return;
            var j = JSON.parse(m.payload.text);
            if (j && j.workflowInstanceId) pageInstanceId = String(j.workflowInstanceId);
            onWorkflowStep(j);
        } catch (e) { console.log(CPT_LOG, 'pops-wf error:', e); }
    });
    // 10.13: the start request POPS sends for the Send Runner button, as seen in
    // the browser's network log: body SEND_RUNNER_BUTTON. Used when the page's
    // own one has not been caught yet.
    var DEFAULT_START = { url: '/wf/start', body: 'SEND_RUNNER_BUTTON' };
    function startReq() { return (pageStartReq && pageStartReq.body) ? pageStartReq : DEFAULT_START; }
    // headers for the script's own /wf/next requests: whatever the page sent
    // with its start request (sign-in tokens etc.), but always as JSON
    function nextHeaders() {
        var out = {}, h = (pageStartReq && pageStartReq.headers) || {};
        Object.keys(h).forEach(function (k) { if (k.toLowerCase() !== 'content-type') out[k] = h[k]; });
        out['Content-Type'] = 'application/json';
        return out;
    }
    // one background request through the page; resolves with the reply as an object
    function bgPost(url, body, headersOverride) {
        return new Promise(function (resolve, reject) {
            var id = 'r' + (++bgSeq) + '_' + Date.now();
            var t = setTimeout(function () { delete bgPending[id]; reject(new Error('no answer from POPS (timeout)')); }, 20000);
            bgPending[id] = function (p) {
                clearTimeout(t);
                if (p.status !== 200) return reject(new Error('POPS answered HTTP ' + p.status));
                var j = null;
                try { j = JSON.parse(p.text); } catch (e) { return reject(new Error('POPS answer was not readable')); }
                if (!j || j.error) return reject(new Error('POPS error: ' + JSON.stringify(j && j.error)));
                resolve(j);
            };
            var hdrs = headersOverride || (pageStartReq && pageStartReq.headers) || {};
            try {
                document.documentElement.dispatchEvent(new CustomEvent('pops-req', { detail: JSON.stringify({ id: id, url: url, body: typeof body === 'string' ? body : JSON.stringify(body), headers: hdrs }) }));
            } catch (e) { clearTimeout(t); delete bgPending[id]; reject(e); }
        });
    }

    // Put the hook into the page. GM_addElement gets past the page's script
    // rules (CSP); a plain <script> tag is the fallback.
    (function injectPageHook() {
        var code = '(' + popsPageHook.toString() + ')();';
        var ok = false;
        try {
            if (typeof GM_addElement === 'function') { GM_addElement('script', { textContent: code }); ok = true; }
        } catch (e) {}
        if (!ok) {
            try {
                var s = document.createElement('script');
                s.textContent = code;
                (document.head || document.documentElement).appendChild(s);
                s.remove();
                ok = true;
            } catch (e) {}
        }
        setTimeout(function () {
            var live = document.documentElement.getAttribute('data-pops-hooked') === '1';
            console.log(CPT_LOG, 'page hook ' + (live ? 'installed' : 'NOT confirmed (the page may block added scripts)'));
        }, 1500);
    })();


    function paintLocStep() {
        var box = document.getElementById('pops-loc-pick');
        var pick = currentLoc ? pickBin(effectiveGroups(currentLoc.groups, currentLoc)) : null;
        // the step must still be on screen: one of its floor group labels is visible
        var labelEl = null, anchor = null;
        if (pick) {
            var labels = {};
            currentLoc.groups.forEach(function (g) { labels[g.label.replace(/\s+/g, ' ')] = g; });
            var nt = normT(currentLoc.title);
            leafElements().forEach(function (el) {
                if (el.closest && el.closest('#pops-loc-pick, #pops-barcode-tools')) return;
                var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (labels[t] && !labelEl) labelEl = el;
                if (nt && !anchor && normT(t) === nt) anchor = el;
            });
        }
        if (!pick || (!labelEl && !anchor)) {
            if (box) box.remove();
            document.querySelectorAll('[data-pops-loc-hl]').forEach(function (el) { el.style.outline = ''; delete el.dataset.popsLocHl; });
            return;
        }
        var sig = pick.bin + '|' + getMyFloor();
        if (!box) {
            box = document.createElement('div');
            box.id = 'pops-loc-pick';
            box.style.cssText = 'margin:10px auto;padding:10px 14px;max-width:560px;border-radius:6px;text-align:center;font-family:Arial,sans-serif;border:3px solid;';
        }
        var where = anchor || labelEl;
        if (anchor ? box.previousElementSibling !== anchor : box.nextElementSibling !== labelEl) {
            where.insertAdjacentElement(anchor ? 'afterend' : 'beforebegin', box);
        }
        if (box.dataset.sig !== sig) {
            box.dataset.sig = sig;
            box.innerHTML = '';
            box.style.background = pick.onMyFloor ? '#e6f4ea' : '#fff4e5';
            box.style.borderColor = pick.onMyFloor ? '#067d62' : '#c45500';
            box.style.color = '#000';
            var head = document.createElement('div');
            head.style.cssText = 'font-weight:bold;font-size:16px;margin-bottom:4px;';
            head.textContent = pick.onMyFloor
                ? '\u2605 Your floor ' + getMyFloor() + ' \u2013 first bin:'
                : (pick.chosen ? 'No bin on your floor (' + getMyFloor() + ') \u2013 first bin on Floor ' + pick.group.floor + ':'
                    : 'First bin (Floor ' + pick.group.floor + ') \u2013 pick your floor in the "My floor" box');
            var binEl = document.createElement('div');
            binEl.style.cssText = 'font:bold 30px monospace;margin:2px 0 4px;';
            binEl.textContent = pick.bin;
            var bc = document.createElement('div');
            bc.innerHTML = renderBarcodeSVG(pick.bin);
            var pb = document.createElement('button');
            pb.type = 'button'; pb.className = 'pops-print-btn'; pb.dataset.code = pick.bin; pb.dataset.label = 'Print'; pb.textContent = 'Print';
            pb.style.cssText = 'margin-top:4px;padding:2px 14px;font-size:14px;font-weight:bold;cursor:pointer;background:#f0ad00;border:1px solid #c08f00;border-radius:3px;color:#000;';
            pb.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); printBin(pb.dataset.code, pb); });
            var sum = document.createElement('div');
            sum.style.cssText = 'margin-top:6px;font-size:12px;color:#555;';
            sum.textContent = currentLoc.groups.map(function (g) { return 'Floor ' + g.floor + (g.mod ? ' Mod ' + g.mod : '') + ': ' + g.bins.length; }).join('  \u00b7  ');
            box.appendChild(head); box.appendChild(binEl); box.appendChild(bc); box.appendChild(pb); box.appendChild(sum);
        }
        // outline the bin in the page's own list; open its floor group once if it is closed
        var binLeaf = null;
        leafElements().forEach(function (el) {
            if (binLeaf || (el.closest && el.closest('#pops-loc-pick'))) return;
            if ((el.textContent || '').trim() === pick.bin) binLeaf = el;
        });
        document.querySelectorAll('[data-pops-loc-hl]').forEach(function (el) {
            if (el !== binLeaf) { el.style.outline = ''; delete el.dataset.popsLocHl; }
        });
        if (binLeaf) {
            if (!binLeaf.dataset.popsLocHl) { binLeaf.dataset.popsLocHl = '1'; binLeaf.style.outline = '4px solid #067d62'; binLeaf.style.outlineOffset = '2px'; }
        } else if (locExpandedFor !== sig && !autoFlow) {   // 9.4: the auto driver opens groups itself
            locExpandedFor = sig;
            var gl = null;
            var want = pick.group.label.replace(/\s+/g, ' ');
            leafElements().forEach(function (el) { if (!gl && (el.textContent || '').replace(/\s+/g, ' ').trim() === want) gl = el; });
            if (gl) { try { gl.click(); } catch (e) {} setTimeout(repaintSoon, 400); }
        }
    }

    // =========================================================================
    // SECTION 2E (8.5): "Scan location" bar at the bottom of the list
    //
    // The associate scans the location the runner was sent to (tote, station
    // or bin) and the matching item opens straight away - no hunting through
    // a long list. It matches the card's own location (hidden tsX / st / tsps
    // cards included) and, failing that, any bin in an item's known location
    // list. Several items in the same tote: a short list to tap instead.
    // =========================================================================
    // ---- 8.7: alert for a pre-loaded item that has only ONE location ---------
    function copyBtn(label, getText) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = 'margin-left:6px;padding:1px 8px;font-size:12px;font-weight:bold;background:#ff9900;color:#000;border:0;border-radius:3px;cursor:pointer;';
        b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            copyText(getText(), function (ok) {
                b.textContent = ok ? '\u2713' : 'failed';
                setTimeout(function () { b.textContent = label; }, 1200);
            });
        });
        return b;
    }

    var scanBar = null, scanBarShown = false;
    function scanFind(code) {
        var want = String(code || '').trim().toUpperCase();
        if (!want) return [];
        var exact = [], viaList = [];
        document.querySelectorAll('button.item').forEach(function (btn) {
            var c = (btn.dataset.popsCode || '').trim().toUpperCase();
            if (c && c === want) { exact.push(btn); return; }
            var t = btn.dataset.popsTitle;
            var e = t ? itemLocs[normT(t)] : null;
            if (e && (e.groups || []).some(function (g) { return (g.bins || []).some(function (b) { return b.toUpperCase() === want; }); })) viaList.push(btn);
            // 9.6: a scanned POD ID (digits only) finds the cards whose bin sits in that pod
            if (/^\d{6,}$/.test(want) && /^P-\d+-/i.test(c)) {
                var bi = binInfo[c];
                if (bi && String(bi.pod) === want) exact.push(btn);
            }
            // 9.7: the bins FCResearch lists for the card's ASIN
            if (BIN_ONLY_RE.test(want) && /^P-\d+-/i.test(c)) {
                try {
                    var aa = asinsFor(c);
                    if (!aa.length) aa = fcrAsinsFor(c, t);
                    var ab = aa.length ? asinBins[aa[0]] : null;
                    if (ab && ab.bins && ab.bins.indexOf(want) !== -1 && viaList.indexOf(btn) === -1) viaList.push(btn);
                } catch (err) {}
            }
        });
        return exact.length ? exact : viaList;
    }
    // State of one scan-bar open: the scanned bin, the step reached, tries.
    var autoFlow = null, AUTO_FLOW_MS = 30 * 1000;

    // =========================================================================
    // 9.4: ON-SCREEN DRIVER for the two steps after a scan-bar open
    //
    // (8.7-9.3 tried to answer the page's network requests instead; removed in 10.0.)
    // It does what the associate does: it waits
    // for the "Select location" screen to be drawn, opens the right floor,
    // taps the bin, waits for "Scan Pick Bin", and types the bin into the
    // scanner box - all on the screen, with a small progress box so it is
    // visible what it is doing (and a "Copy details" button when it gets stuck).
    // The page's own requests are only observed, never changed.
    //
    // Same safety rule as before: "Scan Pick Bin" is only filled in when the
    // associate's own scan in the bar was that very bin.
    // =========================================================================
    var GROUP_RE = /^\[[^\]]+\]\s*-\s*Floor:\s*\[\s*(\d+)\s*\]\s*-\s*Mod:\s*\[\s*([A-Za-z0-9]+)\s*\]/i;
    var BIN_ONLY_RE = /^P-\d+-[A-Z0-9]+$/i;
    function ourUi(el) {
        return !!(el.closest && el.closest('#pops-loc-pick, #pops-scan-bar, #pops-barcode-tools, #pops-auto-pic, #pops-alerts, .pops-barcode-fallback-wrap, .pops-card-strip'));
    }
    function normTxt(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
    function isShown(el) {
        if (!el || !el.isConnected) return false;
        if (!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length))) return false;
        var cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }
    // the page's own accordion headers: "[PickBin] - Floor: [ 3 ] - Mod: [ A ]"
    function domGroups() {
        var out = [];
        document.querySelectorAll('body *').forEach(function (el) {
            if (ourUi(el) || (el.closest && el.closest('button.item'))) return;
            var t = normTxt(el);
            if (t.length > 90) return;
            var m = GROUP_RE.exec(t);
            if (!m) return;
            for (var i = 0; i < el.children.length; i++) if (GROUP_RE.test(normTxt(el.children[i]))) return;   // keep the deepest match
            out.push({ el: el, floor: String(+m[1]), mod: m[2].toUpperCase(), text: t });
        });
        return out;
    }
    // every element that is just a bin ID, outside our own boxes and the list cards
    function domBinEls() {
        var out = [];
        document.querySelectorAll('body *').forEach(function (el) {
            if (ourUi(el) || (el.closest && el.closest('button.item'))) return;
            // 9.6: the element's OWN text, so a bin box that also holds an icon
            // or a line break is found too (9.4 needed a childless element)
            var t = '';
            for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
            t = t.trim();
            if (t.length > 20 || !BIN_ONLY_RE.test(t)) return;
            out.push({ el: el, bin: t.toUpperCase() });
        });
        return out;
    }
    function binsInGroup(groups, i, bins) {
        var g = groups[i], next = groups[i + 1] ? groups[i + 1].el : null;
        return bins.filter(function (b) {
            if (!(g.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
            if (next && !(next.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_PRECEDING)) return false;
            return true;
        });
    }
    function fullClick(el) {
        var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
            var C = (/^pointer/.test(t) && typeof PointerEvent === 'function') ? PointerEvent : MouseEvent;
            var down = (t === 'pointerdown' || t === 'mousedown');
            try { el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
        });
    }
    // three escalating ways to tap an element
    function tap(el, attempt) {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        if (attempt <= 1) { try { el.click(); } catch (e) {} return; }
        if (attempt === 2) { fullClick(el); return; }
        var up = (el.closest && el.closest('button, a, [role="button"], li, label')) || el.parentElement || el;
        fullClick(up);
    }
    function setInputValue(inp, val) {
        var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp), 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (d && d.set) d.set.call(inp, val); else inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function pressKey(inp, key, code, kc) {
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
            try { inp.dispatchEvent(new KeyboardEvent(type, { key: key, code: code || key, keyCode: kc, which: kc, charCode: type === 'keypress' ? kc : 0, bubbles: true, cancelable: true })); } catch (e) {}
        });
    }
    function typeAndEnter(inp, text, attempt) {
        try { inp.focus(); } catch (e) {}
        if (attempt <= 1) {
            setInputValue(inp, text);
        } else {                                           // key by key, like the scanner gun
            setInputValue(inp, '');
            var acc = '';
            text.split('').forEach(function (ch) {
                var kc = ch.toUpperCase().charCodeAt(0);
                try { inp.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: kc, which: kc, bubbles: true, cancelable: true })); } catch (e) {}
                try { inp.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), charCode: ch.charCodeAt(0), bubbles: true, cancelable: true })); } catch (e) {}
                acc += ch; setInputValue(inp, acc);
                try { inp.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: kc, which: kc, bubbles: true, cancelable: true })); } catch (e) {}
            });
        }
        pressKey(inp, 'Enter', 'Enter', 13);
        if (attempt >= 2 && inp.form && typeof inp.form.requestSubmit === 'function') { try { inp.form.requestSubmit(); } catch (e) {} }
    }
    function scannerInput() {
        var all = [].slice.call(document.querySelectorAll('input')).filter(function (el) {
            return !ourUi(el) && !el.disabled && !/^(hidden|checkbox|radio|button|submit)$/i.test(el.type);
        });
        return all.filter(isShown)[0] || all[0] || null;
    }

    // the steps are written to the browser console ("auto:" lines)
    function autoSay(msg) { try { console.log(CPT_LOG, 'auto: ' + msg); } catch (e) {} }
    function autoFail(reason) { autoSay(reason, true); autoFlow = null; hideAutoPic(0); }
    // 10.7: with a pre-scanned item waiting, the box stays until it is entered
    function autoDone(msg) { if (msg) autoSay(msg); autoFlow = null; if (!(prescan && prescan.code)) hideAutoPic(1500); }

    // ---- 10.1: the item's picture stays on screen while the auto steps run ----
    var autoPicEl = null, autoPicT = null;
    // 10.5: picture of the card last opened from the list (by scan or by hand),
    // the fallback for the item screens when nothing else has a picture
    var lastOpenedPic = { title: '', url: '', at: 0 };
    function rememberOpenedCard(btn) {
        try {
            var im = btn.querySelector('.pops-card-strip img');
            var u = (im && im.getAttribute('src') && im.style.display !== 'none') ? im.getAttribute('src') : titleImgFor(btn.dataset.popsTitle || '');
            lastOpenedPic = { title: btn.dataset.popsTitle || '', url: u || '', at: Date.now() };
        } catch (e) {}
    }
    function showAutoPic(btn) {
        if (!document.body) return;
        var title = btn.dataset.popsTitle || '';
        var cardImg = btn.querySelector('.pops-card-strip img');
        var url = (cardImg && cardImg.getAttribute('src') && cardImg.style.display !== 'none' && cardImg.getAttribute('src')) || titleImgFor(title);
        // 10.3: exactly one box, found by its id every time (10.1 could end up
        // with a second and third copy after a few items)
        var copies = document.querySelectorAll('#pops-auto-pic');
        for (var c = 0; c < copies.length; c++) if (copies[c] !== autoPicEl) copies[c].remove();
        if (autoPicEl && !autoPicEl.isConnected) document.body.appendChild(autoPicEl);
        if (!autoPicEl) {
            autoPicEl = document.createElement('div');
            autoPicEl.id = 'pops-auto-pic';
            // 10.3: in the middle of the screen
            autoPicEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483646;width:340px;' +
                'padding:10px;background:#fff;border:3px solid #232f3e;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35);' +
                'font-family:Arial,sans-serif;color:#111;text-align:center;pointer-events:none;';
            document.body.appendChild(autoPicEl);
        }
        // 10.5: the inside is rebuilt for every item. Before, the page-wide bin
        // decorations (barcode, CPT, Print, Floor/POD/ASIN) also landed on the
        // bin text in this box and piled up item after item; the box is now
        // excluded from them and starts clean each time.
        autoPicEl.innerHTML = '<img referrerpolicy="no-referrer" alt="" style="display:block;margin:0 auto 6px;max-width:300px;max-height:300px;object-fit:contain;">' +
            '<div class="pap-title" style="font-size:15px;line-height:1.3;max-height:60px;overflow:hidden;"></div>' +
            '<div class="pap-bin" style="margin-top:6px;font:bold 24px monospace;"></div>';
        lastOpenedPic = { title: title, url: url || '', at: Date.now() };
        // 10.7: pre-scan field under the picture
        prescan = { code: '', at: 0, fill: null };
        var ps = document.createElement('div');
        ps.className = 'pap-scan';
        ps.style.cssText = 'margin-top:10px;pointer-events:auto;';
        ps.innerHTML = '<div style="font:bold 13px Arial,sans-serif;color:#232f3e;margin-bottom:4px;">Scan the item now</div>' +
            '<input class="pap-input" type="text" autocomplete="off" placeholder="item barcode" ' +
            'style="width:100%;box-sizing:border-box;padding:7px;font:16px monospace;border:2px solid #ff9900;border-radius:4px;color:#000;background:#fff;">' +
            '<div class="pap-msg" style="margin-top:4px;font-size:13px;min-height:16px;"></div>';
        autoPicEl.appendChild(ps);
        var pin = ps.querySelector('.pap-input'), pmsg = ps.querySelector('.pap-msg');
        pin.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var v = pin.value.trim();
            pin.value = '';
            if (!v) return;
            prescan = { code: v, at: Date.now(), fill: null };
            pmsg.style.color = '#067d62';
            pmsg.textContent = '\u2713 ' + v + ' saved - entered when the item page opens';
            clearTimeout(autoPicT);
            autoPicT = setTimeout(function () { hideAutoPic(0); }, 3 * 60 * 1000);
            autoSay('pre-scan saved: ' + v);
        });
        ['keypress', 'keyup', 'input'].forEach(function (evn) { pin.addEventListener(evn, function (e) { e.stopPropagation(); }); });
        setTimeout(focusPrescan, 80);
        var im = autoPicEl.querySelector('img');
        if (url) { im.src = url; im.style.display = 'block'; } else im.style.display = 'none';
        autoPicEl.querySelector('.pap-title').textContent = title;
        autoPicEl.querySelector('.pap-bin').textContent = autoFlow ? autoFlow.code : '';
        clearTimeout(autoPicT);
        autoPicEl.style.display = 'block';
        autoPicT = setTimeout(function () { hideAutoPic(0); }, AUTO_FLOW_MS + 2000);   // never left behind
    }
    function hideAutoPic(ms) {
        clearTimeout(autoPicT);
        autoPicT = setTimeout(function () {
            // 10.7: let go of the keyboard, so the next scan reaches the page
            var ae = document.activeElement;
            if (ae && ae.closest && ae.closest('#pops-auto-pic')) { try { ae.blur(); } catch (e) {} }
            document.querySelectorAll('#pops-auto-pic').forEach(function (el) { el.style.display = 'none'; });
            repaintSoon();                                  // the page's picture box comes back
        }, ms || 0);
    }
    function autoPicShown() { return !!(autoPicEl && autoPicEl.isConnected && autoPicEl.style.display === 'block'); }

    // =========================================================================
    // 10.1: AUTOFINISH - after the associate has scanned the ITEM, the script
    // scans the floor's collection tote and presses Continue:
    //   P2 -> tsXpsfpick22, P3 -> tsXpsfpick33, P4 -> tsXpsfpick44
    // The floor is the one POPS listed the chosen bin under on "Select
    // location" (else roboscout's floor of that bin, else "My floor").
    // Only after a scan-bar open that went through the auto steps; it waits up
    // to 3 minutes for the item scan and stops on any other screen.
    // =========================================================================
    var TOTE_BY_FLOOR = { '1': 'tsXpsfpick11', '2': 'tsXpsfpick22', '3': 'tsXpsfpick33', '4': 'tsXpsfpick44' };
    var FINISH_MS = 3 * 60 * 1000;
    var finishFlow = null, lastStep = { keys: [], imgs: [], at: 0 };
    function startAutoFinish(af) { startAutoFinishFor(af.bin, af.binFloor, 'wait-tote'); }
    // 10.3: also for items picked WITHOUT the scan bar - the pick bin is taken
    // from the "Scan Pick Bin" screen / reply, and autofinish starts as soon
    // as the tote screen appears, i.e. after the correct item was scanned.
    var lastPickBin = '', lastPickAt = 0, finishBlocked = false;
    function popsFloorOf(bin) {
        var fl = '';
        Object.keys(itemLocs).some(function (k) {
            var e = itemLocs[k];
            return (e.groups || []).some(function (g) { if ((g.bins || []).indexOf(bin) !== -1) { fl = g.floor; return true; } return false; });
        });
        return fl;
    }
    function startAutoFinishFor(bin, popsFloor, stage) {
        // 10.2: roboscout's floor of the bin first (where the pod really is), then POPS's
        var fl = '';
        var bi = bin ? binInfo[bin] : null; var m = bi && /(\d+)\s*$/.exec(bi.floor || ''); if (m) fl = String(+m[1]);
        if (!fl) fl = popsFloor || (bin ? popsFloorOf(bin) : '');
        if (!fl) { var me = parseMyFloor(); if (me) fl = me.floor; }
        var tote = TOTE_BY_FLOOR[fl];
        if (!tote) { autoSay('autofinish off for this item: floor of ' + (bin || 'the pick bin') + ' not known'); finishFlow = null; return; }
        finishFlow = { tote: tote, floor: fl, bin: bin, stage: stage || 'wait-tote', at: Date.now(), started: Date.now(), nextAt: 0 };
        autoSay('autofinish ready: tote ' + tote + ' (P' + fl + ', bin ' + (bin || '?') + ') and Continue');
    }
    // remembers the pick bin of whatever item is being picked
    function watchPickBin() {
        if (document.querySelector('button.item')) return;
        var t = '';
        try { t = (document.body.innerText || ''); } catch (e) {}
        if (!/SCAN\s*PICK\s*BIN/i.test(t)) return;
        var b = domBinEls().filter(function (x) { return isShown(x.el); })[0];
        if (b && (b.bin !== lastPickBin || Date.now() - lastPickAt > 5000)) { lastPickBin = b.bin; lastPickAt = Date.now(); }
    }
    function stepHas(key, img) {
        if (lastStep.at && Date.now() - lastStep.at < 60000) {
            if (key && lastStep.keys.indexOf(key) !== -1) return true;
            if (img && lastStep.imgs.some(function (u) { return u.indexOf(img) !== -1; })) return true;
        }
        if (img) {
            var imgs = document.querySelectorAll('img[src*="' + img + '"]');
            for (var i = 0; i < imgs.length; i++) if (isShown(imgs[i])) return true;
        }
        return false;
    }
    function onToteScreen() {
        if (document.querySelector('button.item')) return false;
        return stepHas('ScanCollectionToteSubtitle', 'collection_cart');
    }
    function onCollectedScreen() {
        if (document.querySelector('button.item')) return false;
        return stepHas('ItemCollected', 'greencheck');
    }
    function findButtonByText(label) {
        var want = label.toLowerCase(), hit = null;
        document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]').forEach(function (b) {
            if (hit || ourUi(b) || (b.closest && b.closest('button.item')) || !isShown(b)) return;
            var t = (b.value && b.tagName === 'INPUT' ? b.value : normTxt(b)).toLowerCase();
            if (t === want) hit = b;
        });
        return hit;
    }
    function finishTick() {
        var ff = finishFlow;
        var now = Date.now();
        if (!ff) {
            // 10.3: start for ANY item once its tote screen shows up
            watchPickBin();
            if (finishBlocked) { if (!onToteScreen()) finishBlocked = false; return; }
            if (!onToteScreen()) return;
            var pb = (lastPickBin && now - lastPickAt < 15 * 60 * 1000) ? lastPickBin : '';
            startAutoFinishFor(pb, '', 'tote');
            ff = finishFlow;
            if (!ff) { finishBlocked = true; return; }
        }
        if (now - ff.started > FINISH_MS) { autoSay('autofinish stopped: no tote screen within 3 min'); finishFlow = null; return; }
        if (now < ff.nextAt) return;
        if (document.querySelector('button.item')) {                  // back on the list
            if (ff.cont && ff.cont.tries) autoSay('autofinish done - back on the list');
            else if (ff.stage !== 'wait-tote') autoSay('autofinish stopped: back on the list');
            finishFlow = null; return;
        }
        if (ff.stage === 'wait-tote') {
            if (!onToteScreen()) return;                                 // the associate is still scanning the item
            ff.stage = 'tote'; ff.at = now;
        }
        if (ff.stage === 'tote') {
            if (!onToteScreen()) {
                if (ff.fill && ff.fill.tries) { ff.stage = 'wait-continue'; ff.at = now; }
                return;
            }
            var inp = scannerInput();
            var st = ff.fill || (ff.fill = { tries: 0, at: 0 });
            var ways = inp ? ['box', 'box-keys', 'page-keys', 'document-keys'] : ['page-keys', 'document-keys'];
            if (st.tries >= ways.length) { autoSay('autofinish: the tote scan did not go through - scan ' + ff.tote + ' yourself'); finishFlow = null; return; }
            if (st.tries && now - st.at < 2500) return;
            var way = ways[st.tries];
            st.tries++; st.at = now;
            autoSay('autofinish: scanning tote ' + ff.tote + ' (' + way + ')');
            if (way === 'box') typeAndEnter(inp, ff.tote, 1);
            else if (way === 'box-keys') typeAndEnter(inp, ff.tote, 2);
            else if (way === 'page-keys') {
                var tgt = (document.activeElement && document.activeElement !== document.body && !ourUi(document.activeElement)) ? document.activeElement : document.body;
                sendScannerKeys(tgt, ff.tote);
            } else sendScannerKeys(document, ff.tote);
            ff.nextAt = now + 900;
            return;
        }
        if (ff.stage === 'wait-continue') {
            if (now - ff.at > 20000) { autoSay('autofinish stopped: no "Item collected" screen after the tote'); finishFlow = null; return; }
            if (!onCollectedScreen()) return;
            ff.stage = 'continue'; ff.at = now;
        }
        if (ff.stage === 'continue') {
            var b = findButtonByText('Continue');
            var cs = ff.cont || (ff.cont = { tries: 0, at: 0 });
            if (!b) { if (now - ff.at > 10000) { autoSay('autofinish: no Continue button found'); finishFlow = null; } return; }
            if (cs.tries >= 3) { autoSay('autofinish: pressing Continue did nothing - press it yourself'); finishFlow = null; return; }
            if (cs.tries && now - cs.at < 1500) return;
            cs.tries++; cs.at = now;
            autoSay('autofinish: pressing Continue (try ' + cs.tries + ')');
            tap(b, cs.tries);
            ff.nextAt = now + 900;
        }
    }
    setInterval(function () {
        var had = !!finishFlow;
        try { finishTick(); } catch (e) { console.log(CPT_LOG, 'autofinish error:', e); finishFlow = null; }
        if (had && !finishFlow) finishBlocked = true;   // ended (done or stopped): wait until the tote screen is gone
    }, 400);

    // ---- the driver ----
    function domStepLocation(af, groups) {
        var now = Date.now(), code = af.code, isBin = BIN_ONLY_RE.test(code), bins = domBinEls();
        function open(i) {                        // shown bins of group i, or null while we tap / wait
            var inG = binsInGroup(groups, i, bins).filter(function (b) { return isShown(b.el); });
            if (inG.length) return inG;
            var st = af.g[i] || (af.g[i] = { tries: 0, at: 0 });
            if (st.tries >= 3) return [];
            if (now - st.at < 1000) return null;
            st.tries++; st.at = now;
            autoSay('opening Floor ' + groups[i].floor + ' (try ' + st.tries + ')');
            tap(groups[i].el, st.tries);
            af.nextAt = now + 700;
            return null;
        }
        function tapBin(hit, verified) {
            var st = af.bt;
            if (!st || st.bin !== hit.bin) st = af.bt = { bin: hit.bin, tries: 0, at: 0 };
            if (now - st.at < 1100) return;
            if (st.tries >= 3) { autoFail('tapping ' + hit.bin + ' did nothing'); return; }
            st.tries++; st.at = now;
            af.bin = hit.bin; af.verified = !!verified;
            autoSay('tapping ' + hit.bin + (verified ? ' (scanned)' : ' (first on your floor)') + ' - try ' + st.tries);
            tap(hit.el, st.tries);
            af.nextAt = now + 900;
        }
        // 9.7: only the scanned location, never a substitute
        if (!isBin) { autoFail('the scan was not a location (P-...)'); return; }
        if (!af.skipScanned) {
            for (var i = 0; i < groups.length; i++) {
                if (af.checked[i]) continue;
                var sb = open(i);
                if (sb === null) return;
                var hit = sb.filter(function (b) { return b.bin === code; })[0];
                if (hit) { af.binFloor = groups[i].floor; tapBin(hit, true); return; }
                af.checked[i] = true;
            }
            autoFail(code + ' is not in this item\'s location list - choose the location yourself');
            return;
        }
        var me = parseMyFloor(), gi = 0;
        if (me) for (var k = 0; k < groups.length; k++) { if (groups[k].floor === me.floor && (!groups[k].mod || groups[k].mod === me.mod)) { gi = k; break; } }
        var sb2 = open(gi);
        if (sb2 === null) return;
        if (!sb2.length) { autoFail('no bins found under Floor ' + groups[gi].floor); return; }
        tapBin(sb2[0], false);
    }
    // 9.6: is the "Scan Pick Bin" screen showing for this bin? Judged from the
    // screen's text, not from one element (9.4 looked for the green box and
    // never found it, so the bin was never filled in).
    function onPickBinScreen(bin) {
        if (document.querySelector('button.item')) return false;
        var t = '';
        try { t = (document.body.innerText || '').toUpperCase(); } catch (e) {}
        return /SCAN\s*PICK\s*BIN/.test(t) && t.indexOf(String(bin || '').toUpperCase()) !== -1;
    }
    // 9.7: the page may read the scanner from the keyboard rather than from a
    // text box (its main.js logged our scan-bar keys), so the bin is also
    // sent as scanner key strokes to the page itself.
    function keyCodeOf(ch) {
        if (ch === '-') return { key: '-', code: 'Minus', kc: 189, cc: 45 };
        if (/[0-9]/.test(ch)) return { key: ch, code: 'Digit' + ch, kc: ch.charCodeAt(0), cc: ch.charCodeAt(0) };
        return { key: ch, code: 'Key' + ch.toUpperCase(), kc: ch.toUpperCase().charCodeAt(0), cc: ch.charCodeAt(0) };
    }
    function sendScannerKeys(target, text) {
        function fire(type, k) {
            try {
                target.dispatchEvent(new KeyboardEvent(type, { key: k.key, code: k.code, keyCode: type === 'keypress' ? k.cc : k.kc,
                    which: type === 'keypress' ? k.cc : k.kc, charCode: type === 'keypress' ? k.cc : 0, bubbles: true, cancelable: true }));
            } catch (e) {}
        }
        text.split('').forEach(function (ch) { var k = keyCodeOf(ch); fire('keydown', k); fire('keypress', k); fire('keyup', k); });
        var en = { key: 'Enter', code: 'Enter', kc: 13, cc: 13 };
        fire('keydown', en); fire('keypress', en); fire('keyup', en);
    }
    function domStepPickBin(af) {
        var now = Date.now();
        var here = onPickBinScreen(af.bin);
        // 10.11: "Pick This Location" stops here - the location is selected
        // (stock assigned), the pod is called outside POPS, nothing is scanned
        if (af.mode === 'pickonly') {
            if (here) { markPicked(af.bin); autoDone('location ' + af.bin + ' picked - call the pod'); }
            return;
        }
        if (af.fill && af.fill.tries && !here) { startAutoFinish(af); autoDone('done - "Scan item" is next, scan the item'); return; }
        if (!here) return;                                             // screen not drawn yet
        var inp = scannerInput();
        var st = af.fill || (af.fill = { tries: 0, at: 0 });
        if (now - st.at < 1600) return;
        // ways to hand over the scan, tried one after the other until the page moves on
        var ways = inp
            ? ['box', 'box-keys', 'page-keys', 'document-keys']
            : ['page-keys', 'document-keys'];
        if (st.tries >= ways.length) { autoFail('the pick bin scan did not go through (' + (inp ? 'scanner box found' : 'no scanner box') + ')'); return; }
        if (st.tries && now - st.at < 2500) return;                    // give the page time to move on before the next way
        var way = ways[st.tries];
        st.tries++; st.at = now; st.way = way;
        autoSay('confirming pick bin ' + af.bin + ' (' + way + ')');
        if (way === 'box') typeAndEnter(inp, af.bin, 1);
        else if (way === 'box-keys') typeAndEnter(inp, af.bin, 2);
        else if (way === 'page-keys') {
            var tgt = (document.activeElement && document.activeElement !== document.body && !ourUi(document.activeElement)) ? document.activeElement : document.body;
            sendScannerKeys(tgt, af.bin);
        } else sendScannerKeys(document, af.bin);
        af.nextAt = now + 900;
        // 10.7: the associate's scanner must keep typing into the pre-scan box, not the page
        setTimeout(focusPrescan, 60);
    }

    // =========================================================================
    // 10.7: PRE-SCAN - while the auto steps run, the big picture box has a scan
    // field. An item scanned there is kept and entered as soon as "Scan item"
    // shows, so the associate does not wait for the page. The page still
    // checks the item as usual (a wrong item is refused by POPS). Kept 3 min.
    // =========================================================================
    var prescan = { code: '', at: 0, fill: null };
    function focusPrescan() {
        var i = document.querySelector('#pops-auto-pic .pap-input');
        if (i && autoPicShown() && document.activeElement !== i) { try { i.focus(); } catch (e) {} }
    }
    function pageText() {
        var root = document.querySelector('aftroot') || document.body;
        try { return root.innerText || ''; } catch (e) { return ''; }
    }
    function onScanItemScreen() {
        if (document.querySelector('button.item')) return false;
        if (onToteScreen() || onCollectedScreen()) return false;
        if (stepHas('ScanItemSubtitle', '')) return true;
        var t = pageText();
        return /scan\s*item/i.test(t) && !/scan\s*pick\s*bin/i.test(t);
    }
    function prescanTick() {
        if (!prescan.code) return;
        var now = Date.now();
        if (now - prescan.at > 3 * 60 * 1000 || document.querySelector('button.item')) { prescan.code = ''; hideAutoPic(0); return; }
        var st = prescan.fill || (prescan.fill = { tries: 0, at: 0 });
        if (!onScanItemScreen()) {
            if (st.tries) { autoSay('pre-scanned item ' + prescan.code + ' entered'); prescan.code = ''; prescan.fill = null; hideAutoPic(400); return; }
            // the auto steps are over but no "Scan item" screen came: give up after 20 s
            if (!autoFlow) {
                prescan.waitSince = prescan.waitSince || now;
                if (now - prescan.waitSince > 20000) { autoSay('pre-scan dropped: no "Scan item" screen - scan the item on the page'); prescan.code = ''; hideAutoPic(0); }
            }
            return;
        }
        var inp = scannerInput();
        var ways = inp ? ['box', 'box-keys', 'page-keys', 'document-keys'] : ['page-keys', 'document-keys'];
        if (st.tries >= ways.length) { autoSay('pre-scan could not be entered - scan the item again'); prescan.code = ''; prescan.fill = null; hideAutoPic(0); return; }
        if (st.tries && now - st.at < 2500) return;
        var way = ways[st.tries];
        st.tries++; st.at = now;
        autoSay('entering pre-scanned item ' + prescan.code + ' (' + way + ')');
        if (way === 'box') typeAndEnter(inp, prescan.code, 1);
        else if (way === 'box-keys') typeAndEnter(inp, prescan.code, 2);
        else if (way === 'page-keys') sendScannerKeys(document.body, prescan.code);
        else sendScannerKeys(document, prescan.code);
    }
    setInterval(function () { try { prescanTick(); } catch (e) { console.log(CPT_LOG, 'pre-scan error:', e); } }, 400);

    function autoDomTick() {
        var af = autoFlow;
        if (!af) return;
        var now = Date.now();
        if (now - af.at > AUTO_FLOW_MS) { autoFail('stopped: took too long at "' + af.stage + '"'); return; }
        if (now < af.nextAt) return;
        var groups = domGroups();
        if (af.stage === 'wait-location') {
            if (groups.length) { af.stage = 'location'; af.at = now; autoSay('Select-location screen found (' + groups.length + ' floors)'); }
            else if (!document.querySelector('button.item')) {
                // a one-location item skips "Select location" and goes straight to "Scan Pick Bin"
                var lone = domBinEls().filter(function (b) { return isShown(b.el); })[0];
                if (lone && scannerInput() !== undefined && onPickBinScreen(lone.bin)) {
                    // 9.7: only the scanned location may be confirmed
                    if (lone.bin !== af.code) { autoFail('this item\'s only location is ' + lone.bin + ', not the scanned ' + af.code); return; }
                    af.bin = lone.bin; af.verified = BIN_ONLY_RE.test(af.code) && lone.bin === af.code;
                    af.stage = 'pickbin'; af.at = now;
                    autoSay('only one location (' + lone.bin + ') - straight to "Scan Pick Bin"');
                }
                return;
            } else return;
        }
        if (af.stage === 'location') {
            if (!groups.length) {
                if (af.bin) { af.stage = 'pickbin'; af.at = now; autoSay('location chosen: ' + af.bin); }
                return;
            }
            domStepLocation(af, groups);
            return;
        }
        if (af.stage === 'pickbin') domStepPickBin(af);
    }
    setInterval(function () { try { autoDomTick(); } catch (e) { console.log(CPT_LOG, 'auto driver error:', e); } }, 300);

    // =========================================================================
    // 10.11: "PICK THIS LOCATION" on a list card
    // Does what the associate does by hand before calling the pod: opens the
    // card and selects exactly the location shown on it in "Select location".
    // That is the step that moves the stock from UNOWNED to the customer
    // order. It then STOPS on "Scan Pick Bin" - nothing is scanned or
    // confirmed - and the card turns OPENED. If the shown location is not in
    // POPS's list for that pick, nothing is selected.
    // =========================================================================
    // 10.12: done IN THE BACKGROUND - the screen stays on the list. The script
    // opens its own copy of the Send Runner list (the same start request the
    // page sent), opens this pick there and selects exactly this location -
    // the same two requests the associate sends by hand. The button then
    // says whether it worked; on success the pod can be called. If the
    // location is not in POPS's list for the pick, nothing is selected.
    var bgBusy = false;
    function wfParts(j) {
        var out = { list: null, acc: null, box: '', cancel: null };
        ((j && j.componentDataList) || []).forEach(function (c) {
            if (!c) return;
            if (c.componentType === 'type-send-runner-list' && !out.list) out.list = c;
            if (c.componentType === 'type-accordion-selection' && !out.acc) out.acc = c;
            if (c.componentType === 'type-box-text' && !out.box) out.box = String(c.boxText || '');
            if (c.componentType === 'type-buttons' && !out.cancel) {
                (c.buttons || []).forEach(function (b) {
                    if (!out.cancel && (/back|cancel/i.test(b.translationKey || '') || /cancel/i.test(b.value || ''))) out.cancel = { fieldName: c.fieldName || 'eventsField', values: [b.value] };
                });
            }
        });
        return out;
    }
    function cardNth(btn) {
        var t = btn.dataset.popsTitle || '', c = btn.dataset.popsCode || '', n = 0, mine = 0;
        document.querySelectorAll('button.item').forEach(function (b) {
            if ((b.dataset.popsTitle || '') === t && (b.dataset.popsCode || '') === c) { if (b === btn) mine = n; n++; }
        });
        return mine;
    }
    function pickStatus(btn, text, bg, ms) {
        var pb = btn.querySelector('.pcs-pickbtn');
        if (!pb) return;
        pb.dataset.statusUntil = String(Date.now() + (ms || 0));
        pb.textContent = text;
        pb.style.background = bg;
    }
    function pickThisLocation(btn, bin) {
        if (bgBusy) { pickStatus(btn, 'Busy with another pick\u2026', '#8a6d00', 3000); return; }
        // 10.13: no more "open Send Runner once" - the known start request is used
        // when the page's own one has not been caught
        var sr = startReq();
        bgBusy = true;
        var title = btn.dataset.popsTitle || '', code = (btn.dataset.popsCode || '').toUpperCase(), nth = cardNth(btn);
        pickStatus(btn, 'Picking ' + bin + '\u2026', '#1f5fa8', 60000);
        autoSay('Pick This Location (background): ' + bin + ' for ' + title.slice(0, 60));
        var base = location.origin;
        var su = String(sr.url || '/wf/start');
        var startUrl = /^https?:/i.test(su) ? su : base + (su.charAt(0) === '/' ? su : '/' + su);
        var nextUrl = base + '/wf/next';
        function next(j, response) {
            return bgPost(nextUrl, { workflowReferenceId: j.workflowReferenceId, workflowInstanceId: j.workflowInstanceId, responses: [response] }, nextHeaders());
        }
        // the start: as the page sent it; without a caught copy, plain text first, then JSON
        function openList() {
            if (sr !== DEFAULT_START) return bgPost(startUrl, sr.body, sr.headers || {});
            var base2 = nextHeaders(); delete base2['Content-Type'];
            var asText = {}; Object.keys(base2).forEach(function (k) { asText[k] = base2[k]; }); asText['Content-Type'] = 'text/plain;charset=UTF-8';
            return bgPost(startUrl, sr.body, asText).catch(function () {
                var asJson = {}; Object.keys(base2).forEach(function (k) { asJson[k] = base2[k]; }); asJson['Content-Type'] = 'application/json';
                return bgPost(startUrl, sr.body, asJson);
            });
        }
        // 10.18: every error says at which step it happened
        function stepErr(label) { return function (e) { var m = (e && e.message) || 'failed'; if (m.indexOf(' - step: ') === -1) m += ' - step: ' + label; throw new Error(m); }; }
        openList().catch(stepErr('opening the list')).then(function (j) {
            if (pageInstanceId && String(j.workflowInstanceId || '') === pageInstanceId) throw new Error('POPS gave back the page\'s own list - stopped');
            var p = wfParts(j);
            if (!p.list) throw new Error('could not open the Send Runner list');
            var items = [];
            (p.list.sendRunnerAreas || []).forEach(function (a) { (a.items || []).forEach(function (it) { items.push(it); }); });
            var matches = items.filter(function (it) { return normT(it.title) === normT(title) && String(it.location || '').toUpperCase() === code; });
            var it = matches[nth] || matches[0];
            if (!it) throw new Error('this pick is no longer on the Send Runner list');
            return next(j, { fieldName: p.list.fieldName || 'selectedItemFieldName', values: [it.userActionUUID] }).catch(stepErr('opening the pick'));
        }).then(function (j2) {
            var p2 = wfParts(j2);
            if (p2.acc) {
                var loc = parseLocStep(j2);
                // POPS's list for this pick is remembered for the card (10.15)
                if (loc && loc.groups) {
                    itemLocs[normT(title)] = { t: Date.now(), asin: loc.asin, groups: loc.groups }; saveItemLocs();
                    try { learnFloorsFromPops(loc.groups); } catch (e) {}
                }
                // 10.18: ALWAYS one of POPS's own locations on the associate's floor
                // (floor by roboscout where known, else POPS's floor). The card's bin
                // goes first when POPS lists it there; bins already picked for another
                // unit of this item are left out. If POPS refuses a bin, the next
                // one on the floor is tried (up to 3).
                var taken = {};
                Object.keys(pickedFor).forEach(function (k) { if (k !== btn.dataset.popsKey && pickedFor[k].title === normT(title)) taken[pickedFor[k].bin] = true; });
                var me = parseMyFloor(), cands = [];
                if (loc && me) {
                    effectiveGroups(loc.groups, {}, null).forEach(function (g) {
                        if (g.floor !== me.floor || (g.mod && g.mod !== me.mod)) return;
                        g.bins.forEach(function (b) { if (!taken[b] && cands.indexOf(b) === -1) cands.push(b); });
                    });
                }
                if (cands.indexOf(bin) > 0) { cands.splice(cands.indexOf(bin), 1); cands.unshift(bin); }
                if (!cands.length) {
                    if (p2.cancel) next(j2, p2.cancel).catch(function () {});   // nothing was selected: step back out
                    throw new Error('POPS lists no location for this pick on your floor - nothing assigned');
                }
                if (cands[0] !== bin) autoSay('POPS location on your floor: ' + cands[0] + ' (card showed ' + bin + ')');
                var tries = cands.slice(0, 3);
                function trySelect(i, lastErr) {
                    if (i >= tries.length) throw lastErr || new Error('POPS refused every location on your floor');
                    var target = tries[i];
                    return next(j2, { fieldName: p2.acc.fieldName || 'inputField', values: [target] }).then(function (j3) {
                        var b3 = wfParts(j3).box.toUpperCase();
                        if (b3 !== target) throw new Error('POPS selected ' + (b3 || 'something else') + ' instead of ' + target);
                        return target;
                    }, function (e) {
                        autoSay('selecting ' + target + ' failed (' + (e && e.message) + ')' + (i + 1 < tries.length ? ' - trying ' + tries[i + 1] : ''));
                        return trySelect(i + 1, e);
                    });
                }
                return trySelect(0, null).catch(stepErr('selecting the location'));
            }
            if (p2.box) {
                // one-location item: opening it already selected POPS's only location
                return p2.box.toUpperCase();
            }
            throw new Error('unexpected POPS screen');
        }).then(function (got) {
            var changed = got && got !== bin;
            markPicked(got);
            // 10.15: the card now shows (and its barcode encodes) the location really picked
            if (btn.dataset.popsKey) setPickedFor(btn.dataset.popsKey, got, title);
            try { if (btn.dataset.popsKey) markOpened(btn.dataset.popsKey); } catch (e) {}
            try { recordClick(title, code, got); } catch (e) {}
            pickStatus(btn, '\u2713 ' + got + ' picked' + (changed ? ' (instead of ' + bin + ')' : '') + ' - call the pod', '#067d62', 10 * 60 * 1000);
            autoSay('picked ' + got + ' in the background' + (changed ? ' (card showed ' + bin + ')' : ''));
            try { quietPaint(function () { openedScan(); cptScan(); }); } catch (e) {}
        }).catch(function (e) {
            pickStatus(btn, '\u2717 ' + (e && e.message ? e.message : 'failed'), '#c0392b', 60000);
            autoSay('Pick This Location failed: ' + (e && e.message));
            bgBusy = false;
        }).then(function () { bgBusy = false; });
    }
    function scanOpen(btn, scannedCode, mode) {
        var nowT = Date.now();
        var sc = String(scannedCode || '').trim().toUpperCase();
        // 9.6: a POD scan stands for the card's own bin in that pod - the pod
        // holds it, so the pick bin is confirmed with that bin
        if (/^\d{6,}$/.test(sc)) {
            var cb = (btn.dataset.popsCode || '').toUpperCase();
            if (BIN_ONLY_RE.test(cb)) sc = cb;
        }
        autoFlow = { code: sc, title: btn.dataset.popsTitle || '', at: nowT, nextAt: nowT + 400,
            stage: 'wait-location', g: {}, checked: {}, mode: mode || 'scan' };
        autoSay((mode === 'pickonly' ? 'pick-this-location' : 'scan-bar') + ' open for ' + autoFlow.code + ' - waiting for "Select location"');
        finishFlow = null;
        if (mode !== 'pickonly') { try { showAutoPic(btn); } catch (e) {} }
        // hidden cards have no click recorder of their own
        if (btn.style.display === 'none') { try { recordClick(btn.dataset.popsTitle || '', btn.dataset.popsCode || ''); } catch (e) {} }
        try { btn.click(); } catch (e) {}
    }
    // ---- 10.4: what the script remembers about a location -------------------
    // Every list card with a P- bin is remembered for 12 h (title, ASIN, CPT,
    // when last seen). When a scanned location is no longer on the list, its
    // details are put together from that, the click history, the location
    // lists seen in POPS, Rodeo / FCResearch and roboscout.
    var SEEN_KEY = 'pops_seen_cards', SEEN_TTL_MS = 12 * 3600 * 1000, SEEN_MAX = 1500;
    var seenCards = (function () {
        try {
            var o = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}, now = Date.now(), out = {};
            Object.keys(o).forEach(function (k) { if (o[k] && o[k].at && now - o[k].at < SEEN_TTL_MS) out[k] = o[k]; });
            return out;
        } catch (e) { return {}; }
    })();
    var seenSaveT = null;
    function rememberCard(bin, title, asin, cpt) {
        if (!bin) return;
        var e = seenCards[bin], now = Date.now();
        if (e && e.title === title && e.asin === (asin || e.asin) && now - e.at < 60000) return;   // nothing new
        seenCards[bin] = { title: title || (e && e.title) || '', asin: asin || (e && e.asin) || '', cpt: cpt || (e && e.cpt) || '', at: now };
        if (seenSaveT) return;
        seenSaveT = setTimeout(function () {
            seenSaveT = null;
            try {
                var keys = Object.keys(seenCards);
                if (keys.length > SEEN_MAX) {
                    keys.sort(function (a, b) { return seenCards[a].at - seenCards[b].at; });
                    keys.slice(0, keys.length - SEEN_MAX).forEach(function (k) { delete seenCards[k]; });
                }
                localStorage.setItem(SEEN_KEY, JSON.stringify(seenCards));
            } catch (err) {}
        }, 1000);
    }
    function vanishedReport(bin) {
        var title = '', asin = '', cpt = '', seenAt = 0, sources = [];
        var s = seenCards[bin];
        if (s) { title = s.title; asin = s.asin; cpt = s.cpt; seenAt = s.at; sources.push('list'); }
        // click history
        try {
            var h = loadHistory().filter(function (x) { return x.code === bin || x.pick === bin; }).pop();
            if (h) { title = title || h.title; asin = asin || h.asin || ''; if (!seenAt || h.t > seenAt) seenAt = h.t; sources.push('history'); }
        } catch (e) {}
        // POPS location lists seen for an item
        if (!title || !asin) {
            Object.keys(itemLocs).some(function (k) {
                var e = itemLocs[k];
                var has = (e.groups || []).some(function (g) { return (g.bins || []).indexOf(bin) !== -1; });
                if (has) { asin = asin || e.asin || ''; sources.push('POPS list'); }
                return has;
            });
        }
        // Rodeo / FCResearch for the bin
        if (!asin) { var a = asinsFor(bin); if (a.length) { asin = a.join(', '); sources.push('Rodeo'); } }
        if (!asin || !title) {
            var fr = fcrRows[bin];
            if (fr && fr.rows && fr.rows.length) {
                asin = asin || fr.rows.map(function (r) { return r.asin; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; }).join(', ');
                title = title || fr.rows[0].title || '';
                sources.push('FCResearch');
            }
        }
        var bi = binInfo[bin] || {};
        var lines = ['The item has vanished from SR', 'Location: ' + bin];
        if (bi.floor || bi.pod) lines.push('Floor: ' + (bi.floor ? floorShort(bi.floor) + ' (' + bi.floor + ')' : '?') + (bi.pod ? '   POD: ' + bi.pod : ''));
        lines.push('ASIN: ' + (asin || 'not known'));
        if (title) lines.push('Title: ' + title);          // 10.8: no "Title: not known" line
        if (cpt) lines.push('CPT: ' + cpt);
        if (seenAt) { var d = new Date(seenAt); lines.push('Last seen: ' + ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)); }
        lines.push('Pod arrived with no SR at ' + new Date().toLocaleString('en-GB'));   // 10.8: was "Scanned: ..."
        var found = sources.filter(function (v, i, arr) { return arr.indexOf(v) === i; }).join(', ');
        console.log(CPT_LOG, 'vanished: ' + bin + ' - ' + (found || 'nothing remembered'));
        return { text: lines.join('\n'), found: found };
    }
    function scanSubmit(input, msg, choices) {
        var code = input.value.trim();
        input.value = '';
        choices.innerHTML = '';
        if (!code) return;
        // 9.7: the bar takes LOCATIONS only (P-...): that scan is what lets the
        // script choose that bin and confirm "Scan Pick Bin" for the associate
        if (!BIN_ONLY_RE.test(code)) {
            msg.style.color = '#ffb3b3';
            msg.textContent = code + ' is not a location - scan the bin (P-...)';
            return;
        }
        code = code.toUpperCase();
        var hits = scanFind(code);
        if (!hits.length) {
            // 10.4: not on the list any more - copy what the script remembers about it
            var rep = vanishedReport(code);
            msg.style.color = '#ffb3b3';
            msg.textContent = 'No runner on the list for ' + code + ' - copying details\u2026';
            copyText(rep.text, function (ok) {
                msg.textContent = ok
                    ? 'The item has vanished from SR - details copied (' + (rep.found ? rep.found : 'location only, nothing remembered') + ')'
                    : 'No runner on the list for ' + code + ' - copy failed';
            });
            return;
        }
        // 10.15: several units of the SAME item (same ASIN, or same title when the
        // ASIN is not known) are interchangeable - just take one, preferring a
        // unit that is not opened yet, then the soonest CPT
        if (hits.length > 1) {
            var ids = hits.map(function (btn) {
                var bn = (btn.dataset.popsCode || '').toUpperCase(), a = [];
                try { a = asinsFor(bn); if (!a.length) a = fcrAsinsFor(bn, btn.dataset.popsTitle); } catch (e) {}
                return a.length ? 'asin:' + a[0] : 'title:' + normT(btn.dataset.popsTitle);
            });
            var same = ids.every(function (v) { return v === ids[0]; });
            if (same) {
                var ranked = hits.slice().sort(function (x, y) {
                    var ox = opened[x.dataset.popsKey] ? 1 : 0, oy = opened[y.dataset.popsKey] ? 1 : 0;
                    if (ox !== oy) return ox - oy;
                    var cx = cptAtFor((x.dataset.popsCode || '').toUpperCase()) || 9e15, cy = cptAtFor((y.dataset.popsCode || '').toUpperCase()) || 9e15;
                    return cx - cy;
                });
                hits = [ranked[0]];
            }
        }
        if (hits.length === 1) {
            msg.style.color = '#b9f6ca';
            msg.textContent = 'Opening: ' + (hits[0].dataset.popsTitle || code);
            scanOpen(hits[0], code);
            return;
        }
        msg.style.color = '#fff';
        msg.textContent = hits.length + ' items in ' + code + ' - tap one:';
        hits.forEach(function (btn) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = btn.dataset.popsTitle || '(no title)';
            b.style.cssText = 'display:block;width:100%;margin-top:4px;padding:6px 8px;text-align:left;font-size:14px;' +
                'background:#fff;color:#000;border:1px solid #888;border-radius:4px;cursor:pointer;';
            b.addEventListener('click', function () { choices.innerHTML = ''; msg.textContent = ''; scanOpen(btn, code); });
            choices.appendChild(b);
        });
    }
    function paintScanBar() {
        if (!document.body) return;
        var onList = !!document.querySelector('button.item');
        if (!scanBar && !onList) return;
        if (!scanBar) {
            scanBar = document.createElement('div');
            scanBar.id = 'pops-scan-bar';
            scanBar.style.cssText = 'position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:2147483646;' +
                'width:560px;max-width:96vw;box-sizing:border-box;padding:8px 10px;background:#232f3e;color:#fff;' +
                'border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);font-family:Arial,sans-serif;';
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;align-items:center;';
            var lbl = document.createElement('span');
            lbl.textContent = 'Scan location:';
            lbl.style.cssText = 'font-weight:bold;white-space:nowrap;';
            var input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'scan the location (P-...)';
            input.autocomplete = 'off';
            input.style.cssText = 'flex:1 1 auto;padding:7px;font:16px monospace;border:0;border-radius:4px;color:#000;background:#fff;';
            var go = document.createElement('button');
            go.type = 'button'; go.textContent = 'Open';
            go.style.cssText = 'padding:7px 14px;font-weight:bold;background:#ff9900;color:#000;border:0;border-radius:4px;cursor:pointer;';
            var msg = document.createElement('div');
            msg.style.cssText = 'margin-top:4px;font-size:13px;min-height:16px;';
            var choices = document.createElement('div');
            choices.style.cssText = 'max-height:40vh;overflow-y:auto;';
            // keep the page's own keyboard handling out of this box; Enter = scanner done
            input.addEventListener('keydown', function (e) {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); scanSubmit(input, msg, choices); }
            });
            // 9.3: the page listens for scanner keys too (its main.js logged our
            // scan) - none of the other key events may reach it either
            ['keypress', 'keyup', 'input'].forEach(function (evn) {
                input.addEventListener(evn, function (e) { e.stopPropagation(); });
            });
            go.addEventListener('click', function () { scanSubmit(input, msg, choices); });
            row.appendChild(lbl); row.appendChild(input); row.appendChild(go);
            scanBar.appendChild(row); scanBar.appendChild(msg); scanBar.appendChild(choices);
            document.body.appendChild(scanBar);
            scanBar._input = input; scanBar._msg = msg; scanBar._choices = choices;
            // room at the bottom of the page so the bar never covers the last card
            document.body.style.paddingBottom = '110px';
        }
        if (onList && !scanBarShown) {
            scanBarShown = true;
            scanBar.style.display = 'block';
            // ready for the scanner gun, unless the associate is typing somewhere else
            var ae = document.activeElement;
            if (!ae || ae === document.body) { try { scanBar._input.focus(); } catch (e) {} }
        } else if (!onList && scanBarShown) {
            scanBarShown = false;
            scanBar.style.display = 'none';
            scanBar._msg.textContent = ''; scanBar._choices.innerHTML = '';
        }
    }

    // =========================================================================
    // 9.5: the item picture on EVERY Send Runner screen
    // The page shows the picture only when its reply has one (imageUrl), so on
    // "Scan Pick Bin" / "Scan item" it is often missing. The script finds the
    // item's ASIN on the screen itself - the header reads "[ B07XRK5FHP
    // (ZZWO2628ZU) ] title" - or from the last workflow reply, and puts the
    // picture (200 px) just above that header whenever the page has none.
    // =========================================================================
    var curItem = null;
    var HEADER_ASIN_RE = /\[\s*([A-Z0-9]{10})\s*\(\s*[A-Z0-9]+\s*\)\s*\]/;
    function domItemHeader() {
        var hit = null;
        leafElements().forEach(function (el) {
            if (hit || ourUi(el) || (el.closest && el.closest('button.item'))) return;
            var m = HEADER_ASIN_RE.exec(el.textContent || '');
            if (m) hit = { el: el, asin: m[1].toUpperCase() };
        });
        return hit;
    }
    // 10.3: ONE item picture box on every item step ("Select location", "Scan
    // Pick Bin", "Scan item", tote...), placed at the top of the page right
    // under the four boxes, so it is visible straight away without scrolling.
    // Sources, first found wins: POPS's own picture in its reply, the page's
    // own picture on screen, the item's remembered picture, the ASIN lookup.
    // The page's own (often small or missing) picture is hidden meanwhile, so
    // there is never a second copy. Once shown for an item it stays (sticky)
    // until another item comes up.
    var itemPicKey = '', itemPicUrl = '';
    function pageOwnItemImg() {
        var imgs = document.querySelectorAll(PAGE_IMG_SEL);
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (im.closest && im.closest('#pops-item-pic, #pops-item-pic-bottom, #pops-auto-pic, #pops-loc-pick, #pops-barcode-tools, button.item')) continue;
            if (im.getAttribute('src')) return im;
        }
        return null;
    }
    function setPageImgHidden(hide) {
        document.querySelectorAll(PAGE_IMG_SEL).forEach(function (im) {
            if (im.closest && im.closest('#pops-item-pic, #pops-item-pic-bottom, #pops-auto-pic, #pops-loc-pick, #pops-barcode-tools, button.item')) return;
            if (hide) { if (!im.dataset.popsHidden) { im.dataset.popsHidden = '1'; im.style.setProperty('display', 'none', 'important'); } }
            else if (im.dataset.popsHidden) { delete im.dataset.popsHidden; im.style.removeProperty('display'); }
        });
    }
    function paintItemPic() {
        // never more than one box
        var all = document.querySelectorAll('#pops-item-pic');
        for (var d = 1; d < all.length; d++) all[d].remove();
        var box = all[0] || null;
        function drop() { if (box) box.remove(); document.querySelectorAll('#pops-item-pic-bottom').forEach(function (n) { n.remove(); }); setPageImgHidden(false); itemPicKey = ''; itemPicUrl = ''; }
        if (!document.body || document.querySelector('button.item')) { curItem = null; return drop(); }   // the list has its own pictures
        var hdr = domItemHeader();
        var asin = hdr ? hdr.asin : (curItem ? curItem.asin : '');
        // 10.5: the card opened last (within 10 min) is the item being picked
        var recentOpen = (lastOpenedPic.at && Date.now() - lastOpenedPic.at < 10 * 60 * 1000) ? lastOpenedPic : null;
        if (!asin && !recentOpen) return drop();
        var hdrTitle = '';
        if (hdr) { var ht = (hdr.el.textContent || '').split(']'); hdrTitle = ht.length > 1 ? ht.slice(1).join(']').trim() : ''; }
        var tTitle = (curItem && curItem.asin === asin && curItem.title) || hdrTitle || (recentOpen ? recentOpen.title : '');
        var sameAsOpened = recentOpen && recentOpen.url &&
            (!tTitle || normT(tTitle).slice(0, 25) === normT(recentOpen.title).slice(0, 25));
        var own = pageOwnItemImg();
        var url = (curItem && asin && curItem.asin === asin && curItem.imageUrl) || (own ? own.getAttribute('src') : '') ||
            titleImgFor(tTitle) || (asin ? imgFor(asin) : '') || (sameAsOpened ? recentOpen.url : '');
        if (url && tTitle) titleImgSet(tTitle, url);
        if (url && asin && !(imgCache[asin] && imgCache[asin].u)) imgSet(asin, url);
        // sticky for the same item
        var pkey = asin || ('opened:' + normT(tTitle));
        if (itemPicKey === pkey && itemPicUrl && !url) url = itemPicUrl;
        if (itemPicKey !== pkey) { itemPicKey = pkey; itemPicUrl = ''; }
        if (url) itemPicUrl = url;
        if (!box) {
            box = document.createElement('div');
            box.id = 'pops-item-pic';
            box.style.cssText = 'margin:6px auto 10px;max-width:1170px;box-sizing:border-box;padding:0 15px;text-align:center;';
            box.innerHTML = '<div style="display:inline-flex;align-items:center;justify-content:center;width:' + (PIC_H + 60) + 'px;height:' + (PIC_H + 60) + 'px;' +
                'background:#fff;border:2px solid #232f3e;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.2);">' +
                '<img class="pops-asin-img" referrerpolicy="no-referrer" alt="" style="max-width:' + (PIC_H + 40) + 'px;max-height:' + (PIC_H + 40) + 'px;object-fit:contain;">' +
                '<span class="pip-wait" style="font:14px Arial,sans-serif;color:#777;">loading picture\u2026</span></div>';
            var bim = box.querySelector('img');
            bim.addEventListener('error', function () {
                bim.style.display = 'none';
                var k = bim.dataset.asin;
                if (k) { imgSet(k, '', IMG_RETRY_MS); if (itemPicKey === k) itemPicUrl = ''; }
            });
        }
        // right under the four boxes (top of the page); fallback: top of the page
        var tools = document.getElementById('pops-barcode-tools');
        if (tools && tools.parentNode) { if (tools.nextSibling !== box) tools.parentNode.insertBefore(box, tools.nextSibling); }
        else if (box.parentNode !== document.body) document.body.insertBefore(box, document.body.firstChild);
        // while the big picture of the auto steps is up, this box waits (no second copy)
        var wantBox = autoPicShown() ? 'none' : '';
        if (box.style.display !== wantBox) box.style.display = wantBox;
        var img = box.querySelector('img'), wait = box.querySelector('.pip-wait');
        if (url) {
            if (img.getAttribute('src') !== url) { img.dataset.asin = asin; img.src = url; }
            img.style.display = 'block'; wait.style.display = 'none';
            img.title = asin;
            setPageImgHidden(true);
        } else {
            img.style.display = 'none'; wait.style.display = 'inline';
            setPageImgHidden(false);
        }
        // 10.6: an exact copy at the bottom of the page
        var bottoms = document.querySelectorAll('#pops-item-pic-bottom');
        for (var bd = 1; bd < bottoms.length; bd++) bottoms[bd].remove();
        var bottom = bottoms[0] || null;
        if (!bottom) {
            bottom = document.createElement('div');
            bottom.id = 'pops-item-pic-bottom';
            bottom.style.cssText = box.style.cssText;
            bottom.innerHTML = box.innerHTML;
        }
        if (bottom.parentNode !== document.body || bottom.nextSibling) document.body.appendChild(bottom);   // always the last thing on the page
        bottom.style.display = box.style.display;
        bottom.style.margin = '16px auto 20px';
        var bImg = bottom.querySelector('img'), bWait = bottom.querySelector('.pip-wait');
        if (bImg) {
            if (url) {
                if (bImg.getAttribute('src') !== url) bImg.src = url;
                bImg.style.display = 'block'; if (bWait) bWait.style.display = 'none';
                bImg.title = asin;
            } else { bImg.style.display = 'none'; if (bWait) bWait.style.display = 'inline'; }
        }
    }

    // SECTION 3: Shared scan loop
    // One observer + one interval driving all three scans. openedScan() runs
    // first each pass so the OPENED/NEW badge and row tinting are in place
    // before barcodeScan() and cptScan() add anything.
    // =========================================================================

    // Two-pass rendering: pass 1 runs synchronously and only does the work the
    // associate sees immediately (hide non-pickable cards, tint opened/new rows,
    // show/hide the scan bar, ask floor question). The browser gets a paint
    // frame after pass 1 so the list appears instantly. Pass 2 runs in a
    // setTimeout(0) and adds the heavier decoration (card strips with CPT/floor/
    // ASIN, barcodes on detail screens, item picture, Rodeo check).
    var heavyTimer = null;
    function runAllScans() {
        // --- PASS 1: fast, visible immediately ---
        withLeafCache(function () {
            openedScan();
            try { paintScanBar(); } catch (e) { console.log(CPT_LOG, 'scan bar error:', e); }
            try { askFloorOncePerShift(); } catch (e) { console.log(CPT_LOG, 'floor question error:', e); }
        });

        // --- PASS 2: heavier decoration, deferred one frame ---
        if (heavyTimer) return;   // already scheduled
        heavyTimer = setTimeout(function () {
            heavyTimer = null;
            observer.disconnect();
            try {
                withLeafCache(function () {
                    // 10.23: the list cards carry no barcodes, so the barcode walk over every element is
                    // skipped on the list (unless an old barcode is still there to clean up)
                    if (!document.querySelector('button.item') || document.querySelector('[data-pops-barcode-added]')) barcodeScan();
                    try { cptScan(); } catch (e) { console.log(CPT_LOG, 'paint error (CPT only):', e); }
                    try { paintLocStep(); } catch (e) { console.log(CPT_LOG, 'location box error:', e); }
                    try { paintItemPic(); } catch (e) { console.log(CPT_LOG, 'item picture error:', e); }
                    try { rodeoOnListShown(); } catch (e) {}
                });
            } catch (e) { console.log('[FP POPS] heavy scan error:', e); }
            if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        }, 0);
    }

    // The observer is disconnected while scanning so that our own DOM changes
    // (badges, barcodes) cannot retrigger it. JavaScript is single-threaded, so
    // nothing can land on the page during a scan; one scan per burst is enough.
    //
    // 7.1: the scan waits for the page to go QUIET. While the page is still
    // streaming its cards in (the "loading" phase) every change pushes the scan
    // back, up to a ceiling, so the page is not scanned over and over in the
    // middle of its own rendering - that was stealing time from the page's own
    // loading on the slower laptops. One scan runs once the burst ends (or at
    // the ceiling if it never ends), and the badges land in one go.
    var SCAN_QUIET_MS = 150, SCAN_MAX_WAIT_MS = 900;
    var scanDebounce = null, scanFirstChangeAt = 0;
    function scanAndSweep() {
        var now = Date.now();
        if (scanDebounce) {
            clearTimeout(scanDebounce);
            if (now - scanFirstChangeAt >= SCAN_MAX_WAIT_MS) { scanDebounce = null; scanNow(); return; }
        } else {
            scanFirstChangeAt = now;
        }
        scanDebounce = setTimeout(function () { scanDebounce = null; scanNow(); }, SCAN_QUIET_MS);
    }
    function scanNow() {
        observer.disconnect();
        try {
            injectManualBarcodePanel();
            var t0 = Date.now();
            runAllScans();   // pass 1 runs sync; pass 2 reconnects the observer itself after its own work
            var dt = Date.now() - t0;
            if (dt > 150) console.log('[FP POPS PERF] page scan (pass 1) took ' + dt + 'ms');
        } catch (e) { console.log('[FP POPS] scan error:', e); }
        // observer is reconnected by pass 2; reconnect here only if pass 2 was not scheduled
        if (!heavyTimer) observer.observe(document.body, { childList: true, subtree: true });
        // the page has drawn and gone quiet: now is the time for the first Rodeo fetch
        if (document.querySelector('button.item')) firstFetch();
    }

    var observer = new MutationObserver(scanAndSweep);

    // Badge repaints from background replies run with the observer paused, so
    // our own DOM changes never re-trigger a page scan.
    quietPaint = function (fn) {
        observer.disconnect();
        try { fn(); } finally { if (document.body) observer.observe(document.body, { childList: true, subtree: true }); }
    };

    // First full pass once the body exists (the script runs at document end,
    // so this is effectively straight away); the observer takes over from there.
    var waitForContent = setInterval(function () {
        if (!document.body) return;
        clearInterval(waitForContent);
        injectManualBarcodePanel();
        runAllScans();
        observer.observe(document.body, { childList: true, subtree: true });
    }, 300);

    // Heartbeat scan. The MutationObserver above only fires when the page
    // actually changes, which is not enough on its own: while an item is
    // missing from the list nothing is changing, so without this no scan
    // would run during its absence and its age would never be measured.
    // This also keeps lastSeen fresh for items that ARE still on the list,
    // so they are never pruned out from under you while sitting there.
    // Must stay comfortably shorter than GONE_GRACE_MS.
    setInterval(function () { quietPaint(runAllScans); }, 20 * 1000);   // our own repaint must not wake the observer

})();
