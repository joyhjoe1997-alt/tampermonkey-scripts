// ==UserScript==
// @name         Multi-container & Multi-ASIN EditItems Auto Expiration Date
// @author       ibnahlho
// @version      3.3
// @description  Auto EditItems Multi-container Expiration Date & Multi-ASIN
// @match        https://aft-qt-eu.aka.amazon.com/app/edititems?experience=Desktop*
// @include      https://aft-qt-eu.aka.amazon.com/app/edititems*
// @updateURL    https://axzile.corp.amazon.com/-/carthamus/download_script/multi-container-edit-items-auto-expiration-date.user.js
// @downloadURL  https://axzile.corp.amazon.com/-/carthamus/script/multi-container-edit-items-auto-expiration-date
// @icon         https://i.imgur.com/9cJLVsI.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
╔══════════════════════════════════════════════════════╗
║                                                      ║
║     📦 MULTI-CONTAINER EDITITEMS AUTOMATION         ║
║                                                      ║
║                    by ibnahlho                      ║
║                      v3.3                            ║
╠══════════════════════════════════════════════════════╣
║  ┌─────── CORE FEATURES ───────────────┐           ║
║  │                                      │           ║
║  │  📋 Container List (one per line)    │           ║
║  │  🏷️ Single or Multi-ASIN mode        │           ║
║  │  📅 Auto-fill Expiration Date        │           ║
║  │  ▶️ Start • ⏸️ Pause • 🔄 Reset       │           ║
║  │  📊 Progress bar & counters          │           ║
║  │  💾 Auto-saves everything            │           ║
║  │                                      │           ║
║  └──────────────────────────────────────┘           ║
╠══════════════════════════════════════════════════════╣
║  ┌─────── MULTI-ASIN CICLO CORRETTO ───┐           ║
║  │                                      │           ║
║  │  Per ogni container:                 │           ║
║  │  ├── ASIN 1/n → Salva → Start over   │           ║
║  │  ├── ASIN 2/n → Salva → Start over   │           ║
║  │  ├── ...                             │           ║
║  │  └── ASIN n/n → Salva → Start over   │           ║
║  │  └── ✅ Passa al prossimo container   │           ║
║  │                                      │           ║
║  └──────────────────────────────────────┘           ║
╚══════════════════════════════════════════════════════╝
*/
(function () {
    'use strict';

    const LS = {
        running:      'mcsa_running',
        sticky:       'mcsa_sticky',
        containers:   'mcsa_containers',
        cidx:         'mcsa_cidx',
        asin:         'mcsa_asin',
        y:            'mcsa_year',
        m:            'mcsa_month',
        d:            'mcsa_day',
        justSaved:    'mcsa_justSaved',
        advance:      'mcsa_advancing',
        overwrite:    'mcsa_overwrite',
        notifications:'mcsa_notifications',
        optionsVisible: 'mcsa_options_visible',
        multiAsinMode:  'mcsa_multi_asin_mode',
        currentAsinIndex: 'mcsa_current_asin_index',
        asinList:        'mcsa_asin_list'
    };

    const get = (k, def='') => localStorage.getItem(k) ?? def;
    const set = (k, v) => localStorage.setItem(k, v);

    const getRunning = () => get(LS.running)==='true';
    const setRunning = v => set(LS.running, v ? 'true' : 'false');

    const getSticky = () => get(LS.sticky)==='true';
    const setSticky = v => set(LS.sticky, v ? 'true' : 'false');

    const getASIN = () => (get(LS.asin)||'').trim();
    const setASIN = s => set(LS.asin, (s||'').trim());

    const getCIdx = () => parseInt(get(LS.cidx)||'0',10);
    const setCIdx = n => set(LS.cidx, String(Math.max(0,n)));

    const setYMD = (y,m,d)=>{ set(LS.y,String(y??'')); set(LS.m,String(m??'')); set(LS.d,String(d??'')); };
    const getYMD = ()=>({ y:get(LS.y), m:get(LS.m), d:get(LS.d) });

    const setJustSaved = v => set(LS.justSaved, v ? 'true':'false');
    const getJustSaved = ()=> get(LS.justSaved)==='true';

    const isAdvancing  = () => get(LS.advance) === '1';
    const setAdvancing = v  => set(LS.advance, v ? '1' : '0');

    const getOverwrite = () => get(LS.overwrite)==='true';
    const setOverwrite = v => set(LS.overwrite, v ? 'true' : 'false');

    const getNotifications = () => get(LS.notifications)==='true';
    const setNotifications = v => set(LS.notifications, v ? 'true' : 'false');

    const getOptionsVisible = () => get(LS.optionsVisible)==='true';
    const setOptionsVisible = v => set(LS.optionsVisible, v ? 'true' : 'false');

    const getMultiAsinMode = () => get(LS.multiAsinMode) === 'true';
    const setMultiAsinMode = v => set(LS.multiAsinMode, v ? 'true' : 'false');

    const getCurrentAsinIndex = () => parseInt(get(LS.currentAsinIndex) || '0', 10);
    const setCurrentAsinIndex = n => set(LS.currentAsinIndex, String(Math.max(0, n)));

    const getAsinList = () => (get(LS.asinList) || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    const setAsinList = arr => set(LS.asinList, Array.isArray(arr) ? arr.join('\n') : arr);

    const wait = (ms)=> new Promise(r=>setTimeout(r,ms));

    const setStatus = s => {
        const el=document.getElementById('mcsa-status');
        if(el) el.textContent=s||'';
        addLogEntry(s || 'Status cleared');
    };

    const getContainersArr = () => (get(LS.containers)||'')
    .split(/\r?\n/)
    .map(s=>s.trim())
    .filter(Boolean);

    function parseDateInput() {
        const {y,m,d} = getYMD();
        const Y = parseInt(y,10), M = parseInt(m,10), D = parseInt(d,10);
        if (!isNaN(Y) && !isNaN(M) && !isNaN(D)) return {y:Y,m:M,d:D};
        return null;
    }

    // === SLIDE OPTIONS PANEL ===
    function injectPanel(){
        if (document.getElementById('mcsa-panel')) return;

        const wrap = document.createElement('div');
        wrap.id = 'mcsa-panel';
        wrap.innerHTML = `
      <div id="mcsa-head">
        <button id="mcsa-tab" class="tab" title="Open/close panel">
          <span class="tab-icon">⚙️</span>
          <span class="tab-text">Auto EditItems Multi-container</span>
          <span id="mcsa-status-badge" class="status-badge stopped"></span>
        </button>
      </div>

      <div id="mcsa-body" style="display:none">
        <div class="panel-header">
          <h3>🔄 Edit Items Automation</h3>
          <button id="mcsa-close" class="btn-close" title="Close">×</button>
        </div>

        <div class="tabs">
          <button class="tab-btn active" data-tab="config">Configuration</button>
          <button class="tab-btn" data-tab="status">Status</button>
          <button class="tab-btn" data-tab="logs">Logs</button>
        </div>

        <div class="tab-content active" id="tab-config">
          <div class="section">
            <div class="section-header">
              <h4>📦 Containers</h4>
              <span class="hint">(one per line)</span>
            </div>
            <textarea id="mcsa-containers-ta" rows="5"
                      placeholder="Enter container codes...
Example:
tsX00000
csX00000"></textarea>
            <div class="counter">
              <span id="mcsa-container-count">0</span> containers entered
            </div>
          </div>

          <!-- ASIN section that changes based on mode -->
          <div class="section" id="mcsa-asin-section">
            <div class="section-header">
              <h4 id="mcsa-asin-title">🏷️ Single ASIN</h4>
              <span id="mcsa-asin-hint" class="hint"></span>
            </div>
            <div id="mcsa-single-asin-container">
              <div class="input-with-action">
                <input id="mcsa-asin" type="text" placeholder="B07XXXXXXXX">
                <button id="mcsa-clear-asin" class="btn-action" title="Clear">✕</button>
              </div>
            </div>
            <div id="mcsa-multi-asin-container" style="display: none;">
              <textarea id="mcsa-multi-asin-ta" rows="4"
                        placeholder="Enter ASINs for this container...
Example:
B07XXXXXXXX
B08YYYYYYYY
B09ZZZZZZZZ"></textarea>
              <div class="counter">
                <span id="mcsa-multi-asin-count">0</span> ASINs entered
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-header">
              <h4>📅 Expiration Date</h4>
            </div>
            <div class="date-grid">
              <div class="date-field">
                <label for="mcsa-year">Year</label>
                <input id="mcsa-year" type="number" min="2024" max="2100" placeholder="YYYY">
              </div>
              <div class="date-field">
                <label for="mcsa-month">Month</label>
                <input id="mcsa-month" type="number" min="1" max="12" placeholder="MM">
              </div>
              <div class="date-field">
                <label for="mcsa-day">Day</label>
                <input id="mcsa-day" type="number" min="1" max="31" placeholder="DD">
              </div>
            </div>
            <div id="mcsa-date-preview" class="date-preview"></div>
          </div>

          <!-- OPTIONS IN SLIDE DROPDOWN -->
          <div class="options-dropdown" id="mcsa-options-dropdown">
            <div class="dropdown-header" id="mcsa-options-toggle">
              <h4>⚡ Options</h4>
              <span class="dropdown-arrow">▼</span>
            </div>
            <div class="dropdown-content" id="mcsa-options-content" style="display: none;">
              <div class="options-grid">
                <label class="option">
                  <input id="mcsa-overwrite" type="checkbox">
                  <span class="checkmark"></span>
                  <span class="option-text">
                    <strong>Overwrite existing dates</strong>
                    <small>Remove already present dates</small>
                  </span>
                </label>
                <label class="option">
                  <input id="mcsa-notifications" type="checkbox" checked>
                  <span class="checkmark"></span>
                  <span class="option-text">
                    <strong>Notifications</strong>
                    <small>Show completion alerts</small>
                  </span>
                </label>
                <label class="option">
                  <input id="mcsa-multi-asin" type="checkbox">
                  <span class="checkmark"></span>
                  <span class="option-text">
                    <strong>Multi-ASIN Mode</strong>
                    <small>Process multiple ASINs per container (ciclo corretto)</small>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="progress-section">
            <div class="progress-header">
              <span>Progress</span>
              <span id="mcsa-progress-text">0/0</span>
            </div>
            <div class="progress-bar">
              <div id="mcsa-progress-fill" class="progress-fill" style="width: 0%"></div>
            </div>
          </div>

          <div class="action-buttons">
            <button id="mcsa-start" class="btn-primary btn-start">
              <span class="btn-icon">▶️</span>
              <span class="btn-text">Start</span>
            </button>
            <button id="mcsa-pause" class="btn-secondary btn-pause">
              <span class="btn-icon">⏸️</span>
              <span class="btn-text">Pause</span>
            </button>
            <button id="mcsa-reset" class="btn-secondary btn-reset">
              <span class="btn-icon">🔄</span>
              <span class="btn-text">Reset</span>
            </button>
          </div>
        </div>

        <div class="tab-content" id="tab-status">
          <div class="status-card">
            <div class="status-item">
              <span class="status-label">Status:</span>
              <span id="mcsa-status" class="status-value idle">Waiting</span>
            </div>
            <div class="status-item">
              <span class="status-label">Current container:</span>
              <span id="mcsa-current-container" class="status-value">-</span>
            </div>
            <div class="status-item">
              <span class="status-label">Current ASIN:</span>
              <span id="mcsa-current-asin" class="status-value">-</span>
            </div>
            <div class="status-item">
              <span class="status-label">Progress:</span>
              <span id="mcsa-progress-detail" class="status-value">0/0 (0%)</span>
            </div>
            <div class="status-item">
              <span class="status-label">Last action:</span>
              <span id="mcsa-last-action" class="status-value">-</span>
            </div>
          </div>

          <div class="quick-actions">
            <button id="mcsa-skip" class="btn-small">
              ⏭️ Skip container
            </button>
            <button id="mcsa-retry" class="btn-small">
              🔄 Retry current
            </button>
          </div>
        </div>

        <div class="tab-content" id="tab-logs">
          <div class="logs-header">
            <h4>📝 Activity Log</h4>
            <button id="mcsa-clear-logs" class="btn-small">Clear logs</button>
          </div>
          <div id="mcsa-logs" class="logs-container">
            <!-- Logs will appear here -->
          </div>
        </div>
      </div>
    `;
        document.body.appendChild(wrap);

        const css = document.createElement('style');
        css.textContent = `
      #mcsa-head {
        position: fixed;
        top: 72px;
        right: 18px;
        z-index: 1000000;
      }

      #mcsa-tab {
        background: linear-gradient(135deg, #0b3948 0%, #0a2d3a 100%);
        color: #fff;
        border: none;
        cursor: pointer;
        padding: 10px 16px;
        border-radius: 20px;
        font: 14px/1 'Segoe UI', system-ui, Arial, sans-serif;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        display: flex;
        align-items: center;
        gap: 8px;
        transition: all 0.3s ease;
        border: 2px solid transparent;
      }

      #mcsa-tab:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        border-color: #1abc9c;
      }

      .tab-icon {
        font-size: 16px;
      }

      .tab-text {
        font-weight: 600;
      }

      .status-badge {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-left: 4px;
      }

      .status-badge.running {
        background: #2ecc71;
        box-shadow: 0 0 8px #2ecc71;
      }

      .status-badge.paused {
        background: #f39c12;
        box-shadow: 0 0 8px #f39c12;
      }

      .status-badge.stopped {
        background: #e74c3c;
        box-shadow: 0 0 8px #e74c3c;
      }

      #mcsa-body {
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 16px;
        padding: 0;
        width: 420px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        position: fixed;
        top: 120px;
        right: 18px;
        z-index: 999999;
        max-height: 80vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .panel-header {
        padding: 16px;
        border-bottom: 1px solid #eee;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f8f9fa;
        border-radius: 16px 16px 0 0;
      }

      .panel-header h3 {
        margin: 0;
        font-size: 16px;
        color: #2c3e50;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .btn-close {
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #95a5a6;
        padding: 0 8px;
        line-height: 1;
      }

      .btn-close:hover {
        color: #e74c3c;
      }

      .tabs {
        display: flex;
        border-bottom: 1px solid #eee;
        padding: 0 16px;
        background: #f8f9fa;
      }

      .tab-btn {
        flex: 1;
        padding: 12px;
        border: none;
        background: none;
        cursor: pointer;
        font-weight: 500;
        color: #7f8c8d;
        border-bottom: 3px solid transparent;
        transition: all 0.2s;
      }

      .tab-btn.active {
        color: #0b3948;
        border-bottom-color: #0b3948;
        background: rgba(11, 57, 72, 0.05);
      }

      .tab-btn:hover:not(.active) {
        color: #3498db;
      }

      .tab-content {
        padding: 16px;
        overflow-y: auto;
        flex: 1;
        display: none;
      }

      .tab-content.active {
        display: block;
      }

      .section {
        margin-bottom: 20px;
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }

      .section-header h4 {
        margin: 0;
        font-size: 14px;
        color: #2c3e50;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .hint {
        font-size: 12px;
        color: #95a5a6;
      }

      textarea, input[type="text"], input[type="number"] {
        width: 100%;
        padding: 10px 12px;
        border: 2px solid #e0e0e0;
        border-radius: 8px;
        font-size: 14px;
        transition: border-color 0.2s;
        box-sizing: border-box;
      }

      textarea:focus, input:focus {
        outline: none;
        border-color: #0b3948;
        box-shadow: 0 0 0 3px rgba(11, 57, 72, 0.1);
      }

      textarea {
        resize: vertical;
        font-family: monospace;
        font-size: 13px;
      }

      .counter {
        font-size: 12px;
        color: #7f8c8d;
        text-align: right;
        margin-top: 4px;
      }

      .input-with-action {
        display: flex;
        gap: 8px;
      }

      .input-with-action input {
        flex: 1;
      }

      .btn-action {
        background: #f8f9fa;
        border: 2px solid #e0e0e0;
        border-radius: 8px;
        padding: 0 12px;
        cursor: pointer;
        color: #95a5a6;
      }

      .btn-action:hover {
        background: #e74c3c;
        color: white;
        border-color: #e74c3c;
      }

      .date-grid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
        margin-bottom: 12px;
      }

      .date-field label {
        display: block;
        font-size: 12px;
        color: #7f8c8d;
        margin-bottom: 4px;
        font-weight: 500;
      }

      .date-preview {
        text-align: center;
        padding: 8px;
        background: #f8f9fa;
        border-radius: 8px;
        font-size: 14px;
        color: #2c3e50;
        font-weight: 500;
      }

      /* OPTIONS DROPDOWN STYLE */
      .options-dropdown {
        margin: 20px 0;
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        overflow: hidden;
        background: #f8f9fa;
      }

      .dropdown-header {
        padding: 14px 16px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: pointer;
        user-select: none;
        transition: background 0.2s;
      }

      .dropdown-header:hover {
        background: #e8e8e8;
      }

      .dropdown-header h4 {
        margin: 0;
        font-size: 14px;
        color: #2c3e50;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .dropdown-arrow {
        font-size: 12px;
        color: #7f8c8d;
        transition: transform 0.3s ease;
      }

      .dropdown-header.active .dropdown-arrow {
        transform: rotate(180deg);
      }

      .dropdown-content {
        padding: 0 16px;
        max-height: 0;
        overflow: hidden;
        transition: all 0.3s ease;
        background: #fff;
      }

      .dropdown-content.show {
        padding: 16px;
        max-height: 500px;
        border-top: 1px solid #e0e0e0;
      }

      .options-grid {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .option {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        cursor: pointer;
        padding: 8px;
        border-radius: 8px;
        transition: background 0.2s;
      }

      .option:hover {
        background: #f8f9fa;
      }

      .option input {
        margin-top: 2px;
      }

      .option-text {
        flex: 1;
      }

      .option-text strong {
        display: block;
        font-size: 14px;
        color: #2c3e50;
        margin-bottom: 2px;
      }

      .option-text small {
        display: block;
        font-size: 12px;
        color: #95a5a6;
      }

      .progress-section {
        background: #f8f9fa;
        padding: 16px;
        border-radius: 12px;
        margin: 20px 0;
      }

      .progress-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 12px;
        font-size: 14px;
        color: #2c3e50;
        font-weight: 500;
      }

      .progress-bar {
        height: 8px;
        background: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #2ecc71 0%, #1abc9c 100%);
        border-radius: 4px;
        transition: width 0.3s ease;
      }

      .action-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 20px;
      }

      .btn-primary, .btn-secondary {
        padding: 12px;
        border: none;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: all 0.2s;
      }

      .btn-primary {
        background: linear-gradient(135deg, #0b3948 0%, #1abc9c 100%);
        color: white;
        grid-column: span 2;
      }

      .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(11, 57, 72, 0.3);
      }

      .btn-secondary {
        background: #f8f9fa;
        color: #2c3e50;
        border: 2px solid #e0e0e0;
      }

      .btn-secondary:hover {
        background: #e8e8e8;
        border-color: #0b3948;
      }

      .btn-start.running {
        background: linear-gradient(135deg, #f39c12 0%, #e74c3c 100%);
      }

      .status-card {
        background: #f8f9fa;
        padding: 20px;
        border-radius: 12px;
        margin-bottom: 20px;
      }

      .status-item {
        display: flex;
        justify-content: space-between;
        margin-bottom: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid #eee;
      }

      .status-item:last-child {
        margin-bottom: 0;
        border-bottom: none;
      }

      .status-label {
        color: #7f8c8d;
        font-size: 14px;
      }

      .status-value {
        font-weight: 600;
        color: #2c3e50;
      }

      .status-value.idle {
        color: #95a5a6;
      }

      .status-value.running {
        color: #2ecc71;
      }

      .status-value.paused {
        color: #f39c12;
      }

      .status-value.error {
        color: #e74c3c;
      }

      .quick-actions {
        display: flex;
        gap: 12px;
      }

      .btn-small {
        flex: 1;
        padding: 8px 12px;
        background: #f8f9fa;
        border: 1px solid #ddd;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }

      .btn-small:hover {
        background: #e8e8e8;
      }

      .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .logs-container {
        background: #f8f9fa;
        border-radius: 8px;
        padding: 12px;
        max-height: 300px;
        overflow-y: auto;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.4;
      }

      .log-entry {
        padding: 4px 0;
        border-bottom: 1px solid #eee;
      }

      .log-entry:last-child {
        border-bottom: none;
      }

      .log-time {
        color: #95a5a6;
        margin-right: 8px;
      }

      .log-message {
        color: #2c3e50;
      }

      .log-success {
        color: #2ecc71;
      }

      .log-error {
        color: #e74c3c;
      }

      .log-warning {
        color: #f39c12;
      }

      .log-info {
        color: #3498db;
      }
    `;
        document.head.appendChild(css);

        // Initialize UI elements
        const body = wrap.querySelector('#mcsa-body');
        const tabBtns = wrap.querySelectorAll('.tab-btn');
        const tabContents = wrap.querySelectorAll('.tab-content');

        // Tab management
        tabBtns.forEach(btn => {
            btn.onclick = () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
            };
        });

        // Panel events
        document.getElementById('mcsa-tab').onclick = () => {
            body.style.display = (body.style.display === 'none' || !body.style.display) ? 'flex' : 'none';
            updateStatusBadge();
        };

        document.getElementById('mcsa-close').onclick = () => {
            body.style.display = 'none';
        };

        // Load saved values
        document.getElementById('mcsa-containers-ta').value = get(LS.containers) || '';
        document.getElementById('mcsa-asin').value = getASIN();
        const { y, m, d } = getYMD();
        document.getElementById('mcsa-year').value = y || '';
        document.getElementById('mcsa-month').value = m || '';
        document.getElementById('mcsa-day').value = d || '';
        document.getElementById('mcsa-overwrite').checked = getOverwrite();
        document.getElementById('mcsa-notifications').checked = getNotifications();

        // Multi-ASIN options
        const multiAsinCheck = document.getElementById('mcsa-multi-asin');
        const singleAsinContainer = document.getElementById('mcsa-single-asin-container');
        const multiAsinContainer = document.getElementById('mcsa-multi-asin-container');
        const asinTitle = document.getElementById('mcsa-asin-title');
        const asinHint = document.getElementById('mcsa-asin-hint');
        const multiAsinTa = document.getElementById('mcsa-multi-asin-ta');

        multiAsinCheck.checked = getMultiAsinMode();
        multiAsinTa.value = getAsinList().join('\n');

        // Function to update UI based on mode
        function updateAsinUIMode() {
            const isMulti = multiAsinCheck.checked;

            if (isMulti) {
                // Multi-ASIN Mode
                asinTitle.innerHTML = '📋 Multi-ASIN List';
                asinHint.textContent = '(one per line - tutti per ogni container)';
                singleAsinContainer.style.display = 'none';
                multiAsinContainer.style.display = 'block';
            } else {
                // Single ASIN Mode
                asinTitle.innerHTML = '🏷️ Single ASIN';
                asinHint.textContent = '';
                singleAsinContainer.style.display = 'block';
                multiAsinContainer.style.display = 'none';
            }
        }

        // Apply initial UI
        updateAsinUIMode();

        // Event listeners for Multi-ASIN
        multiAsinCheck.addEventListener('change', e => {
            setMultiAsinMode(e.target.checked);
            updateAsinUIMode();

            if (e.target.checked) {
                updateMultiAsinCount();
            }
        });

        multiAsinTa.addEventListener('input', e => {
            setAsinList(e.target.value);
            updateMultiAsinCount();
        });

        // Event listeners
        document.getElementById('mcsa-containers-ta').addEventListener('input', e => {
            set(LS.containers, e.target.value || '');
            updateContainerCount();
            updateProgress();
        });

        document.getElementById('mcsa-asin').addEventListener('input', e => setASIN(e.target.value));
        document.getElementById('mcsa-clear-asin').onclick = () => {
            document.getElementById('mcsa-asin').value = '';
            setASIN('');
        };

        // Date inputs events
        ['year', 'month', 'day'].forEach(field => {
            document.getElementById(`mcsa-${field}`).addEventListener('input', updateDatePreview);
        });

        // Options event listeners
        document.getElementById('mcsa-overwrite').addEventListener('change', e => setOverwrite(e.target.checked));
        document.getElementById('mcsa-notifications').addEventListener('change', e => setNotifications(e.target.checked));

        // Options dropdown management
        const optionsToggle = document.getElementById('mcsa-options-toggle');
        const optionsContent = document.getElementById('mcsa-options-content');
        const optionsArrow = optionsToggle.querySelector('.dropdown-arrow');

        // Initialize dropdown state
        const isVisible = getOptionsVisible();
        if (isVisible) {
            optionsToggle.classList.add('active');
            optionsContent.style.display = 'block';
            optionsContent.classList.add('show');
            optionsArrow.textContent = '▲';
        } else {
            optionsToggle.classList.remove('active');
            optionsContent.style.display = 'none';
            optionsContent.classList.remove('show');
            optionsArrow.textContent = '▼';
        }

        optionsToggle.onclick = () => {
            const isOpen = optionsToggle.classList.contains('active');

            if (isOpen) {
                // Close
                optionsToggle.classList.remove('active');
                optionsContent.style.display = 'none';
                optionsContent.classList.remove('show');
                optionsArrow.textContent = '▼';
                optionsArrow.style.transform = 'rotate(0deg)';
                setOptionsVisible(false);
            } else {
                // Open
                optionsToggle.classList.add('active');
                optionsContent.style.display = 'block';
                setTimeout(() => {
                    optionsContent.classList.add('show');
                }, 10);
                optionsArrow.textContent = '▲';
                optionsArrow.style.transform = 'rotate(180deg)';
                setOptionsVisible(true);
            }
        };

        // Support functions for the new panel
        function updateContainerCount() {
            const count = getContainersArr().length;
            document.getElementById('mcsa-container-count').textContent = count;
        }

        function updateMultiAsinCount() {
            const count = getAsinList().length;
            document.getElementById('mcsa-multi-asin-count').textContent = count;
        }

        function updateDatePreview() {
            const y = document.getElementById('mcsa-year').value;
            const m = document.getElementById('mcsa-month').value;
            const d = document.getElementById('mcsa-day').value;
            const preview = document.getElementById('mcsa-date-preview');

            if (y && m && d) {
                preview.textContent = `Date set: ${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
                setYMD(y, m, d);
            } else {
                preview.textContent = 'Enter a complete date';
            }
        }

        function updateProgress() {
            const containers = getContainersArr();
            const current = getCIdx();
            const total = containers.length;

            // Update current ASIN display
            const currentAsinSpan = document.getElementById('mcsa-current-asin');
            if (currentAsinSpan) {
                if (getMultiAsinMode()) {
                    const asinList = getAsinList();
                    const asinIdx = getCurrentAsinIndex();
                    if (asinList.length > 0 && asinIdx < asinList.length) {
                        currentAsinSpan.textContent = `${asinList[asinIdx]} (${asinIdx + 1}/${asinList.length})`;
                    } else {
                        currentAsinSpan.textContent = '-';
                    }
                } else {
                    currentAsinSpan.textContent = getASIN() || '-';
                }
            }

            if (total === 0) {
                document.getElementById('mcsa-progress-fill').style.width = '0%';
                document.getElementById('mcsa-progress-text').textContent = '0/0';
                if (document.getElementById('mcsa-progress-detail')) {
                    document.getElementById('mcsa-progress-detail').textContent = '0/0 (0%)';
                }
                return;
            }

            // Calculate progress considering multi-ASINs
            let percent;
            let progressText;

            if (getMultiAsinMode() && getAsinList().length > 0) {
                const asinList = getAsinList();
                const asinIdx = getCurrentAsinIndex();
                const totalSteps = total * asinList.length;
                const currentStep = (current * asinList.length) + asinIdx;
                percent = Math.min(100, Math.round((currentStep / totalSteps) * 100));
                progressText = `Container ${current+1}/${total} - ASIN ${asinIdx+1}/${asinList.length}`;
            } else {
                percent = Math.min(100, Math.round((current / total) * 100));
                progressText = `${current}/${total}`;
            }

            document.getElementById('mcsa-progress-fill').style.width = `${percent}%`;
            document.getElementById('mcsa-progress-text').textContent = progressText;

            if (document.getElementById('mcsa-progress-detail')) {
                document.getElementById('mcsa-progress-detail').textContent = `${progressText} (${percent}%)`;
            }

            // Update current container
            if (document.getElementById('mcsa-current-container')) {
                document.getElementById('mcsa-current-container').textContent =
                    containers[current] || '-';
            }
        }

        function updateStatusBadge() {
            const badge = document.getElementById('mcsa-status-badge');
            if (!badge) return;

            badge.className = 'status-badge ';

            if (getRunning()) {
                badge.classList.add('running');
                const startBtn = document.getElementById('mcsa-start');
                if (startBtn) startBtn.classList.add('running');
                const btnText = document.querySelector('.btn-text');
                if (btnText) btnText.textContent = 'Running';
            } else if (getSticky()) {
                badge.classList.add('paused');
            } else {
                badge.classList.add('stopped');
                const startBtn = document.getElementById('mcsa-start');
                if (startBtn) startBtn.classList.remove('running');
                const btnText = document.querySelector('.btn-text');
                if (btnText) btnText.textContent = 'Start';
            }
        }

        // Button functions
        function doPause(){
            setRunning(false);
            setSticky(false);
            setAdvancing(false);
            setStatus('Paused');
            updateStatusBadge();
        }

        function doReset(){
            setRunning(false);
            setSticky(false);
            set(LS.containers,'');
            setCIdx(0);
            setASIN('');
            setAsinList([]);
            setMultiAsinMode(false);
            setCurrentAsinIndex(0);
            setYMD('','','');
            set(LS.justSaved,'false');
            set(LS.advance,'0');
            setOverwrite(false);
            setNotifications(true);
            setOptionsVisible(false);

            document.getElementById('mcsa-containers-ta').value='';
            document.getElementById('mcsa-asin').value='';
            document.getElementById('mcsa-multi-asin').checked=false;
            document.getElementById('mcsa-multi-asin-ta').value='';
            document.getElementById('mcsa-year').value='';
            document.getElementById('mcsa-month').value='';
            document.getElementById('mcsa-day').value='';
            document.getElementById('mcsa-overwrite').checked=false;
            document.getElementById('mcsa-notifications').checked=true;

            // Update UI mode
            updateAsinUIMode();
            updateContainerCount();
            updateMultiAsinCount();
            updateDatePreview();
            updateProgress();
            setStatus('Complete reset');
            addLogEntry('Complete reset performed', 'info');
            updateStatusBadge();
        }

        function doStart(){
            const arr = getContainersArr();
            if (arr.length===0) return setStatus('Enter at least one container (one per line)');

            // ASIN validation based on mode
            if (getMultiAsinMode()) {
                const asinList = getAsinList();
                if (asinList.length === 0) {
                    return setStatus('Enter at least one ASIN in the multi-ASIN list');
                }
            } else {
                if (!getASIN()) return setStatus('Enter ASIN');
            }

            if (!parseDateInput()) return setStatus('Enter date (Year/Month/Day)');

            let idx = getCIdx();
            if (isNaN(idx) || idx < 0 || idx >= arr.length) { idx = 0; setCIdx(0); }

            // Reset current ASIN index
            setCurrentAsinIndex(0);

            setRunning(true);
            setSticky(true);
            setJustSaved(false);
            setAdvancing(false);

            updateProgress();
            updateStatusBadge();
            setStatus(`Started (resuming from ${idx+1}/${arr.length})`);
            addLogEntry(`Automation started with ${arr.length} containers`, 'success');
            debouncedAct();
        }

        // Button connections
        document.getElementById('mcsa-start').onclick = doStart;
        document.getElementById('mcsa-pause').onclick = doPause;
        document.getElementById('mcsa-reset').onclick = doReset;

        document.getElementById('mcsa-skip').onclick = async () => {
            await goToNextContainer('manually skipped');
            addLogEntry('Container manually skipped', 'warning');
        };
        document.getElementById('mcsa-retry').onclick = () => {
            setStatus('Retrying current container...');
            addLogEntry('Retrying current container', 'info');
            debouncedAct();
        };
        document.getElementById('mcsa-clear-logs').onclick = () => {
            const logsContainer = document.getElementById('mcsa-logs');
            if (logsContainer) logsContainer.innerHTML = '';
            addLogEntry('Logs cleared', 'info');
        };

        // Initialize
        updateContainerCount();
        updateMultiAsinCount();
        updateDatePreview();
        updateProgress();
        updateStatusBadge();

        // Periodic updates
        setInterval(updateProgress, 1000);
        setInterval(updateStatusBadge, 500);

        // Initial log
        addLogEntry('Script loaded successfully - Multi-ASIN ciclo corretto v3.3', 'success');
    }

    // Function to add log (must be defined before injectPanel)
    function addLogEntry(message, type = 'info') {
        const logsContainer = document.getElementById('mcsa-logs');
        if (!logsContainer) return;

        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.innerHTML = `
            <span class="log-time">${time}</span>
            <span class="log-message">${message}</span>
        `;

        logsContainer.prepend(entry);

        // Keep maximum 50 log entries
        const entries = logsContainer.querySelectorAll('.log-entry');
        if (entries.length > 50) {
            entries[entries.length - 1].remove();
        }

        // Update last action
        const lastAction = document.getElementById('mcsa-last-action');
        if (lastAction) lastAction.textContent = message;
    }

    // === ORIGINAL SCRIPT FUNCTIONS ===
    function updateCounters(){
        const total = getContainersArr().length;
        const idx = Math.min(getCIdx(), Math.max(0,total-1));
        const cEl = document.getElementById('mcsa-cnt');
        const tEl = document.getElementById('mcsa-total');
        if (cEl) cEl.textContent = total ? String(idx+1) : '0';
        if (tEl) tEl.textContent = String(total);
    }

    function isVisible(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return !!(el.offsetParent !== null && r.width && r.height);
    }

    function findButtonByText(txts){
        const tokens = String(txts).toLowerCase().split('|').map(s=>s.trim()).filter(Boolean);
        const nodes = [
            ...document.querySelectorAll('button, input[type=button], input[type=submit], .a-button, .a-button .a-button-text')
        ];
        return nodes.find(el => {
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            return isVisible(el) && tokens.some(tok => t.includes(tok));
        }) || null;
    }

    function clickContinue(fromEl){
        const hotkey = document.querySelector('input.a-button-input[data-aft-tool-hotkey="return"]');
        if (hotkey && isVisible(hotkey)) { hotkey.click(); return; }
        const form = fromEl ? fromEl.closest('form') : document.querySelector('form');
        if (form){
            const submit = form.querySelector('input[type=submit], button[type=submit], input.a-button-input');
            if (submit && isVisible(submit)) { submit.click(); return; }
        }
        const cont = findButtonByText('continue|continua|immetti|continua [immetti]');
        if (cont) cont.click();
    }

    const LABELS = {
        BARCODE: /(item\s*barcode|codice a barre dell.?articolo)/i,
        CONTAINER_STRICT: /^(container|contenitore)\s*:?$/i,
        CONTAINER_ANY: /(container|contenitore)/i,
    };

    const pageHasContainerId = () =>
    Array.from(document.querySelectorAll('dt.a-list-item, dt'))
    .some(dt => /(ContainerId|ID contenitore)/i.test(dt.textContent||''));

    function findContainerInput(){
        const labs = Array.from(document.querySelectorAll('label, label.a-form-label'));
        let lab = labs.find(l => LABELS.CONTAINER_STRICT.test((l.textContent || '').trim()));
        if (!lab) lab = labs.find(l => LABELS.CONTAINER_ANY.test((l.textContent || '').trim()));
        if (!lab) return null;

        const forId = lab.getAttribute('for');
        if (forId){
            const byId = document.getElementById(forId);
            if (byId && byId.tagName === 'INPUT' && byId.type === 'text') return byId;
        }
        const wrapper =
              lab.closest('.a-input-text-wrapper') ||
              lab.parentElement?.querySelector('.a-input-text-wrapper') ||
              lab.closest('div, fieldset, form');

        if (wrapper){
            const inp = wrapper.querySelector('input[type="text"]');
            if (inp) return inp;
        }
        return document.querySelector(
            'input[type="text"][id*="container" i], ' +
            'input[type="text"][name*="container" i], ' +
            'input[type="text"][placeholder*="container" i]'
        );
    }

    function isScanContainerPage() {
        const hasContainerLabel = Array
        .from(document.querySelectorAll('label, label.a-form-label'))
        .some(l => LABELS.CONTAINER_STRICT.test((l.textContent || '').trim()));

        const hasBarcodeLabel = Array
        .from(document.querySelectorAll('label, label.a-form-label'))
        .some(l => LABELS.BARCODE.test((l.textContent || '').trim()));

        return hasContainerLabel && !hasBarcodeLabel && !pageHasContainerId();
    }

    function findBarcodeInput(){
        const lab = Array.from(document.querySelectorAll('label, label.a-form-label'))
        .find(l => LABELS.BARCODE.test((l.textContent||'').trim()));
        if (lab){
            const form = lab.closest('form') || document;
            const inp = form.querySelector('input[type="text"]');
            if (inp) return inp;
        }
        return document.querySelector('form .a-input-text-wrapper input[type="text"]') ||
            Array.from(document.querySelectorAll('input[type="text"]')).find(i => i.offsetParent!==null) || null;
    }

    const isEnterExpirationPage      = () => !!(document.getElementById('year-input') && document.getElementById('month-input') && document.getElementById('day-input'));
    const isConfirmNewExpirationPage = () => !!findButtonByText('Save expiration date|Save expiry date|Salva data di scadenza');
    const isStartOverPage            = () => !!findButtonByText('Start over|Start again|Ricomincia|Inizia di nuovo');
    const isRemovalConfirmPage       = () => !!findButtonByText('Remove expiration date|Remove expiry date|Rimuovi data di scadenza');

    function isNotInContainerAlertVisible() {
        return Array.from(document.querySelectorAll('.a-alert-content, .a-box-inner'))
            .some(el => /(is not in the container|non è nel container)/i.test(el.textContent||''));
    }

    async function waitForReadyInputById(id, timeout=8000){
        const start = Date.now();
        while (Date.now()-start < timeout){
            const el = document.getElementById(id);
            if (el && el.offsetParent!==null && !el.disabled && !el.readOnly) return el;
            await wait(100);
        }
        return null;
    }

    function setValueOnce(el, val){
        if (!el) return;
        if (String(el.value||'')===String(val)) return;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        if (desc?.set) desc.set.call(el, String(val)); else el.value = String(val);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
    }

    // FUNZIONE MODIFICATA: goToNextContainer con ciclo corretto per multi-ASIN
    async function goToNextContainer(reason='') {
        if (isAdvancing()) return false;

        // Se siamo in modalità multi-ASIN
        if (getMultiAsinMode()) {
            const asinList = getAsinList();
            const currentAsinIdx = getCurrentAsinIndex();
            const containers = getContainersArr();
            const currentContainerIdx = getCIdx();

            // Se abbiamo ancora ASIN da processare per QUESTO container
            if (currentAsinIdx + 1 < asinList.length) {
                // Incrementa solo l'indice ASIN, NON il container
                setCurrentAsinIndex(currentAsinIdx + 1);
                setStatus(`Passaggio al prossimo ASIN (${currentAsinIdx + 2}/${asinList.length}) per lo stesso container`);
                addLogEntry(`Proseguo con il prossimo ASIN per il container corrente`, 'info');

                // Dopo aver incrementato l'ASIN, dobbiamo tornare alla pagina di scansione
                // Clicchiamo "Start over" per ricominciare il ciclo con lo stesso container
                const startOverBtn = findButtonByText('start over|start again|ricomincia|inizia di nuovo');
                if (startOverBtn) {
                    startOverBtn.click();
                    setStatus('Riavvio per il prossimo ASIN...');
                }
                return true; // Non cambiare container, solo ASIN
            }
        }

        // Se siamo qui: o non siamo in multi-ASIN, o abbiamo finito tutti gli ASIN per questo container
        setAdvancing(true);
        const newIdx = getCIdx() + 1;
        setCIdx(newIdx);

        // Reset dell'indice ASIN per il nuovo container
        setCurrentAsinIndex(0);

        // Aggiorna UI
        updateProgress();

        setStatus(`Passaggio al container ${newIdx+1}${reason ? ' — ' + reason : ''}`);
        addLogEntry(`Container cambiato: ${newIdx+1} ${reason ? '(' + reason + ')' : ''}`, 'info');

        const btn = findButtonByText('change container|cambia container');
        if (btn) btn.click();
        return true;
    }

    async function handleEnterExpirationDate(){
        if (!isEnterExpirationPage()) return false;
        const yi = await waitForReadyInputById('year-input');
        const mi = await waitForReadyInputById('month-input');
        const di = await waitForReadyInputById('day-input');
        if (!yi || !mi || !di) return false;

        if (yi.value && mi.value && di.value) return false;

        const dt = parseDateInput(); if (!dt) return false;
        setValueOnce(yi, dt.y);
        setValueOnce(mi, dt.m);
        setValueOnce(di, dt.d);

        const btn = document.querySelector('input.a-button-input[data-aft-tool-hotkey="return"]');
        if (btn) btn.click(); else clickContinue(di);

        setStatus(`Date set: ${dt.y}-${dt.m}-${dt.d}`);
        addLogEntry(`Expiration date set: ${dt.y}-${dt.m}-${dt.d}`, 'success');
        return true;
    }

    async function handleConfirmNewExpiration(){
        if (!isConfirmNewExpirationPage()) return false;
        const saveBtn = findButtonByText('Save expiration date|Save expiry date|Salva data di scadenza');
        if (saveBtn) {
            saveBtn.click();
            setJustSaved(true);
            setStatus('Saving expiration...');
            addLogEntry('Saving expiration date in progress...', 'info');
            return true;
        }
        return false;
    }

    async function handleStartOverPage(){
        if (!isStartOverPage()) return false;
        const startOverBtn = findButtonByText('start over|start again|ricomincia|inizia di nuovo');
        if (startOverBtn) {
            startOverBtn.click();
            setStatus('Start over...');
            addLogEntry('Start over page', 'info');
            return true;
        }
        return false;
    }

    async function handleRemovalConfirm(){
        if (!isRemovalConfirmPage()) return false;

        if (getOverwrite()){
            const rm = findButtonByText('Remove expiration date|Remove expiry date|Rimuovi data di scadenza');
            if (rm) {
                rm.click();
                setStatus('Removing existing date...');
                addLogEntry('Removing existing expiration date', 'warning');
                return true;
            }
            const so = findButtonByText('start over|start again|ricomincia|inizia di nuovo');
            if (so) {
                so.click();
                setStatus('Start over after removal...');
                return true;
            }
            return false;
        } else {
            await goToNextContainer('skip remove');
            return true;
        }
    }

    // FUNZIONE MODIFICATA: act con gestione migliorata per multi-ASIN
    async function act(){
        try {
            if (getSticky() && !getRunning()) setRunning(true);
            if (!getRunning()) return;

            const containers = getContainersArr();
            if (containers.length===0){
                setStatus('Empty container list');
                setRunning(false);
                setSticky(false);
                return;
            }

            let idx = getCIdx();
            if (idx >= containers.length){
                setStatus('Completed: all containers');
                addLogEntry('All containers completed!', 'success');
                setRunning(false);
                setSticky(false);
                return;
            }
            const desiredContainer = containers[idx];

            if (await handleRemovalConfirm())      return;
            if (await handleEnterExpirationDate()) return;
            if (await handleConfirmNewExpiration())return;
            if (await handleStartOverPage())       return;
            if (getJustSaved()) {
                setJustSaved(false);
                await goToNextContainer('after saving');
                return;
            }

            if (!pageHasContainerId()) {
                if (isScanContainerPage()) {
                    const ci = findContainerInput();
                    if (ci) {
                        if (ci.value !== desiredContainer) {
                            ci.focus();
                            setValueOnce(ci, desiredContainer);
                            await wait(80);
                            setAdvancing(false);
                            clickContinue(ci);
                            setStatus(`Container set: ${desiredContainer}`);
                            addLogEntry(`Container set: ${desiredContainer}`, 'info');
                        } else {
                            setAdvancing(false);
                            clickContinue(ci);
                        }
                    } else {
                        setStatus('"Container" field not found...');
                    }
                    return;
                }
            }

            const barcode = findBarcodeInput();
            if (!barcode){
                setStatus('Waiting for "Item barcode" field...');
                return;
            }
            if (isNotInContainerAlertVisible()) {
                await goToNextContainer('ASIN not in container');
                return;
            }

            if ((barcode.value||'').trim()==='') {
                barcode.focus();

                let currentAsin;
                if (getMultiAsinMode()) {
                    const asinList = getAsinList();
                    const asinIdx = getCurrentAsinIndex();
                    currentAsin = asinList[asinIdx] || getASIN();

                    // Log più dettagliato per multi-ASIN
                    const asinProgress = `ASIN ${asinIdx + 1}/${asinList.length}`;
                    setStatus(`Container ${idx+1}/${containers.length} — Inserimento ${asinProgress}: ${currentAsin}`);
                    addLogEntry(`Inserimento ${asinProgress} (${currentAsin}) per container ${desiredContainer}`, 'info');
                } else {
                    currentAsin = getASIN();
                    setStatus(`Container ${idx+1}/${containers.length} — Inserimento ASIN: ${currentAsin}`);
                    addLogEntry(`ASIN ${currentAsin} inserito per container ${desiredContainer}`, 'info');
                }

                setValueOnce(barcode, currentAsin);
                await wait(50);
                clickContinue(barcode);
            }
        } catch (error) {
            console.error('Error in act():', error);
            setStatus('Error: ' + error.message);
            addLogEntry('ERROR: ' + error.message, 'error');
            setRunning(false);
        }
    }

    let t=null;
    function debouncedAct(){
        if (t) clearTimeout(t);
        t = setTimeout(async ()=>{
            try{
                if (getSticky() && !getRunning()) setRunning(true);
                if (getRunning()) await act();
            }catch(err){
                console.error('Error in debouncedAct:', err);
                addLogEntry('ERROR debouncedAct: ' + err.message, 'error');
            }
        }, 220);
    }

    function startObserver(){
        new MutationObserver(()=>{ debouncedAct(); }).observe(document,{childList:true,subtree:true});
    }

    // === INITIALIZATION ===
    injectPanel();
    startObserver();
    if (getSticky()) setRunning(true);
    setTimeout(debouncedAct, 300);
    addLogEntry('Script initialized - Multi-ASIN ciclo corretto v3.3', 'info');
})();
