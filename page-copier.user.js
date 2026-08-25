// ==UserScript==
// @name         Page Copier - Learning Portal Text Extractor
// @author       joyhjoe
// @version      1.3
// @description  Auto-navigates pages, clicks interactive elements, extracts all text to clipboard
// @match        *://myquriosity-learnerportal.learningcloud.me/*
// @match        *://*.learningcloud.me/*
// @match        *://cdncms.learningcloud.me/*
// @match        *://*/*
// @icon         https://cdn-icons-png.flaticon.com/512/1621/1621635.png
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    // Wait for content to be ready, then decide if we should run
    // We run ONLY where actual course content exists (inside the content iframe)
    // Detection: look for ntx-author root or pageContent class
    let initAttempts = 0;
    const maxAttempts = 20;

    function tryInit() {
        initAttempts++;
        const hasContent = document.querySelector('.ntx-ck-editor-container') ||
                          document.querySelector('[data-ntx-type="PageContent"]') ||
                          document.querySelector('#root.ntx-author') ||
                          document.querySelector('.pageContent');

        if (hasContent) {
            // Don't create duplicate panels
            if (document.getElementById('pc-panel')) return;
            initScript();
        } else if (initAttempts < maxAttempts) {
            setTimeout(tryInit, 1000);
        }
    }

    // Start checking after a short delay
    setTimeout(tryInit, 1500);

    function initScript() {
        let isRunning = false;
        let allText = [];

        // --- Helpers ---
        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        // Scroll the page to load lazy content
        async function autoScroll() {
            const root = document.querySelector('.pageContent') ||
                        document.querySelector('#root.ntx-author') ||
                        document.documentElement;
            const maxScroll = Math.max(root.scrollHeight, document.body.scrollHeight, document.documentElement.scrollHeight);
            let current = 0;
            const step = 300;

            while (current < maxScroll) {
                current += step;
                window.scrollTo(0, current);
                root.scrollTop = current;
                document.documentElement.scrollTop = current;
                await sleep(120);
            }
            await sleep(500);
            // Scroll back to top
            window.scrollTo(0, 0);
        }

        // Get page progress (e.g. "2/14")
        function getPageProgress() {
            const allEls = document.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container span');
            for (const el of allEls) {
                const text = el.textContent.trim();
                const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
                if (match && parseInt(match[2]) > 1) {
                    return { current: parseInt(match[1]), total: parseInt(match[2]) };
                }
            }
            return null;
        }

        // Click all carousel/composite slides - goes both directions to catch everything
        async function extractCarousels() {
            let texts = [];
            const carousels = document.querySelectorAll('[data-ntx-type="Composite"]');

            for (const carousel of carousels) {
                // Strategy: First go all the way LEFT (to first slide), then go all the way RIGHT
                // This ensures we don't miss slides regardless of starting position

                const prevBtn = carousel.querySelector('button[aria-label*="Previous"], button[aria-label*="previous"], button[title*="anterior"]')?.closest?.('button') ||
                               carousel.querySelector('.composite-arrow-0 button') ||
                               carousel.querySelector('button .fa-angle-left')?.closest('button');

                const nextBtn = carousel.querySelector('button[aria-label*="Next"], button[aria-label*="next"], button[title*="siguiente"]')?.closest?.('button') ||
                               carousel.querySelector('.composite-arrow-1 button') ||
                               carousel.querySelector('button .fa-angle-right')?.closest('button');

                // Step 1: Go all the way to the first slide (click prev until stuck)
                if (prevBtn) {
                    let safety = 0;
                    while (safety < 20) {
                        if (prevBtn.disabled || prevBtn.getAttribute('aria-disabled') === 'true') break;
                        const before = carousel.querySelector('[role="tabpanel"]:not([hidden])')?.id || '';
                        prevBtn.click();
                        await sleep(400);
                        const after = carousel.querySelector('[role="tabpanel"]:not([hidden])')?.id || '';
                        if (before === after) break; // Didn't change - we're at the start
                        safety++;
                    }
                    await sleep(300);
                }

                // Step 2: Also click first dot if dots exist
                const dots = carousel.querySelectorAll('button[role="tab"]');
                if (dots.length > 1) {
                    dots[0].click();
                    await sleep(400);
                }

                // Step 3: Now extract current slide and go RIGHT through all slides
                let visitedIds = new Set();
                let safety = 0;
                while (safety < 30) {
                    // Extract from current visible panel
                    const visiblePanel = carousel.querySelector('[role="tabpanel"]:not([hidden])');
                    if (visiblePanel) {
                        const panelId = visiblePanel.id || safety.toString();
                        if (visitedIds.has(panelId)) break; // Already seen this slide
                        visitedIds.add(panelId);

                        const els = visiblePanel.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container h4, .ntx-ck-editor-container li');
                        for (const e of els) {
                            const t = e.textContent.trim();
                            if (t && t.length > 1 && !texts.includes(t)) texts.push(t);
                        }

                        // Check for launchers/tiles INSIDE this carousel slide
                        const slideLaunchers = visiblePanel.querySelectorAll('[data-ntx-type="Launcher"][role="button"]');
                        for (const sl of slideLaunchers) {
                            const slLabel = sl.querySelector('.ntx-ck-editor-container')?.textContent.trim() || '';
                            sl.click();
                            await sleep(700);
                            const closeBtn = document.querySelector('button[title="Close pop-up"]');
                            if (closeBtn) {
                                if (slLabel) texts.push(`\n**${slLabel}:**`);
                                const popupArea = closeBtn.closest('[data-ntx-type="Row"]')?.parentElement ||
                                                 closeBtn.closest('[data-ntx-type="Section"]')?.parentElement;
                                if (popupArea) {
                                    const popEls = popupArea.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h4, .ntx-ck-editor-container li');
                                    for (const pe of popEls) {
                                        const pt = pe.textContent.trim();
                                        if (pt && pt.length > 2 && pt !== slLabel && !texts.includes(pt)) texts.push(pt);
                                    }
                                }
                                closeBtn.click();
                                await sleep(400);
                            }
                        }
                    }

                    // Try to go to next slide
                    if (dots.length > 1) {
                        // Use dots - click next unvisited dot
                        const currentIdx = Array.from(dots).findIndex(d => d.getAttribute('aria-selected') === 'true' || d.getAttribute('data-selected') === 'true');
                        if (currentIdx < dots.length - 1) {
                            dots[currentIdx + 1].click();
                            await sleep(500);
                        } else {
                            break; // Last dot reached
                        }
                    } else if (nextBtn) {
                        // Use arrow button
                        if (nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true') break;
                        const beforeId = carousel.querySelector('[role="tabpanel"]:not([hidden])')?.id || '';
                        nextBtn.click();
                        await sleep(500);
                        const afterId = carousel.querySelector('[role="tabpanel"]:not([hidden])')?.id || '';
                        if (beforeId === afterId) break; // Didn't change
                    } else {
                        break; // No navigation available
                    }
                    safety++;
                }
            }
            return texts;
        }

        // Click all Launcher/interactive buttons and extract popup content
        async function extractLaunchers() {
            let texts = [];
            const launchers = document.querySelectorAll('[data-ntx-type="Launcher"][role="button"]');
            if (launchers.length === 0) return texts;

            for (const launcher of launchers) {
                // Get the label text of this launcher
                const labelEl = launcher.querySelector('.ntx-ck-editor-container');
                const label = labelEl ? labelEl.textContent.trim() : '';

                // Click to open popup
                launcher.click();
                await sleep(800);

                // Look for the close popup button (indicates popup is open)
                const closeBtn = document.querySelector('button[title="Close pop-up"]');
                if (closeBtn) {
                    if (label) texts.push(`\n**${label}:**`);

                    // Extract all text visible after popup opens
                    // The popup content is typically in sections near the close button
                    const popupParent = closeBtn.closest('[data-ntx-type="Row"]')?.parentElement ||
                                       closeBtn.closest('[data-ntx-type="Section"]')?.parentElement ||
                                       closeBtn.parentElement?.parentElement?.parentElement;

                    if (popupParent) {
                        const popupEls = popupParent.querySelectorAll('.ntx-ck-editor-container p, .ntx-ck-editor-container h4, .ntx-ck-editor-container h3, .ntx-ck-editor-container li');
                        for (const pe of popupEls) {
                            const pt = pe.textContent.trim();
                            // Skip the label itself and short/empty text
                            if (pt && pt.length > 2 && pt !== label && !texts.includes(pt)) {
                                texts.push(pt);
                            }
                        }
                    }

                    // Also try: get all ntx-ck-editor text that appeared after click
                    // by looking for content in the launcher's selected state area
                    const selectedContent = document.querySelectorAll('[data-ntx-type="Launcher"][data-selected="true"] ~ [data-ntx-type="Section"] .ntx-ck-editor-container p');
                    for (const sc of selectedContent) {
                        const sct = sc.textContent.trim();
                        if (sct && sct.length > 2 && sct !== label && !texts.includes(sct)) {
                            texts.push(sct);
                        }
                    }

                    // Close the popup
                    closeBtn.click();
                    await sleep(400);
                } else {
                    // Maybe the launcher shows content inline (selected state)
                    await sleep(300);
                    const inlineContent = launcher.parentElement?.querySelectorAll('.ntx-ck-editor-container p');
                    if (inlineContent) {
                        if (label) texts.push(`\n**${label}:**`);
                        for (const ic of inlineContent) {
                            const ict = ic.textContent.trim();
                            if (ict && ict.length > 2 && ict !== label && !texts.includes(ict)) texts.push(ict);
                        }
                    }
                }
            }
            return texts;
        }

        // Extract all visible text from current page
        function extractVisibleText() {
            const texts = [];
            const seen = new Set();
            const elements = document.querySelectorAll('.ntx-ck-editor-container h1, .ntx-ck-editor-container h2, .ntx-ck-editor-container h3, .ntx-ck-editor-container h4, .ntx-ck-editor-container p, .ntx-ck-editor-container li');

            for (const el of elements) {
                // Skip hidden carousel panels
                if (el.closest('[role="tabpanel"][hidden]')) continue;
                // Skip hidden elements
                if (el.offsetParent === null && !el.closest('[data-ntx-type="Launcher"]')) continue;

                let content = el.textContent.trim();
                if (!content || content.length < 2) continue;
                // Skip UI text
                if (/^\d+\s*\/\s*\d+$/.test(content)) continue;
                if (content === 'Go to content') continue;
                if (content.includes('reached the end of the page')) continue;
                if (content === 'Select the arrows to navigate through the content.') continue;

                // Format by tag
                const tag = el.tagName.toLowerCase();
                if (tag === 'h1') content = `\n# ${content}\n`;
                else if (tag === 'h2') content = `\n## ${content}\n`;
                else if (tag === 'h3') content = `\n### ${content}\n`;
                else if (tag === 'h4') content = `\n#### ${content}\n`;
                else if (tag === 'li') content = `  - ${content}`;

                if (!seen.has(content.trim())) {
                    seen.add(content.trim());
                    texts.push(content);
                }
            }

            // Image alt text
            const images = document.querySelectorAll('figure img[alt]');
            for (const img of images) {
                const alt = img.getAttribute('alt')?.trim();
                if (alt && alt.length > 2 && !seen.has(alt)) {
                    seen.add(alt);
                    texts.push(`[Image: ${alt}]`);
                }
            }
            return texts;
        }

        // Click "Next page" button
        function clickNextPage() {
            // Try multiple selectors for the next button
            const selectors = [
                'button[title="Next page"]',
                'button[aria-label="Next page"]',
                '[data-ntx-type="Button"][title="Next page"]',
                'button .fa-angle-right'
            ];
            for (const sel of selectors) {
                const btn = document.querySelector(sel);
                if (btn) {
                    const target = btn.closest('button') || btn;
                    if (!target.disabled) { target.click(); return true; }
                }
            }
            // Fallback: find button containing angle-right SVG that's for page nav (not carousel)
            const allBtns = document.querySelectorAll('button[aria-label]');
            for (const b of allBtns) {
                if (b.getAttribute('aria-label')?.toLowerCase().includes('next page')) {
                    b.click(); return true;
                }
            }
            return false;
        }

        // --- Main: Extract ALL pages ---
        async function extractAllPages() {
            if (isRunning) return;
            isRunning = true;
            allText = [];
            setStatus('Starting...', '#3498db');

            const progress = getPageProgress();
            const total = progress ? progress.total : '?';
            let pageNum = progress ? progress.current : 1;

            while (isRunning) {
                setStatus(`Page ${pageNum}/${total} - scrolling...`, '#8e44ad');
                await autoScroll();
                await sleep(400);

                setStatus(`Page ${pageNum}/${total} - text...`, '#8e44ad');
                const pageText = extractVisibleText();

                setStatus(`Page ${pageNum}/${total} - slides...`, '#8e44ad');
                const carouselText = await extractCarousels();

                setStatus(`Page ${pageNum}/${total} - popups...`, '#8e44ad');
                const launcherText = await extractLaunchers();

                // Combine all unique text for this page
                const combined = [`\n=== Page ${pageNum} ===\n`];
                const seen = new Set();
                for (const arr of [pageText, carouselText, launcherText]) {
                    for (const t of arr) {
                        if (!seen.has(t.trim())) { seen.add(t.trim()); combined.push(t); }
                    }
                }
                allText.push(...combined);

                // Check if we reached the last page
                const prog = getPageProgress();
                if (prog && prog.current >= prog.total) break;

                // Try next page
                setStatus(`Page ${pageNum}/${total} - next...`, '#3498db');
                const prevPage = prog ? prog.current : pageNum;
                if (!clickNextPage()) {
                    setStatus(`Page ${pageNum} - no next button found`, '#e67e22');
                    break;
                }

                // Wait for page to change (content reload)
                let changed = false;
                for (let i = 0; i < 20; i++) {
                    await sleep(500);
                    const np = getPageProgress();
                    if (np && np.current !== prevPage) { changed = true; break; }
                    // Also check if h1 changed
                    const h1 = document.querySelector('.ntx-ck-editor-container h1');
                    if (h1 && i > 5) { changed = true; break; }
                }
                if (!changed) { setStatus(`Page ${pageNum} - stuck, stopping`, '#e67e22'); break; }

                pageNum++;
                await sleep(600);
            }

            finishExtraction();
        }

        // --- Main: Extract current page only ---
        async function extractCurrentPage() {
            if (isRunning) return;
            isRunning = true;
            allText = [];
            setStatus('Scrolling...', '#3498db');

            await autoScroll();
            await sleep(300);

            setStatus('Extracting text...', '#8e44ad');
            const pageText = extractVisibleText();

            setStatus('Checking slides...', '#8e44ad');
            const carouselText = await extractCarousels();

            setStatus('Checking popups...', '#8e44ad');
            const launcherText = await extractLaunchers();

            const seen = new Set();
            for (const arr of [pageText, carouselText, launcherText]) {
                for (const t of arr) {
                    if (!seen.has(t.trim())) { seen.add(t.trim()); allText.push(t); }
                }
            }

            finishExtraction();
        }

        function finishExtraction() {
            const finalText = allText.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            if (finalText) {
                try {
                    if (typeof GM_setClipboard !== 'undefined') {
                        GM_setClipboard(finalText, 'text');
                    } else {
                        navigator.clipboard.writeText(finalText);
                    }
                    setStatus(`\u2713 Copied! ${finalText.length} chars`, '#27ae60');
                } catch (e) {
                    setStatus('Extracted - check preview (clipboard failed)', '#e67e22');
                }
                showPreview(finalText);
            } else {
                setStatus('No text found on this page', '#e74c3c');
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
            if (p) {
                p.textContent = text.substring(0, 5000) + (text.length > 5000 ? '\n\n... [full text in clipboard]' : '');
                p.style.display = 'block';
            }
        }

        // Build panel
        const panel = document.createElement('div');
        panel.id = 'pc-panel';
        panel.style.cssText = 'position:fixed;top:60px;right:10px;z-index:2147483647;width:280px;background:#fff;border:2px solid #8e44ad;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.25);font:13px Segoe UI,sans-serif;overflow:hidden';
        panel.innerHTML = `
            <div id="pc-hdr" style="background:linear-gradient(135deg,#8e44ad,#9b59b6);color:#fff;padding:8px 10px;font:700 12px Segoe UI;cursor:move;user-select:none;display:flex;align-items:center">
                <span>\uD83D\uDCCB Page Copier v1.3</span><span id="pc-col" style="margin-left:auto;cursor:pointer;font-size:15px">\u2212</span>
            </div>
            <div id="pc-body" style="padding:8px">
                <div style="display:flex;gap:5px;margin-bottom:6px">
                    <button id="pc-all" style="flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#8e44ad;color:#fff">\uD83D\uDCDA All Pages</button>
                    <button id="pc-page" style="flex:1;padding:7px;border:none;border-radius:6px;cursor:pointer;font:700 11px Segoe UI;background:#3498db;color:#fff">\uD83D\uDCC4 This Page</button>
                </div>
                <button id="pc-stop" style="width:100%;padding:5px;border:none;border-radius:6px;cursor:pointer;font:600 10px Segoe UI;background:#e74c3c;color:#fff;margin-bottom:5px">\u25A0 Stop</button>
                <div id="pc-status" style="padding:4px;border-radius:4px;font:600 10px Segoe UI;text-align:center;background:#f8f9fa;color:#7f8c8d">Ready</div>
                <textarea id="pc-preview" style="display:none;width:100%;height:200px;margin-top:6px;padding:5px;box-sizing:border-box;border:1px solid #ddd;border-radius:6px;font:9px monospace;resize:vertical;color:#333" readonly></textarea>
            </div>`;
        document.body.appendChild(panel);

        // Draggable
        let dx, dy, dragging = false;
        document.getElementById('pc-hdr').onmousedown = e => {
            e.preventDefault();
            dx = e.clientX - panel.offsetLeft;
            dy = e.clientY - panel.offsetTop;
            dragging = true;
        };
        document.addEventListener('mousemove', e => {
            if (dragging) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; }
        });
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
    }
})();
