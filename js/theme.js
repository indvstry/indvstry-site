// Theme switcher - applies saved theme on load and marks the active button
(function() {
  // Apply saved theme immediately to prevent flash
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
  }

  // '' is the default light theme, 'blue' is dark; 'glitch' and 'crt' are
  // the experiments in css/glitch.css and css/crt.css. Each has its own
  // button in the nav.
  window.setTheme = function(name) {
    document.documentElement.dataset.theme = name;
    localStorage.setItem('theme', name);
    updateToggleLabel();
  };

  // Highlight whichever button matches the current theme
  window.updateToggleLabel = function() {
    const current = document.documentElement.dataset.theme || '';
    document.querySelectorAll('.theme-toggle[data-set-theme]').forEach(function(btn) {
      btn.setAttribute('aria-pressed', btn.dataset.setTheme === current ? 'true' : 'false');
    });
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateToggleLabel);
  } else {
    updateToggleLabel();
  }
})();
