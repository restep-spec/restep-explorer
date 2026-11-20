// restep-explorer: el tema elegido (claro u oscuro) antes de pintar, para no parpadear. Se carga sin
// defer en <head>; es una comodidad local y, si localStorage falla, la página sigue en automático.
try {
  const theme = localStorage.getItem('restep-explorer:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
