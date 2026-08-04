// ==UserScript==
// @name         FCresearch +++
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  FCresearch +++
// @author       filiklak
// @connect      amazon.com
// @connect      amazon.dev
// @connect      a2z.com
// @match        http://fcresearch-eu.aka.amazon.com/EMA4/results*
// @match        https://fcresearch-eu.aka.amazon.com/EMA4/results*
// @match        https://smart-icqa.corp.amazon.com/*
// @match        https://pandash.amazon.com/*
// @match        http://localhost:5965/barcodegenerator*
// @match        http://fc-inbound-transshipment-portal-prod-dub.dub.proxy.amazon.com/SearchTransfer*
// @match        https://t.corp.amazon.com/*
// @match        https://eu-west-1.cx-hunter.eu-aces.amazon.dev/api/containers/*
// @match        https://fc-transshipment-sort-tool-EMA4.aka.amazon.com/*
// @match        https://csi.amazon.com/view/*
// @match        https://rodeo-dub.amazon.com/EMA4/*
// @match        https://prepmanager-dub.amazon.com/view/*
// @match        https://eu.item-measurement.aft.a2z.com/item/*
// @match        https://procurementportal-eu.corp.amazon.com/bp/homew/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// @require      https://fc-transshipment-sort-tool-EMA4.aka.amazon.com/assets/js/bootstrap.min.js
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function() {
    'use strict';

    async function getdataPREP(parametroBO, locationDIV){
        let result = await awaitmakeGetRequest ("https://prepmanager-dub.amazon.com/view/"+parametroBO+"?region=EU", "GET");
        let paramPREP= $(result).find("#instructions").text();
        let data_prep_origin = paramPREP.substr(13,11);
        let aaaa_prep = data_prep_origin.substr(1,4);
        let mm_prep = data_prep_origin.substr(6,2);
        let gg_prep = data_prep_origin.substr(9,2);
        let data_prep = gg_prep+"/"+mm_prep+"/"+aaaa_prep;
        let info_prep = paramPREP.substr(40);
        info_prep=info_prep.replace('LOCKED', 'LOCKED ');
        info_prep=info_prep.replace('Asin Stickering', '-> Asin Stickering ');
        info_prep=info_prep.replace('Boxing', '-> Boxing ');
        if (info_prep.indexOf("Bubble wrap/Bubble bag")== -1){
            info_prep=info_prep.replace('Bubble wrap', '-> Bubble wrap ');
            info_prep=info_prep.replace('Bubble bag', '-> Bubble bag ');
        } else info_prep=info_prep.replace('Bubble wrap/Bubble bag', '-> Bubble wrap/Bubble bag ');
        if (paramPREP.lastIndexOf("No instructions set")== -1) $(locationDIV).append('<div id="resultPREP" style="margin-top: 10px; margin-bottom: 10px;"><strong>'+info_prep+'</strong>  Ultimo aggiornamento: '+data_prep+'<div>');
        else $(locationDIV).append('<div id="resultPREP" style="margin-top: 10px; margin-bottom: 10px;"><strong>No instructions set</strong><div>');
    };

    async function getdataLIQ(parametroBO){
        let result = await awaitmakeGetRequest ("https://fcresearch-eu.aka.amazon.com/EMA4/results/product?s="+parametroBO, "GET");
        let paramDESC= $(result).find(".a-keyvalue > tbody:nth-child(1) > tr:nth-child(3) > td:nth-child(2) > a:nth-child(1)").text();
        let val_typeLiq = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(3) > td:nth-child(2) > alchemy-input")
        val_typeLiq.value = paramDESC;
    };


    function awaitmakeGetRequest (url, type) {
        //let mythis = this;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: type,
                url: url,
                data: JSON.stringify(),
                headers: {
                    'Accept':'application/json, text/javascript',
                    'Content-Type':'application/json; charset=UTF-8',
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*'
                },
                beforeSend: function(xhr){
                xhr.withCredentials = true;
                },
                onload: function(response) {
                    resolve(response.responseText);
                },
                onerror: function(error) {
                    reject(error);
                }
            });
        });
    }

    var params = new URLSearchParams(window.location.search);
    var url1 = new URL(window.location);
    if (url1.origin.match("https")) var urlFC="https"; else var urlFC="http";

    if (params.has('s')==true) {
        const script = document.createElement("script");
        script.src = 'https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js';
        script.type = 'text/javascript';
        script.addEventListener('load', () => {
            $(document).ready(function() {
                var dataTSI = new Date();
                var dataTSI2 = new Date();
                var ggTSI, mmTSI, yyyyTSI, dataTSI1, ggTSI2, mmTSI2, yyyyTSI2, dataTSI3;
                ggTSI = dataTSI.getDate();
                mmTSI = dataTSI.getMonth() + 1;
                yyyyTSI = dataTSI.getFullYear();
                if (ggTSI<=9) ggTSI='0'+ggTSI;
                if (mmTSI<=9) mmTSI='0'+mmTSI;
                dataTSI1=yyyyTSI+'-'+mmTSI+'-'+ggTSI;
                dataTSI2.setDate(dataTSI2.getDate() - 40);
                ggTSI2 = dataTSI2.getDate();
                mmTSI2 = dataTSI2.getMonth() + 1;
                yyyyTSI2 = dataTSI2.getFullYear();
                if (ggTSI2<=9) ggTSI2='0'+ggTSI2;
                if (mmTSI2<=9) mmTSI2='0'+mmTSI2;
                dataTSI3=yyyyTSI2+'-'+mmTSI2+'-'+ggTSI2;
                var param_fcresearch = params.get('s');
                var param_check = param_fcresearch.substr(0,2);
                var check_isbn = $.isNumeric(param_fcresearch);

                if ((param_check=="B0")||(param_check=="X0")||(param_check=="ZZ")||(check_isbn)) {
                    $.get( urlFC+"://fcresearch-eu.aka.amazon.com/EMA4/results/product?s="+param_fcresearch, function( datiItem ) {
                        var stringaAsin= $(datiItem).find(".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2) > a:nth-child(1)").text();
                        var stringaSku= $(datiItem).find(".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(2) > a:nth-child(1)").text();
                        var param_asin = stringaAsin.substr(0,2);
                        $.post( urlFC+"://fcresearch-eu.aka.amazon.com/EMA4/results/product?s="+param_fcresearch, function( datiItem2 ) {
                            var valoreFud, stringaPrezzo, itemPrezzo, paramModalPrep, paramModalCubi;

                            if (param_check=="X0") {
                                stringaPrezzo= $(datiItem).find(".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(9) > td:nth-child(2)").text();
                                itemPrezzo= stringaPrezzo.split(" ").pop();
                                if (!$.isNumeric(itemPrezzo)) itemPrezzo='';
                                $( ".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)").append(' <a id="'+stringaAsin+'" class="btn_fast2" href="#"><img src="https://drive-render.corp.amazon.com/view/vbonfran@/ScriptPS/iconCopy.jpg" alt="copy" height="14"></a><a class="btn_fast" id="prep" href="https://prepmanager-dub.amazon.com/view/'+stringaAsin+'?region=EU" target="_blank">Prep</a><a class="btn_fast" target="_blank" href="https://pandash.amazon.com/?itemHazmat='+stringaAsin+'">Hazmat</a><a class="btn_fast" target="_blank" href="https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Researching%22%2C%7B%22OR%22%3A%5B%22Work%20In%20Progress%22%2C%22Pending%22%5D%7D%5D%7D%5D%7D%2C%22AND%22%3A%7B%22keyword%22%3A%22('+stringaAsin+')%22%2C%22isTicket%22%3A%22true%22%7D%7D%7D">SIM TT</a>');
                                $( ".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(2) > td:nth-child(2)").append(' <a id="'+stringaSku+'" class="btn_fast2" href="#"><img src="https://drive-render.corp.amazon.com/view/vbonfran@/ScriptPS/iconCopy.jpg" alt="copy" height="14"></a> <a class="btn_fast" target="_blank" href="https://smart-icqa.corp.amazon.com/defects/new?itemDefect='+stringaSku+'&prezzoDefect='+itemPrezzo+'">Defect</a><a class="btn_fast" target="_blank" href="https://eu.item-measurement.aft.a2z.com/item/'+stringaSku+'">Cubi</a><a class="btn_fast" target="_blank" href="https://diver.qts.amazon.dev/tools/transshipment/dashboards/transfer_details?destination_warehouse_id=EMA4&end_date='+dataTSI1+'&search='+stringaSku+'&source_warehouse_id=&start_date='+dataTSI3+'">TSI ICQA</a><a class="btn_fast" target="_blank" href="http://fc-inbound-transshipment-portal-prod-dub.dub.proxy.amazon.com/SearchTransfer?paramTSI='+stringaSku+'">TSI FC</a><a class="btn_fast" target="_blank" href="https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Researching%22%2C%7B%22OR%22%3A%5B%22Work%20In%20Progress%22%2C%22Pending%22%5D%7D%5D%7D%5D%7D%2C%22AND%22%3A%7B%22keyword%22%3A%22('+stringaSku+')%22%2C%22isTicket%22%3A%22true%22%7D%7D%7D">SIM TT</a><a class="btn_fast" target="_blank" href="https://csi.amazon.com/view?view=simple_product_data_view&item_id='+itemAsin+'&marketplace_id=4&customer_id=&merchant_id=&sku=&fn_sku=&gcid=&fulfillment_channel_code=&listing_type=purchasable&submission_id=&order_id=&external_id=&search_string=&realm=USAmazon&stage=prod&domain_id=&keyword=&submit=Show">CSI</a>');
                            } else {
                                stringaPrezzo= $(datiItem).find(".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(8) > td:nth-child(2)").text();
                                itemPrezzo= stringaPrezzo.split(" ").pop();
                                if (!$.isNumeric(itemPrezzo)) itemPrezzo='';
                                $( ".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)" ).append(' <a id="'+stringaAsin+'" class="btn_fast2" href="#"><img src="https://drive-render.corp.amazon.com/view/vbonfran@/ScriptPS/iconCopy.jpg" alt="copy" height="16"></a> <a class="btn_fast" target="_blank" href="https://smart-icqa.corp.amazon.com/defects/new?itemDefect='+stringaAsin+'&prezzoDefect='+itemPrezzo+'">Defect</a><a class="btn_fast" target="_blank" href="https://diver.qts.amazon.dev/tools/transshipment/dashboards/transfer_details?destination_warehouse_id=EMA4&end_date='+dataTSI1+'&search='+stringaAsin+'&source_warehouse_id=&start_date='+dataTSI3+'">TSI ICQA</a><a class="btn_fast" target="_blank" href="http://fc-inbound-transshipment-portal-prod-dub.dub.proxy.amazon.com/SearchTransfer?paramTSI='+stringaAsin+'">TSI FC</a><a class="btn_fast" id="prep" href="https://prepmanager-dub.amazon.com/view/'+stringaAsin+'?region=EU" target="_blank">Prep</a><a class="btn_fast" target="_blank" href="https://pandash.amazon.com/?itemHazmat='+stringaAsin+'">Hazmat</a><a class="btn_fast" target="_blank" id="cubiscan" href="https://eu.item-measurement.aft.a2z.com/item/'+stringaAsin+'">Cubi</a><a class="btn_fast" target="_blank" href="https://t.corp.amazon.com/issues?q=%7B%22AND%22%3A%7B%22status%22%3A%7B%22OR%22%3A%5B%22Assigned%22%2C%7B%22OR%22%3A%5B%22Researching%22%2C%7B%22OR%22%3A%5B%22Work%20In%20Progress%22%2C%22Pending%22%5D%7D%5D%7D%5D%7D%2C%22AND%22%3A%7B%22keyword%22%3A%22('+stringaAsin+')%22%2C%22isTicket%22%3A%22true%22%7D%7D%7D">SIM TT</a><a class="btn_fast" target="_blank" href="https://csi.amazon.com/view?view=simple_product_data_view&item_id='+stringaAsin+'&marketplace_id=4&customer_id=&merchant_id=&sku=&fn_sku=&gcid=&fulfillment_channel_code=&listing_type=purchasable&submission_id=&order_id=&external_id=&search_string=&realm=USAmazon&stage=prod&domain_id=&keyword=&submit=Show">CSI</a><a class="btn_fast" target="_blank" href="https://procurementportal-eu.corp.amazon.com/bp/asin?asin='+stringaAsin+'&dateRange=today&conditions=Submitted%2CCompletelyConfirmed">Pro</a>');
                            }
                            $("#prep").mouseenter(function() {
                                paramModalPrep = getdataPREP(stringaAsin,".a-span7 > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)");
                                $("#prep").css({"border":"2px solid #C7511F"});
                            }).mouseleave(function() {
                                $( "#resultPREP" ).remove();
                                $("#prep").css({"border":"none"});
                            }).mouseout(function() {
                                $( "#resultPREP" ).remove();
                                $("#prep").css({"border":"none"});
                            });

                            $(".btn_fast").css({"background-color":"#E8E8E8","border-radius":"4px","padding":"4px 6px","text-align":"center","text-decoration":"none","display":"inline-block","font-size":"12px","border":"none","margin":"4px"});
                            $(".btn_fast2").css({"background-color":"#FFFFFF","border-radius":"4px","padding":"6px 4px","text-align":"center","text-decoration":"none","display":"inline-block","font-size":"12px","border":"none","margin":"4px"});
                            $(".btn_fast2").click(function () {
                                var idASIN = $(this).attr('id');
                                const listener = function(ev) {
                                    ev.preventDefault();
                                    ev.clipboardData.setData('text/html', idASIN);
                                    ev.clipboardData.setData('text/plain', idASIN);
                                };
                                document.addEventListener('copy', listener);
                                document.execCommand('copy');
                                document.removeEventListener('copy', listener);
                            });
                        });
                    });
                }
                if ((param_check=="ts")||(param_check=="cs")) {
                    var statusFUD, TSItrue, TSItrue1;
                    $.get( urlFC+"://fcresearch-eu.aka.amazon.com/EMA4/results/container-hierarchy?s="+param_fcresearch, function( datiItem4 ) {
                        var TSItrue1= $(datiItem4).find("ul.a-unordered-list:nth-child(2) > li:nth-child(1) > span:nth-child(1) > a:nth-child(1)").text();
                        var TSItrue = TSItrue1.substr(0,3);
                        $.post( urlFC+"://fcresearch-eu.aka.amazon.com/EMA4/results/inventory?s="+param_fcresearch, function( datiItem3 ) {
                            $( "#results-content" ).prepend('<a class="btn_fast" target="_blank" href="http://localhost:5965/barcodegenerator?itemPrint='+param_fcresearch+'">Printmon</a><a class="btn_fast" target="_blank" href="https://rodeo-dub.amazon.com/EMA4/Search?searchKey='+param_fcresearch+'">Rodeo</a><a class="btn_fast" target="_blank" href="https://diver.qts.amazon.dev/tools/transshipment/dashboards/transfer_details?destination_warehouse_id=EMA4&end_date='+dataTSI1+'&search='+param_fcresearch+'&source_warehouse_id=&start_date='+dataTSI3+'">TSI ICQA</a><a class="btn_fast" target="_blank" href="http://fc-inbound-transshipment-portal-prod-dub.dub.proxy.amazon.com/SearchTransfer?paramTSI='+param_fcresearch+'">TSI FC</a>');
                            //if (TSItrue=="pk-") $( "#results-content" ).prepend('<a class="btn_fast" target="_blank" href="https://fc-transshipment-sort-tool-EMA4.aka.amazon.com/?param98='+param_fcresearch+'">98</a>');
                            $(".btn_fast").css({"background-color":"#E8E8E8","border-radius":"5px","padding":"8px 8px","text-align":"center","text-decoration":"none","display":"inline-block","font-size":"16px","font-weight":"bold","margin-top":"10px","margin-left":"8px","margin-right":"8px"});
                        });
                    });
                }
            });
        });
        document.head.appendChild(script);

    } else if (params.has('itemDefect')==true) {
        var param_defect = params.get('itemDefect');
        var prezzo_defect = params.get('prezzoDefect');
        $('#defect_defect_asin').val(param_defect);
        $('#defect_unit_price').val(prezzo_defect);

    } else if (params.has('itemHazmat')==true) {
        var param_hazmat = params.get('itemHazmat');
        $('#asinsFilter').val(param_hazmat);
        $('#sourceFilter').val("FC");
        $('ol#selectableMP > li#pl').addClass("ui-selected");
        $('#languageFilter').val("EN");
        $('#resultMessage').html("<strong>Clicca sul pulsante CERCA</strong>");
        $('#resultMessage > strong').css("color", "#fbaa0f");
        setTimeout (function () {
            $("#FCinput").css("display", "block");
            $('#FCinput').val("EMA4");
            $('#FCinput').css("float", "left");
            $('#statusRestriction').attr("class","statusOk");
            $('#statusRestriction').css("display", "block");
            $('#statusRestriction').css("float", "right");
            $('#restriction').html("Hazmat Capabilities - MEDIUM");
            $('#btOk').css("display", "block");
        }, 1000);
        setTimeout (function () {
            $("#btOk").click();
        }, 2000);

    } else if (params.has('itemPrint')==true) {
        var param_Print = params.get('itemPrint');
        $('#barcodedata').val(param_Print);

    } else if (params.has('paramTSI')==true) {
        var param_tsi = params.get('paramTSI');

        var ggTSI5, mmTSI5, yyyyTSI5, dataTSI5, dataTSIfine;
        var dataTSI4 = new Date();
        dataTSI4.setDate(dataTSI4.getDate() - 29);
        ggTSI5 = dataTSI4.getDate();
        mmTSI5 = dataTSI4.getMonth() + 1;
        yyyyTSI5 = dataTSI4.getFullYear();
        if (ggTSI5<=9) ggTSI5='0'+ggTSI5;
        if (mmTSI5<=9) mmTSI5='0'+mmTSI5;
        dataTSIfine=mmTSI5+'/'+ggTSI5+'/'+yyyyTSI5;
        //var param_tsi = params.get('paramTSI');
        var param_check_tsi = param_tsi.substr(0,2);
        if ((param_check_tsi!="ts")&&(param_check_tsi!="cs")) $('#search-type').val("ASIN");
        if ($('#id-search-bar').val()=='') {
            $('#id-search-bar').val(param_tsi);
            $('#start-date').val(dataTSIfine);
            $('#form').submit();
        }

    } else if (params.has('paramLiquidation')==true) {
        let uri = window.location.search.substring(1);
        let params = new URLSearchParams(uri);
        let asin = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(4) > td:nth-child(2) > alchemy-input").shadowRoot.querySelector("div > div > div > input")
        let asin2 = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(5) > td:nth-child(2) > alchemy-input").shadowRoot.querySelector("div > div > div > input")
        let val_type1 = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(11) > td:nth-child(2) > alchemy-input").shadowRoot.querySelector("div > div > div > input")
        let val_type2 = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(12) > td:nth-child(2) > alchemy-input").shadowRoot.querySelector("div > div > div > input")
        let val_type3 = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(20) > td:nth-child(2) > alchemy-textarea")
        let val_warehouse = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(2) > td:nth-child(2) > select > option")
        let val_product = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(9) > td:nth-child(2) > select > option")
        let val_log = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(13) > td:nth-child(2) > select > option")
        let val_reason = document.querySelector("#root > div:nth-child(4) > form > table > tbody > tr:nth-child(14) > td:nth-child(2) > select > option")

        asin.value = params.get("paramLiquidation");
        asin2.value = params.get("paramLiquidation");
        val_type1.value = "-";
        val_type2.value = "-";
        val_type3.value = "damaged";
        getdataLIQ(params.get("paramLiquidation"));
        val_warehouse.text = "EMA4"
        val_warehouse.selected = true
        val_product.text = "Home"
        val_product.selected = true
        val_log.text = "Liquidation"
        val_log.selected = true
        val_reason.text = "FC Damage"
        val_reason.selected = true
    }

})();
