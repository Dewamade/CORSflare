// ----------------------------------------------------------------------------------
// CORSflare - v1.0.4
// ref.: https://github.com/Darkseal/CORSflare
// A lightweight JavaScript CORS Reverse Proxy designed to run in a Cloudflare Worker
// ----------------------------------------------------------------------------------



// ----------------------------------------------------------------------------------
// CONFIGURATION SETTINGS
// ----------------------------------------------------------------------------------

// The hostname of the upstream website to proxy(example: `www.google.com`).
const upstream = 'www.google.com';

// The hostname of the upstream website to proxy for requests coming from mobile devices(example: `www.google.com`).
// if the upstream website doesn't have a dedicated hostname for mobile devices, you can set it to NULL.
const upstream_mobile = null;

// Custom pathname for the upstream website ('/' will work for most scenarios)
const upstream_path = '/';

// An array of countries and regions that won't be able to use the proxy.
const blocked_regions = ['CN', 'KP', 'SY', 'PK', 'CU'];

// An array of IP addresses that won't be able to use the proxy.
const blocked_ip_addresses = ['0.0.0.0', '127.0.0.1'];

// Set this value to TRUE to fetch the upstream website using HTTPS, FALSE to use HTTP.
// If the upstream website doesn't support HTTPS, this must be set to FALSE; also, if the proxy is HTTPS,
// you'll need to enable the replacement_rules rule to HTTPS proxy an HTTP-only website (see below).
const https = true;

// Set this value to TRUE to forcefully apply the "SameSite=None" and "Secure" directives to all cookies generated by the upstream.
// If you plan to put this proxy within a <iframe> and allow users to POST FORM data, you might need this option to make auth cookies work.
// ref.: https://sites.google.com/a/chromium.org/dev/updates/same-site/faq
// ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite
// NOTE: This is an experimental feature and could prevent some cookies from being generated due to a known bug of the Fetch API
// affecting the "Set-Cookie" response headers: use it at your own risk.
const set_cookie_samesite_none = false;

// an array of HTTP Response Headers to add (or to update, in case they're already present in the upstream response)
const http_response_headers_set = {
    // use these headers to bypass DENY and SAMEORIGIN policies for IFRAME, OBJECT, EMBED and so on for most browsers.
    // NOTE: be sure to replace "https://www.example.com" with the domain of the HTML page containing the IFRAME.
    // ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
    // ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
    'X-Frame-Options': 'ALLOW FROM https://www.example.com', // IE
    'Content-Security-Policy': "frame-ancestors 'self' https://www.example.com;", // Chrome, Firefox, etc.

    // use this header to bypass the same-origin policy for XMLHttpRequest, Fetch API and so on
    // ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
    'Access-Control-Allow-Origin': '*',

    // use this header to accept (and respond to) preflight requests when the request's credentials mode is set to 'include'
    // ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Credentials
    'Access-Control-Allow-Credentials': true,

    // use this header to override the Cache-Control settings of the upstream pages. Allowed values include:
    // 'must-revalidate', 'no-cache', 'no-store', 'no-transform', 'public', 'private', 
    // 'proxy-revalidate', 'max-age=<seconds>', 's-maxage=<seconds>'.
    // ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
    // 'Cache-Control': 'no-cache'
};

// an array of HTTP Response Headers to delete (if present in the upstream response)
const http_response_headers_delete = [
    'Content-Security-Policy-Report-Only',
    'Clear-Site-Data'
];

// ----------------------------------------------------------------------------------
// TEXT REPLACEMENT RULES
// ----------------------------------------------------------------------------------
// The replacement_rules array can be used to configure the text replacement rules
// that will be applied by the proxy before serving any text/html resource back to the user.
// The common usage of such rules is to "fix" non-standard internal URLs and/or local paths
// within the upstream's HTML pages (css, js, internal links, custom fonts, and so on) and force them 
// to pass to the proxy; however, they can also be used to alter the response content in various ways
// (change a logo, modify the page title, add a custom css/js, and so on).

// Each rule must be defined in the following way:

// '<source_string>' : '<replacement_string>'

// The following dynamic placeholder can be used within the source and replacement strings:

// {upstream_hostname}  : will be replaced with the upstream's hostname
// {proxy_hostname}     : will be replaced with this proxy's hostname

// HINT: Rules are processed from top to bottom: put the most specific rules before the generic ones.

const replacement_rules = {

    // enable this rule only if you need to HTTPS proxy an HTTP-only website
    'http://{upstream_hostname}/': 'https://{proxy_hostname}/',

    // this rule should be always enabled (replaces the upstream hostname for internal links, CSS, JS, and so on)
    '{upstream_hostname}': '{proxy_hostname}',

}

// the replacement_rules will be only applied to the returned content 
// with the following content types specified by the replacement_content_types array.
const replacement_content_types = ['text/html'];

// Set this value to TRUE to allow RegEx syntax in replacement rules (see URLs below for details):
// - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
// - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions/Cheatsheet
// NOTE: if RegEx syntax is enabled, RegEx special chars in search patterns will have to be escaped
// using a double back slash (\\) accordingly.
const replacement_use_regex = true;



// ----------------------------------------------------------------------------------
// MAIN CODE
// ----------------------------------------------------------------------------------

var regexp_upstreamHostname = (replacement_use_regex)
    ? new RegExp('{upstream_hostname}', 'g')
    : null;
var regexp_proxyHostname = (replacement_use_regex)
    ? new RegExp('{proxy_hostname}', 'g')
    : null;

addEventListener('fetch', event => {
    event.respondWith(fetchAndApply(event.request));
})

async function fetchAndApply(request) {
    var r = request.headers.get('cf-ipcountry');
    const region = (r) ? r.toUpperCase() : null;
    const ip_address = request.headers.get('cf-connecting-ip');
    const user_agent = request.headers.get('user-agent');

    let response = null;
    let url = new URL(request.url);
    let url_hostname = url.hostname;

    if (https == true) {
        url.protocol = 'https:';
    } else {
        url.protocol = 'http:';
    }

    if (upstream_mobile && await is_mobile_user_agent(user_agent)) {
        var upstream_domain = upstream_mobile;
    } else {
        var upstream_domain = upstream;
    }

    url.host = upstream_domain;
    if (url.pathname == '/') {
        url.pathname = upstream_path;
    } else {
        url.pathname = upstream_path + url.pathname;
    }

    if (blocked_regions.includes(region) || blocked_ip_addresses.includes(ip_address)) {
        response = new Response('Access denied', {
            status: 403
        });
    } else {
        let method = request.method;
        let request_headers = request.headers;
        let new_request_headers = new Headers(request_headers);
        let request_content_type = new_request_headers.get('content-type');

        new_request_headers.set('Host', upstream_domain);
        new_request_headers.set('Origin', upstream_domain);
        new_request_headers.set('Referer', url.protocol + '//' + url_hostname);

        var params = {
            method: method,
            headers: new_request_headers,
            // this is required to properly handle standard HTTP redirects, as we need to alter the "location" header:
            // the default "follow" value would auto-resolve them with the upstream URL, which is not what we want.
            redirect: 'manual'
        }

        // if the request is supposed to contain Form Data, populates the request body accordingly
        if (method.toUpperCase() === "POST" && request_content_type) {
            let request_content_type_toLower = request_content_type.toLowerCase();
            if (request_content_type_toLower.includes("application/x-www-form-urlencoded")
                || request_content_type_toLower.includes("multipart/form-data")
                || request_content_type_toLower.includes("application/json")
            ) {
                let reqText = await request.text(); // TODO: this won't work for multipart/form-data
                if (reqText) {
                    params.body = reqText;
                }
            }
        }

        let original_response = await fetch(url.href, params);

        connection_upgrade = new_request_headers.get("Upgrade");
        if (connection_upgrade && connection_upgrade.toLowerCase() == "websocket") {
            return original_response;
        }

        let original_response_clone = original_response.clone();
        let response_headers = original_response_clone.headers;
        let response_status = original_response_clone.status;
        let original_text = null;
        let new_response_headers = new Headers(response_headers);
        let new_response_status = response_status;

        if (http_response_headers_set) {
            for (let k in http_response_headers_set) {
                var v = http_response_headers_set[k];
                new_response_headers.set(k, v);
            }
        }

        if (http_response_headers_delete) {
            for (let k of http_response_headers_delete) {
                new_response_headers.delete(k);
            }
        }

        // Patch "x-pjax-url" header to handle pushState ajax redirects
        if (new_response_headers.get("x-pjax-url")) {
            new_response_headers.set("x-pjax-url", new_response_headers.get("x-pjax-url")
                .replace(url.protocol + "//", "https://")
                .replace(upstream_domain, url_hostname));
        }

        // Patch "location" header to handle standard 301/302/303/307/308 HTTP redirects
        if (new_response_headers.get("location")) {
            new_response_headers.set("location", new_response_headers.get("location")
                .replace(url.protocol + "//", "https://")
                .replace(upstream_domain, url_hostname));
        }

        // Patch "set-cookie" headers by forcefully apply "SameSite=None" and "Secure" directives to allow cross-domain usage
        // (if "set_cookie_samesite_none" is set to TRUE: see that configuration option's comment block for details and references)
        if (set_cookie_samesite_none && new_response_headers.has("set-cookie")) {
            // NOTE: unfortunately the Fetch API Headers object doesn't support multiple Set-Cookie headers due to a bug in Fetch API's
            // "Headers" interface, as they are merged into a single comma-separated string (which is incompatible with most browsers).
            // ref.: https://stackoverflow.com/questions/63204093/how-to-get-set-multiple-set-cookie-response-headers-using-fetch-api
            // For that very reason, we can only support the * first * set-cookie header here.
            var firstCookie = new_response_headers.get("set-cookie").split(',').shift();
            new_response_headers.set("set-cookie", firstCookie
                .split("SameSite=Lax; Secure").join("")
                .split("SameSite=Lax").join("")
                .split("SameSite=Strict; Secure").join("")
                .split("SameSite=Strict").join("")
                .split("SameSite=None; Secure").join("")
                .split("SameSite=None").join("")
                .replace(/^;+$/g, '')
                + "; SameSite=None; Secure");
        }

        let response_content_type = new_response_headers.get('content-type');
        if (response_content_type
            && replacement_content_types.some(v => response_content_type.toLowerCase().includes(v))) {
            original_text = await replace_response_text(original_response_clone, upstream_domain, url_hostname);
        } else {
            original_text = original_response_clone.body;
        }

        response = new Response(original_text, {
            status: new_response_status,
            headers: new_response_headers
        })
    }
    return response;
}

async function replace_response_text(response, upstream_domain, host_name) {
    let text = await response.text()
    if (replacement_rules) {
        for (let k in replacement_rules) {
            var v = replacement_rules[k];

            if (replacement_use_regex) {
                k = k.replace(regexp_upstreamHostname, upstream_domain);
                k = k.replace(regexp_proxyHostname, host_name);
                v = v.replace(regexp_upstreamHostname, upstream_domain);
                v = v.replace(regexp_proxyHostname, host_name);
                text = text.replace(new RegExp(k, 'g'), v);
            }
            else {
                k = k.split('{upstream_hostname}').join(upstream_domain);
                k = k.split('{proxy_hostname}').join(host_name);
                v = v.split('{upstream_hostname}').join(upstream_domain);
                v = v.split('{proxy_hostname}').join(host_name);
                text = text.split(k).join(v);
            }
        }
    }
    return text;
}

async function is_mobile_user_agent(user_agent_info) {
    var agents = ["Android", "iPhone", "SymbianOS", "Windows Phone", "iPad", "iPod"];
    for (var v = 0; v < agents.length; v++) {
        if (user_agent_info.indexOf(agents[v]) > 0) {
            return true;
        }
    }
    return false;
}