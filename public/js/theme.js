// Runs before first paint, so a dark room does not get a white flash while the
// module graph loads. A plain classic script in its own file rather than an
// inline one: inline would force either 'unsafe-inline' or a hash pinned to
// these exact bytes in the Content-Security-Policy.
(function () {
  try {
    var saved = localStorage.getItem('pollen.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    // Storage is off. The system preference still applies.
  }

  // PROTOTYPE, ?skin=austere only. A design variant kept behind a query string
  // so it can be looked at beside the real thing without touching it. It is
  // deleted once the choice is made, whichever way that goes.
  try {
    if (new URLSearchParams(location.search).get('skin') === 'austere') {
      document.documentElement.setAttribute('data-skin', 'austere');
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/style-austere.css?v=1';
      document.head.appendChild(link);
    }
  } catch (e) {
    // A malformed query string is not worth failing the page over.
  }
})();
