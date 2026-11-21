// ==UserScript==
// @name         ISS Workflow Suite
// @namespace    https://wave.qubit.amazon.dev/
// @version      4.0.0
// @description  All-in-one ISS tool: Bin Shower (binSignals + scan-to-start), Photo Manager (capture/inject/expiry), Pro Mode auto-clicker, Virtual Inventory, Quick Date Picker, Camera Focus, Command Center barcode hover.
// @author       merged: jaroskol + wilhejwa
// @match        https://wave.qubit.amazon.dev/*
// @require      https://cdn.jsdelivr.net/npm/jsbarcode@3.11.0/dist/JsBarcode.all.min.js
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      fcresearch-eu.aka.amazon.com
// @connect      qi-fcresearch-eu.corp.amazon.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================================
  // Â§1  CONFIG CONSTANTS
  // =========================================================================

  // IndexedDB
  const DB_NAME    = 'waveIssCaptureDB';
  const DB_VERSION = 1;
  const STORE      = 'sessions';

  // localStorage keys
  const LS_BOUND_SELECTOR = 'waveIssBoundSelector';
  const LS_LANG_KEY       = 'waveIssPhotoManagerLang';
  const PRO_MODE_KEY      = 'binShowerProMode';

  // sessionStorage keys
  const SCANNED_BIN_KEY = 'binShowerScannedBin';

  // Timing
  const POLL_INTERVAL_MS      = 1500;
  const MAX_WAIT_MS           = 30000;
  const FETCH_DELAY_MS        = 150;
  const SCAN_MAX_INTERVAL_MS  = 80;

  // Region â†’ marketplace ID map
  const REGION_MARKETPLACE = { EU: 44551, NA: 1, FE: 6 };

  // =========================================================================
  // Â§2  PAGE ROUTING HELPERS
  // =========================================================================

  const isContainerPage      = () => location.pathname.startsWith('/ISS/container/');
  const isQueueInitPage      = () => location.pathname.startsWith('/ISS/queue-initiation');
  const isLoadWorkflowPage   = () => location.pathname.startsWith('/ISS/load-workflow');
  const isCommandCenterPage  = () => location.pathname.startsWith('/command-center/ISS');
  const isPhotoWorkflowPage  = () => /\/ISS\/load-workflow|\/ISS\/container\//.test(location.pathname);

  // =========================================================================
  // Â§3  STYLES  (single GM_addStyle block)
  // =========================================================================

  GM_addStyle(`
    /* â”€â”€ Pro Mode toggle â”€â”€ */
    .bin-shower-pro-toggle {
      position: fixed; bottom: 60px; right: 16px; z-index: 99999;
      display: flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
      cursor: pointer; user-select: none; transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .bin-shower-pro-toggle.pro-on  { background: #1a8a3f; color: #fff; }
    .bin-shower-pro-toggle.pro-off { background: #555;    color: #ccc; }
    .bin-shower-pro-toggle:hover   { transform: scale(1.05); box-shadow: 0 3px 12px rgba(0,0,0,0.3); }
    .bin-shower-pro-toggle .pro-icon { font-size: 14px; }

    /* â”€â”€ Bin Shower table cells â”€â”€ */
    .bin-shower-cell {
      font-weight: bold; color: #0073bb; font-size: 13px;
      white-space: nowrap; cursor: pointer; position: relative;
    }
    .bin-shower-cell.loading { color: #888; font-style: italic; font-weight: normal; cursor: default; }
    .bin-shower-cell.error   { color: #d13212; font-style: italic; font-weight: normal; cursor: default; }
    .bin-shower-header       { font-weight: bold; font-size: 13px; }

    /* â”€â”€ Banner â”€â”€ */
    .bin-shower-banner {
      background: #232f3e; color: #fff; padding: 6px 16px; font-size: 13px;
      display: flex; align-items: center; gap: 10px;
      position: sticky; top: 0; z-index: 9999;
    }
    .bin-shower-banner .status         { color: #2ea44f; }
    .bin-shower-banner .status.loading { color: #f0c040; }

    /* â”€â”€ Barcode popup â”€â”€ */
    .bin-shower-barcode-popup {
      position: absolute; z-index: 10000; background: #fff;
      border: 2px solid #232f3e; border-radius: 6px; padding: 8px 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25); display: none; pointer-events: none;
    }
    .bin-shower-barcode-popup svg { display: block; }

    /* â”€â”€ Scanned-row highlight â”€â”€ */
    tr.bin-shower-scanned-row > td {
      background: #fff3b0 !important;
      box-shadow: inset 0 0 0 9999px rgba(255,214,0,0.18);
    }
    tr.bin-shower-scanned-row > td:first-child { border-left: 5px solid #f0a020 !important; }
    .bin-shower-cell.bin-shower-scanned-bin {
      background: #ffd600 !important; color: #1a1a1a !important; border-radius: 4px;
    }

    /* â”€â”€ Command-center hover â”€â”€ */
    .bin-shower-cc-hover { cursor: pointer; position: relative; }

    /* â”€â”€ Virtual inventory panel â”€â”€ */
    .bin-shower-inventory-panel {
      position: fixed; right: 20px; top: 80px; background: #fff;
      border: 1px solid #d5d9d9; border-radius: 8px; padding: 0;
      min-width: 200px; box-shadow: 0 2px 12px rgba(0,0,0,0.15);
      font-size: 13px; z-index: 9998; overflow: hidden; cursor: default;
    }
    .bin-shower-inventory-panel .inv-drag-handle {
      background: #232f3e; color: #fff; padding: 8px 12px; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;
      cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center;
    }
    .bin-shower-inventory-panel .inv-grip { opacity: 0.5; font-size: 10px; }
    .bin-shower-inventory-panel .inv-body { padding: 10px 14px; }
    .bin-shower-inventory-panel .inv-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 5px 0; border-bottom: 1px solid #f0f0f0;
    }
    .bin-shower-inventory-panel .inv-row:last-child { border-bottom: none; }
    .bin-shower-inventory-panel .inv-row.inv-highlight {
      background: #e6f7e9; margin: 0 -6px; padding: 5px 6px;
      border-radius: 4px; font-weight: 600;
    }
    .bin-shower-inventory-panel .inv-asin       { font-family: monospace; font-size: 10px; color: #555; margin-left: 4px; }
    .bin-shower-inventory-panel .inv-fnsku       { font-family: monospace; font-size: 12px; color: #0073bb; }
    .bin-shower-inventory-panel .inv-fnsku.match { color: #1a8a3f; font-weight: 700; }
    .bin-shower-inventory-panel .inv-qty-cell    { font-weight: bold; font-size: 14px; min-width: 28px; text-align: right; }
    .bin-shower-inventory-panel .inv-qty-cell.match { color: #1a8a3f; }
    .bin-shower-inventory-panel .inv-disposition { font-size: 10px; color: #888; margin-left: 4px; }
    .bin-shower-inventory-panel .inv-footer {
      padding: 8px 14px; border-top: 1px solid #e0e0e0;
      display: flex; justify-content: space-between; font-size: 12px; color: #555; background: #fafafa;
    }
    .bin-shower-inventory-panel .inv-footer-total { font-weight: bold; color: #232f3e; }

    /* â”€â”€ Quick Date Picker â”€â”€ */
    .bin-shower-datepicker {
      position: fixed; right: 20px; top: 50%; transform: translateY(-50%);
      background: #fff; border: 1px solid #d5d9d9; border-radius: 8px; padding: 0;
      width: 220px; box-shadow: 0 2px 12px rgba(0,0,0,0.15);
      font-size: 13px; z-index: 9998; overflow: hidden; display: none;
    }
    .bin-shower-datepicker.visible { display: block; }
    .bin-shower-datepicker .dp-header {
      background: #0073bb; color: #fff; padding: 8px 12px; font-size: 12px;
      font-weight: 600; cursor: move; user-select: none;
      display: flex; justify-content: space-between; align-items: center;
    }
    .bin-shower-datepicker .dp-body   { padding: 10px; }
    .bin-shower-datepicker .dp-section { margin-bottom: 8px; }
    .bin-shower-datepicker .dp-label  { font-size: 10px; text-transform: uppercase; color: #555; margin-bottom: 4px; font-weight: 600; }
    .bin-shower-datepicker .dp-grid   { display: grid; gap: 3px; }
    .bin-shower-datepicker .dp-grid.months { grid-template-columns: repeat(6, 1fr); }
    .bin-shower-datepicker .dp-grid.years  { grid-template-columns: repeat(4, 1fr); }
    .bin-shower-datepicker .dp-grid.days   { grid-template-columns: repeat(7, 1fr); }
    .bin-shower-datepicker .dp-btn {
      padding: 5px 2px; border: 1px solid #ddd; border-radius: 4px;
      background: #f9f9f9; text-align: center; cursor: pointer; font-size: 11px;
      font-weight: 500; transition: all 0.1s;
    }
    .bin-shower-datepicker .dp-btn:hover    { background: #e3f2fd; border-color: #0073bb; }
    .bin-shower-datepicker .dp-btn.selected { background: #0073bb; color: #fff; border-color: #0073bb; }
    .bin-shower-datepicker .dp-preview {
      text-align: center; padding: 8px; margin-top: 6px; background: #f0f7ff;
      border-radius: 4px; font-size: 16px; font-weight: bold; color: #0073bb; letter-spacing: 1px;
    }
    .bin-shower-datepicker .dp-submit {
      display: block; width: 100%; padding: 8px; margin-top: 8px;
      background: #1a8a3f; color: #fff; border: none; border-radius: 4px;
      font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .bin-shower-datepicker .dp-submit:hover    { background: #15703a; }
    .bin-shower-datepicker .dp-submit:disabled { background: #ccc; cursor: not-allowed; }
    .bin-shower-datepicker .dp-last {
      display: block; width: 100%; padding: 10px; margin-bottom: 10px;
      background: #0073bb; color: #fff; border: none; border-radius: 4px;
      font-size: 14px; font-weight: 600; cursor: pointer; letter-spacing: 0.5px;
    }
    .bin-shower-datepicker .dp-last:hover { background: #005a94; }

    /* â”€â”€ Camera focus bar â”€â”€ */
    .bin-shower-focus-bar {
      position: fixed; left: 20px; top: 50%; transform: translateY(-50%);
      background: rgba(0,0,0,0.8); border-radius: 8px; padding: 12px 10px;
      z-index: 99998; display: none; align-items: center; flex-direction: column; gap: 8px;
    }
    .bin-shower-focus-bar.visible { display: flex; }
    .bin-shower-focus-bar .focus-label {
      color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      writing-mode: vertical-rl; transform: rotate(180deg);
    }
    .bin-shower-focus-bar input[type="range"] {
      writing-mode: vertical-lr; direction: rtl; width: 20px; height: 150px;
      cursor: pointer; accent-color: #0073bb;
    }
    .bin-shower-focus-bar .focus-value    { color: #48bb78; font-size: 11px; font-weight: bold; }
    .bin-shower-focus-bar .focus-auto-btn {
      background: #0073bb; color: #fff; border: none; border-radius: 4px;
      padding: 4px 8px; font-size: 10px; cursor: pointer;
    }
    .bin-shower-focus-bar .focus-auto-btn:hover { background: #005a94; }

    /* â”€â”€ Photo Manager panel â”€â”€ */
    #wave-iss-panel {
      position: fixed; top: 80px; right: 16px; z-index: 999999;
      width: 340px; max-height: 80vh; display: flex; flex-direction: column;
      background: #fff; border: 1px solid #d5d9d9; border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,.18); font-family: Arial, sans-serif;
      font-size: 13px; color: #111;
    }
    #wave-iss-panel .wi-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; background: #232f3e; color: #fff;
      border-radius: 8px 8px 0 0; cursor: move;
    }
    #wave-iss-panel .wi-header b { font-size: 13px; }
    #wave-iss-panel .wi-lang-btn {
      background: transparent; border: 1px solid rgba(255,255,255,.4); color: #fff;
      padding: 1px 5px; border-radius: 3px; font-size: 10px; cursor: pointer; margin-right: 4px;
    }
    #wave-iss-panel .wi-lang-btn.active { background: #fff; color: #232f3e; font-weight: bold; }
    #wave-iss-panel .wi-actions { padding: 8px 10px 4px; display: flex; gap: 6px; flex-wrap: wrap; }
    #wave-iss-panel .wi-inject-status {
      padding: 4px 10px; font-size: 11px; color: #565959; border-bottom: 1px solid #eee;
    }
    #wave-iss-panel .wi-inject-status.active { color: #067d62; font-weight: bold; background: #f0fff8; }
    #wave-iss-panel .wi-bin-display {
      padding: 6px 10px; font-size: 13px; font-weight: bold;
      background: #e8f5e9; color: #2e7d32; border-bottom: 1px solid #c8e6c9;
      display: none; text-align: center;
    }
    #wave-iss-panel .wi-bin-display.active { display: block; }
    #wave-iss-panel .wi-bin-display .bin-label { font-weight: normal; font-size: 11px; color: #565959; }
    #wave-iss-panel .wi-bin-display .bin-value {
      font-size: 16px; font-weight: bold; color: #1b5e20;
      background: #c8e6c9; padding: 2px 8px; border-radius: 4px;
      display: inline-block; margin-top: 2px;
    }
    #wave-iss-panel .wi-expiry-inline {
      display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 11px;
    }
    #wave-iss-panel .wi-expiry-inline .expiry-value {
      font-weight: bold; color: #d84315; background: #fbe9e7; padding: 1px 5px; border-radius: 3px;
    }
    #wave-iss-panel .wi-expiry-inline input {
      width: 75px; padding: 2px 4px; border: 1px solid #adb1b8; border-radius: 3px; font-size: 11px;
    }
    #wave-iss-panel .wi-expiry-inline button {
      padding: 2px 6px; font-size: 10px; cursor: pointer;
      border: 1px solid #adb1b8; border-radius: 3px; background: #f7f8f8;
    }
    #wave-iss-panel .wi-fcsku-alert { padding: 0; }
    #wave-iss-panel .wi-alert-content {
      padding: 8px 10px; background: #fff3cd; border-bottom: 1px solid #ffc107;
      font-size: 12px; line-height: 1.4; position: relative;
    }
    #wave-iss-panel .wi-alert-content strong { color: #856404; }
    #wave-iss-panel .wi-alert-inject {
      margin-top: 6px; padding: 4px 10px; background: #c8f7c5;
      border: 1px solid #067d62; border-radius: 4px; color: #065446;
      font-weight: bold; font-size: 11px; cursor: pointer;
    }
    #wave-iss-panel .wi-alert-dismiss {
      position: absolute; top: 4px; right: 6px; background: none; border: none;
      font-size: 16px; cursor: pointer; color: #856404; padding: 2px 6px;
    }
    #wave-iss-panel .wi-bind-status    { padding: 0 10px 6px; font-size: 11px; color: #565959; }
    #wave-iss-panel .wi-bind-status.active { color: #067d62; font-weight: bold; }
    #wave-iss-panel .wi-speed-control  { padding: 4px 10px; font-size: 11px; color: #565959; border-bottom: 1px solid #eee; }
    #wave-iss-panel .wi-speed-input    { width: 40px; padding: 2px 4px; border: 1px solid #adb1b8; border-radius: 4px; font-size: 12px; text-align: center; }
    #wave-iss-panel button.arming      { background: #067d62; border-color: #067d62; color: #fff; }
    body.wave-iss-binding, body.wave-iss-binding * { cursor: crosshair !important; }
    #wave-iss-panel button {
      cursor: pointer; border: 1px solid #adb1b8; border-radius: 6px;
      padding: 6px 10px; background: #f7f8f8; font-size: 12px;
    }
    #wave-iss-panel button.primary { background: #ffd814; border-color: #fcd200; }
    #wave-iss-panel button.inject  { background: #c8f7c5; border-color: #067d62; color: #065446; font-weight: bold; }
    #wave-iss-panel button.danger  { background: #fdeceb; border-color: #d13212; color: #a5290b; }
    #wave-iss-panel .wi-list       { overflow: auto; padding: 4px 10px 10px; }
    #wave-iss-panel .wi-item       { border: 1px solid #e6e6e6; border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    #wave-iss-panel .wi-item.wi-highlighted {
      border: 2px solid #ffc107; background: #fff8e1; box-shadow: 0 0 8px rgba(255,193,7,.4);
    }
    #wave-iss-panel .wi-item .wi-title { font-weight: bold; margin-bottom: 4px; }
    #wave-iss-panel .wi-item .wi-meta  { color: #565959; font-size: 11px; margin-bottom: 6px; }
    #wave-iss-panel .wi-thumbs         { display: flex; gap: 6px; flex-wrap: wrap; }
    #wave-iss-panel .wi-thumbs img {
      width: 60px; height: 60px; object-fit: contain; border: 1px solid #e6e6e6;
      border-radius: 4px; cursor: pointer; background: #fafafa;
    }
    #wave-iss-panel .wi-thumbs img.selected-for-inject {
      border: 3px solid #067d62; box-shadow: 0 0 6px rgba(6,125,98,.4);
    }
    #wave-iss-panel .wi-item-actions { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
    #wave-iss-panel .wi-empty        { color: #565959; padding: 8px 0; }

    /* â”€â”€ Toast â”€â”€ */
    #wave-iss-toast {
      position: fixed; bottom: 20px; right: 20px; z-index: 1000000;
      background: #232f3e; color: #fff; padding: 10px 14px; border-radius: 6px;
      font-family: Arial, sans-serif; font-size: 13px; opacity: 0; transition: opacity .2s;
    }
    #wave-iss-toast.show { opacity: 1; }

    /* â”€â”€ Panel collapse â”€â”€ */
    #wave-iss-panel.collapsed .wi-actions,
    #wave-iss-panel.collapsed .wi-inject-status,
    #wave-iss-panel.collapsed .wi-bind-status,
    #wave-iss-panel.collapsed .wi-list { display: none; }
  `);

  // =========================================================================
  // Â§4  TRANSLATIONS
  // =========================================================================

  const TRANSLATIONS = {
    pl: {
      panelTitle:      'ISS Photo Manager',
      saveSession:     'Zapisz sesjÄ™',
      bindButton:      'PowiÄ…Å¼ przycisk',
      refresh:         'OdÅ›wieÅ¼',
      clear:           'WyczyÅ›Ä‡',
      injectAll:       'â¬† Wstrzyknij wszystkie',
      download:        'Pobierz',
      delete:          'UsuÅ„',
      tempoLabel:      'Tempo inject:',
      bindStatusBound: 'Przycisk powiÄ…zany (do auto-inject).',
      bindStatusNone:  'Brak powiÄ…zanego przycisku.',
      bindStatusBinding: 'Kliknij przycisk "Take Photo" na stronie...',
      injectStatus:    (n) => `ðŸŸ¢ AUTO-INJECT: ${n} zdj. pozostaÅ‚o... (kliknij aby anulowaÄ‡)`,
      autoInjectStart: (n) => `Auto-wstrzykiwanie ${n} zdj. ProszÄ™ czekaÄ‡...`,
      allInjected:     'Wszystkie zdjÄ™cia wstrzykniÄ™te!',
      noPhotos:        'Nie znaleziono zdjÄ™Ä‡ na stronie',
      saved:           (name, n) => `Zapisano "${name}" (${n} zdj.)`,
      sessionExists:   (fcsku) => `âš ï¸ Sesja dla ${fcsku} juÅ¼ istnieje!`,
      checkDates:      'SprawdÅº czy to te same daty dla tej ZZ.',
      inject:          'â¬† Wstrzyknij',
      cancel:          'Anulowano wstrzykiwanie.',
      cleared:         'Wyczyszczono',
      deleted:         'UsuniÄ™to sesjÄ™',
      noSessions:      'Brak zapisanych sesji.',
      loading:         'Åadowanie...',
      confirmClear:    'UsunÄ…Ä‡ wszystkie zapisane sesje?',
      removeBind:      'UsunÄ…Ä‡ obecne powiÄ…zanie?\n\nOK = usuÅ„, Anuluj = wybierz nowy przycisk',
      bindRemoved:     'UsuniÄ™to powiÄ…zanie.',
      bindSuccess:     'PowiÄ…zano przycisk.',
      bindFail:        'Nie udaÅ‚o siÄ™ powiÄ…zaÄ‡ tego przycisku.',
      binLabel:        'ðŸ“ Aktualny BIN:',
      tempo:           (v) => `Tempo inject: ${v}s`,
      photoBtn:        'Nie znaleziono przycisku zdjÄ™cia. Kliknij rÄ™cznie.',
      expiryInjected:  (v) => `ðŸ“… Data waÅ¼noÅ›ci wstrzykniÄ™ta: ${v}`,
      expiryNotFound:  (v) => `âš ï¸ Nie znaleziono pola daty â€” wpisz rÄ™cznie: ${v}`,
    },
    en: {
      panelTitle:      'ISS Photo Manager',
      saveSession:     'Save session',
      bindButton:      'Bind button',
      refresh:         'Refresh',
      clear:           'Clear',
      injectAll:       'â¬† Inject all',
      download:        'Download',
      delete:          'Delete',
      tempoLabel:      'Inject tempo:',
      bindStatusBound: 'Button bound (for auto-inject).',
      bindStatusNone:  'No button bound.',
      bindStatusBinding: 'Click the "Take Photo" button on the page...',
      injectStatus:    (n) => `ðŸŸ¢ AUTO-INJECT: ${n} photo(s) remaining... (click to cancel)`,
      autoInjectStart: (n) => `Auto-injecting ${n} photo(s). Please wait...`,
      allInjected:     'All photos injected!',
      noPhotos:        'No photos found on page',
      saved:           (name, n) => `Saved "${name}" (${n} photos)`,
      sessionExists:   (fcsku) => `âš ï¸ Session for ${fcsku} already exists!`,
      checkDates:      'Check if these are the same dates for this FCSKU.',
      inject:          'â¬† Inject',
      cancel:          'Injection cancelled.',
      cleared:         'Cleared',
      deleted:         'Session deleted',
      noSessions:      'No saved sessions.',
      loading:         'Loading...',
      confirmClear:    'Delete all saved sessions?',
      removeBind:      'Remove current binding?\n\nOK = remove, Cancel = choose new button',
      bindRemoved:     'Binding removed.',
      bindSuccess:     'Button bound.',
      bindFail:        'Failed to bind this button.',
      binLabel:        'ðŸ“ Current BIN:',
      tempo:           (v) => `Inject tempo: ${v}s`,
      photoBtn:        'Take Photo button not found. Click manually.',
      expiryInjected:  (v) => `ðŸ“… Expiry date injected: ${v}`,
      expiryNotFound:  (v) => `âš ï¸ Expiry date field not found â€” enter manually: ${v}`,
    }
  };

  let currentLang = localStorage.getItem(LS_LANG_KEY) || 'en';

  function t(key, ...args) {
    const val = TRANSLATIONS[currentLang]?.[key] ?? TRANSLATIONS.en[key];
    return typeof val === 'function' ? val(...args) : val;
  }

  function setLang(lang) {
    currentLang = lang;
    localStorage.setItem(LS_LANG_KEY, lang);
    rebuildPanelTexts();
  }

  // =========================================================================
  // Â§5  SHARED LIVE STATE
  // =========================================================================

  let currentFcsku        = '';
  let currentAsin         = '';
  let currentBinId        = '';
  let currentExpiryDate   = '';
  let currentPhysicalDate = '';

  // =========================================================================
  // Â§6  STATE / USER-INFO HELPERS
  // =========================================================================

  function getStateData() {
    try {
      const raw = localStorage.getItem('state');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function getBinMapFromState() {
    const state = getStateData();
    if (!state?.binQueue?.container?.item) return null;
    const map = {};
    for (const item of state.binQueue.container.item) {
      if (item.issueId && item.binId) map[item.issueId] = item.binId;
    }
    return map;
  }

  function detectWarehouseFromDom() {
    for (const el of document.querySelectorAll('span, div, button, p')) {
      const text = el.textContent.trim();
      if (/^[A-Z]{3,4}\d{1,2}$/.test(text) && el.children.length === 0) return text;
    }
    return null;
  }

  function detectUserNameFromDom() {
    const uiWords = ['pending','status','confirm','scan','start','workflow','title',
                     'quantity','logout','assigned','open','closed'];
    for (const el of document.querySelectorAll('span, div, p')) {
      const text = el.textContent.trim();
      if (/^[a-z]{4,10}$/.test(text) && el.children.length === 0 && !uiWords.includes(text))
        return text;
    }
    return null;
  }

  function getUserInfoFromState() {
    const state = getStateData();
    const info = {
      warehouseId:  state?.currentUser?.fc || state?.currentUser?.warehouseConfiguration?.warehouseId,
      userName:     state?.currentUser?.alias || state?.currentUser?.midwayLogin,
      marketplaceId: state?.currentUser?.warehouseConfiguration?.marketplaceId,
    };
    if (!info.warehouseId) info.warehouseId = detectWarehouseFromDom();
    if (!info.userName)    info.userName    = detectUserNameFromDom();
    return info;
  }

  // =========================================================================
  // Â§7  SINGLE window.fetch OVERRIDE  (S3 auto-retry on 403)
  //     Uses unsafeWindow so the override reaches the page's own fetch calls
  //     even under Tampermonkey's sandbox.
  // =========================================================================

  const _targetWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const _baseFetch    = _targetWindow.fetch.bind(_targetWindow);

  async function getPresignedUrl(checksum) {
    const query = `query GetPresignedUrl($checksum: String!) {
  presignedUrl(checksum: $checksum) { presignedUrl imageKey }
}`;
    const resp = await _baseFetch('/api/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { checksum } })
    });
    if (!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
    return (await resp.json())?.data?.presignedUrl;
  }

  async function sha256Base64(blob) {
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return btoa(String.fromCharCode(...new Uint8Array(hash)));
  }

  _targetWindow.fetch = async function (...args) {
    const [resource, options] = args;
    const url    = typeof resource === 'string' ? resource : (resource?.url || '');
    const method = (options?.method || 'GET').toUpperCase();

    // Intercept S3 PUT â€” auto-retry on 403 with fresh pre-signed URL
    if (method === 'PUT' && /s3.*amazonaws/i.test(url)) {
      const body     = options?.body;
      const bodySize = body instanceof Blob ? body.size : (body?.byteLength || 0);
      console.log(`[Suite] S3 PUT: ${Math.round(bodySize / 1024)}KB`);

      const resp = await _baseFetch(...args);

      if (resp.status === 403) {
        console.log('[Suite] S3 403 â€” fetching fresh pre-signed URL...');
        try {
          const blob     = body instanceof Blob ? body : new Blob([body]);
          const checksum = await sha256Base64(blob);
          const presigned = await getPresignedUrl(checksum);
          if (presigned?.presignedUrl) {
            const retryResp = await _baseFetch(presigned.presignedUrl, {
              method: 'PUT', body: blob,
              headers: { 'Content-Type': 'image/png', 'x-amz-checksum-sha256': checksum }
            });
            showToast(retryResp.ok ? 'âœ… Upload retry OK' : 'âš ï¸ Retry failed. Refresh page.');
            return retryResp;
          }
        } catch (err) {
          console.error('[Suite] S3 retry error:', err);
          showToast('âš ï¸ Failed to refresh token. Refresh page (F5).');
        }
      }
      return resp;
    }

    return _baseFetch(...args);
  };

  // =========================================================================
  // Â§8  SINGLE XHR INTERCEPTOR  (GraphQL response parsing)
  // =========================================================================

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__url = url;
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__url && /graphql/i.test(this.__url)) {
      this.addEventListener('load', function () {
        try {
          const text = this.responseText;

          // â”€â”€ FCSKU extraction (3 strategies) â”€â”€
          let foundFcsku = null;
          const m1 = text.match(/(?:fcsku|fnSku|scannedBarcode)[^Z]*?(ZZ[A-Z0-9]{6,})/i);
          if (m1) foundFcsku = m1[1];
          if (!foundFcsku) { const m2 = text.match(/"(ZZ[A-Z0-9]{7,})"/);   if (m2) foundFcsku = m2[1]; }
          if (!foundFcsku) { const m3 = text.match(/productAsin=(ZZ[A-Z0-9]{5,})/); if (m3) foundFcsku = m3[1]; }
          if (!foundFcsku) { const m4 = text.match(/barcodeMapping[^Z]*?(ZZ[A-Z0-9]{6,})/); if (m4) foundFcsku = m4[1]; }

          if (foundFcsku && foundFcsku !== currentFcsku) {
            currentFcsku = foundFcsku;
            clearHighlights();
            hideSessionAlert();
            checkExistingSession(currentFcsku);
            renderList();
          }

          // â”€â”€ ASIN â”€â”€
          const asinM = text.match(/"asin"\s*:\s*"(B[A-Z0-9]+)"/);
          if (asinM) currentAsin = asinM[1];

          // â”€â”€ Bin ID â”€â”€
          const binM = text.match(/"bin_id"\s*:\s*"([^"]+)"/);
          if (binM) { currentBinId = binM[1]; updateBinDisplay(); }

          // â”€â”€ AI expiry date â”€â”€
          const aiM = text.match(/ANALYZE_EXPIRY_DATE_IMAGE\.normalized_date[^"]*":\s*"([^"]+)"/);
          if (aiM) { currentExpiryDate = aiM[1]; updateLastSessionExpiry(currentExpiryDate); }

          // â”€â”€ Physical expiry date â”€â”€
          const physM = text.match(/"physical_expiration_date"\s*:\s*"([^"]+)"/);
          if (physM && /\d/.test(physM[1])) {
            currentPhysicalDate = physM[1];
            currentExpiryDate   = physM[1];
            updateLastSessionExpiry(currentExpiryDate);
          }

          // â”€â”€ Workflow finished â”€â”€
          if (/"isFinished"\s*:\s*true/.test(text)) {
            console.log('[Suite] Workflow finished.');
          }
        } catch (_) { /* ignore parse errors */ }
      });
    }
    return _xhrSend.call(this, body);
  };

  // =========================================================================
  // Â§9  INDEXEDDB LAYER
  // =========================================================================

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function dbTx(mode, fn) {
    const db  = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  const addSession    = (s)  => dbTx('readwrite', (st) => st.add(s));
  const getAllSessions = ()   => dbTx('readonly',  (st) => st.getAll()).then(r => r || []);
  const deleteSession = (id) => dbTx('readwrite', (st) => st.delete(id));
  const clearSessions = ()   => dbTx('readwrite', (st) => st.clear());

  async function updateSessionExpiry(sessionId, expiryDate) {
    const sessions = await getAllSessions();
    const session  = sessions.find(s => s.id === sessionId);
    if (!session) return;
    session.expiryDate = expiryDate;
    await dbTx('readwrite', (st) => st.put(session));
    console.log(`[Suite] Updated session ${session.name} expiry: ${expiryDate}`);
  }

  async function updateLastSessionExpiry(expiryDate) {
    if (!currentFcsku || !expiryDate) return;
    const sessions = await getAllSessions();
    const matching = sessions
      .filter(s => s.fcsku === currentFcsku)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!matching.length || matching[0].expiryDate === expiryDate) return;
    await updateSessionExpiry(matching[0].id, expiryDate);
  }

  // =========================================================================
  // Â§10  PRO MODE
  // =========================================================================

  const isProMode  = () => localStorage.getItem(PRO_MODE_KEY) !== '0';
  const setProMode = (on) => {
    localStorage.setItem(PRO_MODE_KEY, on ? '1' : '0');
    updateProModeButton();
  };

  let proModeBtn = null;

  function createProModeButton() {
    if (proModeBtn) return;
    proModeBtn = document.createElement('div');
    proModeBtn.className = 'bin-shower-pro-toggle';
    proModeBtn.addEventListener('click', () => setProMode(!isProMode()));
    document.body.appendChild(proModeBtn);
    updateProModeButton();
  }

  function updateProModeButton() {
    if (!proModeBtn) return;
    const on = isProMode();
    proModeBtn.innerHTML = `<span class="pro-icon">${on ? 'âš¡' : 'ðŸ’¤'}</span><span class="pro-label">PRO ${on ? 'ON' : 'OFF'}</span>`;
    proModeBtn.classList.toggle('pro-on',  on);
    proModeBtn.classList.toggle('pro-off', !on);
  }

  // =========================================================================
  // Â§11  BARCODE POPUP  (JsBarcode CODE128)
  // =========================================================================

  let barcodePopup = null;

  function ensureBarcodePopup() {
    if (barcodePopup) return barcodePopup;
    barcodePopup = document.createElement('div');
    barcodePopup.className = 'bin-shower-barcode-popup';
    document.body.appendChild(barcodePopup);
    return barcodePopup;
  }

  function showBarcode(targetEl, text) {
    if (!text || text === '...' || text === 'â€”' || text === '?') return;
    const popup = ensureBarcodePopup();
    popup.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    popup.appendChild(svg);
    try {
      JsBarcode(svg, text, { format: 'CODE128', width: 2, height: 60, displayValue: true, fontSize: 14, margin: 4 });
    } catch (e) { console.error('[Suite] Barcode error:', e); return; }
    const rect = targetEl.getBoundingClientRect();
    popup.style.display = 'block';
    popup.style.top  = `${window.scrollY + rect.bottom + 6}px`;
    popup.style.left = `${window.scrollX + rect.left}px`;
  }

  function hideBarcode() {
    if (barcodePopup) barcodePopup.style.display = 'none';
  }

  function attachBarcodeHover(cell) {
    cell.addEventListener('mouseenter', function () { showBarcode(this, this.textContent.trim()); });
    cell.addEventListener('mouseleave', hideBarcode);
  }

  document.addEventListener('click', hideBarcode);
  setInterval(() => {
    if (barcodePopup?.style.display === 'block' && !document.querySelector('.bin-shower-cell:hover, .bin-shower-cc-hover:hover'))
      hideBarcode();
  }, 2000);

  // =========================================================================
  // Â§12  BIN SHOWER  (File-2 superset version)
  // =========================================================================

  // â”€â”€ Container / scanned bin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function setScannedBin(value) {
    if (!value || value === 'undefined' || value === 'null') return;
    try { sessionStorage.setItem(SCANNED_BIN_KEY, value); } catch (_) {}
  }

  function getScannedBin() {
    try {
      const v = sessionStorage.getItem(SCANNED_BIN_KEY);
      return (!v || v === 'undefined' || v === 'null') ? null : v;
    } catch (_) { return null; }
  }

  function getScannedContainerId() {
    const m = location.pathname.match(/\/ISS\/container\/([\w-]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
    const hm = (document.body?.innerText || '').match(/bin checks required for the ([\w-]+) container/i);
    return hm ? hm[1] : null;
  }

  function getBinFromUrl() {
    const m = location.pathname.match(/\/ISS\/container\/(P-[^/?#]+)/i);
    return m ? m[1] : null;
  }

  // â”€â”€ Region / binSignals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function detectRegionForWarehouse(warehouseId) {
    try {
      const resp = await _baseFetch('/api/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'getWarehouse' },
        body: JSON.stringify({ query: `{ getWarehouse(warehouseId: "${warehouseId}", team: "ISS") }` })
      });
      const region = (await resp.json())?.data?.getWarehouse?.globalFields?.fields?.region?.value;
      if (region) return region;
    } catch (e) { console.warn('[Suite] Region detection failed, defaulting EU:', e); }
    return 'EU';
  }

  async function fetchBinMapViaBinSignals(scannableId, warehouseId, userName) {
    if (!scannableId || !warehouseId || !userName) return null;
    const region      = await detectRegionForWarehouse(warehouseId);
    const marketplaceId = REGION_MARKETPLACE[region] || REGION_MARKETPLACE.EU;
    const query = `mutation binSignalsWrapper($warehouseId:String!,$routingRegion:String!,$scannableId:String!,$process:String!,$userName:String!,$marketplaceId:Int!){
      binSignals(warehouseId:$warehouseId,routingRegion:$routingRegion,scannableId:$scannableId,process:$process,userName:$userName,marketplaceId:$marketplaceId){
        issueId binId fcsku asin quantity pickOrder
      }
    }`;
    try {
      const resp = await _baseFetch('/api/graphql', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-apollo-operation-name': 'binSignalsWrapper' },
        body: JSON.stringify({ operationName: 'binSignalsWrapper', query, variables: { warehouseId, routingRegion: region, scannableId, process: 'ISS', userName, marketplaceId } })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const signals = (await resp.json())?.data?.binSignals;
      if (!Array.isArray(signals)) return null;
      const map = {};
      for (const s of signals) { if (s.issueId && s.binId) map[s.issueId] = s.binId; }
      console.log(`[Suite] binSignals: ${Object.keys(map).length} bins (region=${region})`);
      return map;
    } catch (err) { console.error('[Suite] binSignals failed:', err); return null; }
  }

  async function fetchBinIdViaApi(signalId, warehouseId, userName, marketplaceId) {
    const query = `query QueryWaveSignal($warehouseId:String!,$signalProcess:String!,$signalStatus:String!,$userName:String!,$signalId:String!,$marketplaceId:Int!){
  queryWaveSignal(warehouseId:$warehouseId,signalProcess:$signalProcess,signalStatus:$signalStatus,userName:$userName,signalId:$signalId,marketplaceId:$marketplaceId){
    signalId signalMetadata
  }
}`;
    const variables = { warehouseId, signalProcess: 'iss', signalStatus: 'Assigned', userName, signalId,
                        marketplaceId: (typeof marketplaceId === 'number' ? marketplaceId : parseInt(marketplaceId, 10)) || 4 };
    const params = new URLSearchParams({ query, variables: JSON.stringify(variables) });
    try {
      const resp = await _baseFetch(`/api/graphql?${params}`, { method: 'GET', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const meta = (await resp.json())?.data?.queryWaveSignal?.signalMetadata;
      if (!meta) return null;
      return (typeof meta === 'string') ? (JSON.parse(meta).binId || null) : (meta.binId || null);
    } catch (err) { console.error('[Suite] queryWaveSignal failed:', signalId, err); return null; }
  }

  // â”€â”€ Table helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const TABLE_HEADER_KEYWORDS = [
    ['ticket id', 'status'],
    ['ticket-id', 'status'],
    ['ticket-nr', 'status'],
  ];

  function tableHasTicketRows(table) {
    for (const row of table.querySelectorAll('tbody tr')) {
      for (const cell of row.querySelectorAll('td')) {
        const link = cell.querySelector('a');
        if (/^[0-9a-f-]{36}$/i.test((link ? link.textContent : cell.textContent).trim())) return true;
      }
    }
    return false;
  }

  function getTable() {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headers = table.querySelectorAll('thead th');
      if (headers.length >= 5) {
        const texts = Array.from(headers).map(h => h.textContent.trim().toLowerCase());
        if (TABLE_HEADER_KEYWORDS.some(kws => kws.every(kw => texts.some(h => h.includes(kw))))) return table;
      }
    }
    for (const table of tables) {
      if (table.querySelectorAll('thead th').length >= 5 && tableHasTicketRows(table)) return table;
    }
    return null;
  }

  function getTicketIdsFromTable(table) {
    const tickets = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells    = row.querySelectorAll('td');
      if (cells.length < 2) continue;
      const link     = cells[1].querySelector('a');
      const ticketId = (link ? link.textContent : cells[1].textContent).trim();
      if (/^[0-9a-f-]{36}$/i.test(ticketId)) tickets.push({ row, ticketId });
    }
    return tickets;
  }

  function addBinColumn(table) {
    const headerRow = table.querySelector('thead tr');
    if (!headerRow || headerRow.querySelector('.bin-shower-header')) return;
    const th = document.createElement('th');
    th.className  = 'bin-shower-header';
    th.textContent = 'Bin ID';
    th.style.cssText = 'padding:8px 12px;text-align:left;';
    headerRow.insertBefore(th, headerRow.lastElementChild);
  }

  function addBinCell(row, text, cssClass) {
    let binCell = row.querySelector('.bin-shower-cell');
    if (binCell) { binCell.textContent = text; binCell.className = `bin-shower-cell ${cssClass}`; if (!cssClass) attachBarcodeHover(binCell); return; }
    const td = document.createElement('td');
    td.className   = `bin-shower-cell ${cssClass}`;
    td.textContent = text;
    td.style.cssText = 'padding:8px 12px;';
    row.insertBefore(td, row.querySelectorAll('td')[row.querySelectorAll('td').length - 1]);
    if (!cssClass) attachBarcodeHover(td);
  }

  // â”€â”€ Banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function showBanner(message, isLoading) {
    let banner = document.querySelector('.bin-shower-banner');
    if (!banner) { banner = document.createElement('div'); banner.className = 'bin-shower-banner'; document.body.prepend(banner); }
    banner.innerHTML = `<span>ðŸ—‚ï¸ <strong>Bin Shower</strong></span><span class="status ${isLoading ? 'loading' : ''}">${message}</span>`;
  }

  function removeBanner() {
    document.querySelector('.bin-shower-banner')?.remove();
  }

  // â”€â”€ Scan-to-start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  let scanBuffer  = '';
  let scanTimeout = null;

  function handleScanInput(e) {
    if (e.key === 'Enter') {
      if (scanBuffer.length >= 3) {
        const scanned = scanBuffer.trim();
        scanBuffer = '';
        clearTimeout(scanTimeout);
        const matched = processScan(scanned);
        if (matched) { e.preventDefault(); e.stopPropagation(); if (e.target?.tagName?.toLowerCase() === 'input') e.target.value = ''; }
        return;
      }
      scanBuffer = ''; clearTimeout(scanTimeout); return;
    }
    if (e.key.length === 1) {
      scanBuffer += e.key;
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => { scanBuffer = ''; }, SCAN_MAX_INTERVAL_MS);
    }
  }

  function processScan(scannedValue) {
    console.log(`[Suite] Scan: "${scannedValue}"`);
    const table = getTable();
    if (!table) { console.warn('[Suite] No table, cannot process scan.'); return false; }

    const matchingRows = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const binCell = row.querySelector('.bin-shower-cell');
      if (binCell?.textContent.trim() === scannedValue) matchingRows.push({ row, binCell });
    }

    if (!matchingRows.length) { showScanFeedback(null, false, scannedValue); return false; }

    if (matchingRows.length === 1) {
      const { row, binCell } = matchingRows[0];
      setScannedBin(scannedValue);
      highlightScannedRow(row, binCell);
      showScanFeedback(binCell, true);
      clickStartWorkflow(row);
      return true;
    }

    // Multiple rows â€” check for duplicate SKU
    const skus          = matchingRows.map(({ row }) => row.querySelectorAll('td')[2]?.textContent.trim() || '');
    const hasDuplicateSku = skus.some((sku, i) => sku && skus.indexOf(sku) !== i);
    setScannedBin(scannedValue);
    for (const { row, binCell } of matchingRows) { row.classList.add('bin-shower-scanned-row'); binCell.classList.add('bin-shower-scanned-bin'); }
    matchingRows[0].row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showBanner(hasDuplicateSku
      ? `âš ï¸ Duplicate SKU+Bin for ${scannedValue}. Select workflow manually.`
      : `âš ï¸ ${matchingRows.length} workflows for ${scannedValue}. Select manually.`, false);
    return true;
  }

  function highlightScannedRow(row, binCell) {
    clearScannedRowHighlight();
    row.classList.add('bin-shower-scanned-row');
    if (binCell) binCell.classList.add('bin-shower-scanned-bin');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function clearScannedRowHighlight() {
    document.querySelectorAll('tr.bin-shower-scanned-row').forEach(r => r.classList.remove('bin-shower-scanned-row'));
    document.querySelectorAll('.bin-shower-cell.bin-shower-scanned-bin').forEach(c => c.classList.remove('bin-shower-scanned-bin'));
  }

  function reapplyPersistedHighlight(autoClick = false) {
    const scanned = getScannedBin() || getBinFromUrl();
    if (!scanned) return;
    const table = getTable();
    if (!table) return;

    const matchingRows = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const binCell = row.querySelector('.bin-shower-cell');
      if (binCell?.textContent.trim() === scanned) {
        row.classList.add('bin-shower-scanned-row');
        binCell.classList.add('bin-shower-scanned-bin');
        matchingRows.push(row);
      }
    }

    if (autoClick && !reapplyPersistedHighlight._autoClicked && isProMode() && matchingRows.length > 0) {
      reapplyPersistedHighlight._autoClicked = true;
      if (matchingRows.length === 1) {
        console.log(`[Suite] Auto-clicking Start Workflow for "${scanned}"`);
        setTimeout(() => clickStartWorkflow(matchingRows[0]), 300);
      } else {
        const skus = matchingRows.map(r => r.querySelectorAll('td')[2]?.textContent.trim() || '');
        const dup  = skus.some((s, i) => s && skus.indexOf(s) !== i);
        showBanner(dup
          ? `âš ï¸ Duplicate SKU+Bin for ${scanned}. Select manually.`
          : `âš ï¸ ${matchingRows.length} workflows for ${scanned}. Select manually.`, false);
      }
    }
  }
  reapplyPersistedHighlight._autoClicked = false;

  function clickStartWorkflow(row) {
    const cells    = row.querySelectorAll('td');
    const lastCell = cells[cells.length - 1];
    if (!lastCell) return;
    const btn = lastCell.querySelector('button');
    if (btn) { btn.click(); return; }
    const alchemyBtn = lastCell.querySelector('alchemy-button');
    if (alchemyBtn) {
      const inner = alchemyBtn.shadowRoot?.querySelector('button');
      if (inner) { inner.click(); return; }
      alchemyBtn.click(); return;
    }
    const link = lastCell.querySelector('a');
    if (link) { link.click(); return; }
    lastCell.querySelector('[role="button"],[tabindex="0"]')?.click();
  }

  function showScanFeedback(cell, success, value) {
    if (success && cell) {
      const orig = cell.style.background;
      cell.style.background = '#d4edda';
      setTimeout(() => { cell.style.background = orig; }, 1200);
    } else if (!success) {
      showBanner(`Scan "${value}" â€” no matching bin on this page.`, false);
      setTimeout(removeBanner, 3000);
    }
  }

  // â”€â”€ Main bin shower run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function binShowerRun() {
    console.log('[Suite] BinShower starting...');
    showBanner('Waiting for table...', true);

    // Store bin from URL (most reliable source)
    const urlMatch = location.pathname.match(/\/ISS\/container\/(.+)/);
    if (urlMatch?.[1]) {
      const c = decodeURIComponent(urlMatch[1]);
      if (c && c !== 'undefined') { console.log(`[Suite] Scanned bin from URL: "${c}"`); setScannedBin(c); }
    }

    // Wait for table
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let table = null;
    const t0  = Date.now();
    while (!table && Date.now() - t0 < MAX_WAIT_MS) { table = getTable(); if (!table) await sleep(POLL_INTERVAL_MS); }
    if (!table) { removeBanner(); return; }

    showBanner('Loading bin IDs...', true);
    addBinColumn(table);

    const tickets = getTicketIdsFromTable(table);
    if (!tickets.length) { showBanner('No tickets found.', false); setTimeout(removeBanner, 3000); return; }
    for (const { row } of tickets) addBinCell(row, '...', 'loading');

    const userInfo = getUserInfoFromState();
    let   binMap   = {};
    let   resolvedFromContainer = 0;
    let   needsApi = [];

    // Strategy 1: binSignals mutation (most reliable)
    const container = getScannedContainerId();
    if (container && userInfo?.warehouseId && userInfo?.userName) {
      const containerMap = await fetchBinMapViaBinSignals(container, userInfo.warehouseId, userInfo.userName);
      if (containerMap && Object.keys(containerMap).length) binMap = containerMap;
    }

    // Strategy 2: merge localStorage state
    const stateMap = getBinMapFromState();
    if (stateMap) { for (const [k, v] of Object.entries(stateMap)) { if (!binMap[k]) binMap[k] = v; } }

    // Apply resolved bins
    for (const { row, ticketId } of tickets) {
      if (binMap[ticketId]) { addBinCell(row, binMap[ticketId], ''); resolvedFromContainer++; }
      else needsApi.push({ row, ticketId });
    }

    // Strategy 3: per-ticket queryWaveSignal fallback
    if (needsApi.length > 0 && userInfo?.warehouseId && userInfo?.userName) {
      showBanner(`API: ${needsApi.length} remaining bins...`, true);
      for (const { row, ticketId } of needsApi) {
        const binId = await fetchBinIdViaApi(ticketId, userInfo.warehouseId, userInfo.userName, userInfo.marketplaceId);
        addBinCell(row, binId || 'â€”', binId ? '' : 'error');
        await sleep(FETCH_DELAY_MS);
      }
    } else {
      for (const { row } of needsApi) addBinCell(row, '?', 'error');
    }

    showBanner(`Done! ${resolvedFromContainer} from container, ${needsApi.length} via fallback. Total: ${tickets.length}.`, false);
    reapplyPersistedHighlight(true);
    setTimeout(removeBanner, 5000);
  }

  // Register the single global scan listener
  document.addEventListener('keydown', handleScanInput, true);

  // =========================================================================
  // Â§13  PHOTO MANAGER PANEL  (UI scaffold)
  // =========================================================================

  const panel = document.createElement('div');
  panel.id = 'wave-iss-panel';
  panel.innerHTML = `
    <div class="wi-header">
      <b>ISS Photo Manager</b>
      <span>
        <button class="wi-lang-btn" data-lang="pl" title="Polski">PL</button>
        <button class="wi-lang-btn" data-lang="en" title="English">EN</button>
        <span class="wi-toggle" style="cursor:pointer;">&#9662;</span>
      </span>
    </div>
    <div class="wi-bin-display"></div>
    <div class="wi-inject-status"></div>
    <div class="wi-actions">
      <button class="primary" data-act="capture">${t('saveSession')}</button>
      <button data-act="bind">${t('bindButton')}</button>
      <button data-act="refresh">${t('refresh')}</button>
      <button class="danger" data-act="clear">${t('clear')}</button>
    </div>
    <div class="wi-speed-control">
      <label>${t('tempoLabel')} <input type="number" class="wi-speed-input" min="0.3" max="10" step="0.1" value="0.5"> s</label>
    </div>
    <div class="wi-bind-status"></div>
    <div class="wi-list"><div class="wi-empty">${t('loading')}</div></div>
  `;
  document.body.appendChild(panel);

  const toast = document.createElement('div');
  toast.id = 'wave-iss-toast';
  document.body.appendChild(toast);

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }

  const listEl        = panel.querySelector('.wi-list');
  const injectStatusEl = panel.querySelector('.wi-inject-status');

  // Tempo input
  const speedInput = panel.querySelector('.wi-speed-input');
  speedInput.addEventListener('change', () => {
    const val = parseFloat(speedInput.value);
    if (val >= 0.3 && val <= 10) { autoInjectIntervalMs = val * 1000; showToast(t('tempo', val)); }
  });

  // Language buttons
  panel.querySelectorAll('.wi-lang-btn').forEach(btn => btn.addEventListener('click', () => setLang(btn.dataset.lang)));

  function updateLangButtons() {
    panel.querySelectorAll('.wi-lang-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.lang === currentLang));
  }

  function rebuildPanelTexts() {
    updateLangButtons();
    const btns = panel.querySelectorAll('.wi-actions button');
    btns[0].textContent = t('saveSession');
    btns[1].textContent = t('bindButton');
    btns[2].textContent = t('refresh');
    btns[3].textContent = t('clear');
    panel.querySelector('.wi-speed-control label').childNodes[0].textContent = `${t('tempoLabel')} `;
    updateBindStatus();
    updateInjectStatus();
    updateBinDisplay();
    renderList();
  }

  updateLangButtons();

  function updateInjectStatus() {
    if (injectionActive) {
      injectStatusEl.textContent = t('injectStatus', injectionQueue.length);
      injectStatusEl.className   = 'wi-inject-status active';
    } else {
      injectStatusEl.textContent = '';
      injectStatusEl.className   = 'wi-inject-status';
    }
  }

  function updateBinDisplay() {
    const binEl = panel.querySelector('.wi-bin-display');
    if (currentBinId) {
      binEl.innerHTML = `<div class="bin-label">${t('binLabel')}</div><div class="bin-value">${currentBinId}</div>`;
      binEl.classList.add('active');
    } else {
      binEl.classList.remove('active');
      binEl.innerHTML = '';
    }
  }

  // â”€â”€ Session alert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function checkExistingSession(fcsku) {
    const sessions = await getAllSessions();
    const found    = sessions.filter(s => s.fcsku === fcsku);
    if (found.length) { showSessionAlert(fcsku, found[0]); await renderList(); highlightExistingSession(fcsku); }
    else { hideSessionAlert(); clearHighlights(); }
  }

  function showSessionAlert(fcsku, session) {
    let alertEl = panel.querySelector('.wi-fcsku-alert');
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.className = 'wi-fcsku-alert';
      injectStatusEl.after(alertEl);
    }
    alertEl.innerHTML = `
      <div class="wi-alert-content">
        <strong>${t('sessionExists', fcsku)}</strong><br>
        <span>${session.images.length} ðŸ“·${session.expiryDate ? ` &middot; ðŸ“… EXP: ${session.expiryDate}` : ''}</span><br>
        <span>${t('checkDates')}</span>
        <button class="wi-alert-inject">${t('inject')}</button>
        <button class="wi-alert-dismiss">âœ•</button>
      </div>`;
    alertEl.querySelector('.wi-alert-dismiss').addEventListener('click', hideSessionAlert);
    alertEl.querySelector('.wi-alert-inject').addEventListener('click', () => {
      loadInjectionQueue(session.images, session.expiryDate || '');
      hideSessionAlert();
    });
  }

  function hideSessionAlert() {
    const el = panel.querySelector('.wi-fcsku-alert');
    if (el) el.innerHTML = '';
  }

  // â”€â”€ Session list rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function renderList() {
    const sessions = await getAllSessions();
    if (!sessions.length) { listEl.innerHTML = `<div class="wi-empty">${t('noSessions')}</div>`; return; }

    listEl.innerHTML = '';
    sessions.sort((a, b) => b.createdAt - a.createdAt);

    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = 'wi-item';
      if (currentFcsku && s.fcsku === currentFcsku) item.classList.add('wi-highlighted');

      const thumbs = (s.images || []).map((src, i) =>
        `<img src="${src}" title="Click = preview" data-full="1" data-idx="${i}">`).join('');

      item.innerHTML = `
        <div class="wi-title">${s.name}</div>
        <div class="wi-meta">${s.images.length} ðŸ“·${s.binId ? ` &middot; BIN: ${s.binId}` : ''}</div>
        <div class="wi-expiry-inline">
          ðŸ“… EXP: ${s.expiryDate ? `<span class="expiry-value">${s.expiryDate}</span>` : '<em style="color:#999">not set</em>'}
          <input type="text" placeholder="dd/mm/yyyy" value="${s.expiryDate || ''}" data-session-id="${s.id}">
          <button data-act="save-date" data-id="${s.id}">âœ“</button>
        </div>
        <div class="wi-thumbs">${thumbs}</div>
        <div class="wi-item-actions">
          <button class="inject" data-act="inject-all" data-id="${s.id}">${t('injectAll')}</button>
          <button data-act="download" data-id="${s.id}">${t('download')}</button>
          <button class="danger" data-act="del" data-id="${s.id}">${t('delete')}</button>
        </div>`;

      item.querySelectorAll('img[data-full]').forEach(img => img.addEventListener('click', () => openImage(img.src)));

      item.querySelector('[data-act="save-date"]').addEventListener('click', async () => {
        const val = item.querySelector('input[data-session-id]').value.trim();
        if (val) { await updateSessionExpiry(s.id, val); showToast(`ðŸ“… EXP: ${val}`); renderList(); }
      });

      item.querySelector('[data-act="inject-all"]').addEventListener('click', () => loadInjectionQueue(s.images, s.expiryDate || ''));
      item.querySelector('[data-act="download"]').addEventListener('click', () => downloadSession(s));
      item.querySelector('[data-act="del"]').addEventListener('click', async () => {
        await deleteSession(s.id); showToast(t('deleted')); renderList();
      });

      listEl.appendChild(item);
    }

    const hi = listEl.querySelector('.wi-highlighted');
    if (hi) setTimeout(() => hi.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  }

  function openImage(src) {
    const w = window.open('');
    if (w) { w.document.title = 'Photo Preview'; const img = w.document.createElement('img'); img.src = src; img.style.maxWidth = '100%'; w.document.body.appendChild(img); }
  }

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  }

  function downloadSession(s) {
    (s.images || []).forEach((src, i) => {
      const ext      = (src.match(/^data:image\/(\w+)/) || [, 'png'])[1];
      const safeName = s.name.replace(/[^\w-]+/g, '_');
      downloadDataUrl(src, `${safeName}_${i + 1}.${ext}`);
    });
  }

  function highlightExistingSession(fcsku) {
    clearHighlights();
    listEl.querySelectorAll('.wi-item').forEach(item => {
      if (item.querySelector('.wi-title')?.textContent.startsWith(fcsku)) {
        item.classList.add('wi-highlighted');
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  function clearHighlights() {
    listEl.querySelectorAll('.wi-item.wi-highlighted').forEach(el => el.classList.remove('wi-highlighted'));
  }

  // â”€â”€ Panel button wiring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  panel.querySelector('.wi-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if      (act === 'capture') captureSession();
    else if (act === 'bind')    handleBindClick();
    else if (act === 'refresh') renderList();
    else if (act === 'clear')   {
      if (confirm(t('confirmClear'))) { await clearSessions(); showToast(t('cleared')); renderList(); }
    }
  });

  injectStatusEl.addEventListener('click', () => { if (injectionActive) cancelInjection(); });

  panel.querySelector('.wi-toggle').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    panel.querySelector('.wi-toggle').innerHTML = panel.classList.contains('collapsed') ? '&#9656;' : '&#9662;';
  });

  // Drag
  (function makeDraggable() {
    const header = panel.querySelector('.wi-header');
    let dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wi-toggle')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offX = e.clientX - rect.left; offY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left  = `${e.clientX - offX}px`;
      panel.style.top   = `${e.clientY - offY}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

  // =========================================================================
  // Â§14  PHOTO CAPTURE
  // =========================================================================

  function collectImages() {
    const imgs   = Array.from(document.querySelectorAll('img[src^="data:image/"]'));
    const seen   = new Set();
    const result = [];

    for (const img of imgs) {
      const src = img.src;
      if (!src || seen.has(src) || img.closest('#wave-iss-panel')) continue;
      seen.add(src);
      if (img.closest('li.thumb')) result.push(src);
    }

    if (!result.length) {
      seen.clear();
      for (const img of imgs) {
        const src = img.src;
        if (!src || seen.has(src) || img.closest('#wave-iss-panel')) continue;
        seen.add(src); result.push(src);
      }
    }
    return result;
  }

  // =========================================================================
  // Â§15  PHOTO INJECTION ENGINE
  // =========================================================================

  let injectionQueue      = [];
  let injectionActive     = false;
  let lastInjectTime      = 0;
  let autoInjectIntervalMs = 500;
  let pendingExpiryDate   = '';
  let autoInjectTimer     = null;

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;

  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    if (injectionActive && injectionQueue.length > 0) {
      lastInjectTime = Date.now();
      const img = injectionQueue.shift();
      console.log('[Suite] Injected photo. Remaining:', injectionQueue.length);
      updateInjectStatus();
      if (!injectionQueue.length) {
        injectionActive = false;
        updateInjectStatus();
        showToast(t('allInjected'));
        if (pendingExpiryDate) setTimeout(() => injectExpiryDate(pendingExpiryDate), 800);
      }
      return img;
    }
    return origToDataURL.apply(this, args);
  };

  function loadInjectionQueue(dataUrls, expiryDate) {
    injectionQueue    = [...dataUrls];
    injectionActive   = true;
    lastInjectTime    = 0;
    pendingExpiryDate = expiryDate || '';
    updateInjectStatus();
    showToast(t('autoInjectStart', injectionQueue.length));
    startAutoInject();
  }

  function startAutoInject() {
    if (autoInjectTimer) clearInterval(autoInjectTimer);
    autoClickTakePhoto();
    autoInjectTimer = setInterval(() => {
      if (!injectionActive || !injectionQueue.length) { stopAutoInject(); return; }
      autoClickTakePhoto();
    }, autoInjectIntervalMs);
  }

  function stopAutoInject() {
    if (autoInjectTimer) { clearInterval(autoInjectTimer); autoInjectTimer = null; }
  }

  function autoClickTakePhoto() {
    // Prefer the user-bound button
    const boundSel = getBoundSelector();
    if (boundSel) {
      try { const b = document.querySelector(boundSel); if (b) { b.click(); return; } } catch (_) {}
    }

    const candidates = [
      ...document.querySelectorAll('button[aria-label*="photo" i],button[aria-label*="capture" i],button[aria-label*="camera" i]'),
      ...Array.from(document.querySelectorAll('button')).filter(b => {
        const txt = b.textContent.trim().toLowerCase();
        return txt.includes('take photo') || txt.includes('capture');
      }),
      ...document.querySelectorAll('[class*="capture" i] button,[class*="camera" i] button,[class*="shutter" i]'),
    ];

    if (candidates.length) { candidates[0].click(); return; }

    console.warn('[Suite] Take Photo button not found!');
    showToast(`âš ï¸ ${t('photoBtn')}`);
    stopAutoInject();
  }

  function cancelInjection() {
    stopAutoInject();
    injectionQueue    = [];
    injectionActive   = false;
    pendingExpiryDate = '';
    updateInjectStatus();
    showToast(t('cancel'));
  }

  // =========================================================================
  // Â§16  EXPIRY DATE INJECTION
  // =========================================================================

  function injectExpiryDate(dateValue) {
    if (!dateValue) return;

    const candidateSelectors = [
      'input[name*="expir" i]', 'input[name*="expiry" i]', 'input[name*="expiration" i]',
      'input[placeholder*="expir" i]', 'input[placeholder*="mm/dd/yyyy" i]', 'input[placeholder*="dd/mm/yyyy" i]',
      'input[aria-label*="expir" i]', 'input[aria-label*="date" i]',
      'input[data-testid*="expir" i]', 'input[id*="expir" i]',
    ];

    let input = null;
    for (const sel of candidateSelectors) {
      try { const f = document.querySelector(sel); if (f && !f.closest('#wave-iss-panel')) { input = f; break; } } catch (_) {}
    }

    if (!input) {
      for (const el of document.querySelectorAll('input[type="date"],input[type="text"]')) {
        if (el.closest('#wave-iss-panel')) continue;
        const ph  = (el.placeholder || '').toLowerCase();
        const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
        const nm  = (el.name || '').toLowerCase();
        if (ph.includes('date') || ph.includes('expir') || lbl.includes('expir') || nm.includes('expir')) { input = el; break; }
      }
    }

    if (!input) {
      console.warn('[Suite] Expiry input not found.');
      showToast(t('expiryNotFound', dateValue));
      return;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, dateValue);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
    input.focus();
    console.log(`[Suite] Expiry injected: ${dateValue}`);
    showToast(t('expiryInjected', dateValue));
  }

  // =========================================================================
  // Â§17  SESSION MANAGEMENT  (capture)
  // =========================================================================

  function findFcskuFromDOM() {
    const zzMatch = (document.body.innerText || '').match(/\b(ZZ[A-Z0-9]{6,})\b/);
    if (zzMatch) return zzMatch[1];
    for (const link of document.querySelectorAll('a[href*="fcresearch" i]')) {
      const m = link.href?.match(/[?&]s=(ZZ[A-Z0-9]{5,})/);
      if (m) return m[1];
    }
    for (const a of document.querySelectorAll('a')) {
      if (/^ZZ[A-Z0-9]{6,}$/.test(a.textContent.trim())) return a.textContent.trim();
    }
    return '';
  }

  function getCurrentIdentifier() {
    if (currentFcsku) return currentFcsku;
    if (currentAsin)  return currentAsin;
    const fromDom = findFcskuFromDOM();
    if (fromDom) return fromDom;
    const urlM = location.href.match(/issueId=([a-f0-9-]+)/i);
    if (urlM)  return urlM[1].substring(0, 12);
    return 'unknown';
  }

  async function captureSession() {
    const images = collectImages();
    if (!images.length) { showToast(t('noPhotos')); return; }

    let identifier = getCurrentIdentifier();
    if (!identifier || identifier === 'unknown' || !identifier.startsWith('ZZ')) {
      const manual = prompt('FCSKU not detected automatically.\nEnter FCSKU (ZZ...) manually:');
      if (!manual?.trim()) return;
      identifier = currentFcsku = manual.trim().toUpperCase();
    }

    const existing = await getAllSessions();
    const sameId   = existing.filter(s => s.fcsku === identifier);

    if (sameId.length) {
      highlightExistingSession(identifier);
      const action = prompt(
        `Session for ${identifier} already exists (${sameId[0].images.length} photos).\n\n` +
        `â€¢ Enter new FCSKU if it's a different product\nâ€¢ Type "OK" to save as duplicate\nâ€¢ Leave empty to cancel`
      );
      if (!action?.trim()) return;
      if (action.trim().toUpperCase() !== 'OK') identifier = currentFcsku = action.trim().toUpperCase();
    }

    const updated = (await getAllSessions()).filter(s => s.fcsku === identifier);
    const session = {
      name:       identifier + (updated.length ? `(${updated.length + 1})` : ''),
      fcsku:      identifier,
      asin:       currentAsin         || '',
      binId:      currentBinId        || '',
      expiryDate: currentExpiryDate   || currentPhysicalDate || '',
      createdAt:  Date.now(),
      url:        location.href,
      images,
    };

    await addSession(session);
    showToast(t('saved', session.name, images.length));
    renderList();
  }

  // =========================================================================
  // Â§18  BUTTON BINDING
  // =========================================================================

  const bindStatusEl = panel.querySelector('.wi-bind-status');
  let binding = false;

  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList).find(c => !c.startsWith('wi-'));
      if (cls) part += `.${CSS.escape(cls)}`;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const getBoundSelector = () => localStorage.getItem(LS_BOUND_SELECTOR) || '';
  function setBoundSelector(sel) {
    sel ? localStorage.setItem(LS_BOUND_SELECTOR, sel) : localStorage.removeItem(LS_BOUND_SELECTOR);
    updateBindStatus();
  }

  function updateBindStatus() {
    const sel = getBoundSelector();
    if (binding)   { bindStatusEl.textContent = t('bindStatusBinding'); bindStatusEl.className = 'wi-bind-status active'; }
    else if (sel)  { bindStatusEl.textContent = t('bindStatusBound');   bindStatusEl.className = 'wi-bind-status active'; }
    else           { bindStatusEl.textContent = t('bindStatusNone');    bindStatusEl.className = 'wi-bind-status'; }
  }

  function bindingClickHandler(e) {
    if (panel.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const target = e.target.closest('button,a,[role="button"],input[type="button"],input[type="submit"]') || e.target;
    const sel    = buildSelector(target);
    stopBinding();
    let ok = false;
    try { ok = document.querySelector(sel) === target; } catch (_) {}
    if (!ok) { showToast(t('bindFail')); return; }
    setBoundSelector(sel);
    showToast(t('bindSuccess'));
  }

  function startBinding() {
    if (binding) return;
    binding = true;
    document.body.classList.add('wave-iss-binding');
    document.addEventListener('click', bindingClickHandler, true);
    panel.querySelector('[data-act="bind"]').classList.add('arming');
    updateBindStatus();
  }

  function stopBinding() {
    if (!binding) return;
    binding = false;
    document.body.classList.remove('wave-iss-binding');
    document.removeEventListener('click', bindingClickHandler, true);
    panel.querySelector('[data-act="bind"]').classList.remove('arming');
    updateBindStatus();
  }

  function handleBindClick() {
    if (binding) stopBinding();
    else if (getBoundSelector()) {
      if (confirm(t('removeBind'))) { setBoundSelector(''); showToast(t('bindRemoved')); }
      else startBinding();
    } else startBinding();
  }

  // =========================================================================
  // Â§19  COMMAND CENTER MODE
  // =========================================================================

  const CC_BIN_PATTERN = /^P-\d+-[A-Z]\d{3}[A-Z]\d{3}$/;

  function ccProcessBins() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text   = node.textContent.trim();
      const parent = node.parentNode;
      if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue;
      if (parent.classList.contains('bin-shower-cc-hover')) continue;
      if (CC_BIN_PATTERN.test(text)) { parent.classList.add('bin-shower-cc-hover'); attachBarcodeHover(parent); }
    }
    for (const el of document.querySelectorAll('td,div,span,p,li')) {
      if (el.classList.contains('bin-shower-cc-hover') || el.children.length) continue;
      if (CC_BIN_PATTERN.test(el.textContent)) { el.classList.add('bin-shower-cc-hover'); attachBarcodeHover(el); }
    }
  }

  let ccObserver = null;
  function ccInit() {
    console.log('[Suite] Command Center mode.');
    ccProcessBins();
    if (ccObserver) return;
    ccObserver = new MutationObserver(() => { clearTimeout(ccObserver._t); ccObserver._t = setTimeout(ccProcessBins, 500); });
    ccObserver.observe(document.body, { childList: true, subtree: true });
  }

  // =========================================================================
  // Â§20  QUEUE INITIATION MODE
  // =========================================================================

  function queueInitiationInit() {
    console.log('[Suite] Queue Initiation mode.');
    const checkInterval = setInterval(() => {
      const input = document.querySelector('input[type="text"],input:not([type])');
      if (!input) return;
      clearInterval(checkInterval);

      const captureAndStore = () => {
        const val = input.value.trim();
        if (val.length >= 3) { console.log(`[Suite] Queue Init storing "${val}"`); setScannedBin(val); }
      };

      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') captureAndStore(); });
      const confirmBtn = document.querySelector('button');
      if (confirmBtn?.textContent.includes('Confirm')) confirmBtn.addEventListener('click', captureAndStore);

      const pollInput = setInterval(() => {
        const val = (input.value || '').trim();
        if (val.length >= 5 && /^[A-Z0-9]/.test(val)) { setScannedBin(val); clearInterval(pollInput); }
      }, 200);
      setTimeout(() => clearInterval(pollInput), 30000);
    }, 500);
    setTimeout(() => clearInterval(checkInterval), 10000);
  }

  // =========================================================================
  // Â§21  LOAD-WORKFLOW MODE
  // =========================================================================

  function loadWorkflowInit() {
    if (!isProMode()) { console.log('[Suite] Load-Workflow: Pro OFF, skipping auto-click & inventory.'); return; }
    console.log('[Suite] Load-Workflow mode (Pro ON).');

    // â”€â”€ Auto-clicker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const AUTO_CLICK_TEXTS = ['understood - continue', 'understood - fortfahren', 'next item', 'finish'];
    let lastClickedText    = null;

    function tryAutoClick() {
      for (const ab of document.querySelectorAll('alchemy-button')) {
        const textLower = (ab.textContent || '').trim().toLowerCase();
        const matched   = AUTO_CLICK_TEXTS.find(txt => textLower.includes(txt));
        if (matched && lastClickedText !== matched) {
          lastClickedText = matched;
          setTimeout(() => {
            ab.click();
            setTimeout(() => {
              const still = [...document.querySelectorAll('alchemy-button')].find(b => (b.textContent || '').trim().toLowerCase().includes(matched));
              if (still) { still.click(); setTimeout(() => { const again = [...document.querySelectorAll('alchemy-button')].find(b => (b.textContent || '').trim().toLowerCase().includes(matched)); if (again) again.click(); }, 1000); }
              else { console.log('[Suite] Auto-click button gone.'); lastClickedText = null; }
            }, 1500);
          }, 800);
          return;
        }
      }
      for (const btn of document.querySelectorAll('button')) {
        if (btn.id?.startsWith('devtools-')) continue;
        const textLower = btn.textContent.trim().toLowerCase();
        const matched   = AUTO_CLICK_TEXTS.find(txt => textLower.includes(txt));
        if (matched && lastClickedText !== matched) {
          lastClickedText = matched;
          setTimeout(() => { btn.click(); setTimeout(() => { lastClickedText = null; }, 2000); }, 300);
          return;
        }
      }
    }

    const autoClickObs   = new MutationObserver(() => tryAutoClick());
    autoClickObs.observe(document.body, { childList: true, subtree: true });
    const autoClickPoll  = setInterval(() => { if (isLoadWorkflowPage()) tryAutoClick(); else { autoClickObs.disconnect(); clearInterval(autoClickPoll); } }, 1000);

    // â”€â”€ Virtual Inventory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    showVirtualInventory();

    // â”€â”€ Quick Date Picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    showDatePicker();

    // â”€â”€ Camera Focus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    initCameraFocusControl();

    // â”€â”€ Expiration date auto-click (disabled â€” manual decision required) â”€â”€
    console.log('[Suite] Expiration date auto-click is disabled â€” manual decision required.');
  }

  // â”€â”€ Virtual Inventory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function showVirtualInventory() {
    function getWarehouseId() {
      try { return JSON.parse(localStorage.getItem('state') || '{}')?.currentUser?.fc || 'PAD2'; } catch { return 'PAD2'; }
    }
    function getContainerIdFromPage() {
      const m = (document.body.innerText || '').match(/Container\s*ID:\s*([A-Z0-9][\w-]+)/i);
      if (m) return m[1];
      for (const a of document.querySelectorAll('a')) { if (/^P-\d+-[A-Z0-9]+$/i.test(a.textContent.trim())) return a.textContent.trim(); }
      return null;
    }
    function getAsinFromPage() {
      const m = (document.body.innerText || '').match(/Asin:\s*([A-Z0-9]{10})/i);
      if (m) return m[1];
      // No "Asin:" on page: resolve it from the FcSku shown in the <h2> via FC Research.
      const fcsku = getFcSkuFromPage();
      if (!fcsku) return null;
      if (fcskuAsinCache[fcsku] !== undefined) return fcskuAsinCache[fcsku];
      resolveAsinFromFcSku(fcsku);
      return null;
    }

    const fcskuAsinCache = {};   // fcsku -> asin | null (null = looked up, not found)
    const fcskuPending   = new Set();
    function getFcSkuFromPage() {
      for (const h of document.querySelectorAll('h2')) {
        const t = h.textContent.trim();
        if (/^ZZ[A-Z0-9]{8,}$/.test(t)) return t;
      }
      return null;
    }
    function resolveAsinFromFcSku(fcsku) {
      if (fcskuPending.has(fcsku)) return;
      fcskuPending.add(fcsku);
      const wh = getWarehouseId();
      const base = `https://fcresearch-eu.aka.amazon.com/${wh}/results`;
      const ASIN_RE = /^[A-Z0-9]{10}$/;
      // Try the table endpoints (same style as the working /results/inventory call), then the page itself.
      const attempts = [
        { method: 'POST', url: `${base}/inventory`, data: `s=${encodeURIComponent(fcsku)}`,
          parse(doc) {
            for (const tr of doc.querySelectorAll('table tr')) {
              const td = tr.querySelectorAll('td');
              const a = td[1]?.textContent.trim();
              if (td.length >= 6 && ASIN_RE.test(a) && td[3]?.textContent.trim() === fcsku) return a;
            }
          } },
        { method: 'POST', url: `${base}/product`, data: `s=${encodeURIComponent(fcsku)}`,
          parse(doc) {
            for (const tr of doc.querySelectorAll('table.a-keyvalue tr')) {
              if (tr.querySelector('th')?.textContent.trim() === 'ASIN') return tr.querySelector('td')?.textContent.trim();
            }
            return doc.querySelector('table.a-keyvalue[data-row-id]')?.getAttribute('data-row-id');
          } },
        { method: 'GET', url: `${base}?s=${encodeURIComponent(fcsku)}`,
          parse(doc, raw) {
            const m = raw.match(/<th>\s*ASIN\s*<\/th>\s*<td>\s*<a[^>]*>\s*([A-Z0-9]{10})\s*</i);
            return m && m[1];
          } },
      ];
      const done = (asin) => {
        fcskuPending.delete(fcsku);
        fcskuAsinCache[fcsku] = asin || null;
        console.log('[Suite] FcSku', fcsku, '-> ASIN', asin || null);
        checkAndFetch();
      };
      const tryNext = (i) => {
        if (i >= attempts.length) return done(null);
        const at = attempts[i];
        GM_xmlhttpRequest({
          method: at.method, url: at.url,
          headers: at.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
          data: at.data,
          onload(r) {
            let asin = null;
            if (r.status === 200) {
              try { asin = at.parse(new DOMParser().parseFromString(r.responseText, 'text/html'), r.responseText); } catch (_) {}
            }
            console.log('[Suite] FcSku attempt', i, at.method, at.url, 'HTTP', r.status, '->', asin || null);
            asin && ASIN_RE.test(asin) ? done(asin) : tryNext(i + 1);
          },
          onerror() { tryNext(i + 1); }
        });
      };
      tryNext(0);
    }

    let lastFetchedContainer = null;
    let lastFetchedAsin      = null;
    let lastFetchedAsinQty   = null;
    let quantityPrefilled    = false;

    function fetchInventory(containerId, warehouseId, asin) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://fcresearch-eu.aka.amazon.com/${warehouseId}/results/inventory`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: `s=${encodeURIComponent(containerId)}`,
        onload(response) {
          if (response.status === 200) parseAndDisplayInventory(response.responseText, containerId, asin);
        },
        onerror(err) { console.error('[Suite] FC Research failed:', err); }
      });
    }

    function parseAndDisplayInventory(html, containerId, targetAsin) {
      const doc   = new DOMParser().parseFromString(html, 'text/html');
      const items = [];
      let totalQty = 0, asinQty = 0;
      for (const row of doc.querySelectorAll('table tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 6) continue;
        const asin        = cells[1]?.textContent?.trim();
        const fnsku       = cells[2]?.textContent?.trim();
        const qty         = parseInt(cells[5]?.textContent?.trim(), 10);
        const disposition = cells[6]?.textContent?.trim();
        if (!isNaN(qty) && qty > 0) {
          totalQty += qty;
          items.push({ asin, fnsku, qty, disposition });
          if (targetAsin && asin === targetAsin) asinQty += qty;
        }
      }
      if (totalQty > 0) {
        // Never prefill the bin total: only prefill when the ASIN matched.
        lastFetchedAsinQty = (targetAsin && asinQty > 0) ? asinQty : null;
        quantityPrefilled  = false;
        displayInventoryPanel(lastFetchedAsinQty, totalQty, items, containerId, targetAsin);
      }
    }

    function displayInventoryPanel(asinQty, totalQty, items, containerId, targetAsin) {
      document.querySelector('.bin-shower-inventory-panel')?.remove();
      const invPanel = document.createElement('div');
      invPanel.className = 'bin-shower-inventory-panel';
      invPanel.innerHTML = `
        <div class="inv-drag-handle"><span>${containerId}</span><span class="inv-grip">&#x2630;</span></div>
        <div class="inv-body">
          ${items.map(item => `
            <div class="inv-row ${targetAsin && item.asin === targetAsin ? 'inv-highlight' : ''}">
              <div>
                <span class="inv-fnsku ${targetAsin && item.asin === targetAsin ? 'match' : ''}">${item.fnsku || ''}</span>
                <span class="inv-asin">${item.asin}</span>
                <span class="inv-disposition">${item.disposition}</span>
              </div>
              <span class="inv-qty-cell ${targetAsin && item.asin === targetAsin ? 'match' : ''}">${item.qty}</span>
            </div>`).join('')}
        </div>
        <div class="inv-footer"><span>Bin Total</span><span class="inv-footer-total">${totalQty}</span></div>`;
      document.body.appendChild(invPanel);

      try {
        const pos = JSON.parse(sessionStorage.getItem('binShowerInvPos') || 'null');
        if (pos) { invPanel.style.top = `${pos.top}px`; invPanel.style.left = `${pos.left}px`; invPanel.style.right = 'auto'; }
      } catch (_) {}

      const handle = invPanel.querySelector('.inv-drag-handle');
      let isDragging = false, startX, startY, startLeft, startTop;
      handle.addEventListener('mousedown', (e) => {
        isDragging = true; startX = e.clientX; startY = e.clientY;
        const r = invPanel.getBoundingClientRect(); startLeft = r.left; startTop = r.top;
        invPanel.style.right = 'auto'; e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        invPanel.style.left = `${startLeft + e.clientX - startX}px`;
        invPanel.style.top  = `${startTop  + e.clientY - startY}px`;
      });
      document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; try { sessionStorage.setItem('binShowerInvPos', JSON.stringify({ top: parseInt(invPanel.style.top), left: parseInt(invPanel.style.left) })); } catch (_) {} }
      });
    }

    function prefillQuantity() {
      if (quantityPrefilled || !lastFetchedAsinQty) return;
      for (const input of document.querySelectorAll('input')) {
        if (input.type === 'hidden') continue;
        if (input.closest('.bin-shower-inventory-panel,.bin-shower-datepicker,#wave-dpt-control-panel')) continue;
        if (input.id?.startsWith('devtools-')) continue;
        try { const s = window.getComputedStyle(input); if (s.display === 'none' || s.visibility === 'hidden' || !input.offsetParent) continue; } catch (_) { continue; }
        if (input.value) return;
        const qty = String(lastFetchedAsinQty);
        input.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, qty);
        if (input._valueTracker) input._valueTracker.setValue('');
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        quantityPrefilled = true;
        return;
      }
    }

    function checkAndFetch() {
      const containerId = getContainerIdFromPage();
      const asin        = getAsinFromPage();
      if (!containerId) return;

      const bodyText      = document.body.innerText;
      const isQuantityStep = bodyText.includes('Quantity') && bodyText.includes('virtually in the bin');
      const isAsinStep     = bodyText.includes('Scan the ASIN') || bodyText.includes('ASIN Sticker') || bodyText.includes('scan an item barcode');
      const invPanel      = document.querySelector('.bin-shower-inventory-panel');

      if (invPanel) {
        if (!(isQuantityStep || isAsinStep)) { invPanel.style.display = 'none'; return; }
        invPanel.style.display = '';
      }
      if (isQuantityStep) prefillQuantity();

      if (containerId !== lastFetchedContainer || asin !== lastFetchedAsin) {
        lastFetchedContainer = containerId; lastFetchedAsin = asin;
        fetchInventory(containerId, getWarehouseId(), asin);
      }
    }

    const invPoll = setInterval(checkAndFetch, 2000);
    const invObs  = new MutationObserver(() => { clearTimeout(invObs._t); invObs._t = setTimeout(checkAndFetch, 500); });
    invObs.observe(document.body, { childList: true, subtree: true });
    const invStop = setInterval(() => {
      if (!isLoadWorkflowPage()) {
        clearInterval(invPoll); clearInterval(invStop); invObs.disconnect();
        document.querySelector('.bin-shower-inventory-panel')?.remove();
      }
    }, 2000);
  }

  // â”€â”€ Quick Date Picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function showDatePicker() {
    let pickerEl      = null;
    let selectedDay   = null, selectedMonth = null, selectedYear = null;

    function createPicker() {
      if (pickerEl) return pickerEl;
      pickerEl = document.createElement('div');
      pickerEl.className = 'bin-shower-datepicker';

      const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
      const curYear = new Date().getFullYear();
      const years   = Array.from({ length: 9 }, (_, i) => String(curYear + i));
      const days    = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));
      const lastDate = sessionStorage.getItem('binShowerLastDate') || '';

      pickerEl.innerHTML = `
        <div class="dp-header"><span>Quick Date (DD/MM/YYYY)</span><span style="opacity:.5;font-size:10px">&#x2630;</span></div>
        <div class="dp-body">
          <button class="dp-last" id="dp-last" style="display:${lastDate ? 'block' : 'none'}">${lastDate ? `Last: ${lastDate}` : ''}</button>
          <div class="dp-section"><div class="dp-label">Day</div><div class="dp-grid days">${days.map(d => `<div class="dp-btn dp-day" data-val="${d}">${d}</div>`).join('')}</div></div>
          <div class="dp-section"><div class="dp-label">Month</div><div class="dp-grid months">${months.map(m => `<div class="dp-btn dp-month" data-val="${m}">${m}</div>`).join('')}</div></div>
          <div class="dp-section"><div class="dp-label">Year</div><div class="dp-grid years">${years.map(y => `<div class="dp-btn dp-year" data-val="${y}">${y}</div>`).join('')}</div></div>
          <div class="dp-preview" id="dp-preview">--/--/----</div>
          <button class="dp-submit" id="dp-submit" disabled>Insert &amp; Next</button>
        </div>`;
      document.body.appendChild(pickerEl);

      pickerEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.dp-btn');
        if (!btn) return;
        if (btn.classList.contains('dp-day'))   { pickerEl.querySelectorAll('.dp-day').forEach(b => b.classList.remove('selected'));   btn.classList.add('selected'); selectedDay   = btn.dataset.val; }
        if (btn.classList.contains('dp-month')) { pickerEl.querySelectorAll('.dp-month').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); selectedMonth = btn.dataset.val; }
        if (btn.classList.contains('dp-year'))  { pickerEl.querySelectorAll('.dp-year').forEach(b => b.classList.remove('selected'));  btn.classList.add('selected'); selectedYear  = btn.dataset.val; }
        updatePreview();
      });

      pickerEl.querySelector('#dp-submit').addEventListener('click', () => {
        if (selectedDay && selectedMonth && selectedYear) insertDate(`${selectedDay}/${selectedMonth}/${selectedYear}`);
      });
      pickerEl.querySelector('#dp-last').addEventListener('click', () => {
        const stored = sessionStorage.getItem('binShowerLastDate');
        if (stored) insertDate(stored);
      });

      // Drag
      const handle = pickerEl.querySelector('.dp-header');
      let isDragging = false, sX, sY, sL, sT;
      try {
        const pos = JSON.parse(sessionStorage.getItem('binShowerDatePos') || 'null');
        if (pos) { pickerEl.style.top = `${pos.top}px`; pickerEl.style.left = `${pos.left}px`; pickerEl.style.right = 'auto'; pickerEl.style.transform = 'none'; }
      } catch (_) {}
      handle.addEventListener('mousedown', (e) => {
        isDragging = true; sX = e.clientX; sY = e.clientY;
        const r = pickerEl.getBoundingClientRect(); sL = r.left; sT = r.top;
        pickerEl.style.right = 'auto'; pickerEl.style.transform = 'none'; e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => { if (isDragging) { pickerEl.style.left = `${sL + e.clientX - sX}px`; pickerEl.style.top = `${sT + e.clientY - sY}px`; } });
      document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; try { sessionStorage.setItem('binShowerDatePos', JSON.stringify({ top: parseInt(pickerEl.style.top), left: parseInt(pickerEl.style.left) })); } catch (_) {} }
      });

      return pickerEl;
    }

    function updatePreview() {
      if (!pickerEl) return;
      pickerEl.querySelector('#dp-preview').textContent = `${selectedDay || '--'}/${selectedMonth || '--'}/${selectedYear || '----'}`;
      pickerEl.querySelector('#dp-submit').disabled = !(selectedDay && selectedMonth && selectedYear);
    }

    function insertDate(dateStr) {
      let targetInput = null;
      for (const input of document.querySelectorAll('input')) {
        if (input.type === 'hidden') continue;
        if (input.closest('.bin-shower-datepicker,#wave-dpt-control-panel')) continue;
        if (input.id?.startsWith('devtools-')) continue;
        try { const s = window.getComputedStyle(input); if (s.display === 'none' || s.visibility === 'hidden' || !input.offsetParent) continue; } catch (_) { continue; }
        targetInput = input; break;
      }
      if (!targetInput) { console.log('[Suite] DatePicker: no visible input.'); return; }

      sessionStorage.setItem('binShowerLastDate', dateStr);
      if (pickerEl) {
        const lb = pickerEl.querySelector('#dp-last');
        if (lb) { lb.textContent = `Last: ${dateStr}`; lb.style.display = 'block'; }
      }

      targetInput.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(targetInput, dateStr);
      if (targetInput._valueTracker) targetInput._valueTracker.setValue('');
      targetInput.dispatchEvent(new Event('input',  { bubbles: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));

      setTimeout(() => {
        for (const ab of document.querySelectorAll('alchemy-button')) {
          const txt = (ab.textContent || '').trim().toLowerCase();
          if (txt === 'next' || txt === 'weiter') { ab.click(); return; }
        }
        for (const btn of document.querySelectorAll('button')) {
          if (btn.id?.startsWith('devtools-') || btn.closest('.bin-shower-datepicker')) continue;
          const txt = btn.textContent.trim().toLowerCase();
          if (txt === 'next' || txt === 'weiter') { btn.click(); return; }
        }
      }, 300);

      selectedDay = selectedMonth = selectedYear = null;
      pickerEl?.querySelectorAll('.dp-btn.selected').forEach(b => b.classList.remove('selected'));
      updatePreview();
    }

    function checkForDateStep() {
      const bodyText = document.body.innerText;
      const hasDDMMYYYY = bodyText.includes('DD/MM/YYYY');
      let hasVisibleInput = false;
      if (hasDDMMYYYY) {
        for (const input of document.querySelectorAll('input')) {
          if (input.type === 'hidden' || input.closest('.bin-shower-datepicker,#wave-dpt-control-panel')) continue;
          try { const s = window.getComputedStyle(input); if (s.display !== 'none' && s.visibility !== 'hidden' && input.offsetParent) { hasVisibleInput = true; break; } } catch (_) {}
        }
      }
      createPicker().classList.toggle('visible', hasDDMMYYYY && hasVisibleInput);
    }

    const dpPoll = setInterval(checkForDateStep, 1000);
    const dpObs  = new MutationObserver(() => { clearTimeout(dpObs._t); dpObs._t = setTimeout(checkForDateStep, 300); });
    dpObs.observe(document.body, { childList: true, subtree: true });
    const dpStop = setInterval(() => {
      if (!isLoadWorkflowPage()) { clearInterval(dpPoll); clearInterval(dpStop); dpObs.disconnect(); pickerEl?.remove(); pickerEl = null; }
    }, 2000);
  }

  // â”€â”€ Camera Focus Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function initCameraFocusControl() {
    let focusBarEl = null, currentTrack = null;

    function createFocusBar() {
      if (focusBarEl) return focusBarEl;
      focusBarEl = document.createElement('div');
      focusBarEl.className = 'bin-shower-focus-bar';
      focusBarEl.innerHTML = `
        <span class="focus-label">FOCUS</span>
        <input type="range" id="bs-focus-slider" min="0" max="1000" value="500" step="10">
        <span class="focus-value" id="bs-focus-value">Auto</span>
        <button class="focus-auto-btn" id="bs-focus-auto">Auto</button>`;
      document.body.appendChild(focusBarEl);

      const slider = focusBarEl.querySelector('#bs-focus-slider');
      const label  = focusBarEl.querySelector('#bs-focus-value');
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value);
        label.textContent = v === 0 ? 'Near' : v >= 1000 ? 'Far' : v;
        applyFocus('manual', v / 1000);
      });
      focusBarEl.querySelector('#bs-focus-auto').addEventListener('click', () => {
        applyFocus('continuous', null); label.textContent = 'Auto'; slider.value = 500;
      });
      return focusBarEl;
    }

    async function applyFocus(mode, distance) {
      if (!currentTrack) return;
      try {
        const caps = currentTrack.getCapabilities();
        const c    = {};
        if (caps.focusMode?.includes(mode)) c.focusMode = mode;
        if (mode === 'manual' && distance !== null && caps.focusDistance) {
          const min = caps.focusDistance.min || 0, max = caps.focusDistance.max || 1;
          c.focusDistance = min + (max - min) * distance;
        }
        await currentTrack.applyConstraints({ advanced: [c] });
      } catch (e) { console.log('[Suite] Focus error:', e.message); }
    }

    const focusPoll = setInterval(() => {
      if (!isLoadWorkflowPage()) return;
      const video  = document.querySelector('video[autoplay]');
      const track  = video?.srcObject?.getVideoTracks()?.[0] || null;
      const bar    = createFocusBar();
      if (track?.readyState === 'live') {
        currentTrack = track;
        try { const caps = track.getCapabilities(); bar.classList.toggle('visible', !!(caps.focusMode || caps.focusDistance)); }
        catch (_) { bar.classList.remove('visible'); }
      } else { currentTrack = null; bar.classList.remove('visible'); }
    }, 1000);

    const focusStop = setInterval(() => {
      if (!isLoadWorkflowPage()) { clearInterval(focusPoll); clearInterval(focusStop); focusBarEl?.remove(); focusBarEl = null; }
    }, 2000);
  }

  // =========================================================================
  // Â§22  SINGLE SPA ROUTER
  // =========================================================================

  let lastUrl            = location.href;
  let binShowerRunning   = false;
  let loadWorkflowActive = false;

  function routeForCurrentPage() {
    console.log(`[Suite] Routing: ${location.pathname}`);
    if (isContainerPage() && !binShowerRunning) {
      binShowerRunning = true;
      setTimeout(() => binShowerRun().finally(() => { binShowerRunning = false; }), 1500);
    } else if (isCommandCenterPage()) {
      ccInit();
    } else if (isQueueInitPage()) {
      queueInitiationInit();
    } else if (isLoadWorkflowPage() && !loadWorkflowActive) {
      loadWorkflowActive = true;
      loadWorkflowInit();
    }
  }

  function onUrlChange() {
    console.log(`[Suite] URL â†’ ${location.pathname}`);
    hideBarcode();
    reapplyPersistedHighlight._autoClicked = false;
    loadWorkflowActive = false;
    binShowerRunning   = false;
    setTimeout(routeForCurrentPage, 300);
    setTimeout(routeForCurrentPage, 1000);
    setTimeout(routeForCurrentPage, 2500);
  }

  // URL polling (primary â€” most reliable for React SPA route changes)
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; onUrlChange(); }
    if (isContainerPage()) reapplyPersistedHighlight();
  }, 500);

  // MutationObserver (secondary â€” faster detection)
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; onUrlChange(); }
  }).observe(document.body, { childList: true, subtree: true });

  // =========================================================================
  // Â§23  BOOTSTRAP
  // =========================================================================

  createProModeButton();
  updateBindStatus();
  updateInjectStatus();
  renderList();

  // Initial FCSKU detection from DOM (before XHR fires)
  setTimeout(async () => {
    const fcsku = findFcskuFromDOM();
    if (fcsku && !currentFcsku) { currentFcsku = fcsku; await checkExistingSession(fcsku); }
  }, 1500);

  // Periodic FCSKU re-check (backup for pages where GraphQL doesn't fire)
  setInterval(async () => {
    const fcsku = findFcskuFromDOM();
    if (fcsku && fcsku !== currentFcsku) {
      currentFcsku = fcsku;
      clearHighlights(); hideSessionAlert();
      await checkExistingSession(fcsku);
      renderList();
    }
  }, 2000);

  // Initial page route
  routeForCurrentPage();

})();
