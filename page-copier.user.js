// ==UserScript==
// @name         Page Copier - Learning Portal Text Extractor
// @author       joyhjoe
// @version      1.1
// @description  Auto-navigates pages, clicks interactive elements, extracts all text to clipboard
// @match        *://myquriosity-learnerportal.learningcloud.me/*
// @match        *://*.learningcloud.me/*
// @match        *://cdncms.learningcloud.me/*
// @icon         https://cdn-icons-png.flaticon.com/512/1621/1621635.png
// @run-at       document-idle
// @grant        GM_setClipboard
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // Only run in top frame (prevents duplicate panels in iframes)
    if (window.self !== window.top) return;

    let isRunning = false;
    let allText = [];

    // --- Helpers ---
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Get the iframe document where course content lives
    function getContentDoc() {
        const iframe = document.querySelector('iframe[src*="learningcloud.me"]');
        if (iframe) {
            try { return iframe.contentDocument || iframe.contentWindow.document; } catch (e) { /* cross-origin */ }
        }
        return document;
    }

    // Scroll inside content to trigger lazy loading
    async function autoScroll(doc) {
        const scrollTarget = doc.querySelector('.pageContent') || doc.documentElement;
        if (!scrollTarget) return;
        const maxScroll = scrollTarget.scrollHeight;
        let current = 0;
        const step = 400;
        while (current < maxScroll) {
            current += step;
            scrollTarget.scrollTop = current;
            await sleep(100);
        }
        const iframeEl = document.querySelector('iframe[src*="learningcloud.me"]');
        if (iframeEl) { try { iframeEl.contentWindow?.scrollTo(0, current); } catch(e) {} }
        await sleep(400);
    }

    // Get page progress from content doc (e.g. "2/14")
    function getPageProgress(doc) {
        const els = doc.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container span');
        for (const el of els) {
            const match = el.textContent.trim().match(/^(\d+)\/(\d+)\s*$/);
            if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
        }
        return null;
    }

    // Click all carousel dots and extract content from each slide
    async function extractCarousels(doc) {
        let texts = [];
        const carousels = doc.querySelectorAll('[data-ntx-type="Composite"]');
        for (const carousel of carousels) {
            const dots = carousel.querySelectorAll('button[role="tab"]');
            if (dots.length <= 1) continue;
            for (const dot of dots) {
                dot.click();
                await sleep(500);
                const panel = carousel.querySelector('[role="tabpanel"]:not([hidden])');
                if (panel) {
                    const els = panel.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container h4, .ntx-ck-editor-container li');
                    for (const e of els) {
                        const t = e.textContent.trim();
                        if (t && t.length > 1 && !texts.includes(t)) texts.push(t);
                    }
                }
            }
        }
        return texts;
    }

    // Click all Launcher buttons (interactive elements) and extract popup content
    async function extractLaunchers(doc) {
        let texts = [];
        const launchers = doc.querySelectorAll('[data-ntx-type="Launcher"][role="button"]');
        for (const launcher of launchers) {
            const label = launcher.querySelector('.ntx-ck-editor-container')?.textContent.trim();
            launcher.click();
            await sleep(700);
            // Find the close button which indicates a popup opened
            const closeBtn = doc.querySelector('button[title="Close pop-up"]');
            if (closeBtn) {
                if (label) texts.push(`\n**${label}:**`);
                // Extract text from the popup area (parent sections near close button)
                const popupSection = closeBtn.closest('[data-ntx-type="Section"]')?.parentElement;
                if (popupSection) {
                    const pEls = popupSection.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h4, .ntx-ck-editor-container li');
                    for (const pe of pEls) {
                        const pt = pe.textContent.trim();
                        if (pt && pt.length > 2 && pt !== label && !texts.includes(pt)) texts.push(pt);
                    }
                }
                closeBtn.click();
                await sleep(400);
            }
        }
        return texts;
    }

    // Extract all visible text from current page
    function extractVisibleText(doc) {
        const texts = [];
        const seen = new Set();
        const elements = doc.querySelectorAll('.ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container h4, .ntx-ck-editor-container p, .ntx-ck-editor-container li');
        for (const el of elements) {
            if (el.closest('[role="tabpanel"][hidden]')) continue;
            let content = el.textContent.trim();
            if (!content || content.length < 2) continue;
            if (/^\d+\/\d+$/.test(content)) continue;
            if (content === 'Go to content' || content.includes('reached the end of the page')) continue;
            if (content === 'Select the arrows to navigate through the content.') continue;
            const tag = el.tagName.toLowerCase();
            if (tag === 'h1') content = `\n# ${content}\n`;
            else if (tag === 'h2') content = `\n## ${content}\n`;
            else if (tag === 'h3') content = `\n### ${content}\n`;
            else if (tag === 'h4') content = `\n#### ${content}\n`;
            else if (tag === 'li') content = `  - ${content}`;
            if (!seen.has(content.trim())) { seen.add(content.trim()); texts.push(content); }
        }
        // Image alt text
        const images = doc.querySelectorAll('figure img[alt]');
        for (const img of images) {
            const alt = img.getAttribute('alt')?.trim();
            if (alt && alt.length > 2 && !seen.has(alt)) { seen.add(alt); texts.push(`[Image: ${alt}]`); }
        }
        return texts;
    }

    // Click "Next page" in content doc
    function clickNextPage(doc) {
        const btn = doc.querySelector('button[title="Next page"]') || doc.querySelector('button[aria-label="Next page"]');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
    }

    // --- Main: Extract ALL pages ---
    async function extractAllPages() {
        if (isRunning) return;
        isRunning = true;
        allText = [];
        setStatus('Starting...', '#3498db');

        const doc = getContentDoc();
        const progress = getPageProgress(doc);
        const total = progress ? progress.total : '?';
        let pageNum = progress ? progress.current : 1;

        while (isRunning) {
            setStatus(`Page ${pageNum}/${total} - scrolling...`, '#8e44ad');
            await autoScroll(doc);
            await sleep(300);

            setStatus(`Page ${pageNum}/${total} - extracting...`, '#8e44ad');
            const pageText = extractVisibleText(doc);

            setStatus(`Page ${pageNum}/${total} - carousels...`, '#8e44ad');
            const carouselText = await extractCarousels(doc);

            setStatus(`Page ${pageNum}/${total} - interactive items...`, '#8e44ad');
            const launcherText = await extractLaunchers(doc);

            // Combine all unique text
            const combined = [`\n=== Page ${pageNum} ===\n`];
            const seen = new Set();
            for (const arr of [pageText, carouselText, launcherText]) {
                for (const t of arr) { if (!seen.has(t.trim())) { seen.add(t.trim()); combined.push(t); } }
            }
            allText.push(...combined);

            // Check if last page
            const prog = getPageProgress(doc);
            if (prog && prog.current >= prog.total) break;

            // Navigate to next page
            setStatus(`Page ${pageNum}/${total} - next...`, '#3498db');
            if (!clickNextPage(doc)) break;

            // Wait for page change
            let waited = 0;
            const prevPage = prog ? prog.current : pageNum;
            while (waited < 15) {
                await sleep(500);
                const np = getPageProgress(doc);
                if (np && np.current !== prevPage) break;
                waited++;
            }
            pageNum++;
            await sleep(500);
        }

        finishExtraction();
    }

    // --- Main: Extract current page only ---
    async function extractCurrentPage() {
        if (isRunning) return;
        isRunning = true;
        allText = [];
        setStatus('Extracting...', '#3498db');

        const doc = getContentDoc();
        await autoScroll(doc);

        const pageText = extractVisibleText(doc);
        const carouselText = await extractCarousels(doc);
        const launcherText = await extractLaunchers(doc);

        const seen = new Set();
        for (const arr of [pageText, carouselText, launcherText]) {
            for (const t of arr) { if (!seen.has(t.trim())) { seen.add(t.trim()); allText.push(t); } }
        }

        finishExtraction();
    }

    function finishExtraction() {
        const finalText = allText.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (finalText) {
            if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(finalText, 'text'); }
            else { navigator.clipboard.writeText(finalText); }
            setStatus(`\u2713 Copied! ${finalText.length} chars`, '#27ae60');
            showPreview(finalText);
        } else {
            setStatus('No text found', '#e74c3c');
        }
        isRunning = false;
    }

    // --- UI ---
    function setStatus(msg, color) {
        const el = document.getElementById('pc-status');
        if (el) { el.textContent = msg; el.style.color = color; }
    }

    function showPreview(text) {
        const p = document.getElementById('pc-preview');
        if (p) { p.textContent = text.substring(0, 3000) + (text.length > 3000 ? '\n\n... [full text in clipboard]' : ''); p.style.display = 'block'; }
    }

    // Build panel
    const panel = document.createElement('div');
    panel.id = 'pc-panel';
    panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:300px;background:#fff;border:2px solid #8e44ad;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.2);font:13px Segoe UI,sans-serif;overflow:hidden';
    panel.innerHTML = `
        <div id="pc-hdr" style="background:linear-gradient(135deg,#8e44ad,#9b59b6);color:#fff;padding:8px 12px;font:700 13px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
            <span>\uD83D\uDCCB Page Copier v1.1</span><span id="pc-col" style="margin-left:auto;cursor:pointer;font-size:15px">\u2212</span>
        </div>
        <div id="pc-body" style="padding:10px">
            <div style="display:flex;gap:6px;margin-bottom:8px">
                <button id="pc-all" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#8e44ad;color:#fff">\uD83D\uDCDA All Pages</button>
                <button id="pc-page" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#3498db;color:#fff">\uD83D\uDCC4 This Page</button>
            </div>
            <button id="pc-stop" style="width:100%;padding:6px;border:none;border-radius:6px;cursor:pointer;font:600 10px Segoe UI;background:#e74c3c;color:#fff;margin-bottom:6px">\u25A0 Stop</button>
            <div id="pc-status" style="padding:4px;border-radius:4px;font:600 10px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
            <textarea id="pc-preview" style="display:none;width:100%;height:180px;margin-top:8px;padding:6px;box-sizing:border-box;border:1px solid #ddd;border-radius:6px;font:10px monospace;resize:vertical;color:#333" readonly></textarea>
        </div>`;
    document.body.appendChild(panel);

    // Draggable
    let dx, dy, dragging = false;
    document.getElementById('pc-hdr').onmousedown = e => { e.preventDefault(); dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; dragging = true; };
    document.addEventListener('mousemove', e => { if (dragging) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; } });
    document.addEventListener('mouseup', () => { dragging = false; });

    // Collapse
    document.getElementById('pc-col').onclick = () => {
        const b = document.getElementById('pc-body');
        b.style.display = b.style.display === 'none' ? '' : 'none';
        document.getElementById('pc-col').textContent = b.style.display === 'none' ? '+' : '\u2212';
    };

    // Buttons
    document.getElementById('pc-all').onclick = extractAllPages;
    document.getElementById('pc-page').onclick = extractCurrentPage;
    document.getElementById('pc-stop').onclick = () => { isRunning = false; setStatus('Stopped', '#e74c3c'); };
})();
