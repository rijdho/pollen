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

})();
