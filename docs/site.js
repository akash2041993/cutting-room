// Fills in your business name, support email and price from config.js on every page, and the footer links.
(function () {
  var C = window.APP_CONFIG || {};
  var ph = function (v) { return !v || /PASTE_YOUR/.test(String(v)); };
  var map = {
    BUSINESS_NAME: C.BUSINESS_NAME || 'Cutting Room',
    SUPPORT_EMAIL: ph(C.SUPPORT_EMAIL) ? '' : C.SUPPORT_EMAIL,
    PRICE_RUPEES: String(C.PRICE_RUPEES || 500)
  };
  document.querySelectorAll('[data-cfg]').forEach(function (el) {
    var k = el.getAttribute('data-cfg'), v = map[k];
    if (k === 'SUPPORT_EMAIL' && v) { el.innerHTML = ''; var a = document.createElement('a'); a.href = 'mailto:' + v; a.textContent = v; el.appendChild(a); }
    else if (k === 'SUPPORT_EMAIL') el.textContent = 'the support email shown in the app';
    else el.textContent = v;
  });
  var w = String(C.SUPPORT_WHATSAPP || '').replace(/\D/g, '');
  document.querySelectorAll('[data-whatsapp]').forEach(function (el) { if (w) el.textContent = ' You can also message us on WhatsApp: +' + (w.length === 10 ? '91' + w : w) + '.'; });
  document.title = document.title.replace('{name}', map.BUSINESS_NAME);
})();
