// ==UserScript==
// @name         MoveItems Multi-Container Automation
// @namespace    moveitems-container-automation
// @version      1.5.0
// @description  Move multiple source containers to one destination, skip empty containers, continue after failures, and unstick on demand.
// @author       paulspis
// @match        https://aft-qt-eu.aka.amazon.com/app/moveitems*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    /* ================= SETTINGS ================= */
    const CONFIG = {
        panelId: 'moveitems-automation-panel',
        storageKey: 'moveitemsAutomationV150',
        lockKey: 'moveitemsAutomationLockV150',
        checkInterval: 350,
        actionDelay: 700,
        pageTimeout: 30000,
        staleErrorGrace: 2500,
        maxRetries: 2,
        enableCompletionSound: true,
        // Error elements considered when looking for page errors.
        errorSelectors: [
            '[role="alert"]',
            '.a-alert-error',
            '.a-box-error',
            '.aft-tool-critical-box',
            '.aft-tool-warn-box'
        ],
        maxErrorTextLength: 300
    };

    const DEFAULT_STATE = {
        running: false,
        paused: false,
        stuck: false,
        destination: '',
        pending: [],
        current: '',
        completed: [],
        skipped: [],
        failed: [],
        phase: 'idle',
        detectedPage: 'unknown',
        lastMessage: 'Ready',
        lastActionAt: 0,
        lastErrorText: '',
        retries: 0,
        startedAt: null,
        finishedAt: null,
        activeTab: 'configuration',
        panelCollapsed: false,
        panelX: null,
        panelY: 70,
        logs: []
    };

    const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let state = loadState();
    let panel = null;
    let actionLocked = false;
    let timeoutTimer = null;

    /* ================= HELPERS ================= */
    const query = (selector, root = document) => root.querySelector(selector);
    const queryAll = (selector, root = document) => [...root.querySelectorAll(selector)];
    const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));
    const clone = value => JSON.parse(JSON.stringify(value));

    function normalize(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function cleanContainer(value) {
        return String(value ?? '').trim().replace(/\s+/g, '');
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function uniqueContainers(values) {
        const found = new Set();
        const result = [];
        for (const rawValue of values) {
            const value = cleanContainer(rawValue);
            if (!value) continue;
            const key = value.toLowerCase();
            if (found.has(key)) continue;
            found.add(key);
            result.push(value);
        }
        return result;
    }

    function parseSources(text) {
        return uniqueContainers(String(text ?? '').split(/[\s,;]+/));
    }

    function isVisible(element) {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rectangle.width > 0 &&
            rectangle.height > 0
        );
    }

    const inPanel = element => Boolean(element.closest(`#${CONFIG.panelId}`));

    /* ================= STORAGE ================= */
    function loadState() {
        try {
            const saved = JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}');
            return {
                ...clone(DEFAULT_STATE),
                ...saved,
                pending: Array.isArray(saved.pending) ? saved.pending : [],
                completed: Array.isArray(saved.completed) ? saved.completed : [],
                skipped: Array.isArray(saved.skipped) ? saved.skipped : [],
                failed: Array.isArray(saved.failed) ? saved.failed : [],
                logs: Array.isArray(saved.logs) ? saved.logs.slice(-300) : []
            };
        } catch (error) {
            console.error('[MoveItems Automation] Could not load saved state.', error);
            return clone(DEFAULT_STATE);
        }
    }

    function saveState() {
        try {
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
        } catch (error) {
            console.error('[MoveItems Automation] Could not save state.', error);
        }
    }

    /* ================= TAB LOCK =================
     * Only one tab may drive the queue. The lock is refreshed on every tick
     * and expires after 5 seconds, so a closed tab never blocks forever. */
    function ownsLock() {
        try {
            const now = Date.now();
            const lock = JSON.parse(localStorage.getItem(CONFIG.lockKey) || 'null');
            if (!lock || lock.tab === TAB_ID || now - lock.time > 5000) {
                localStorage.setItem(CONFIG.lockKey, JSON.stringify({ tab: TAB_ID, time: now }));
                return true;
            }
            return false;
        } catch {
            return true;
        }
    }

    /* ================= LOGGING ================= */
    function addLog(message, type = 'info') {
        state.lastMessage = message;
        state.logs.push({ time: new Date().toISOString(), type, message });
        state.logs = state.logs.slice(-300);
        saveState();
        renderPanel();

        const output = `[MoveItems Automation] ${message}`;
        if (type === 'error') console.error(output);
        else if (type === 'warn') console.warn(output);
        else console.log(output);
    }

    /* ================= PAGE DETECTION ================= */
    function getPageText() {
        // Exclude our own panel so its labels never influence detection.
        const clonedBody = document.body?.cloneNode(true);
        if (!clonedBody) return '';
        clonedBody.querySelector(`#${CONFIG.panelId}`)?.remove();
        // cloneNode drops layout, so innerText is unavailable; use textContent.
        return normalize(clonedBody.textContent || '');
    }

    /**
     * Returns the text of the first visible, specific error element.
     * Only short messages from known error containers are considered.
     */
    function getVisibleErrorText() {
        for (const element of queryAll(CONFIG.errorSelectors.join(','))) {
            if (!isVisible(element) || inPanel(element)) continue;
            const text = normalize(element.innerText || element.textContent);
            if (text && text.length <= CONFIG.maxErrorTextLength) return text;
        }
        return '';
    }

    function getEmptyContainerMessage() {
        const errorText = getVisibleErrorText();
        return errorText.includes('empty container') ? errorText : '';
    }

    function detectPage() {
        const text = getPageText();

        // Empty container is only reported from visible error elements.
        if (getEmptyContainerMessage()) return 'empty-container';

        // Confirm is checked before success so a stray "change container"
        // link on the confirm page can never be mistaken for success.
        if (text.includes('confirm move')) return 'confirm';

        if (text.includes('success') && text.includes('change container')) return 'success';

        if (text.includes('scan destination container')) return 'destination';
        if (text.includes('scan source container')) return 'source';
        if (text.includes('scan container')) return 'source';

        if (getVisibleErrorText()) return 'error';

        return 'unknown';
    }

    /* ================= ELEMENT FINDERS ================= */
    function getElementText(element) {
        if (!element) return '';
        return normalize(
            element.innerText ||
            element.textContent ||
            element.value ||
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            ''
        );
    }

    /**
     * Finds the scan input. Prefers inputs whose id, name, placeholder, or
     * label mention the wanted kind ("source" / "destination"). Falls back to
     * the only visible text input. If several unrelated inputs exist and none
     * matches, returns null instead of guessing.
     */
    function findPageInput(kind) {
        const inputs = queryAll(
            'input:not([type]), input[type="text"], input[type="search"], input[type="tel"]'
        ).filter(element =>
            isVisible(element) && !element.disabled && !element.readOnly && !inPanel(element)
        );

        if (!inputs.length) return null;

        if (kind) {
            const match = inputs.find(input => {
                const label = input.id ? query(`label[for="${CSS.escape(input.id)}"]`) : null;
                const description = normalize([
                    input.id,
                    input.name,
                    input.placeholder,
                    input.getAttribute('aria-label'),
                    label?.textContent,
                    input.closest('label')?.textContent
                ].join(' '));
                return description.includes(kind);
            });
            if (match) return match;
        }

        return inputs.length === 1 ? inputs[0] : null;
    }

    function actionableFor(element) {
        if (element.matches('button, input, a, [role="button"]')) return element;
        return query(
            'input[type="submit"], input[type="button"], button, a[role="button"]',
            element
        );
    }

    /**
     * Finds a button by label. An exact label match wins over a partial one,
     * so "Continue" is preferred over e.g. "Continue to report".
     */
    function findControlByText(searchText) {
        const wanted = normalize(searchText);
        const controls = queryAll(
            'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]'
        ).filter(element => isVisible(element) && !element.disabled && !inPanel(element));

        const exact = controls.find(element => getElementText(element) === wanted);
        if (exact) return exact;

        const partial = controls.find(element => getElementText(element).includes(wanted));
        if (partial) return partial;

        // Amazon AUI: the label sits in .a-button-text, the real input is in the wrapper.
        const textElements = queryAll('.a-button-text, span, div, label').filter(element =>
            isVisible(element) && !inPanel(element) && getElementText(element) === wanted
        );

        for (const textElement of textElements) {
            const wrapper = textElement.closest('.a-button, button, form, [role="button"]');
            if (!wrapper) continue;
            const actionable = actionableFor(wrapper);
            if (actionable && isVisible(actionable) && !actionable.disabled) return actionable;
        }

        return null;
    }

    function findRecoveryControl() {
        const labels = [
            'change container',
            'scan another container',
            'try another container',
            'continue',
            'back'
        ];
        for (const label of labels) {
            const control = findControlByText(label);
            if (control) return control;
        }
        return null;
    }

    /* ================= INPUT / BUTTON ACTIONS ================= */
    function setNativeInputValue(input, value) {
        const descriptor =
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') ||
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

        if (descriptor?.set) descriptor.set.call(input, value);
        else input.value = value;

        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    function activateControl(control) {
        if (!control || !isVisible(control) || control.disabled) return false;
        control.focus();
        control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        control.click();
        return true;
    }

    async function enterValueAndContinue(value, description, kind) {
        const input = findPageInput(kind);
        if (!input) throw new Error(`No ${description} input was found.`);

        input.focus();
        setNativeInputValue(input, value);
        await sleep(250);

        if (cleanContainer(input.value).toLowerCase() !== value.toLowerCase()) {
            throw new Error(`${description} field did not keep the entered value.`);
        }

        const continueControl = findControlByText('continue');
        if (continueControl) {
            if (!activateControl(continueControl)) throw new Error('Continue button could not be clicked.');
            return;
        }

        const form = input.closest('form');
        if (form?.requestSubmit) {
            form.requestSubmit();
            return;
        }

        throw new Error('Continue button was not found.');
    }

    /* ================= QUEUE MANAGEMENT ================= */
    function getNextSource() {
        if (state.current) return state.current;

        while (state.pending.length) {
            const next = cleanContainer(state.pending.shift());
            if (!next) continue;

            if (next.toLowerCase() === state.destination.toLowerCase()) {
                state.skipped.push({
                    container: next,
                    reason: 'Source matches destination',
                    time: new Date().toISOString()
                });
                addLog(`${next} skipped because it matches the destination.`, 'warn');
                continue;
            }

            state.current = next;
            state.retries = 0;
            saveState();
            return next;
        }
        return '';
    }

    function completedAlready(container) {
        return state.completed.some(item => {
            const saved = typeof item === 'string' ? item : item.container;
            return normalize(saved) === normalize(container);
        });
    }

    function recordCompleted(container) {
        if (!container || completedAlready(container)) return;
        state.completed.push({
            container,
            destination: state.destination,
            time: new Date().toISOString()
        });
    }

    function completeCurrentSource() {
        if (!state.current) return;
        const container = state.current;
        recordCompleted(container);
        state.current = '';
        state.retries = 0;
        state.phase = 'waiting-for-source-page';
        saveState();
        addLog(`${container} completed. ${state.pending.length} remaining.`);
    }

    function skipCurrentSource(reason) {
        const container = state.current || 'Unknown container';
        state.skipped.push({
            container,
            destination: state.destination,
            reason,
            time: new Date().toISOString()
        });
        state.current = '';
        state.retries = 0;
        state.stuck = false;
        state.phase = 'recovering-after-skip';
        state.lastActionAt = Date.now();
        saveState();
        addLog(`${container} skipped: ${reason}`, 'warn');
    }

    /** A failure records the container and the run CONTINUES with the next one. */
    function failCurrentSource(reason) {
        const container = state.current || 'Unknown container';
        state.failed.push({
            container,
            destination: state.destination,
            reason,
            time: new Date().toISOString()
        });
        state.current = '';
        state.retries = 0;
        state.stuck = false;
        state.phase = 'recovering-after-failure';
        state.lastActionAt = Date.now();
        saveState();
        addLog(`${container} failed: ${reason}. Continuing with the next container.`, 'error');
        resetPageTimeout();
    }

    /* ================= TIMEOUT / STUCK ================= */
    function clearPageTimeout() {
        if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
        }
    }

    function resetPageTimeout() {
        clearPageTimeout();
        if (!state.running || state.paused) return;

        timeoutTimer = window.setTimeout(() => {
            if (!state.running || state.paused) return;
            state.paused = true;
            state.stuck = true;
            state.phase = 'paused-after-timeout';
            saveState();
            addLog(
                'Page timed out. Automation paused. Use "Skip stuck container" to move on, or Stop.',
                'error'
            );
        }, CONFIG.pageTimeout);
    }

    /** Leaves whatever page we are on and returns to the source-scan page. */
    async function leaveCurrentPage() {
        const control = findRecoveryControl();
        if (control && activateControl(control)) return;
        // Last resort: reload the MoveItems start page.
        window.location.assign(`${window.location.origin}/app/moveitems`);
    }

    /** Manual escape hatch for a stuck or errored page. */
    async function skipStuckContainer() {
        if (!state.running) return;

        if (state.current) {
            skipCurrentSource('Skipped manually while stuck');
        } else {
            addLog('Stuck with no active container. Leaving the current page.', 'warn');
        }

        state.paused = false;
        state.stuck = false;
        state.phase = 'recovering-after-skip';
        state.lastErrorText = getVisibleErrorText();
        state.lastActionAt = Date.now();
        saveState();
        renderPanel();
        resetPageTimeout();

        await leaveCurrentPage();
    }

    /* ================= PAGE HANDLERS ================= */
    async function handleSourcePage() {
        // Fallback for versions that return to the source page without Success.
        if (state.current && state.phase === 'waiting-for-return') {
            completeCurrentSource();
        }

        const source = getNextSource();
        if (!source) {
            finishAutomation();
            return;
        }

        state.phase = 'submitting-source';
        state.lastActionAt = Date.now();
        saveState();
        addLog(`Entering source container: ${source}`);

        await sleep(CONFIG.actionDelay);
        await enterValueAndContinue(source, 'source container', 'source');

        state.phase = 'waiting-for-confirmation';
        state.lastActionAt = Date.now();
        saveState();
        resetPageTimeout();
    }

    async function handleConfirmPage() {
        if (!state.current) {
            throw new Error('Confirm page reached without a current source container.');
        }

        // The page must actually show the container we think we are moving.
        if (!getPageText().includes(state.current.toLowerCase())) {
            throw new Error(
                `Confirm page does not show ${state.current}. Refusing to confirm a different move.`
            );
        }

        const continueControl = findControlByText('continue');
        if (!continueControl) throw new Error('Continue button was not found on Confirm move.');

        state.phase = 'confirming-move';
        state.lastActionAt = Date.now();
        saveState();

        await sleep(CONFIG.actionDelay);

        if (!activateControl(continueControl)) {
            throw new Error('Could not click Continue on Confirm move.');
        }

        state.phase = 'waiting-for-destination';
        state.lastActionAt = Date.now();
        saveState();
        addLog(`Confirmed move for ${state.current}.`);
        resetPageTimeout();
    }

    async function handleDestinationPage() {
        if (!state.current) {
            throw new Error('Destination page reached without a current source container.');
        }
        if (!state.destination) throw new Error('Destination container is empty.');

        state.phase = 'submitting-destination';
        state.lastActionAt = Date.now();
        saveState();
        addLog(`Entering destination ${state.destination} for ${state.current}.`);

        await sleep(CONFIG.actionDelay);
        await enterValueAndContinue(state.destination, 'destination container', 'destination');

        state.phase = 'waiting-for-return';
        state.lastActionAt = Date.now();
        saveState();
        resetPageTimeout();
    }

    async function handleSuccessPage() {
        if (state.current) {
            const completedContainer = state.current;
            recordCompleted(completedContainer);
            state.current = '';
            state.retries = 0;
            state.phase = 'leaving-success-page';
            state.lastActionAt = Date.now();
            saveState();
            addLog(
                `${completedContainer} moved successfully to ${state.destination}. ` +
                `${state.pending.length} remaining.`
            );
        }

        const changeContainerControl = findControlByText('change container');
        if (!changeContainerControl) {
            throw new Error('Change container button was not found on Success.');
        }

        state.phase = 'leaving-success-page';
        state.lastActionAt = Date.now();
        saveState();

        await sleep(CONFIG.actionDelay);

        if (!activateControl(changeContainerControl)) {
            throw new Error('Could not click Change container.');
        }

        state.phase = 'waiting-for-source-page';
        state.lastActionAt = Date.now();
        saveState();
        resetPageTimeout();
    }

    async function handleEmptyContainerPage() {
        const emptyMessage = getEmptyContainerMessage() || 'Empty container';

        // The same error text can linger right after we submitted a new source.
        // Ignore it briefly so a valid container is not skipped by mistake.
        if (
            state.current &&
            state.phase === 'waiting-for-confirmation' &&
            emptyMessage === state.lastErrorText &&
            Date.now() - state.lastActionAt < CONFIG.staleErrorGrace
        ) {
            return;
        }

        if (state.current) {
            state.lastErrorText = emptyMessage;
            skipCurrentSource(emptyMessage);
        }

        // Error shown on the source page itself: just carry on with the next one.
        const pageText = getPageText();
        const looksLikeSourcePage =
            pageText.includes('scan source container') ||
            (pageText.includes('scan container') && !pageText.includes('scan destination container'));

        if (findPageInput('source') && looksLikeSourcePage) {
            state.phase = 'waiting-for-source-page';
            state.lastActionAt = Date.now();
            saveState();
            await handleSourcePage();
            return;
        }

        const recoveryControl = findRecoveryControl();
        if (recoveryControl) {
            state.phase = 'recovering-empty-container';
            state.lastActionAt = Date.now();
            saveState();
            await sleep(CONFIG.actionDelay);

            if (!activateControl(recoveryControl)) {
                throw new Error('Could not leave the Empty container error page.');
            }

            state.phase = 'waiting-for-source-page';
            state.lastActionAt = Date.now();
            saveState();
            resetPageTimeout();
            return;
        }

        addLog('No recovery button found. Returning to the previous page.', 'warn');
        state.phase = 'recovering-with-browser-back';
        state.lastActionAt = Date.now();
        saveState();
        history.back();
        resetPageTimeout();
    }

    /** Generic error page: fail the current container and move on. */
    async function handleErrorPage() {
        const errorText = getVisibleErrorText() || 'Unknown MoveItems error';

        // Ignore a stale error right after we acted.
        if (
            errorText === state.lastErrorText &&
            Date.now() - state.lastActionAt < CONFIG.staleErrorGrace
        ) {
            return;
        }

        state.lastErrorText = errorText;

        if (state.current && state.retries < CONFIG.maxRetries) {
            state.retries += 1;
            state.lastActionAt = Date.now();
            saveState();
            addLog(`Error: ${errorText}. Retry ${state.retries}/${CONFIG.maxRetries} for ${state.current}.`, 'warn');
            await leaveCurrentPage();
            return;
        }

        if (state.current) failCurrentSource(errorText);
        else addLog(`Error page: ${errorText}`, 'error');

        await sleep(CONFIG.actionDelay);
        await leaveCurrentPage();
    }

    /* ================= ERROR HANDLING ================= */
    async function handleAutomationError(error) {
        const reason = error instanceof Error ? error.message : String(error);
        addLog(reason, 'error');

        if (state.current && state.retries < CONFIG.maxRetries) {
            state.retries += 1;
            state.lastActionAt = 0;
            saveState();
            addLog(`Retry ${state.retries}/${CONFIG.maxRetries} for ${state.current}.`, 'warn');
            await sleep(1200);
            return;
        }

        // Out of retries: record the failure and continue with the queue.
        if (state.current) {
            failCurrentSource(reason);
            await sleep(CONFIG.actionDelay);
            await leaveCurrentPage();
        } else {
            // Nothing to fail; flag stuck so the user can skip or stop.
            state.paused = true;
            state.stuck = true;
            state.phase = 'paused-after-error';
            clearPageTimeout();
            saveState();
            addLog('Automation paused after an unrecoverable error.', 'error');
        }
    }

    /* ================= MAIN LOOP ================= */
    async function automationTick() {
        if (!state.running || state.paused || actionLocked) return;
        if (!ownsLock()) return;

        const detectedPage = detectPage();

        if (state.detectedPage !== detectedPage) {
            state.detectedPage = detectedPage;
            saveState();
            renderPanel();
            resetPageTimeout();
        }

        if (Date.now() - state.lastActionAt < CONFIG.actionDelay) return;

        actionLocked = true;
        try {
            switch (detectedPage) {
                case 'source': await handleSourcePage(); break;
                case 'confirm': await handleConfirmPage(); break;
                case 'destination': await handleDestinationPage(); break;
                case 'success': await handleSuccessPage(); break;
                case 'empty-container': await handleEmptyContainerPage(); break;
                case 'error': await handleErrorPage(); break;
                default:
                    if (state.lastMessage !== 'Waiting for a recognised MoveItems page…') {
                        state.lastMessage = 'Waiting for a recognised MoveItems page…';
                        saveState();
                        renderPanel();
                    }
                    break;
            }
        } catch (error) {
            await handleAutomationError(error);
        } finally {
            actionLocked = false;
        }
    }

    /* ================= START / PAUSE / STOP ================= */
    function startAutomation() {
        const destinationInput = query('#mia-destination', panel);
        const sourceInput = query('#mia-sources', panel);

        const destination = cleanContainer(destinationInput?.value || state.destination);
        const sources = parseSources(sourceInput?.value || state.pending.join('\n'));

        if (!destination) {
            window.alert('Enter a destination container.');
            destinationInput?.focus();
            return;
        }
        if (!sources.length) {
            window.alert('Enter at least one source container.');
            sourceInput?.focus();
            return;
        }
        if (sources.some(source => source.toLowerCase() === destination.toLowerCase())) {
            window.alert('A source container cannot be the same as the destination.');
            return;
        }

        const confirmed = window.confirm(
            `Move ${sources.length} source container(s) to:\n\n${destination}\n\nStart automation?`
        );
        if (!confirmed) return;

        state.destination = destination;
        state.pending = sources;
        state.current = '';
        state.completed = [];
        state.skipped = [];
        state.failed = [];
        state.running = true;
        state.paused = false;
        state.stuck = false;
        state.phase = 'waiting-for-source-page';
        state.detectedPage = 'unknown';
        state.retries = 0;
        state.lastActionAt = 0;
        state.lastErrorText = '';
        state.startedAt = new Date().toISOString();
        state.finishedAt = null;
        state.activeTab = 'status';
        saveState();

        addLog(`Started with ${sources.length} source container(s). Destination: ${destination}.`);
        resetPageTimeout();
        automationTick();
    }

    function pauseAutomation() {
        if (!state.running) return;
        state.paused = true;
        state.phase = 'paused';
        clearPageTimeout();
        saveState();
        addLog('Automation paused.', 'warn');
    }

    function resumeAutomation() {
        if (!state.running) return;
        state.paused = false;
        state.stuck = false;
        state.phase = 'resuming';
        state.lastActionAt = 0;
        saveState();
        addLog('Automation resumed.');
        resetPageTimeout();
        automationTick();
    }

    function stopAutomation() {
        if (!state.running) return;
        if (!window.confirm('Stop the automation?')) return;

        state.running = false;
        state.paused = false;
        state.stuck = false;
        state.phase = 'stopped';
        clearPageTimeout();
        saveState();
        addLog('Automation stopped.', 'warn');
    }

    function finishAutomation() {
        state.running = false;
        state.paused = false;
        state.stuck = false;
        state.phase = 'finished';
        state.finishedAt = new Date().toISOString();
        clearPageTimeout();
        saveState();

        const message =
            `Finished. ${state.completed.length} completed, ` +
            `${state.skipped.length} skipped, ${state.failed.length} failed.`;

        addLog(message);
        state.activeTab = 'status';
        saveState();
        renderPanel();

        if (CONFIG.enableCompletionSound) playCompletionSound();
        window.alert(message);
    }

    function resetAll() {
        if (state.running) return;
        if (!window.confirm('Clear all automation data?')) return;

        const panelSettings = {
            panelX: state.panelX,
            panelY: state.panelY,
            panelCollapsed: state.panelCollapsed
        };
        state = { ...clone(DEFAULT_STATE), ...panelSettings };
        saveState();
        renderPanel();
    }

    function retrySkippedAndFailed() {
        if (state.running) return;

        const toContainer = item => (typeof item === 'string' ? item : item.container);
        const retryContainers = uniqueContainers([
            ...state.skipped.map(toContainer),
            ...state.failed.map(toContainer)
        ]);

        state.pending = uniqueContainers([...retryContainers, ...state.pending]);
        state.skipped = [];
        state.failed = [];
        state.activeTab = 'configuration';
        saveState();
        addLog(`${retryContainers.length} container(s) returned to the queue.`);
    }

    /* ================= SOUND ================= */
    function playCompletionSound() {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            const context = new AudioContextClass();
            const oscillator = context.createOscillator();
            const gain = context.createGain();

            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.frequency.value = 520;
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.45);
        } catch {
            // Sound is optional.
        }
    }

    /* ================= PANEL HTML ================= */
    function calculateElapsed() {
        if (!state.startedAt) return '00:00';
        const endTime = state.finishedAt ? new Date(state.finishedAt).getTime() : Date.now();
        const startTime = new Date(state.startedAt).getTime();
        const totalSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function renderSkipStuckButton() {
        const label = state.stuck ? '⚠ Skip stuck container' : '⏭ Skip current container';
        return `
            <button type="button" data-action="skip-stuck"
                class="${state.stuck ? 'mia-warn-btn' : ''}"
                ${state.running ? '' : 'disabled'}>
                ${label}
            </button>
        `;
    }

    function renderConfigurationTab() {
        const inputsLocked = state.running && !state.paused;

        return `
            <div class="mia-content">
                <label class="mia-label">Destination container</label>
                <input id="mia-destination" class="mia-input" type="text"
                    autocomplete="off" spellcheck="false" placeholder="Example: tsX999"
                    value="${escapeHtml(state.destination)}" ${inputsLocked ? 'disabled' : ''}>

                <label class="mia-label mia-top">
                    Source containers <small>one per line</small>
                </label>
                <textarea id="mia-sources" class="mia-textarea"
                    autocomplete="off" spellcheck="false"
                    placeholder="csX001&#10;csX002&#10;csX003"
                    ${inputsLocked ? 'disabled' : ''}>${escapeHtml(state.pending.join('\n'))}</textarea>

                <div class="mia-counter">${state.pending.length} containers in queue</div>

                <div class="mia-warning">
                    Verify the destination before starting.
                    Empty source containers are skipped automatically.
                    Failed containers are recorded and the run continues.
                </div>

                <div class="mia-buttons">
                    ${state.running
                        ? state.paused
                            ? '<button type="button" data-action="resume" class="mia-primary">▶ Resume</button>'
                            : '<button type="button" data-action="pause">⏸ Pause</button>'
                        : '<button type="button" data-action="start" class="mia-primary">▶ Start</button>'}
                    <button type="button" data-action="stop" class="mia-danger"
                        ${state.running ? '' : 'disabled'}>■ Stop</button>
                </div>

                <div class="mia-buttons">${renderSkipStuckButton()}</div>

                <div class="mia-buttons">
                    <button type="button" data-action="retry"
                        ${(state.skipped.length || state.failed.length) ? '' : 'disabled'}>
                        Retry skipped/failed
                    </button>
                    <button type="button" data-action="reset" ${state.running ? 'disabled' : ''}>
                        Reset all
                    </button>
                </div>
            </div>
        `;
    }

    function renderStatusTab() {
        const total =
            state.pending.length +
            state.completed.length +
            state.skipped.length +
            state.failed.length +
            (state.current ? 1 : 0);

        const processed = state.completed.length + state.skipped.length + state.failed.length;
        const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

        let statusText = 'Idle';
        if (state.running && state.stuck) statusText = 'Stuck (paused)';
        else if (state.running && state.paused) statusText = 'Paused';
        else if (state.running) statusText = 'Running';
        else if (state.phase === 'finished') statusText = 'Finished';

        return `
            <div class="mia-content">
                <div class="mia-status-card ${state.stuck ? 'mia-stuck' : ''}">
                    <strong>${escapeHtml(statusText)}</strong>
                    <div class="mia-message">${escapeHtml(state.lastMessage)}</div>
                    <div class="mia-progress"><div style="width:${percentage}%"></div></div>
                    <small>${processed}/${total} processed (${percentage}%)</small>
                </div>

                <div class="mia-grid">
                    <div><small>Current source</small><strong>${escapeHtml(state.current || '—')}</strong></div>
                    <div><small>Destination</small><strong>${escapeHtml(state.destination || '—')}</strong></div>
                    <div><small>Detected page</small><strong>${escapeHtml(state.detectedPage)}</strong></div>
                    <div><small>Phase</small><strong>${escapeHtml(state.phase)}</strong></div>
                    <div><small>Remaining</small><strong>${state.pending.length}</strong></div>
                    <div><small>Completed</small><strong>${state.completed.length}</strong></div>
                    <div><small>Skipped</small><strong>${state.skipped.length}</strong></div>
                    <div><small>Failed</small><strong>${state.failed.length}</strong></div>
                    <div><small>Elapsed</small><strong>${calculateElapsed()}</strong></div>
                </div>

                <div class="mia-buttons">
                    ${state.paused
                        ? '<button type="button" data-action="resume" class="mia-primary">▶ Resume</button>'
                        : `<button type="button" data-action="pause" ${state.running ? '' : 'disabled'}>⏸ Pause</button>`}
                    <button type="button" data-action="stop" class="mia-danger"
                        ${state.running ? '' : 'disabled'}>■ Stop</button>
                </div>

                <div class="mia-buttons">${renderSkipStuckButton()}</div>
            </div>
        `;
    }

    function renderLogsTab() {
        const rows = state.logs.length
            ? state.logs.map(entry => {
                const time = new Date(entry.time).toLocaleTimeString();
                return `
                    <div class="mia-log ${escapeHtml(entry.type)}">
                        <span>${escapeHtml(time)}</span>${escapeHtml(entry.message)}
                    </div>
                `;
            }).join('')
            : '<div class="mia-log">No logs yet.</div>';

        return `
            <div class="mia-content">
                <div class="mia-log-box">${rows}</div>
                <div class="mia-buttons">
                    <button type="button" data-action="copy-logs">Copy logs</button>
                    <button type="button" data-action="clear-logs">Clear logs</button>
                </div>
            </div>
        `;
    }

    /* ================= PANEL RENDERING ================= */
    function renderPanel() {
        if (!panel) return;

        panel.classList.toggle('mia-collapsed', state.panelCollapsed);

        queryAll('.mia-tab', panel).forEach(button => {
            button.classList.toggle('mia-active', button.dataset.tab === state.activeTab);
        });

        const content = query('#mia-tab-content', panel);
        if (!content) return;

        // Do not rebuild the form while the user is typing in it.
        const active = document.activeElement;
        if (
            state.activeTab === 'configuration' &&
            active &&
            panel.contains(active) &&
            active.matches('input, textarea')
        ) {
            return;
        }

        if (state.activeTab === 'status') content.innerHTML = renderStatusTab();
        else if (state.activeTab === 'logs') content.innerHTML = renderLogsTab();
        else content.innerHTML = renderConfigurationTab();

        const collapseButton = query('#mia-collapse', panel);
        if (collapseButton) collapseButton.textContent = state.panelCollapsed ? '+' : '−';
    }

    /* ================= PANEL EVENTS ================= */
    function handlePanelClick(event) {
        const tabButton = event.target.closest('[data-tab]');
        if (tabButton) {
            state.activeTab = tabButton.dataset.tab;
            saveState();
            renderPanel();
            return;
        }

        const actionButton = event.target.closest('[data-action]');
        if (!actionButton) return;

        const action = actionButton.dataset.action;

        if (action === 'start') startAutomation();
        else if (action === 'pause') pauseAutomation();
        else if (action === 'resume') resumeAutomation();
        else if (action === 'stop') stopAutomation();
        else if (action === 'skip-stuck') skipStuckContainer();
        else if (action === 'retry') retrySkippedAndFailed();
        else if (action === 'reset') resetAll();
        else if (action === 'clear-logs') {
            state.logs = [];
            saveState();
            renderPanel();
        } else if (action === 'copy-logs') {
            const text = state.logs
                .map(entry => `${entry.time} [${entry.type}] ${entry.message}`)
                .join('\n');
            navigator.clipboard.writeText(text).catch(() => {
                addLog('Could not copy logs.', 'warn');
            });
        }
    }

    /* ================= PANEL CREATION ================= */
    function injectPanelStyles() {
        const id = CONFIG.panelId;
        const style = document.createElement('style');
        style.textContent = `
            #${id}, #${id} * { box-sizing: border-box; }
            #${id} {
                position: fixed; top: 70px; right: 18px; width: 410px;
                max-width: calc(100vw - 20px); z-index: 2147483647; overflow: hidden;
                color: #263c4b; background: #fff; border: 1px solid #d9dee2;
                border-radius: 15px; box-shadow: 0 15px 45px rgba(0,0,0,0.20);
                font-family: Arial, sans-serif; font-size: 14px;
            }
            #${id}.mia-collapsed { width: 310px; }
            #${id}.mia-collapsed .mia-body { display: none; }
            #${id} .mia-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 13px 15px; border-bottom: 1px solid #e5e8ea; cursor: move;
                font-size: 16px; font-weight: 700; user-select: none;
            }
            #${id} .mia-header button {
                width: 30px; height: 30px; padding: 0; color: #75838c;
                background: transparent; border: 0; border-radius: 6px;
                font-size: 21px; cursor: pointer;
            }
            #${id} .mia-tabs {
                display: grid; grid-template-columns: repeat(3, 1fr);
                border-bottom: 1px solid #e5e8ea; background: #fafbfb;
            }
            #${id} .mia-tab {
                padding: 13px 5px; color: #78848c; background: transparent;
                border: 0; cursor: pointer;
            }
            #${id} .mia-tab.mia-active {
                color: #06455d; border-bottom: 3px solid #064f6b; font-weight: 700;
            }
            #${id} .mia-content { max-height: 72vh; padding: 15px; overflow: auto; }
            #${id} .mia-label { display: block; margin-bottom: 7px; font-weight: 700; }
            #${id} .mia-label small { color: #82909a; font-weight: 400; }
            #${id} .mia-top { margin-top: 14px; }
            #${id} .mia-input, #${id} .mia-textarea {
                width: 100%; padding: 10px; border: 2px solid #d6dbde;
                border-radius: 8px; outline: none; font-family: Consolas, monospace;
                font-size: 13px;
            }
            #${id} .mia-input:focus, #${id} .mia-textarea:focus { border-color: #4380a0; }
            #${id} .mia-textarea { min-height: 130px; resize: vertical; }
            #${id} .mia-counter { margin-top: 5px; color: #78848c; text-align: right; font-size: 12px; }
            #${id} .mia-warning {
                margin-top: 12px; padding: 10px; color: #5d4500; background: #fff7d8;
                border: 1px solid #ead68a; border-radius: 8px; font-size: 12px;
            }
            #${id} .mia-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 11px; }
            #${id} .mia-buttons button:only-child { grid-column: 1 / -1; }
            #${id} .mia-buttons button {
                min-height: 40px; padding: 9px; background: #fff;
                border: 1px solid #aeb8bf; border-radius: 8px; font-weight: 700; cursor: pointer;
            }
            #${id} .mia-buttons button.mia-primary { background: #ffd814; border-color: #e8c400; }
            #${id} .mia-buttons button.mia-danger { color: #fff; background: #ad2929; border-color: #922020; }
            #${id} .mia-buttons button.mia-warn-btn {
                color: #fff; background: #e07b00; border-color: #b86200;
            }
            #${id} button:disabled { opacity: 0.45; cursor: not-allowed; }
            #${id} .mia-status-card {
                padding: 12px; background: #f4f7f8; border: 1px solid #e0e5e7; border-radius: 9px;
            }
            #${id} .mia-status-card.mia-stuck { background: #fff1e0; border-color: #e07b00; }
            #${id} .mia-message { margin-top: 5px; }
            #${id} .mia-progress {
                height: 9px; margin: 10px 0 5px; overflow: hidden;
                background: #dfe5e7; border-radius: 10px;
            }
            #${id} .mia-progress div { height: 100%; background: #16799d; }
            #${id} .mia-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 11px; }
            #${id} .mia-grid > div { padding: 9px; border: 1px solid #e1e5e7; border-radius: 8px; }
            #${id} .mia-grid small { display: block; color: #77838b; text-transform: uppercase; font-size: 10px; }
            #${id} .mia-grid strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
            #${id} .mia-log-box {
                height: 320px; padding: 7px; overflow: auto; color: #dbe5e9;
                background: #17242c; border-radius: 8px; font-family: Consolas, monospace; font-size: 11px;
            }
            #${id} .mia-log { padding: 5px; border-bottom: 1px solid rgba(255,255,255,0.06); overflow-wrap: anywhere; }
            #${id} .mia-log span { margin-right: 6px; color: #8ca1ac; }
            #${id} .mia-log.error { color: #ff9d9d; }
            #${id} .mia-log.warn { color: #ffd27b; }
            @media (max-width: 600px) {
                #${id} { right: 8px; left: 8px; width: auto; max-width: none; }
            }
        `;
        document.head.appendChild(style);
    }

    function createPanel() {
        const existing = query(`#${CONFIG.panelId}`);
        if (existing) {
            panel = existing;
            return;
        }

        injectPanelStyles();

        panel = document.createElement('section');
        panel.id = CONFIG.panelId;
        panel.innerHTML = `
            <div class="mia-header" id="mia-drag-handle">
                <span>↪ MoveItems Automation</span>
                <button type="button" id="mia-collapse" title="Collapse">−</button>
            </div>
            <div class="mia-body">
                <div class="mia-tabs">
                    <button type="button" class="mia-tab" data-tab="configuration">Configuration</button>
                    <button type="button" class="mia-tab" data-tab="status">Status</button>
                    <button type="button" class="mia-tab" data-tab="logs">Logs</button>
                </div>
                <div id="mia-tab-content"></div>
            </div>
        `;
        document.body.appendChild(panel);

        if (Number.isFinite(state.panelX)) {
            panel.style.left = `${state.panelX}px`;
            panel.style.right = 'auto';
        }
        if (Number.isFinite(state.panelY)) {
            panel.style.top = `${state.panelY}px`;
        }

        panel.addEventListener('click', handlePanelClick);

        query('#mia-collapse', panel).addEventListener('click', event => {
            event.stopPropagation();
            state.panelCollapsed = !state.panelCollapsed;
            saveState();
            renderPanel();
        });

        makePanelDraggable(panel, query('#mia-drag-handle', panel));
        renderPanel();
    }

    function makePanelDraggable(element, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) return;
            const rectangle = element.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rectangle.left;
            offsetY = event.clientY - rectangle.top;
            handle.setPointerCapture(event.pointerId);
        });

        handle.addEventListener('pointermove', event => {
            if (!dragging) return;
            const maximumX = Math.max(0, window.innerWidth - element.offsetWidth);
            const maximumY = Math.max(0, window.innerHeight - 50);
            const x = Math.max(0, Math.min(maximumX, event.clientX - offsetX));
            const y = Math.max(0, Math.min(maximumY, event.clientY - offsetY));

            element.style.left = `${x}px`;
            element.style.top = `${y}px`;
            element.style.right = 'auto';
            state.panelX = x;
            state.panelY = y;
        });

        function stopDragging() {
            if (!dragging) return;
            dragging = false;
            saveState();
        }

        handle.addEventListener('pointerup', stopDragging);
        handle.addEventListener('pointercancel', stopDragging);
    }

    /* ================= INITIALISATION ================= */
    function initialise() {
        createPanel();

        if (state.running && !state.paused) {
            addLog('Automation restored after page navigation.');
            resetPageTimeout();
        }

        window.setInterval(automationTick, CONFIG.checkInterval);

        const observer = new MutationObserver(mutations => {
            if (!state.running || state.paused) return;
            // Ignore the panel's own re-renders.
            const external = mutations.some(mutation => !inPanel(mutation.target));
            if (external) window.setTimeout(automationTick, 50);
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('beforeunload', saveState);
    }

    initialise();
})();
