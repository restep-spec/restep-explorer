// Builds restep-explorer for restep.wubytes.com, in English and Spanish, from a single source.
//   node tools/restep-explorer/build.mjs        (from projects/restep)
// Writes:
//   public/explorer/index.html            (lang="en")
//   public/es/explorador/index.html       (lang="es")
//   public/explorer/explorer.css, explorer-theme.js, explorer-i18n.js, explorer-logic.js, explorer.js
//     (shared: both pages load them with the absolute path /explorer/...)
// The texts come from explorer-i18n.js, the same dictionary the page uses in the browser.
// The page has no inline script or style: it works with the CSP in the CSP constant, below.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const ORIGIN = 'https://restep.wubytes.com';

// The CSP that /explorer/* and /es/explorador/* need (it goes in public/_headers, not in the page).
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Files copied as they are to public/explorer/, in the order the page loads them.
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

// {{key}}: text from the dictionary, escaped. {{{keyHtml}}}: markup from the dictionary, as is.
// {{=variable}}: a value from the build (paths, URLs), escaped. Anything missing is an error.
export function renderPage(lang, template = readFileSync(join(here, 'page.html'), 'utf8'), dict = loadDictionary()) {
  const page = PAGES[lang];
  const d = dict[lang];
  if (!page || !d) throw new Error(`language without a page or a dictionary: ${lang}`);
  const vars = {
    lang, url: ORIGIN + page.path, urlEn: ORIGIN + PAGES.en.path, urlEs: ORIGIN + PAGES.es.path,
    assets: '/explorer/', home: page.home, spec: page.spec, tools: page.tools, self: page.path,
    otherPath: page.otherPath, otherLang: page.other, ogImage: page.ogImage,
  };
  const text = (key) => {
    const v = d[key];
    if (typeof v !== 'string') throw new Error(`page.html uses "${key}", which is not a text in the "${lang}" dictionary`);
    return v;
  };
  return template
    .replace(/\{\{\{([A-Za-z0-9]+)\}\}\}/g, (_, key) => {
      if (!key.endsWith('Html')) throw new Error(`{{{${key}}}}: only keys ending in Html go unescaped`);
      return text(key);
    })
    .replace(/\{\{=([A-Za-z0-9]+)\}\}/g, (_, key) => {
      if (!(key in vars)) throw new Error(`page.html uses the variable "${key}", which build.mjs does not define`);
      return escapeHtml(vars[key]);
    })
    .replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_, key) => {
      if (key.endsWith('Html')) throw new Error(`{{${key}}}: an Html key goes in triple braces`);
      return escapeHtml(text(key));
    })
    .replace(/\{\{[^}]*\}\}/g, (m) => { throw new Error(`unreplaced placeholder in page.html: ${m}`); });
}

// Everything that is published: { 'path relative to public/': content }.
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
    if (process.argv.includes('--check')) {
      if (!existsSync(out) || readFileSync(out, 'utf8') !== content) {
        console.error(`Out of date: ${rel}`); process.exitCode = 1;
      }
    } else {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content);
    }
    console.log(`  ${rel}  (${Buffer.byteLength(content)} B)`);
  }
  console.log(`\nHeader for /explorer/* and /es/explorador/*:\n  Content-Security-Policy: ${CSP}`);
}
