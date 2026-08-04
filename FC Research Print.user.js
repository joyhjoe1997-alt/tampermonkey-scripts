// ==UserScript==
// @name         FC Research Print
// @version      1.3
// @description  Adds a Print ASIN button to the product details on FCResearch. Prints text with Alt-Click. Initial code from @mojordaq
// @author       @scdavids
// @match        http://fcresearch-na.aka.amazon.com/*/results?s=*
// @match        http://fcresearch-eu.aka.amazon.com/*/results?s=*
// @match        http://fcresearch-fe.aka.amazon.com/*/results?s=*
// @match        https://fcresearch-na.aka.amazon.com/*/results?s=*
// @match        https://fcresearch-eu.aka.amazon.com/*/results?s=*
// @match        https://fcresearch-fe.aka.amazon.com/*/results?s=*
// @match        https://qi-fcresearch-eu.corp.amazon.com/*/results?s=*
// @match        https://qi-fcresearch-na.corp.amazon.com/*/results?s=*
// @match        https://qi-fcresearch-fe.corp.amazon.com/*/results?s=*
// @match        *qifcr.eu.aftx.amazonoperations.app/*/results?s=*
// @match        *qifcr.eu.aftx.amazonoperations.app/*/results?s=*
// @updateURL    https://axzile.corp.amazon.com/-/carthamus/download_script/fc-research-print.user.js
// @downloadURL  https://axzile.corp.amazon.com/-/carthamus/download_script/fc-research-print.user.js
// @require      https://drive-render.corp.amazon.com/view/scdavids@/jquery-3.6.0.js
// @grant        GM_xmlhttpRequest
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @connect      *
// ==/UserScript==

var current_location = window.location;
var $ = window.jQuery;
var Print_Status;
//document.getElementById("search").style.setProperty('width', '250px', 'important');
function waitForKeyElements(e, t, a, n) {
    var o, r;
    (o = void 0 === n ? $(e) : $(n).contents().find(e)) && o.length > 0 ? (r = !0, o.each(function() {
        var e = $(this);
        e.data("alreadyFound") || !1 || (t(e) ? r = !1 : e.data("alreadyFound", !0))
    })) :
    r = !1;
    var l = waitForKeyElements.controlObj || {},
        i = e.replace(/[^\w]/g, "_"),
        c = l[i];
    r && a && c ? (clearInterval(c), delete l[i]) : c || (
        c = setInterval(function() {
            waitForKeyElements(e, t, a, n)
        }, 300),
        l[i] = c);
    waitForKeyElements.controlObj = l;
};

// waitForKeyElements("[data-section-type=\"product\"] > > > > > > [data-row-id=\""+document.getElementById("search").placeholder+"\"]", function(a){
waitForKeyElements("[data-section-type=\"product\"] > > > > > > table", function(a){
    a = a[0];
    var button2;
    var button3;
    var button4;
    var button5;
    var button6;
    var button7;
    var button8;
    var space2;
    var q2 = document.createElement("input");

    if(a.rows[1].innerHTML.includes("FCSku") && a.rows[2].innerHTML.includes("Title")){
        button2 = document.createElement("button");
        button2.innerHTML = "Print FCSku";
        button2.onclick = function(){
            quickPrint(a.rows[1].querySelector("a").textContent, document.getElementById("asinquantity2").value, a.rows[2].querySelector("a").textContent, "FCSku", a.rows[2].querySelector("a"));
        }
        space2 = document.createElement("span");
        space2.innerHTML = "&nbsp;&nbsp;&nbsp;";
        q2.type = "number";
        q2.id = "asinquantity2";
        q2.value = 1;
        q2.max = 25;
        q2.min = 1;
        q2.style.width = "75px";
        a.rows[1].lastChild.append(space2);
        a.rows[1].lastChild.append(button2);
        a.rows[1].lastChild.append(q2);
    }
    if(a.rows[2].innerHTML.includes("FCSku") && a.rows[3].innerHTML.includes("Title")){
        button3 = document.createElement("button");
        button3.innerHTML = "Print FCSku";
        button3.onclick = function(){
            quickPrint(a.rows[2].querySelector("a").textContent, document.getElementById("asinquantity3").value, a.rows[3].querySelector("a").textContent, "FCSku", a.rows[3].querySelector("a"));
        }
        var space3 = document.createElement("span");
        space3.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q3 = document.createElement("input");
        q3.type = "number";
        q3.id = "asinquantity3";
        q3.value = 1;
        q3.max = 25;
        q3.min = 1;
        q3.style.width = "75px";
        a.rows[2].lastChild.append(space3);
        a.rows[2].lastChild.append(button3);
        a.rows[2].lastChild.append(q3);
    }
    if(a.rows[0].innerHTML.includes("ASIN") && a.rows[3].innerHTML.includes("Title")){
        button4 = document.createElement("button");
        button4.innerHTML = "Print ASIN";
        button4.onclick = function(){
            quickPrint(a.rows[0].querySelector("a").textContent, document.getElementById("asinquantity4").value, a.rows[3].querySelector("a").textContent, "ASIN", a.rows[3].querySelector("a"));
        }
        var space4 = document.createElement("span");
        space4.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q4 = document.createElement("input");
        q4.type = "number";
        q4.id = "asinquantity4";
        q4.value = 1;
        q4.max = 25;
        q4.min = 1;
        q4.style.width = "75px";
        a.rows[0].lastChild.append(space4);
        a.rows[0].lastChild.append(button4);
        a.rows[0].lastChild.append(q4);
    }
    if(a.rows[0].innerHTML.includes("ASIN") && a.rows[2].innerHTML.includes("Title")){
        button5 = document.createElement("button");
        button5.innerHTML = "Print ASIN";
        button5.onclick = function(){
            quickPrint(a.rows[0].querySelector("a").textContent, document.getElementById("asinquantity5").value, a.rows[2].querySelector("a").textContent, "ASIN", a.rows[2].querySelector("a"));
        }
        var space5 = document.createElement("span");
        space5.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q5 = document.createElement("input");
        q5.type = "number";
        q5.id = "asinquantity5";
        q5.value = 1;
        q5.max = 25;
        q5.min = 1;
        q5.style.width = "75px";
        a.rows[0].lastChild.append(space5);
        a.rows[0].lastChild.append(button5);
        a.rows[0].lastChild.append(q5);
    }
    if(a.rows[0].innerHTML.includes("ASIN") && a.rows[1].innerHTML.includes("Title")){
        button6 = document.createElement("button");
        button6.innerHTML = "Print ASIN";
        button6.onclick = function(){
            quickPrint(a.rows[0].querySelector("a").textContent, document.getElementById("asinquantity6").value, a.rows[1].querySelector("a").textContent, "ASIN", a.rows[1].querySelector("a"));
        }
        var space6 = document.createElement("span");
        space6.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q6 = document.createElement("input");
        q6.type = "number";
        q6.id = "asinquantity6";
        q6.value = 1;
        q6.max = 25;
        q6.min = 1;
        q6.style.width = "75px";
        a.rows[0].lastChild.append(space6);
        a.rows[0].lastChild.append(button6);
        a.rows[0].lastChild.append(q6);
    }
    if(a.rows[1].innerHTML.includes("FNSku") && a.rows[3].innerHTML.includes("Title")){
        button7 = document.createElement("button");
        button7.innerHTML = "Print FNSku";
        button7.onclick = function(){
            quickPrint(a.rows[1].querySelector("a").textContent, document.getElementById("asinquantity7").value, a.rows[3].querySelector("a").textContent, "FNSku", a.rows[3].querySelector("a"));
        }
        var space7 = document.createElement("span");
        space7.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q7 = document.createElement("input");
        q7.type = "number";
        q7.id = "asinquantity7";
        q7.value = 1;
        q7.max = 25;
        q7.min = 1;
        q7.style.width = "75px";
        a.rows[1].lastChild.append(space7);
        a.rows[1].lastChild.append(button7);
        a.rows[1].lastChild.append(q7);
    }
    if(a.rows[1].innerHTML.includes("FNSku") && a.rows[2].innerHTML.includes("Title")){
        button8 = document.createElement("button");
        button8.innerHTML = "Print FNSku";
        button8.onclick = function(){
            quickPrint(a.rows[1].querySelector("a").textContent, document.getElementById("asinquantity8").value, a.rows[2].querySelector("a").textContent, "FNSku", a.rows[2].querySelector("a"));
        }
        var space8 = document.createElement("span");
        space8.innerHTML = "&nbsp;&nbsp;&nbsp;";
        var q8 = document.createElement("input");
        q8.type = "number";
        q8.id = "asinquantity8";
        q8.value = 1;
        q8.max = 25;
        q8.min = 1;
        q8.style.width = "75px";
        a.rows[1].lastChild.append(space8);
        a.rows[1].lastChild.append(button8);
        a.rows[1].lastChild.append(q8);
    }
});
function addButton(elem, title){
    var button = document.createElement("button");
    button.innerHTML = "Print FCSku";
    button.onclick = function(){
        quickPrint(elem.textContent, document.getElementById("print" + title).value);
    }
    var space = document.createElement("span");
    space.innerHTML = "&nbsp;&nbsp;&nbsp;";
    var q = document.createElement("input");
    q.type = "number";
    q.id = "print" + title;
    q.value = 1;
    q.max = 25;
    q.min = 1;
    q.style.width = "75px";
    elem.append(space);
    elem.lastChild.append(button);
    elem.lastChild.append(q);
}
function quickPrint(asin, quantity, desc, type, link){
    asin = asin.trim();
    getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(asin) +
        "&text=" + asciihex(asin) +
        "&quantity=" + quantity +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" + asciihex(desc) +
        "&seq=" + genId(),
        "Print Button",asin,type,quantity,desc,link);
}

function quickPrint2(barcode,type){
    getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(barcode) +
        "&text=" + asciihex(barcode) +
        "&quantity=1" +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Alt-Click",barcode,type,1,"N/A","N/A");
}

    function sendMessageNew(mode,asin,type,quantity,desc,link) {
        var lt = new Date().toLocaleString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")";
var d = new Date();
var tz = d.toString().split("GMT")[1];
        var msg = "FC Research Print V1.1.9\nMode: " + mode + "\n\nLogin: " + login + "\nWHID: " + whid + "\nLocal Time: " + lt + "\nTime Zone: " + tz + "\nWebsite: " + current_location + "\n\nBarcode: " + asin + "\nType: " + type + "\nQuantity: " + quantity + "\nDescription: " + desc + "\nLink: " + link + "\n\nStatus: " + Print_Status;
        var request = new XMLHttpRequest();
      request.open("POST", "https://hooks.slack.com/workflows/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", true);
      request.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
      var params = {
          "message": msg
      }
      request.send(JSON.stringify(params));
      var request2 = new XMLHttpRequest();
      request2.open("POST", "https://hooks.chime.aws/incomingwebhooks/57ac74cf-327c-4d67-b99a-36eacc49b184?token=WXRrazJXajl8MXxKMEs4S2FsUGVCMVEtSDFlUklEakpEWXlHMlZuR09jZDVCVXliRTg5b0NR", true);
      request2.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
      var params2 = {
          "Content": msg
      }
      request2.send(JSON.stringify(params2));
    }

function getStatus(url,mode,asin,type,quantity,desc,link) {
    var xmlhttp;
    xmlhttp = new XMLHttpRequest();
    xmlhttp.open("GET", url, true);
    xmlhttp.send();
    xmlhttp.onreadystatechange = function () {
			if (xmlhttp.readyState == 4) {
				if (xmlhttp.responseText == "valid"){
					 Print_Status = "Successful";
                sendMessageNew(mode,asin,type,quantity,desc,link);
                document.getElementById("search").value = "";}
				else if (xmlhttp.responseText == "invalid"){
					 Print_Status = "Unsuccessful (Printer Error)";
                sendMessageNew(mode,asin,type,quantity,desc,link);
                alert("Barcode: " + asin + "\n\nFailed to print the barcode!\nPlease check to see if your printer is plugged in and turned on.");}
                else {
                    Print_Status = "Unsuccessful (Printmon Error)";
                sendMessageNew(mode,asin,type,quantity,desc,link);
                alert("Barcode: " + asin + "\n\nFailed to print the barcode!\nPrintmon not installed!\nPrintmon is required is required to use this script.");}
			}
		};
    document.getElementById("search").focus();
}
var ip = getCookie("fcmenu-remoteAddr");
var whid = getCookie("fcmenu-warehouseId");
var badgeId = getCookie("fcmenu-employeeId");
var login = getCookie("fcmenu-employeeLogin");
function getCookie(c){
    var cookies = document.cookie.split(";");
    for(var i = 0; i < cookies.length; i++){
        if(cookies[i].includes(c)){
            return (cookies[i].substring(cookies[i].indexOf("=")+1));
        }
    }
    console.log(`didn't find ${c}`);
}

function genId() {
    var id1 = "";
    for (var i = 0; i < 10; i++){
        id1 += Math.floor(Math.random() * 9);
    }
    return id1;
}

function asciihex(str) {
    var text1 = "";
    for (var i = 0, l = str.length; i < l; i++) {
        var hex1 = Number(str.charCodeAt(i)).toString(16);
        text1 += hex1;
    }
    return text1;
}

document.addEventListener ("keydown", function (FreePrint) {
    if (FreePrint.altKey && FreePrint.key === "p") {
        FreePrintPage();
        barcodeQuantity.value = 1;
        barcodeText.value = "";
    }
} );

    document.body.addEventListener("click", altClickPrint, false);
        function altClickPrint(event) {
        if ( ! event.altKey ) return
        if (event.target.innerText.includes("LPN")) {

let barcodeText = event.target.innerText.split('\n')[0].trim()
	const response = confirm("Barcode: " + barcodeText + "\n\nLPN's are considered unique and should not be printed.\n\nPress OK to continue, or Cancel to stop.");
if (response) {
    // add code if the user pressed the Ok button
        quickPrint2(barcodeText,"LPN")
} else {
    Print_Status = "Cancelled"
    sendMessageNew("Alt-Click",barcodeText,"LPN",1,"N/A","N/A")
    // add code if the user pressed the Cancel button
}
        }
        else {
        let barcodeText = event.target.innerText.split('\n')[0].trim()
        quickPrint2(barcodeText,"Unknown")
        }
    }


    const barcodeShowStyle = document.createElement('style')
    barcodeShowStyle.innerHTML =
`
.barcodes_cover {
  display: none;
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: #f3f3f3cc;
  z-index: 160;
  align-items: center;
  justify-items: center;
}

.barcodes_cover>.barcodes_panel {
  display: inline;
  width: 100px;
  height: 350px;
  background-color: #fff;
  border: 1px solid #aaa;
  border-radius: 5px;
  min-width: 25rem;
  min-height: 17rem;
  grid-template-rows: 10% auto;
  align-items: center;
  justify-items: center;
  box-shadow: 1px 1px 4px #999;
}

.barcodes_cover>.barcodes_panel>p {
  display: block;
  margin-top:1rem;
  color:#444;
}
`;

// making DOM elements
        var space = document.createElement("span");
    space.innerHTML = "<br><br><br><br>";
            var space1 = document.createElement("span");
    space1.innerHTML = "<br><br>";

    var buttonClose = document.createElement("button");
     buttonClose.innerHTML = "Close";
    buttonClose.onclick = function(){
        document.getElementById("search").focus();
            bar_cover.style.display="none"
    };

        var buttonFPrint = document.createElement("button");
     buttonFPrint.innerHTML = "Print";
    buttonFPrint.onclick = function(){
        if (barcodeText.value == ""){
                Print_Status = "Unsuccessful (Barcode Empty)"
    sendMessageNew("Free Print",barcodeText.value,"Unknown",barcodeQuantity.value,"N/A","N/A")
            alert("Please enter text into the barcode box.")
        } else if (barcodeText.value.includes("LPN")){
        	const response = confirm("Barcode: " + barcodeText.value + "\n\nLPN's are considered unique and should not be printed.\n\nPress OK to continue, or Cancel to stop.");
if (response) {
    // add code if the user pressed the Ok button
            getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(barcodeText.value) +
        "&text=" + asciihex(barcodeText.value) +
        "&quantity=1" +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Free Print",barcodeText.value,"LPN",1,"N/A","N/A");

} else {
    Print_Status = "Cancelled"
    sendMessageNew("Free Print",barcodeText.value,"LPN",1,"N/A","N/A")
    // add code if the user pressed the Cancel button
}
        } else {
    getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(barcodeText.value) +
        "&text=" + asciihex(barcodeText.value) +
        "&quantity=" + barcodeQuantity.value +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Free Print",barcodeText.value,"Unknown",barcodeQuantity.value,"N/A","N/A");
        }
    };
            var barcodeText = document.createElement("input");
        barcodeText.id = "barcodeText";
                var barcodeQuantity = document.createElement("input");
        barcodeQuantity.type = "number";
        barcodeQuantity.id = "barcodeQuantity";
        barcodeQuantity.min = 1;
    var bar_cover=document.createElement("div");
    bar_cover.classList.add("barcodes_cover");
    let bar_panel = document.createElement("div");
    bar_panel.classList.add("barcodes_panel");
    var bar_label = document.createElement('p');
    var FreePrintText = document.createElement('p');
        var FreePrintQuantity = document.createElement('p');
    bar_panel.appendChild(bar_label);
    bar_panel.appendChild(FreePrintText);
    bar_panel.appendChild(barcodeText);
    bar_panel.appendChild(FreePrintQuantity);
    bar_panel.appendChild(barcodeQuantity);
    bar_panel.appendChild(space1);
    bar_panel.appendChild(buttonFPrint);
    bar_panel.appendChild(space);
    bar_panel.appendChild(buttonClose);
    bar_cover.appendChild(bar_panel);

    function FreePrintPage() {
       bar_label.innerText="Free Print"
        bar_label.style.textAlign = "center";
        bar_label.style.fontWeight = "bold";
        FreePrintText.innerText="Barcode: "
        FreePrintQuantity.innerText="Quantity: "
       bar_cover.style.display="grid"
    }

    document.head.appendChild(barcodeShowStyle);
    document.body.append(bar_cover);
document.getElementById('search-profile').type="button";
document.getElementById('search-profile').style="margin-right:50px";
document.getElementById('search-button').style="margin-left:10px";
            var barcodeSearchQuantity = document.createElement("input");
                barcodeSearchQuantity.type="number";
                barcodeSearchQuantity.style.width = "50px";
                barcodeSearchQuantity.value = 1;
                barcodeSearchQuantity.min = 1;
document.getElementById('search-profile').value = "Print Barcode";
            var barcodeSearchText = document.createElement("input");
        barcodeSearchText.id = "barcodeSearchText";
var child = document.getElementById('search-profile');
child.parentNode.insertBefore(barcodeSearchText, child);
//child.parentNode.insertBefore(barcodeSearchQuantity, child);
barcodeSearchText.placeholder = "Enter barcode data";
barcodeSearchText.autocomplete = "off";

    document.getElementById('search-profile').onclick = function(){
        let BarcodeSearch = document.getElementById("barcodeSearchText").value;
        if (BarcodeSearch == ""){
            BarcodeSearch = document.getElementById("search").placeholder

if (BarcodeSearch.includes("LPN")) {
	const response = confirm("Barcode: " + BarcodeSearch + "\n\nLPN's are considered unique and should not be printed.\n\nPress OK to continue, or Cancel to stop.");
if (response) {
    // add code if the user pressed the Ok button
            getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(BarcodeSearch) +
        "&text=" + asciihex(BarcodeSearch) +
        "&quantity=" + barcodeSearchQuantity.value +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Print Search Box (Placeholder)",BarcodeSearch,"LPN",barcodeSearchQuantity.value,"N/A","N/A");

} else {
    Print_Status = "Cancelled"
    sendMessageNew("Print Search Box (Placeholder)",BarcodeSearch,"LPN",barcodeSearchQuantity.value,"N/A","N/A")
    // add code if the user pressed the Cancel button
}
        }else{
    getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(BarcodeSearch) +
        "&text=" + asciihex(BarcodeSearch) +
        "&quantity=" + barcodeSearchQuantity.value +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Print Search Box (Placeholder)",BarcodeSearch,"Unknown",barcodeSearchQuantity.value,"N/A","N/A");
        }



         //       Print_Status = "Unsuccessful (Barcode Empty)"
    //sendMessageNew("Print Search Box(Placeholder)",BarcodeSearch,"Unknown",barcodeSearchQuantity.value,"N/A","N/A")
         //   alert("Please enter text into the text box.")
            document.getElementById("search").focus();
        } else if (BarcodeSearch.includes("LPN")) {
	const response = confirm("Barcode: " + BarcodeSearch + "\n\nLPN's are considered unique and should not be printed.\n\nPress OK to continue, or Cancel to stop.");
if (response) {
    // add code if the user pressed the Ok button
            getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(BarcodeSearch) +
        "&text=" + asciihex(BarcodeSearch) +
        "&quantity=" + barcodeSearchQuantity.value +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Print Search Box",BarcodeSearch,"LPN",barcodeSearchQuantity.value,"N/A","N/A");

} else {
    Print_Status = "Cancelled"
    sendMessageNew("Print Search Box",BarcodeSearch,"LPN",barcodeSearchQuantity.value,"N/A","N/A")
    // add code if the user pressed the Cancel button
}
        }else{
    getStatus(
        "http://localhost:5965/printer?action=print&type=barcode&" +
        "data=" + asciihex(BarcodeSearch) +
        "&text=" + asciihex(BarcodeSearch) +
        "&quantity=" + barcodeSearchQuantity.value +
        "&badgeid=" + getCookie("fcmenu-employeeId") +
        "&desc=" +
        "&seq=" + genId(),
        "Print Search Box",BarcodeSearch,"Unknown",barcodeSearchQuantity.value,"N/A","N/A");
        }
    };

document.forms[0].id="SearchForm";
//document.forms.SearchForm
    document.forms[0].onsubmit= function() {
  if(barcodeSearchText === document.activeElement)
  {
    document.getElementById('search-profile').click();
    return false;
  }
  return true;
}