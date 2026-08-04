/* SPU Annotation Helper - Shopee product identity (shared)
 *
 * A search-result link and the URL of the product page you land on are almost
 * never the same string: the title slug differs, the site rewrites it on
 * redirect, tracking params get appended, and results sometimes link to
 * /product/<shopid>/<itemid> while the page itself becomes -i.<shopid>.<itemid>.
 * Comparing URLs is therefore unreliable - everything keys off the shop/item id
 * pair instead, which is stable for a given product.
 *
 * Loaded into both the content script and the service worker so the key can
 * never drift between the writer and the reader. Deliberately not wrapped in an
 * IIFE: the sibling content script and importScripts() both need the function
 * in their global scope.
 */

var SHOPEE_PRODUCT_PATTERNS = [
  /(?:^|[/\-])i\.(\d+)\.(\d+)/, // /Product-Name-i.<shopid>.<itemid>, /p-i.<...>
  /\/product\/(\d+)\/(\d+)/, // /product/<shopid>/<itemid>
];

// "<shopid>.<itemid>", or null when the URL is not a Shopee product.
function getProductKey(rawUrl) {
  if (!rawUrl) return null;
  var path;
  try {
    var parsed = new URL(rawUrl);
    if (!/(^|\.)shopee\./.test(parsed.hostname)) return null;
    path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      // Malformed escape - the ids we need are plain ASCII, so keep it raw.
    }
  } catch (e) {
    return null; // Not a URL we can read (javascript:, about:, relative, ...)
  }
  for (var i = 0; i < SHOPEE_PRODUCT_PATTERNS.length; i++) {
    var m = path.match(SHOPEE_PRODUCT_PATTERNS[i]);
    if (m) return m[1] + "." + m[2];
  }
  return null;
}
