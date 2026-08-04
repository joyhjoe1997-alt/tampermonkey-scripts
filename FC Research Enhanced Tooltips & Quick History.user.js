// ==UserScript==
// @name         FC Research Enhanced Tooltips & Quick History
// @namespace    http://tampermonkey.net/
// @author       @sarsingm (Sarbjeet Singh-YOW1)
// @version      3.0
// @description  Shows tooltips with product images/titles on ASIN links, employee photos/details on login hover, and adds Quick 6 Month History button
// @author       You
// @match        *://fcresearch-eu.aka.amazon.com/*
// @match        *://qi-fcresearch-eu.corp.amazon.com/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // Create and append tooltip container to body
 const tooltipContainer = document.createElement('div');
tooltipContainer.style.cssText = `
    position: fixed;
    border: 3px solid #000;
    display: none;
    z-index: 10000;
    width: 400px;
    pointer-events: none;
    transform: translate3d(0, 0, 0);
    will-change: transform;
    color: #000;
    font-family: 'MS Sans Serif', monospace, sans-serif;
    font-size: 11px;
    box-shadow: 3px 3px 0px #000;
`;


    // Add CSS animations
    const style = document.createElement('style');
    style.textContent = `
        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }
        .retro-loader {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 4px;
            margin: 20px 0;
        }
        .retro-dot {
            width: 8px;
            height: 8px;
            background: #000;
            animation: blink 1.2s infinite;
        }
        .retro-dot:nth-child(2) { animation-delay: 0.2s; }
        .retro-dot:nth-child(3) { animation-delay: 0.4s; }
        .retro-dot:nth-child(4) { animation-delay: 0.6s; }
        .loading-text {
            color: #000;
            font-weight: normal;
            text-align: center;
            font-family: 'MS Sans Serif', monospace, sans-serif;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(tooltipContainer);

    // Cache management functions
    const CACHE_DURATION = 20 * 60 * 60 * 1000; // 20 hours in milliseconds
    const CACHE_KEY_PREFIX = 'product_cache_';
    const EMPLOYEE_CACHE_KEY_PREFIX = 'employee_cache_';

    function saveToCache(site, asin, data) {
        const cacheKey = `${CACHE_KEY_PREFIX}${site}-${asin}`;
        const cacheData = {
            data: data,
            timestamp: Date.now()
        };
        try {
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (e) {
            // If localStorage is full, clear it and try again
            if (e.name === 'QuotaExceededError') {
                clearOldCache();
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
                } catch (e) {
                    console.error('Failed to save to cache even after clearing:', e);
                }
            }
        }
    }

    function getFromCache(site, asin) {
        const cacheKey = `${CACHE_KEY_PREFIX}${site}-${asin}`;
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const parsedCache = JSON.parse(cached);
                const age = Date.now() - parsedCache.timestamp;

                if (age < CACHE_DURATION) {
                    return parsedCache.data;
                } else {
                    // Remove expired cache entry
                    localStorage.removeItem(cacheKey);
                }
            }
        } catch (e) {
            console.error('Error reading from cache:', e);
        }
        return null;
    }

    function clearOldCache() {
        const keys = Object.keys(localStorage);
        const now = Date.now();

        keys.forEach(key => {
            if (key.startsWith(CACHE_KEY_PREFIX) || key.startsWith(EMPLOYEE_CACHE_KEY_PREFIX)) {
                try {
                    const cached = JSON.parse(localStorage.getItem(key));
                    if (now - cached.timestamp > CACHE_DURATION) {
                        localStorage.removeItem(key);
                    }
                } catch (e) {
                    // If entry is corrupted, remove it
                    localStorage.removeItem(key);
                }
            }
        });
    }

    function parseProductData(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        const img = doc.querySelector('img').src;
        const titleRow = Array.from(doc.querySelectorAll('tr')).find(row =>
            row.querySelector('th') &&
            row.querySelector('th').textContent.trim() === 'Title'
        );
        const title = titleRow ? titleRow.querySelector('td a').textContent : '';

        return { img, title };
    }

    function parseEmployeeData(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');

        const img = doc.querySelector('img').src;
        const table = doc.querySelector('table.a-keyvalue');
        const rows = table.querySelectorAll('tr');

        const data = { img };
        rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (th && td) {
                data[th.textContent.trim()] = td.textContent.trim();
            }
        });

        return data;
    }

    function fetchProductData(site, asin) {
        // Check cache first
        const cachedData = getFromCache(site, asin);
        if (cachedData) {
            return Promise.resolve(cachedData);
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://qi-fcresearch-eu.corp.amazon.com/${site}/results/product?s=${asin}`,
                headers: {
                    "Content-Type": "application/json",
                },
                onload: function(response) {
                    try {
                        const data = parseProductData(response.responseText);
                        // Save to cache
                        saveToCache(site, asin, data);
                        resolve(data);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: reject
            });
        });
    }

    function saveEmployeeToCache(login, data) {
        const cacheKey = `${EMPLOYEE_CACHE_KEY_PREFIX}${login}`;
        const cacheData = {
            data: data,
            timestamp: Date.now()
        };
        try {
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                clearOldCache();
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
                } catch (e) {
                    console.error('Failed to save employee to cache:', e);
                }
            }
        }
    }

    function getEmployeeFromCache(login) {
        const cacheKey = `${EMPLOYEE_CACHE_KEY_PREFIX}${login}`;
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const parsedCache = JSON.parse(cached);
                const age = Date.now() - parsedCache.timestamp;

                if (age < CACHE_DURATION) {
                    return parsedCache.data;
                } else {
                    localStorage.removeItem(cacheKey);
                }
            }
        } catch (e) {
            console.error('Error reading employee from cache:', e);
        }
        return null;
    }

    function fetchEmployeeData(login) {
        const cachedData = getEmployeeFromCache(login);
        if (cachedData) {
            return Promise.resolve(cachedData);
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: "https://qi-fcresearch-eu.corp.amazon.com/EMA4/results/employee",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data: `s=${login}`,
                onload: function(response) {
                    try {
                        const data = parseEmployeeData(response.responseText);
                        saveEmployeeToCache(login, data);
                        resolve(data);
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: reject
            });
        });
    }

  let isHoveringLink = false;

    function showTooltip(event, content) {
        if (!isHoveringLink) return;

        // Remove any loading tooltip first
        const loadingTooltip = document.querySelector('.temp-loading');
        if (loadingTooltip) loadingTooltip.remove();

        tooltipContainer.innerHTML = content;
        tooltipContainer.style.display = 'block';

    // Get viewport and tooltip dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const tooltipWidth = tooltipContainer.offsetWidth;
    const tooltipHeight = tooltipContainer.offsetHeight;

    // Get mouse coordinates relative to the viewport
    const mouseX = event.clientX;
    const mouseY = event.clientY;

    // Calculate position (offset from cursor)
    const offset = 15;
    let x = mouseX + offset;
    let y = mouseY + offset;

    // Check right edge
    if (x + tooltipWidth > viewportWidth) {
        x = mouseX - tooltipWidth - offset;
    }

    // Check bottom edge
    if (y + tooltipHeight > viewportHeight) {
        y = mouseY - tooltipHeight - offset;
    }

    // Ensure tooltip stays within viewport
    x = Math.max(0, Math.min(x, viewportWidth - tooltipWidth));
    y = Math.max(0, Math.min(y, viewportHeight - tooltipHeight));

    // Apply the position using fixed positioning
    tooltipContainer.style.left = `${x}px`;
    tooltipContainer.style.top = `${y}px`;
}

  let throttleTimer;
    document.addEventListener('mousemove', (event) => {
        if (isHoveringLink && tooltipContainer.style.display === 'block') {
            if (!throttleTimer) {
                throttleTimer = setTimeout(() => {
                    showTooltip(event, tooltipContainer.innerHTML);
                    throttleTimer = null;
                }, 16);
            }
        } else {
            hideTooltip();
        }
    });

    function hideTooltip() {
        tooltipContainer.style.display = 'none';
        // Also remove any temporary loading tooltip
        const loadingTooltip = document.querySelector('.temp-loading');
        if (loadingTooltip) loadingTooltip.remove();
    }

    function createTooltipContent(data) {
        return `
            <div style="width: 100%; height: 280px; background: #ffffff; background-image: url('${data.img}'); background-size: contain; background-position: center; background-repeat: no-repeat; border-bottom: 2px inset #808080;"></div>
            <div style="padding: 12px; background: #ffffff; min-height: 120px; display: flex; align-items: center; justify-content: center;">
                <div style="font-size: 15px; color: #000; font-weight: normal; text-align: center; line-height: 1.3; font-family: monospace;">${data.title}</div>
            </div>
        `;
    }

    function createEmployeeTooltipContent(data) {
        return `
            <div style="display: flex; width: 100%; background: #ffffff;">
                <div style="width: 120px; height: 120px; background: #ffffff; background-image: url('${data.img}'); background-size: contain; background-position: center; background-repeat: no-repeat; border-right: 2px inset #808080; flex-shrink: 0;"></div>
                <div style="padding: 12px; flex: 1;">
                    <div style="font-size: 12px; color: #000; font-family: monospace; line-height: 1.3;">
                        <div><strong>Login:</strong> ${data.Login || 'N/A'}</div>
                        <div><strong>Name:</strong> ${data.Name || 'N/A'}</div>
                        <div><strong>Job Title:</strong> ${data['Job Title'] || 'N/A'}</div>
                        <div><strong>FC:</strong> ${data.FC || 'N/A'}</div>
                        <div><strong>Supervisor:</strong> ${data.Supervisor || 'N/A'}</div>
                    </div>
                </div>
            </div>
        `;
    }

    function showLoadingTooltip(event) {
        // Remove any existing loading tooltip
        const existing = document.querySelector('.temp-loading');
        if (existing) existing.remove();

        // Create a smaller loading tooltip
        const loadingContainer = document.createElement('div');
        loadingContainer.style.cssText = `
            position: fixed;
            border: 2px solid #000;
            border-style: outset;
            background: #c0c0c0;
            padding: 12px;
            z-index: 10000;
            pointer-events: none;
            font-family: 'MS Sans Serif', monospace, sans-serif;
            font-size: 11px;
            box-shadow: 2px 2px 0px #808080;
        `;
        loadingContainer.innerHTML = '<div class="retro-loader"><div class="retro-dot"></div><div class="retro-dot"></div><div class="retro-dot"></div><div class="retro-dot"></div></div><div class="loading-text">Loading...</div>';
        loadingContainer.className = 'temp-loading';

        // Position it
        const mouseX = event.clientX;
        const mouseY = event.clientY;
        loadingContainer.style.left = `${mouseX + 15}px`;
        loadingContainer.style.top = `${mouseY + 15}px`;

        document.body.appendChild(loadingContainer);
    }

     // Handle mouseenter event
    async function handleMouseEnter(event) {
        isHoveringLink = true;
        const element = event.target;
        const href = element.getAttribute('href');
        const text = element.textContent.trim();

        // Check if it's a product link
        if (href) {
            const productMatch = href.match(/\/([^\/]+)\/results\?s=([^&]+)/);
            if (productMatch && !isEmployeePattern(text)) {
                const [, site, asin] = productMatch;
                showLoadingTooltip(event);

                try {
                    const data = await fetchProductData(site, asin);
                    showTooltip(event, createTooltipContent(data));
                } catch (error) {
                    console.error('Error fetching product data:', error);
                    hideTooltip();
                }
                return;
            }
        }

        // Check if it's an employee link (/results?s= pattern)
        if (href && href.includes('/results?s=') && isEmployeePattern(text)) {
            try {
                const data = await fetchEmployeeData(text);
                showTooltip(event, createEmployeeTooltipContent(data));
            } catch (error) {
                console.error('Error fetching employee data:', error);
                hideTooltip();
            }
        }
    }

    // Handle mouseleave event
    function handleMouseLeave() {
        isHoveringLink = false;
        hideTooltip();
    }

    // Check if text matches employee pattern
    function isEmployeePattern(text) {
        return text.length > 3 &&
               text === text.toLowerCase() &&
               /^[a-z0-9]+$/.test(text);
    }

  // Add event delegation - only on <a> tags
    document.body.addEventListener('mouseenter', (event) => {
        const element = event.target;

        if (element.tagName === 'A' && element.href) {
            handleMouseEnter(event);
        }
    }, true);

    document.body.addEventListener('mouseleave', (event) => {
        if (event.target.tagName === 'A' && event.target.href) {
            handleMouseLeave();
        }
    }, true);

    // Clear old cache entries on script initialization
    clearOldCache();

    // Quick 6 Month History functionality
    function calculate180DaysBack(date) {
        const d = new Date(date);
        d.setDate(d.getDate() - 180);
        return d.toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        });
    }

    function scrollToInventoryHistory() {
        const observer = new MutationObserver((mutations, obs) => {
            const targetElement = document.getElementById('table-inventory-history_wrapper');
            if (targetElement) {
                const elementPosition = targetElement.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - 150;
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
                obs.disconnect();
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function addNavButton() {
        if (document.getElementById('quick6MonthsButton')) {
            return;
        }

        const inventoryItem = document.getElementById('inventory-status');
        if (inventoryItem) {
            const newListItem = document.createElement('li');
            newListItem.id = 'quick6MonthsButton';
            newListItem.innerHTML = `
                <a href="#">
                    <i class="s-icon-status"></i>
                    Quick 6 Month History
                </a>
            `;

            newListItem.querySelector('a').addEventListener('click', function(e) {
                e.preventDefault();

                const endDateInput = document.getElementById('searchEnd');
                const startDateInput = document.getElementById('searchStart');

                scrollToInventoryHistory();

                if (endDateInput && endDateInput.value) {
                    const startDate = calculate180DaysBack(endDateInput.value);
                    startDateInput.value = startDate;

                    const event = new Event('change', { bubbles: true });
                    startDateInput.dispatchEvent(event);

                    window.location.hash = 'inventory-history-nav';

                    let button = document.querySelector('button.a-button-text[type="button"]');
                    if (button && button.textContent.trim() === 'Search') {
                        button.click();
                    }
                }
            });

            inventoryItem.parentNode.insertBefore(newListItem, inventoryItem.nextSibling);
        }
    }

    const navObserver = new MutationObserver(function(mutations) {
        addNavButton();
    });

    navObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    addNavButton();
    setTimeout(addNavButton, 1000);
})();
