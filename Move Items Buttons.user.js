// ==UserScript==
// @name         Move Items Buttons
// @namespace    http://tampermonkey.net/
// @version      2025-06-25
// @description  Add mode buttons onto Move Items to not require as many button clicks and other UI fixes.
// @author       cgriffie
// @match        *aft-qt-eu.aka.amazon.com/app/moveitems?experience=Desktop
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Helper function to easily add utility to common key presses/shortcuts in the application.

    function pressKey(key) {
        let code;

        switch (key.toLowerCase()) {
            case 'c': code = 67; break;
            case 'm': code = 77; break;
            case 'q': code = 81; break;
            case 'r': code = 82; break;
            case 's': code = 83; break;

            case 'enter': code = 13; break;
            case 'backspace': code = 8; break;

            case 'arrowleft': code = 37; break;
            case 'arrowup': code = 38; break;
            case 'arrowright': code = 39; break;
            case 'arrowdown': code = 40; break;

            default:
                console.warn(`Unrecognized key: ${key}`);
                return;
        }

        const options = {
            key,
            code: key.toLowerCase() === 'enter' ? 'Enter' : 'Key' + key.toUpperCase(),
            keyCode: code,
            which: code,
            bubbles: true,
        };

        const downEvent = new KeyboardEvent('keydown', options);
        const upEvent = new KeyboardEvent('keyup', options);

        document.dispatchEvent(downEvent);
        document.dispatchEvent(upEvent);
    }

    // Adds a new container to house the new buttons.

    const workspace = document.querySelector('#workspace');

    const newContainer = document.createElement('div');
    newContainer.classList.add('button-container');
    newContainer.style.display = 'flex';
    newContainer.style.justifyContent = 'center';

    const textContainer = document.createElement('div');
    textContainer.innerText = 'Change Mode:';
    textContainer.style.display = 'flex';
    textContainer.style.justifyContent = 'center';
    textContainer.style.margin = '20px';

    workspace.appendChild(textContainer);
    workspace.appendChild(newContainer);

    // Creates a button which will include a 'name' variable.
    // This doubles as text for the button and what the DOM will try to locate to select the proper mode.

    function createButton(name) {
        const newButton = document.createElement('button');
        newButton.textContent = name;
        newButton.style.border = 'none';
        newButton.style.background = '#ffd814';
        newButton.style.borderRadius = '15px';
        newButton.style.font = 'inherit';
        newButton.style.paddingTop = '5px';
        newButton.style.paddingBottom = '5px';
        newButton.style.paddingRight = '15px';
        newButton.style.paddingLeft = '15px';
        newButton.style.margin = '10px';
        newButton.style.cursor = 'pointer';
        newButton.style.display = 'flex';
        newButton.style.justifyContent = 'center';


        newContainer.appendChild(newButton);

        // Adds whichever button is clicked into the session storage.
        // This lets it hold the data while the page refreshes when changing menus.
        // This then selects the 'c' button which opens up the change mode menu.

        newButton.addEventListener("click", () => {
            sessionStorage.setItem('menuSelected', name);
            pressKey('c');
        });
    }

    function waitForElement(selector, callback) {
        const observer = new MutationObserver((mutations, obs) => {
            const element = document.querySelector(selector);
            if (element) {
                obs.disconnect();
                callback(element);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function waitForElementWithText(selector, text, callback, exact = true) {
        const observer = new MutationObserver((mutations, obs) => {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                const content = el.innerText.trim();
                if ((exact && content === text) || (!exact && content.includes(text))) {
                    obs.disconnect();
                    callback(el);
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // Once the session storage has a menu item, a timeout is set and waits for the DOM to refresh.
    // Once the DOM refreshes it finds the label that matches the value of the button pressed and clicks it.

    const triggered = sessionStorage.getItem('menuSelected');

    if (triggered) {
        sessionStorage.removeItem('menuSelected');

        setTimeout(() => {
            waitForElement(`input[value="${triggered}"]`, (input) => {
                const clickable = input.closest('label') || input.closest('div') || input;
                clickable.click();

                setTimeout(() => {
                    pressKey('enter');
                }, 100);
            });
        }, 50);
    }

    // This event listener helps to override scanner defaults which can cause the app to crash.

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && document.activeElement === document.body) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.log('Blocked rogue Enter on body.');
        }
    }, true);

    // Allows users to scan their original cage/tote/case to act as an "Enter" button.
    // Also prevents app from crashing when an item is scanned during Multi or Container moves.

    waitForElement('#context > dl:nth-of-type(2) > dd', (currentCageElement) => {

        const cageValue = currentCageElement.innerText.trim();

        let dummyInput = document.getElementById('scanner-capture');

        if (!dummyInput) {

            dummyInput = document.createElement('input');

            dummyInput.setAttribute('tabindex', '-1');
            dummyInput.type = 'text';
            dummyInput.id = 'scanner-capture';

            dummyInput.style.position = 'absolute';
            dummyInput.style.opacity = '0';
            dummyInput.style.top = '-1000px';
            dummyInput.style.height = '0';
            dummyInput.style.width = '0';
            dummyInput.style.left = '-1000px';
            dummyInput.style.width = '1px';
            dummyInput.style.height = '1px';
            dummyInput.style.pointerEvents = 'none';
            dummyInput.style.zIndex = '-1';

            document.body.appendChild(dummyInput);
        }

        dummyInput.focus({ preventScroll: true });

        dummyInput.addEventListener('keydown', (e) => {

            if (e.key === 'Enter') {
                const scanned = dummyInput.value.trim();
                dummyInput.value = ''; // clear for next scan

                console.log('Scanned value:', scanned);

                if (scanned === cageValue || !scanned) {
                    dummyInput.blur();
                    pressKey('enter');
                } else {
                    dummyInput.blur();
                    console.log('Scanned value does not match current cage');
                }

            }
        });
    });

    // If in Multi Mode and the unit count is 1, the input field will automatically enter 1 to all easier flow.

    const interval = setInterval(() => {
        const labels = document.querySelectorAll('.a-form-label');
        const label = Array.from(labels).find(el => el.innerText.trim() === 'Quantity');

        const input = document.querySelector('input[type="text"]');
        const quantity = document.querySelector('#context > dl:nth-of-type(3) > dd:nth-of-type(4)');

        if (label && input && quantity) {
            if (quantity.innerText.trim() === '1') {
                input.value = '1';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                console.log('Input set via interval fallback');
            }
            clearInterval(interval);
        }
    }, 100);

    createButton('EACH');
    createButton('MULTI');
    createButton('CONTAINER');
    createButton('LPN');

})();