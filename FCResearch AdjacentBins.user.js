// ==UserScript==
// @name        FCResearch AdjacentBins
// @namespace   Amazon.com
// @author      Kmmcclai@
// @description Shows adjacent bins in FCResearch via Roboscout
// @version     1.02
// @run-at      document-end
// @grant       GM_xmlhttpRequest

// I'm not sure what the FCResearch URL is (where the script will run); but it should go here:
// @include     http://fcresearch*.amazon.com/*
// @include     https://fcresearch*.amazon.com/*

// ==/UserScript==


function findBins() {
// Find bins via https://roboscout.amazon.com/app/adjacentbins/
  // Example to show how to iterate over a table, make HTTP requests, and elements to the table.

  // This example uses the "Results" table from https://roboscout.amazon.com/app/adjacentbins/
  // Which is stupid because the table *has* adjacent bin IDs! But this is an example. Adjust as needed.
  var binResultRows = document.querySelectorAll("#table-inventory tbody tr");
  // ^ That finds the table with ID "bin_id_results_table", then finds all table rows ("tr")

  if (binResultRows.length === 0) {
    console.log("No rows found in the bin results table.");
    return;
  }

  var warehouseElement = document.querySelector(".warehouse-id");
  if (!warehouseElement) {
    console.log("No warehouse ID found");
    return;
  }
  var warehouseId = warehouseElement.textContent;

  document.querySelector("#table-inventory").parentNode.style.height = "auto";
  document.querySelector("#table-inventory").parentNode.style["max-height"] = "800px";

  // Iterate every row
  binResultRows.forEach(function(tr) {
    // Extract the Container
    var containerTD = tr.querySelector("td:nth-child(1)"); // 1st column of the results table: "Container"
    if (!containerTD || containerTD.classList.contains("had_adjacent_bins")) return;
    var containerID = containerTD.textContent;

    // Construct URL to fetch neighboring bins (via containerID and building).
    var url = "https://roboscout.amazon.com/ipa/kpps/get_neighboring_bins/?bin_id=" + containerID + "&building=" + warehouseId;
    console.log("Requesting " + url);

    // Add a spinner to the column we are fetching.
    var spinneri = document.createElement("i");
    spinneri.className = "s-icon-status";
    var spinner = document.createElement("span");
    spinner.className = "loading adjacent_bin_finder_spinner";
    spinner.appendChild(spinneri);
    containerTD.appendChild(spinner);
    //containerTD.innerHTML += '<div class="loading adjacent_bin_finder_spinner"><i class="s-icon-status"></i></div>';

    // Make a web request to the URL.
    GM_xmlhttpRequest({
      method: "GET",
      url: url,
      // This is the "callback" when we get a response from roboscout:
      onload: function(response) {
        console.log("Got response from " + url + ": " + response.responseText);

        // Remove the spinner
        containerTD.removeChild(containerTD.querySelector('.adjacent_bin_finder_spinner'));

        var message = '';
        if (response.responseText.indexOf("Bad Request") === 0) {
          message = '<font color="red"><b>Error:</b> <i>' + response.responseText.substring(12) + '<i/></font>';
        } else {
          // Convert response to JSON object.
          // Details on format of response: https://paste.amazon.com/show/kmmcclai/1504345446
          var json = JSON.parse(response.responseText);
          console.log("json", json);
          var floor = json[containerID].floor;

          // Consruct message to insert into to the table.
          message = '<font color="green"><b>Floor:</b> <i>' + floor + '</i></font> <br/>';

        }

        // Add the message to the table cell we were iterating.
        containerTD.innerHTML += '<br/>' + message;
        containerTD.style.overflow = "auto";
        containerTD.style["white-space"] = "nowrap";

        // Mark the cell so we don't query it again.
        containerTD.classList.add("had_adjacent_bins");
      }
    });
  });
}

function attachFindBinsButton() {
  var inventoryBlock = document.querySelector('.section-placeholder[data-section-type="inventory"]');
  if (!inventoryBlock) {
    console.log("No section-placeholder for section-type='inventory'.");
    return;
  }

  // Add a button to the page to kick off the findBins() function.
  var button = document.createElement("button");
  button.textContent = "Find Floor Level";
  button.addEventListener("click", function(evt) {
    findBins();
    this.parentNode.style.display = "none";
  }, false); // Call the "findBinds()" function when the button is clicked.

  // Panel around the button; so it's easy to style.
  var div = document.createElement("div");
  div.style.cssText = "background-color: #aaa; padding:10px";
  div.appendChild(button);

  // Add panel to the page.
  inventoryBlock.parentNode.insertBefore(div, inventoryBlock);
}

attachFindBinsButton();


// ==UserScript==
// @name        New script
// @namespace   Violentmonkey Scripts
// @match       *://*/*
// @grant       none
// @version     1.0
// @author      -
// @description 04/10/2021, 01:23:37
// ==/UserScript==
