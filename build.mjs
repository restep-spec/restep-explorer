// Construye restep-explorer para restep.wubytes.com, en inglés y en español, desde una sola fuente.
//   node tools/restep-explorer/build.mjs        (desde projects/restep)
// Escribe:
//   public/explorer/index.html            (lang="en")
//   public/es/explorador/index.html       (lang="es")
//   public/explorer/explorer.css, explorer-theme.js, explorer-i18n.js, explorer-logic.js, explorer.js
//     (compartidos: las dos páginas los cargan con ruta absoluta /explorer/...)
// Los textos salen de explorer-i18n.js, el mismo diccionario que usa la página en el navegador.
// La página no lleva ningún script ni estilo en línea: funciona con la CSP de la constante CSP, más abajo.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const ORIGIN = 'https://restep.wubytes.com';

// La CSP que necesitan /explorer/* y /es/explorador/* (va en public/_headers, no en la página).
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Archivos que se copian tal cual a public/explorer/, en el orden en que los carga la página.
export const ASSETS = ['explorer.css', 'explorer-theme.js', 'explorer-i18n.js', 'explorer-logic.js', 'explorer.js'];

export const PAGES = {
  en: {
    out: 'explorer/index.html', path: '/explorer/', home: '/', spec: '/1/', tools: '/tools/',
    other: 'es', otherPath: '/es/explorador/', ogImage: `${ORIGIN}/og.png`,
  },
  es: {
    out: 'es/explorador/index.html', path: '/es/explorador/', home: '/es/', spec: '/es/1/', tools: '/es/herramientas/',
    other: 'en', otherPath: '/explorer/', ogImage: `${ORIGIN}/og-es.png`,
  },
};

export function loadDictionary() {
  const box = {};
  box.globalThis = box;
  vm.runInNewContext(readFileSync(join(here, 'explorer-i18n.js'), 'utf8'), box, { filename: 'explorer-i18n.js' });
  return box.RestepI18n;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// {{clave}}: texto del diccionario, escapado. {{{claveHtml}}}: marcado del diccionario, tal cual.
// {{=variable}}: un valor de la construcción (rutas, URL), escapado. Lo que falte es un error.
export function renderPage(lang, template = readFileSync(join(here, 'page.html'), 'utf8'), dict = loadDictionary()) {
  const page = PAGES[lang];
  const d = dict[lang];
  if (!page || !d) throw new Error(`idioma sin página o sin diccionario: ${lang}`);
  const vars = {
    lang, url: ORIGIN + page.path, urlEn: ORIGIN + PAGES.en.path, urlEs: ORIGIN + PAGES.es.path,
    assets: '/explorer/', home: page.home, spec: page.spec, tools: page.tools, self: page.path,
    otherPath: page.otherPath, otherLang: page.other, ogImage: page.ogImage,
  };
  const text = (key) => {
    const v = d[key];
    if (typeof v !== 'string') throw new Error(`page.html usa «${key}», que no es un texto en el diccionario «${lang}»`);
    return v;
  };
  return template
    .replace(/\{\{\{([A-Za-z0-9]+)\}\}\}/g, (_, key) => {
      if (!key.endsWith('Html')) throw new Error(`{{{${key}}}}: solo las claves que acaban en Html van sin escapar`);
      return text(key);
    })
    .replace(/\{\{=([A-Za-z0-9]+)\}\}/g, (_, key) => {
      if (!(key in vars)) throw new Error(`page.html usa la variable «${key}», que build.mjs no define`);
      return escapeHtml(vars[key]);
    })
    .replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_, key) => {
      if (key.endsWith('Html')) throw new Error(`{{${key}}}: una clave Html va entre llaves triples`);
      return escapeHtml(text(key));
    })
    .replace(/\{\{[^}]*\}\}/g, (m) => { throw new Error(`marcador sin reemplazar en page.html: ${m}`); });
}

// Todo lo que se publica: { 'ruta relativa a public/': contenido }.
export function buildFiles() {
  const template = readFileSync(join(here, 'page.html'), 'utf8');
  const dict = loadDictionary();
  const files = {};
  for (const lang of Object.keys(PAGES)) files[PAGES[lang].out] = renderPage(lang, template, dict);
  for (const a of ASSETS) files[`explorer/${a}`] = readFileSync(join(here, a), 'utf8');
  return files;
}

export { PUBLIC };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [rel, content] of Object.entries(buildFiles())) {
    const out = join(PUBLIC, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
    console.log(`  ${rel}  (${Buffer.byteLength(content)} B)`);
  }
  console.log(`\nCabecera para /explorer/* y /es/explorador/*:\n  Content-Security-Policy: ${CSP}`);
}
