# Tampermonkey Scripts Summary

## 1. Sideline v6.0 (`sideline-6.0.user.js`)
**Author:** joyhjoe | **Domain:** AFT Poirot  
**Purpose:** Automated multi-tote deletion with price verification  
- Paste tote IDs, processes them sequentially
- Reads all items (FNSKU/ASIN + qty) from Change Container page
- Resolves X0 FNSKUs to ASINs via FC Research `/results/product` API
- Fetches live Amazon.co.uk prices (parallel batches of 3)
- Shows confirmation dialog with item table + grand total
- High-value (>1000) and high-qty (>100) warnings
- Skips vt/pa/numeric totes
- Persists progress across page reloads

---

## 2. FC Badge Manager (`FC Badge Manager.user.js`)
**Author:** joyhjoe | **Domain:** FC Research + localhost:5965  
**Purpose:** Auto-captures badge ID from FC Research, auto-fills barcode generator  
- 5 detection strategies: cookies, window vars, storage, URL params, DOM scan
- Saves badge/login/WHID to GM storage
- On barcode generator page: auto-fills badge input field
- Only shows notification when badge changes (not on every refresh)

---

## 3. FC Research Print (`FC Research Print.user.js`)
**Author:** scdavids | **Domain:** FC Research  
**Purpose:** Adds Print buttons for ASIN/FNSKU/FCSku to FC Research product pages  
- Adds "Print ASIN", "Print FNSku", "Print FCSku" buttons next to each identifier
- Uses localhost:5965 Printmon for barcode printing
- Alt+Click on any text to quick-print it
- Alt+P for free-print mode (enter any barcode)
- Logs print actions to Slack and Chime webhooks

---

## 4. FC Research Enhanced Tooltips & Quick History (`FC Research Enhanced Tooltips & Quick History.user.js`)
**Author:** sarsingm | **Domain:** FC Research  
**Purpose:** Hover tooltips with product images/employee details + Quick 6-Month History button  
- Hover any ASIN link -> shows product image + title tooltip
- Hover any employee login -> shows photo, name, job title, FC, supervisor
- Caches data in localStorage (20h TTL)
- Adds "Quick 6 Month History" nav button that auto-sets date range and searches

---

## 5. FCresearch +++ (`FCresearch +++.user.js`)
**Author:** filiklak | **Domain:** FC Research + multiple Amazon tools  
**Purpose:** Adds quick-action buttons (Defect, Prep, Hazmat, TSI, SIM TT, CSI, etc.)  
- For B0/X0 searches: adds buttons linking to Prep Manager, Pandash Hazmat, SIM tickets, Cubiscan, TSI
- For container (ts/cs) searches: adds Printmon, Rodeo, TSI links
- Auto-fills forms on Smart ICQA, Pandash, Printmon, FC Transshipment Portal
- Copy-to-clipboard on ASIN/FCSku badges

---

## 6. FCResearch AdjacentBins (`FCResearch AdjacentBins.user.js`)
**Author:** Kmmcclai | **Domain:** FC Research  
**Purpose:** Shows floor level for inventory bins via Roboscout API  
- Adds "Find Floor Level" button to Inventory section
- For each container, calls Roboscout adjacent bins API
- Displays floor level info inline in the inventory table

---

## 7. Move Items Buttons (`Move Items Buttons.user.js`)
**Author:** cgriffie | **Domain:** AFT Move Items  
**Purpose:** Adds EACH/MULTI/CONTAINER/LPN mode buttons to Move Items page  
- Eliminates need to navigate menus for mode changes
- Cage-scan acts as Enter key (scan source cage to confirm)
- Auto-fills quantity "1" when in Multi mode with single item
- Prevents scanner-induced crashes from rogue Enter events

---

## 8. Autofill Move Items Quantity (`Autofill Move Items Quantity.user.js`)
**Author:** ammcclu | **Domain:** AFT Move Items  
**Purpose:** Auto-fills the quantity field on the Move Items destination page  
- Reads quantity from page and fills the input automatically
- Only fires when on the correct step (not scan destination or scan item)

---

## 9. Multi-container & Multi-ASIN EditItems Auto Expiration Date (`Multi-container...user.js`)
**Author:** ibnahlho | **Domain:** AFT Edit Items  
**Purpose:** Bulk-processes expiration date edits across multiple containers and ASINs  
- Paste container list + ASIN(s) + expiration date
- Single-ASIN or Multi-ASIN mode (processes all ASINs per container)
- Start/Pause/Reset controls with progress tracking
- Auto-saves state, supports overwrite mode
- Activity log with timestamps

---

## Why They Can't Be Merged Into One Script

These scripts target **different domains** (`@match`):
- AFT Poirot (`aft-poirot-website-dub.dub.proxy.amazon.com`)
- FC Research (`qi-fcresearch-eu.corp.amazon.com`, `fcresearch-eu.aka.amazon.com`)
- AFT Move Items (`aft-qt-eu.aka.amazon.com/app/moveitems`)
- AFT Edit Items (`aft-qt-eu.aka.amazon.com/app/edititems`)
- Barcode Generator (`localhost:5965`)
- Various other Amazon internal tools

Tampermonkey only runs a script on pages matching its `@match` patterns. Merging them into one script with ALL match patterns would:
1. Load unnecessary code on every page (slow)
2. Risk DOM conflicts between scripts
3. Make maintenance difficult

**Recommendation:** Keep them as separate scripts. The FC Badge Manager is the only one that spans multiple domains (by design).
