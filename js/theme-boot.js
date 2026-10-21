(function () {
  try {
    var cur = localStorage.getItem('doodlemail:current');
    var theme = 'system';
    if (cur) {
      var s = JSON.parse(localStorage.getItem('doodlemail:settings:' + cur) || '{}');
      theme = s.theme || 'system';
    }
    if (theme === 'system') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  } catch (e) { document.documentElement.dataset.theme = 'light'; }
})();
