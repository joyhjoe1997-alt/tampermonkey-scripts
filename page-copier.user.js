// ==UserScript==
// @name         Page Copier - Learning Portal Text Extractor
// @author       joyhjoe
// @version      1.0
// @description  Auto-navigates all pages, extracts text from carousels and content, copies to clipboard
// @match        *://myquriosity-learnerportal.learningcloud.me/*
// @match        *://*.learningcloud.me/*
// @icon         https://cdn-icons-png.flaticon.com/512/1621/1621635.png
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    let isRunning = false;
    let allText = [];
    let currentPage = 0;
    let totalPages = 0;

    // --- Helpers ---
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Scroll down gradually to trigger lazy loading and reveal content
    async function autoScroll() {
        const scrollTarget = document.querySelector('.pageContent') || document.documentElement;
        const maxScroll = scrollTarget.scrollHeight;
        let current = 0;
        const step = 300;
        while (current < maxScroll) {
            current += step;
            scrollTarget.scrollTop = current;
            window.scrollTo(0, current);
            await sleep(150);
        }
        await sleep(500);
    }

    // Get page progress (e.g. "2/14" -> {current: 2, total: 14})
    function getPageProgress() {
        const allText = document.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container span');
        for (const el of allText) {
            const match = el.textContent.trim().match(/^(\d+)\/(\d+)\s*$/);
            if (match) return { current: parseInt(match[1]), total: parseInt(match[2]) };
        }
        // Fallback: search all text nodes
        const body = document.body.innerText;
        const m = body.match(/(\d+)\/(\d+)/);
        if (m && parseInt(m[2]) > 1 && parseInt(m[1]) <= parseInt(m[2])) {
            return { current: parseInt(m[1]), total: parseInt(m[2]) };
        }
        return null;
    }

    // Click all carousel dots to reveal hidden slides, extract from each
    async function extractCarouselContent() {
        let carouselText = [];
        const carousels = document.querySelectorAll('[data-ntx-type="Composite"]');

        for (const carousel of carousels) {
            const dots = carousel.querySelectorAll('button[role="tab"]');
            if (dots.length <= 1) continue;

            for (const dot of dots) {
                dot.click();
                await sleep(600); // Wait for slide transition

                // Extract from the visible panel
                const visiblePanel = carousel.querySelector('[role="tabpanel"]:not([hidden])');
                if (visiblePanel) {
                    const texts = visiblePanel.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container li');
                    for (const t of texts) {
                        const content = t.textContent.trim();
                        if (content && !carouselText.includes(content)) carouselText.push(content);
                    }
                }
            }
        }
        return carouselText;
    }

    // Extract all text content from current page view
    function extractPageText() {
        const texts = [];
        const elements = document.querySelectorAll('.ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container p, .ntx-ck-editor-container li, .ntx-ck-editor-container span');
        const seen = new Set();

        for (const el of elements) {
            // Skip if parent already captured (avoid duplicates from nested elements)
            if (el.closest('[role="tabpanel"][hidden]')) continue;

            let content = el.textContent.trim();
            if (!content || content.length < 2) continue;
            // Skip page counters and navigation text
            if (/^\d+\/\d+$/.test(content)) continue;
            if (content === 'Go to content' || content === 'You have reached the end of the page.') continue;

            // Format headings
            const tag = el.tagName.toLowerCase();
            if (tag === 'h1') content = `\n# ${content}\n`;
            else if (tag === 'h2') content = `\n## ${content}\n`;
            else if (tag === 'h3') content = `\n### ${content}\n`;
            else if (tag === 'li') content = `  - ${content}`;

            if (!seen.has(content.trim())) {
                seen.add(content.trim());
                texts.push(content);
            }
        }

        // Extract image alt text
        const images = document.querySelectorAll('figure img[alt]');
        for (const img of images) {
            const alt = img.getAttribute('alt')?.trim();
            if (alt && alt.length > 2) {
                const desc = `[Image: ${alt}]`;
                if (!seen.has(desc)) { seen.add(desc); texts.push(desc); }
            }
        }

        return texts;
    }

    // Click "Next page" button
    function clickNextPage() {
        const btn = document.querySelector('button[title="Next page"]');
        if (btn && !btn.disabled) { btn.click(); return true; }
        // Fallback: look for right arrow button with angle-right icon
        const arrows = document.querySelectorAll('button[aria-label="Next page"]');
        for (const a of arrows) { if (!a.disabled) { a.click(); return true; } }
        return false;
    }

    // Wait for page content to change
    async function waitForPageChange(prevText) {
        let attempts = 0;
        while (attempts < 20) {
            await sleep(500);
            const newProgress = getPageProgress();
            if (newProgress && newProgress.current !== prevText) return true;
            // Also check if content changed
            const h1 = document.querySelector('.ntx-ck-editor-container h1');
            if (h1 && !prevText.toString().includes(h1.textContent.trim())) return true;
            attempts++;
        }
        return false;
    }

    // --- Main extraction flow ---
    async function extractAllPages() {
        if (isRunning) return;
        isRunning = true;
        allText = [];

        setStatus('Starting...', '#3498db');

        // Get total pages
        const progress = getPageProgress();
        if (progress) {
            totalPages = progress.total;
            currentPage = progress.current;
            setStatus(`Page ${currentPage}/${totalPages}`, '#3498db');
        } else {
            totalPages = 1;
            currentPage = 1;
        }

        // If not on page 1, just extract current page forward
        let pageNum = currentPage;

        while (true) {
            setStatus(`Scraping page ${pageNum}${totalPages ? '/' + totalPages : ''}...`, '#8e44ad');

            // Scroll to load lazy content
            await autoScroll();
            await sleep(300);

            // Extract main page text
            const pageText = extractPageText();

            // Extract carousel/slide content
            const carouselContent = await extractCarouselContent();

            // Combine
            const combined = [...pageText];
            for (const ct of carouselContent) {
                if (!combined.some(t => t.includes(ct))) combined.push(ct);
            }

            if (combined.length > 0) {
                allText.push(`\n--- Page ${pageNum} ---\n`);
                allText.push(...combined);
            }

            // Check if we're on the last page
            const prog = getPageProgress();
            if (prog && prog.current >= prog.total) break;
            if (!prog && pageNum > 1) break; // No progress indicator, already navigated

            // Try to go to next page
            const prevPage = prog ? prog.current : pageNum;
            if (!clickNextPage()) break;

            // Wait for page to load
            const changed = await waitForPageChange(prevPage);
            if (!changed) break;

            pageNum++;
            await sleep(500);
        }

        // Done - format and copy
        const finalText = allText.join('\n').replace(/\n{3,}/g, '\n\n').trim();

        if (finalText) {
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(finalText, 'text');
            } else {
                await navigator.clipboard.writeText(finalText);
            }
            setStatus(`Copied! ${totalPages} pages, ${finalText.length} chars`, '#27ae60');
            showPreview(finalText);
        } else {
            setStatus('No text found', '#e74c3c');
        }

        isRunning = false;
    }

    // Extract current page only
    async function extractCurrentPage() {
        if (isRunning) return;
        isRunning = true;

        setStatus('Extracting...', '#3498db');
        await autoScroll();
        await sleep(300);

        const pageText = extractPageText();
        const carouselContent = await extractCarouselContent();
        const combined = [...pageText, ...carouselContent.filter(ct => !pageText.some(t => t.includes(ct)))];
        const finalText = combined.join('\n').replace(/\n{3,}/g, '\n\n').trim();

        if (finalText) {
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(finalText, 'text');
            } else {
                await navigator.clipboard.writeText(finalText);
            }
            setStatus(`Copied! ${finalText.length} chars`, '#27ae60');
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
        const preview = document.getElementById('pc-preview');
        if (preview) {
            preview.textContent = text.substring(0, 2000) + (text.length > 2000 ? '\n\n... [truncated in preview, full text in clipboard]' : '');
            preview.style.display = 'block';
        }
    }

    // Build floating panel
    const panel = document.createElement('div');
    panel.id = 'pc-panel';
    panel.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;width:300px;background:#fff;border:2px solid #8e44ad;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.2);font:13px Segoe UI,sans-serif;overflow:hidden';
    panel.innerHTML = `
        <div id="pc-hdr" style="background:linear-gradient(135deg,#8e44ad,#9b59b6);color:#fff;padding:8px 12px;font:700 13px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
            <span>\uD83D\uDCCB Page Copier</span><span id="pc-col" style="margin-left:auto;cursor:pointer;font-size:15px">\u2212</span>
        </div>
        <div id="pc-body" style="padding:10px">
            <div style="display:flex;gap:6px;margin-bottom:8px">
                <button id="pc-all" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#8e44ad;color:#fff">\uD83D\uDCDA Copy All Pages</button>
                <button id="pc-page" style="flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#3498db;color:#fff">\uD83D\uDCC4 This Page</button>
            </div>
            <button id="pc-stop" style="width:100%;padding:6px;border:none;border-radius:6px;cursor:pointer;font:600 10px Segoe UI;background:#e74c3c;color:#fff;display:none">\u25A0 Stop</button>
            <div id="pc-status" style="margin-top:6px;padding:4px;border-radius:4px;font:600 10px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
            <textarea id="pc-preview" style="display:none;width:100%;height:150px;margin-top:8px;padding:6px;box-sizing:border-box;border:1px solid #ddd;border-radius:6px;font:10px monospace;resize:vertical;color:#333" readonly></textarea>
        </div>`;
    document.body.appendChild(panel);

    // Draggable
    let dx, dy, dragging = false;
    document.getElementById('pc-hdr').onmousedown = e => {
        e.preventDefault(); dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; dragging = true;
    };
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
