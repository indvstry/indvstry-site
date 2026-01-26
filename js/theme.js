// Theme switcher - applies saved theme on load and provides toggle function
(function() {
  // Apply saved theme immediately to prevent flash
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
  }

  // Toggle between default and blue theme
  window.toggleTheme = function() {
    const current = document.documentElement.dataset.theme;
    const next = current === 'blue' ? '' : 'blue';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    updateToggleLabel();
  };

  // Update button label based on current theme
  window.updateToggleLabel = function() {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      const isBlue = document.documentElement.dataset.theme === 'blue';
      btn.textContent = isBlue ? 'Light' : 'Dark';
      btn.setAttribute('aria-label', isBlue ? 'Switch to light theme' : 'Switch to dark theme');
    }
  };

  // Initialize label when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateToggleLabel);
  } else {
    updateToggleLabel();
  }
})();
