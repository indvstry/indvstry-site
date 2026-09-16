// Theme switcher - applies saved theme on load and provides toggle function
(function() {
  // Apply saved theme immediately to prevent flash
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
  }

  // Cycle order. '' is the default light theme; 'glitch' is an experiment
  // (css/glitch.css) that warps, liquifies and adds noise to the posts.
  const ORDER = ['', 'blue', 'glitch'];
  // Button label names the theme you'll get by pressing it.
  const LABEL = { '': 'Light', blue: 'Dark', glitch: 'Glitch' };

  const nextTheme = function() {
    const current = document.documentElement.dataset.theme || '';
    const i = ORDER.indexOf(current);
    return ORDER[(i + 1) % ORDER.length];
  };

  window.toggleTheme = function() {
    const next = nextTheme();
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    updateToggleLabel();
  };

  // Update button label based on current theme
  window.updateToggleLabel = function() {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      const label = LABEL[nextTheme()];
      btn.textContent = label;
      btn.setAttribute('aria-label', 'Switch to ' + label.toLowerCase() + ' theme');
    }
  };

  // Initialize label when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateToggleLabel);
  } else {
    updateToggleLabel();
  }
})();
