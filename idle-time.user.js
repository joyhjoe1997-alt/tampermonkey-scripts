// ==UserScript==
// @name        Idle Time (FS,LM) - amazon.com
// @namespace   Violentmonkey Scripts
// @match       https://fclm-portal.amazon.com/reports/functionRollup*
// @version     7.1
// @grant       GM_xmlhttpRequest
// @author      mmarcelp
// @author      koosting
// @author      xlle@amazon.com
// @author      joyhjoe (v7 mods)
// @description Enhanced employee activity monitoring with idle gap breakdown (>15m, >30m)
// ==/UserScript==

(function() {
'use strict';

const employeeMisses = new Map();
const processedLogins = new Set();

// Style Definitions
const styleSheet = document.createElement("style");
styleSheet.textContent = `
.transfer-button {
    background-color: #0066cc;
    color: white;
    border: none;
    border-radius: 3px;
    padding: 1px 4px;
    cursor: pointer;
    margin-left: 3px;
    font-size: 11px;
    vertical-align: middle;
    min-width: 40px;
    font-weight: normal;
}
.idle-time-cell {
    font-size: 11px;
    vertical-align: middle;
    white-space: nowrap;
}
.transfer-time-cell {
    display: flex;
    align-items: center;
    white-space: nowrap;
    max-width: 120px;
}
.transfer-time-display {
    display: inline-block;
    margin-right: 3px;
}
.transfer-summary-button {
    position: fixed;
    top: 20px;
    right: 20px;
    background-color: #0066cc;
    color: white;
    border: none;
    border-radius: 5px;
    padding: 10px 20px;
    cursor: pointer;
    z-index: 1000;
    font-weight: bold;
}
.transfer-summary-modal {
    display: none;
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: white;
    padding: 20px;
    border-radius: 5px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
    z-index: 1001;
    max-height: 80vh;
    overflow-y: auto;
    min-width: 600px;
}
.transfer-summary-modal.show {
    display: block;
}
.modal-backdrop {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0,0,0,0.5);
    z-index: 1000;
}
.modal-backdrop.show {
    display: block;
}
.transfer-summary-header {
    font-size: 18px;
    font-weight: bold;
    margin-bottom: 15px;
    padding-bottom: 10px;
    border-bottom: 1px solid #ddd;
}
.transfer-summary-content {
    margin-bottom: 15px;
}
.transfer-detail-item {
    padding: 8px;
    border-bottom: 1px solid #eee;
    margin-bottom: 10px;
}
.transfer-detail-item:nth-child(odd) {
    background-color: #f9f9f9;
}
.transfer-miss {
    color: red;
    margin-left: 15px;
    padding: 3px 0;
}
.close-modal-button {
    position: absolute;
    top: 10px;
    right: 10px;
    background: none;
    border: none;
    font-size: 20px;
    cursor: pointer;
}
.total-misses {
    font-size: 16px;
    font-weight: bold;
    margin-bottom: 15px;
    padding: 10px;
    background-color: #f0f0f0;
    border-radius: 5px;
    text-align: center;
}
.manager-section {
    margin-bottom: 20px;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 5px;
}
.manager-header {
    font-size: 16px;
    font-weight: bold;
    margin-bottom: 10px;
    padding-bottom: 5px;
    border-bottom: 2px solid #0066cc;
    color: #0066cc;
}
.transfer-details {
    display: none;
    position: absolute;
    background-color: white;
    border: 1px solid #ddd;
    padding: 10px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    z-index: 1000;
    font-size: 12px;
    min-width: 150px;
}
.transfer-details.show {
    display: block;
}
tfoot td {
    text-align: center;
    font-weight: bold;
    border-top: 2px solid #ddd;
}
.sort-button {
    background: none;
    border: none;
    cursor: pointer;
    font-weight: bold;
    padding: 5px;
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
}
.sort-button:hover {
    background-color: #f0f0f0;
}
.sort-button.active {
    color: #0066cc;
}
.sort-icon {
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-left: 5px;
}
.sort-button.desc .sort-icon::after {
    content: '\\25BC';
}
.sort-button.asc .sort-icon::after {
    content: '\\25B2';
}
`;
document.head.appendChild(styleSheet);

// Department Definitions
const departments = {
    P2R: {
        name: 'P2R',
        processes: [
            'Pack Multis\u2666Pack Kaizen 1',
            'Pack Singles\u2666Pack Kaizen 1',
            'Pack Multis\u2666Pack Kaizen 2',
            'Pack Singles\u2666Pack Kaizen 2',
            'Pack Multis\u2666Pack Merge',
            'Pack Singles\u2666Pack Merge',
            'Pick\u2666Pick To Rebin',
            'Pack Support\u2666P2R Waterspider',
            'Process Guide PackMu',
            'Pack Support\u2666Process Guide PackMu',
        ]
    },
    ArsawPick: {
        name: 'ARSAW',
        processes: [
            'Pick\u2666MultiFlow Picking',
            'Pick\u2666RF Pick Singles',
            'Pick\u2666RF Pick',
            'Transfer Out Pick\u2666RF Pick Transship',
            'Pick Support\u2666Tote Replenishment',
        ]
    },
    Stow: {
        name: 'Stow',
        processes: [
            'Each Transfer In\u2666Stow Each Nike',
            'Stow to Prime\u2666Stow Each Nike',
            'Stow to Prime\u2666Stow Each Nike Light',
            'Each Transfer In\u2666Stow Each Nike Light',
            'Pack Support\u2666Buffer Operator',
            'Buffer Operator',
            'Transfer In Support\u2666Cart/Pallet Builder',
            'Facility\u2666Tote Prep',
        ]
    },
    Dock: {
        name: 'DOCK',
        processes: [
            'Container Load\u2666Container Loader',
            'Fluid Load\u2666Fluid Loader',
            'Container Build\u2666Auto Cont. Builder',
            'Container Move\u2666Flat Waterspider',
            'Container Move\u2666Flat Wing',
            'Pallet Banding',
            'I Induct\u2666Flat Inductor',
            'Process Guide Ship',
            'Ship Dock Support\u2666Process Guide Ship',
            'Ship Dock Support\u2666FSRI Operator',
            'FSRI Operator',
            'Dock Pallet Loader',
            'Container Build\u2666Manual Cont. Builder',
        ]
    },
    Problemsolve: {
        name: 'PS',
        processes: [
            'Pack Multis\u2666Scan Packages',
            'Pack Support\u2666SLAM Kickout',
            'OB Problem Solve\u2666POPS Check In',
            'OB Problem Solve\u2666Pack from POPS',
            'OB Problem Solve\u2666POPS Collector',
            'OB Problem Solve\u2666POPS Runner',
            'OB Problem Solve\u2666POPS Overage',
        ]
    },
    Singlepack: {
        name: 'SM',
        processes: [
            'Pack Singles\u2666Scan Verify SIOC',
            'Chuting\u2666Scan Verify AFE',
            'Buffer Operator',
            'Pack Support\u2666Buffer Operator',
            'SLAM Operator',
            'Pack Support\u2666SLAM Operator',
            'Gift-Wrap\u2666Pack HandTape',
            'Gift-Wrap\u2666Pack Multis HandTape',
            'Custom Packaging\u2666Pack Multis HandTape',
            'Pack Singles\u2666Scan Verify Medium',
            'Pack Singles\u2666Scan Verify',
            'Sort-Flow\u2666AFE 1 Rebin',
            'Pack Singles\u2666Scan Verify Large',
            'Pack Singles\u2666Slam At Pack',
            'Pack Singles\u2666SLAP Mix',
            'Sort-Flow\u2666AFE1 Induct',
        ]
    },
    Icqa: {
        name: 'ICQA',
        processes: [
            'IC-QA-CS\u2666SBC - Other',
            'IC-QA-CS\u2666Other Other',
            'IC-QA-CS\u2666Simple Record Count',
            'IC-QA-CS\u2666Amnesty',
            'Amnesty',
            'IC-QA-CS\u2666Damage Processing',
            'IC-QA-CS\u2666Andon Bin Chk WAVE',
            'IB Problem Solve\u2666Stow to Prime PSolve',
        ]
    },
    Receive: {
        name: 'REC',
        processes: [
            'Facility\u2666Tote Prep',
            'Transfer In Dock\u2666Decant',
            'RSR Support\u2666Decant',
            'Receive-Support\u2666Decant Non-TI',
            'Transfer In Support\u2666Line Load Injection',
            'Each-Receive\u2666Receive Medium A',
            'Transfer In Dock\u2666Pallet_decant_split',
            'Prep Recorder\u2666Prep Receive',
            'Transfer In Support\u2666TransferIn Transport',
        ]
    }
};

// Helper Functions
function createCell(content, backgroundColor, textColor = '', isIdleTime = false) {
    const cell = document.createElement('td');
    cell.textContent = content;
    if (backgroundColor) cell.style.backgroundColor = backgroundColor;
    if (textColor) cell.style.color = textColor;
    if (isIdleTime) cell.classList.add('idle-time-cell');
    return cell;
}

// Color based on idle percentage: red >10%, yellow >=8%, green <8%
function getIdleTimeColor(percentage) {
    if (percentage > 10) return '#ffc7ce';
    if (percentage >= 8) return '#ffeb9c';
    return '#c6efce';
}

// Color based on gap count: red 3+, yellow 1-2, green 0
function getGapColor(count) {
    if (count >= 3) return '#ffc7ce';
    if (count >= 1) return '#ffeb9c';
    return '#c6efce';
}

function formatIdleTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function calculateIdlePercentage(idleTime, paidTimeSegments) {
    let totalTime = 0;
    paidTimeSegments.forEach((row) => {
        const tds = row.querySelectorAll('td');
        if (tds.length >= 4) {
            const timeText = tds[3].innerText;
            const [hours, minutes] = timeText.split(':').map(Number);
            totalTime += hours + (minutes / 60);
        }
    });
    return totalTime > 0 ? (idleTime / totalTime * 100) : 0;
}

// Sorting functions
function getColumnValue(row, columnType) {
    const cells = row.querySelectorAll('td[data-custom]');
    let value = 0;
    let text, minutes, seconds, transferCell;

    switch(columnType) {
        case 'idle':
            text = cells[0]?.textContent || '0';
            value = parseFloat(text.replace(/[^\d.]/g, '')) || 0;
            break;
        case 'idlePercentage':
            text = cells[1]?.textContent || '0%';
            value = parseFloat(text.replace('%', '')) || 0;
            break;
        case 'fast':
            text = cells[2]?.textContent || '';
            value = text === '\u2713' ? 0 : parseInt(text.replace(/[^\d.]/g, '')) || 0;
            break;
        case 'transfer':
            transferCell = cells[3]?.querySelector('.transfer-time-display');
            if (!transferCell || transferCell.textContent === '-') {
                value = 0;
            } else {
                [minutes, seconds] = (transferCell.textContent || '0:00').split(':').map(Number);
                value = (minutes || 0) + ((seconds || 0) / 60);
            }
            break;
        case 'idle15':
            text = cells[4]?.textContent || '0';
            value = text === '\u2713' ? 0 : parseInt(text) || 0;
            break;
        case 'idle30':
            text = cells[5]?.textContent || '0';
            value = text === '\u2713' ? 0 : parseInt(text) || 0;
            break;
        default:
            value = 0;
    }
    return value;
}

function sortTableByColumn(table, columnType, ascending = false) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach((row, index) => {
        row.setAttribute('data-original-order', index);
    });

    rows.sort((a, b) => {
        const valueA = getColumnValue(a, columnType);
        const valueB = getColumnValue(b, columnType);
        if (valueA === valueB) {
            return (parseInt(a.getAttribute('data-original-order')) -
                   parseInt(b.getAttribute('data-original-order')));
        }
        return ascending ? valueA - valueB : valueB - valueA;
    });

    tbody.innerHTML = '';
    rows.forEach(row => tbody.appendChild(row));
}

function checkForTransfer(currentProcess, nextProcess) {
    let fromDepartment = null;
    let toDepartment = null;

    for (let dept in departments) {
        if (departments[dept].processes.includes(currentProcess)) {
            fromDepartment = departments[dept].name;
        }
        if (departments[dept].processes.includes(nextProcess)) {
            toDepartment = departments[dept].name;
        }
    }

    if (fromDepartment && toDepartment && fromDepartment !== toDepartment) {
        return { from: fromDepartment, to: toDepartment, fromProcess: currentProcess, toProcess: nextProcess };
    }
    return null;
}

function parseTransferTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    try {
        if (timeStr.includes(':')) {
            const [minutes, seconds] = timeStr.split(':').map(Number);
            return minutes + (seconds / 60);
        }
        return parseFloat(timeStr) || 0;
    } catch (error) {
        return 0;
    }
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    try {
        if (timeStr.includes(':')) {
            const [hours, minutes] = timeStr.split(':').map(Number);
            return (hours * 60) + minutes;
        }
        return parseFloat(timeStr) || 0;
    } catch (error) {
        return 0;
    }
}

function formatMinutesToTime(totalMinutes) {
    const minutes = Math.floor(totalMinutes);
    const seconds = Math.round((totalMinutes % 1) * 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function createTransferSummaryButton() {
    const button = document.createElement('button');
    button.className = 'transfer-summary-button';
    button.textContent = 'Transfer Misses Summary';

    const modal = document.createElement('div');
    modal.className = 'transfer-summary-modal';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const closeButton = document.createElement('button');
    closeButton.className = 'close-modal-button';
    closeButton.textContent = '\u00d7';
    modal.appendChild(closeButton);

    const header = document.createElement('div');
    header.className = 'transfer-summary-header';
    header.textContent = 'Transfer Misses Summary';
    modal.appendChild(header);

    const content = document.createElement('div');
    content.className = 'transfer-summary-content';
    modal.appendChild(content);

    button.onclick = updateAndShowModal;
    closeButton.onclick = () => {
        modal.classList.remove('show');
        backdrop.classList.remove('show');
    };
    backdrop.onclick = closeButton.onclick;

    document.body.appendChild(button);
    document.body.appendChild(modal);
    document.body.appendChild(backdrop);
}

function updateAndShowModal() {
    const modal = document.querySelector('.transfer-summary-modal');
    const backdrop = document.querySelector('.modal-backdrop');
    const content = modal.querySelector('.transfer-summary-content');
    content.innerHTML = '';

    const managerGroups = new Map();
    employeeMisses.forEach((data, login) => {
        const manager = data.manager;
        if (!managerGroups.has(manager)) {
            managerGroups.set(manager, []);
        }
        managerGroups.get(manager).push({login, ...data});
    });

    let totalMisses = 0;
    employeeMisses.forEach(data => { totalMisses += data.missCount; });

    const totalMissesDiv = document.createElement('div');
    totalMissesDiv.className = 'total-misses';
    totalMissesDiv.textContent = `Total Transfer Misses: ${totalMisses}`;
    content.appendChild(totalMissesDiv);

    const sortedManagers = Array.from(managerGroups.entries()).sort((a, b) => {
        const missesA = a[1].reduce((sum, emp) => sum + emp.missCount, 0);
        const missesB = b[1].reduce((sum, emp) => sum + emp.missCount, 0);
        return missesB - missesA;
    });

    sortedManagers.forEach(([manager, employees]) => {
        const managerSection = document.createElement('div');
        managerSection.className = 'manager-section';

        const managerHeader = document.createElement('div');
        managerHeader.className = 'manager-header';
        managerHeader.textContent = `Manager: ${manager}`;
        managerSection.appendChild(managerHeader);

        employees.sort((a, b) => b.totalTime - a.totalTime);

        employees.forEach(({ loginName, missCount, details, totalTime }) => {
            const detailItem = document.createElement('div');
            detailItem.className = 'transfer-detail-item';

            if (missCount > 0) {
                let detailsHtml = `
                    <strong>Login:</strong> <a href="https://fclm-portal.amazon.com/employee/timeDetails?warehouseId=BRE2&employeeId=${loginName}" target="_blank">${loginName}</a><br>
                    <strong>Total Misses:</strong> ${missCount}<br>
                    <strong>Total Transfer Time:</strong> ${formatMinutesToTime(totalTime)}<br>
                    <strong>Transfer Details:</strong>
                `;

                const missedTransfers = details.filter(transfer =>
                    parseTransferTimeToMinutes(transfer.time) > 10
                );

                missedTransfers.forEach(transfer => {
                    detailsHtml += `
                        <div class="transfer-miss">
                            ${transfer.from} \u2192 ${transfer.to} (${transfer.time})
                        </div>
                    `;
                });

                detailItem.innerHTML = detailsHtml;
                managerSection.appendChild(detailItem);
            }
        });

        content.appendChild(managerSection);
    });

    modal.classList.add('show');
    backdrop.classList.add('show');
}

function createTransferCell(transfers, login, row) {
    const cell = document.createElement('td');
    cell.classList.add('transfer-time-cell');

    if (!transfers || transfers.length === 0) {
        cell.textContent = '-';
        return cell;
    }

    let totalMinutes = 0;
    let missCount = 0;

    const validTransfers = transfers.filter(transfer =>
        transfer && transfer.from && transfer.to && transfer.idleTime &&
        parseTransferTimeToMinutes(transfer.idleTime) > 10
    );

    validTransfers.forEach(transfer => {
        const minutes = parseTransferTimeToMinutes(transfer.idleTime);
        totalMinutes += minutes;
        missCount++;
    });

    const loginLink = row.querySelector('td:nth-child(6)');
    const loginName = loginLink ? loginLink.textContent.trim() : 'Unknown';
    const managerCell = row.querySelector('td:nth-child(4)');
    const manager = managerCell ? managerCell.textContent.trim() : 'Unknown';

    if (loginName && missCount > 0) {
        if (!processedLogins.has(loginName)) {
            employeeMisses.set(loginName, {
                loginName: loginName,
                missCount: missCount,
                totalTime: totalMinutes,
                manager: manager,
                details: validTransfers.map(transfer => ({
                    from: transfer.from,
                    to: transfer.to,
                    time: transfer.idleTime,
                    minutes: parseTransferTimeToMinutes(transfer.idleTime)
                }))
            });
            processedLogins.add(loginName);
        }
    }

    const timeDisplay = document.createElement('span');
    timeDisplay.textContent = missCount > 0 ? formatMinutesToTime(totalMinutes) : '-';
    timeDisplay.classList.add('transfer-time-display');
    cell.appendChild(timeDisplay);

    if (validTransfers.length > 0) {
        const detailsButton = document.createElement('button');
        detailsButton.textContent = 'Details';
        detailsButton.className = 'transfer-button';
        cell.appendChild(detailsButton);

        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'transfer-details';

        validTransfers.forEach(transfer => {
            const detail = document.createElement('div');
            detail.textContent = `${transfer.from} \u2192 ${transfer.to} (${transfer.idleTime})`;
            detail.style.color = 'red';
            detailsDiv.appendChild(detail);
        });

        detailsButton.onclick = (e) => {
            e.stopPropagation();
            document.querySelectorAll('.transfer-details').forEach(d => {
                if (d !== detailsDiv) d.classList.remove('show');
            });
            detailsDiv.classList.toggle('show');
        };

        document.addEventListener('click', (e) => {
            if (!detailsDiv.contains(e.target) && e.target !== detailsButton) {
                detailsDiv.classList.remove('show');
            }
        });

        cell.appendChild(detailsDiv);
    }

    cell.style.backgroundColor = missCount > 0 ? '#ffc7ce' : '#c6efce';
    return cell;
}

function addColumnHeaders() {
    const tables = document.querySelectorAll("table[id^=function]");
    tables.forEach(table => {
        const headerRow = table.querySelector("thead tr");
        if (headerRow) {
            const existingHeaders = headerRow.querySelectorAll('th[data-custom]');
            existingHeaders.forEach(header => header.remove());

            const newHeaders = [
                { text: 'Total Idle', type: 'idle' },
                { text: 'Idle %', type: 'idlePercentage' },
                { text: 'Fast Start', type: 'fast' },
                { text: 'Transfer', type: 'transfer' },
                { text: 'Idle >15m', type: 'idle15' },
                { text: 'Idle >30m', type: 'idle30' }
            ];

            newHeaders.forEach(({text, type}) => {
                const th = document.createElement('th');
                th.setAttribute('data-custom', 'true');

                const button = document.createElement('button');
                button.className = 'sort-button';
                button.innerHTML = `${text}<span class="sort-icon"></span>`;
                button.setAttribute('data-sort-type', type);

                let ascending = false;
                button.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    document.querySelectorAll('.sort-button').forEach(btn => {
                        btn.classList.remove('active', 'asc', 'desc');
                    });
                    ascending = !ascending;
                    this.classList.add('active', ascending ? 'asc' : 'desc');
                    const parentTable = this.closest('table');
                    if (parentTable) {
                        sortTableByColumn(parentTable, type, ascending);
                    }
                });

                th.appendChild(button);
                headerRow.appendChild(th);
            });
        }
    });
}

function getTime(row, href, table) {
    const loginCell = row.querySelector('td:nth-child(6)');
    const login = loginCell ? loginCell.textContent.trim() : null;

    GM_xmlhttpRequest({
        method: "GET",
        url: href,
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Cache-Control": "no-cache"
        },
        onload: function(response) {
            try {
                let tempHtml = document.createElement('div');
                tempHtml.innerHTML = response.responseText;

                const editableElements = tempHtml.querySelectorAll('.editable');
                const paidTimeSegments = tempHtml.querySelectorAll('.clock-seg.on-clock.paid');

                let idleTime = 0;
                let shiftStartIdleMinutes = 0;
                let fastStartFound = false;
                let transfers = [];
                let idleOver15 = 0;
                let idleOver30 = 0;

                editableElements.forEach((item) => {
                    if (!item.parentNode.parentNode.classList.contains('edited')) {
                        const processRow = item.parentNode.parentNode;
                        const processCell = processRow.cells[0];
                        const currentProcess = processCell ? processCell.textContent.trim() : '';
                        const timeCell = processRow.querySelector('.rightAlign');
                        const idleTimeText = timeCell ? timeCell.textContent : '';

                        // Process idle time calculation
                        if (idleTimeText && idleTimeText.includes(':')) {
                            const [minutes, seconds] = idleTimeText.split(':').map(Number);
                            const gapMinutes = minutes + (seconds / 60);
                            idleTime += gapMinutes;

                            // Count gaps over 15m and 30m (inclusive)
                            if (gapMinutes > 15) idleOver15++;
                            if (gapMinutes > 30) idleOver30++;

                            // Fast Start calculation
                            if (!fastStartFound) {
                                const previousRow = processRow.previousElementSibling;
                                const previousProcess = previousRow ? previousRow.cells[0].textContent.trim() : '';

                                if (previousProcess === 'OnClock/Paid') {
                                    const startEndTimes = processRow.querySelector('td:nth-child(3)');
                                    if (startEndTimes) {
                                        const timeText = startEndTimes.textContent;
                                        const timeMatch = timeText.match(/\d{2}\/\d{2}-(\d{2}):(\d{2}):\d{2}/);

                                        if (timeMatch) {
                                            const endHour = parseInt(timeMatch[1]);
                                            const endMin = parseInt(timeMatch[2]);

                                            let shiftStartHour, shiftStartMin;
                                            if (endHour >= 18 && endHour < 19) {
                                                shiftStartHour = 18;
                                                shiftStartMin = 15;
                                            } else if (endHour >= 7 && endHour < 8) {
                                                shiftStartHour = 7;
                                                shiftStartMin = 40;
                                            } else if (endHour >= 8 && endHour < 9) {
                                                shiftStartHour = 8;
                                                shiftStartMin = 40;
                                            }

                                            if (shiftStartHour !== undefined) {
                                                const activityStartMinutes = (endHour * 60) + endMin;
                                                const shiftStartMinutes = (shiftStartHour * 60) + shiftStartMin;
                                                const toleranceMinutes = 10;
                                                const timeDifference = activityStartMinutes - shiftStartMinutes;
                                                shiftStartIdleMinutes = timeDifference <= toleranceMinutes ? 0 : timeDifference - toleranceMinutes;
                                                fastStartFound = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Process transfers
                        const nextRow = processRow.nextElementSibling;
                        if (nextRow && currentProcess) {
                            const nextProcess = nextRow.cells[0] ? nextRow.cells[0].textContent.trim() : '';
                            const transfer = checkForTransfer(currentProcess, nextProcess);
                            if (transfer && idleTimeText && idleTimeText.includes(':')) {
                                transfers.push({
                                    from: transfer.from,
                                    to: transfer.to,
                                    idleTime: idleTimeText
                                });
                            }
                        }
                    }
                });

                // Calculate idle percentage
                const idlePercentage = calculateIdlePercentage(idleTime, paidTimeSegments);
                const roundedPercentage = Math.round(idlePercentage * 100) / 100;
                const colorBasedOnPercentage = getIdleTimeColor(roundedPercentage);

                // Create cells: Idle Time, Idle %, Fast Start, Transfer, Idle >15m, Idle >30m
                const newCells = [
                    createCell(
                        Math.round(idleTime * 100) / 100,
                        colorBasedOnPercentage, '', true
                    ),
                    createCell(
                        roundedPercentage + '%',
                        colorBasedOnPercentage, '', true
                    ),
                    createCell(
                        shiftStartIdleMinutes > 0 ? shiftStartIdleMinutes + ' min' : '\u2713',
                        shiftStartIdleMinutes > 0 ? '#800080' : '#c6efce',
                        shiftStartIdleMinutes > 0 ? '#FFFFFF' : '#006100'
                    ),
                    createTransferCell(transfers, login, row),
                    createCell(
                        idleOver15 > 0 ? idleOver15 : '\u2713',
                        getGapColor(idleOver15),
                        idleOver15 > 0 ? '' : '#006100', true
                    ),
                    createCell(
                        idleOver30 > 0 ? idleOver30 : '\u2713',
                        getGapColor(idleOver30),
                        idleOver30 > 0 ? '' : '#006100', true
                    )
                ];

                // Add cells to the row
                newCells.forEach(cell => {
                    cell.setAttribute('data-custom', 'true');
                    row.appendChild(cell);
                });

            } catch (error) {
                console.error('Error processing response:', error);
            }
        },
        onerror: function(error) {
            console.error('Error in GM_xmlhttpRequest:', error);
        }
    });
}

// --- Night Shift Quick-Fill Button ---
function createNightShiftButton() {
    const btn = document.createElement('button');
    btn.textContent = '\uD83C\uDF19 Night Shift (18:15 \u2192 04:45)';
    btn.style.cssText = 'position:fixed;top:20px;right:240px;background:#1a1a2e;color:#fff;border:none;border-radius:5px;padding:10px 16px;cursor:pointer;z-index:1000;font:bold 13px Segoe UI,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.onclick = function() {
        const now = new Date();
        const hour = now.getHours();
        let startDate, endDate;

        // If 18:00-23:59 → today to tomorrow
        // If 00:00-04:59 → yesterday to today
        // Otherwise default to today to tomorrow
        if (hour >= 18) {
            startDate = new Date(now);
            endDate = new Date(now);
            endDate.setDate(endDate.getDate() + 1);
        } else if (hour < 5) {
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 1);
            endDate = new Date(now);
        } else {
            startDate = new Date(now);
            endDate = new Date(now);
            endDate.setDate(endDate.getDate() + 1);
        }

        const fmt = d => d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0');

        // Select Intraday radio
        const intradayRadio = document.querySelector('input[name="spanType"][value="Intraday"]');
        if (intradayRadio) { intradayRadio.checked = true; intradayRadio.click(); }

        // Start: 18:15
        document.getElementById('startDateIntraday').value = fmt(startDate);
        document.getElementById('startHourIntraday').value = '18';
        document.getElementById('startMinuteIntraday').value = '15';

        // End: 04:45
        document.getElementById('endDateIntraday').value = fmt(endDate);
        document.getElementById('endHourIntraday').value = '4';
        document.getElementById('endMinuteIntraday').value = '45';

        btn.textContent = '\u2713 Set! (' + fmt(startDate) + ' \u2192 ' + fmt(endDate) + ')';
        btn.style.background = '#27ae60';
        setTimeout(function() { btn.textContent = '\uD83C\uDF19 Night Shift (18:15 \u2192 04:45)'; btn.style.background = '#1a1a2e'; }, 3000);
    };
    document.body.appendChild(btn);
}

// Initialize
function initialize() {
    try {
        employeeMisses.clear();
        processedLogins.clear();
        createNightShiftButton();
        createTransferSummaryButton();
        addColumnHeaders();

        const tables = document.querySelectorAll("table[id^=function]");
        if (tables.length === 0) return;

        tables.forEach((table) => {
            try {
                const rows = table.querySelectorAll('tbody tr');
                rows.forEach((row) => {
                    try {
                        const link = row.querySelector('td:nth-child(2) a');
                        if (link) {
                            getTime(row, link.href, table);
                        }
                    } catch (rowError) {
                        console.error('Error processing row:', rowError);
                    }
                });
            } catch (tableError) {
                console.error('Error processing table:', tableError);
            }
        });
    } catch (error) {
        console.error('Error in initialization:', error);
    }
}

setTimeout(initialize, 1000);

})();
