// ==UserScript==
// @name     Autofill Move Items Quantity
// @version  0.1
// @require         https://code.jquery.com/jquery-3.2.1.min.js
// @grant       GM_xmlhttpRequest
// @include  https://aft-qt-eu.aka.amazon.com/app/moveitems*
// @author   ammcclu
// ==/UserScript==

var Quantity = document.getElementsByClassName("a-list-item")[15].innerText;
var Unique = document.getElementsByClassName("a-list-item")[14].innerText;
var Dest = document.getElementsByClassName("a-size-large")[0].innerText;


if ( Dest != "Scan destination container" && Dest != "Scan item" )
{
   if ( Unique = "Quantity:")
   {
document.forms[0].elements[0].value = Quantity;
   }
}
