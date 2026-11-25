// restep-explorer: the chosen theme (light or dark) before painting, to avoid flashing. Loaded without
// defer in <head>; it is a local convenience and, if localStorage fails, the page stays on automatic.
try {
  const theme = localStorage.getItem('restep-explorer:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
