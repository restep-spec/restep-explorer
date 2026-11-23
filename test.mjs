// Pruebas de restep-explorer, sobre la versión construida (public/explorer/ y public/es/explorador/).
//   node tools/restep-explorer/build.mjs       (desde projects/restep; las pruebas fallan si no está al día)
//   node tools/restep-explorer/test.mjs
// 1. Lógica pura: explorer-i18n.js y explorer-logic.js publicados se evalúan en Node (vm), en inglés y en español.
// 2. Páginas construidas: textos, metadatos, enlaces y nada en línea (ni script, ni style, ni style=, ni on*=).
// 3. Integración: una copia del servidor de referencia con CORS (en un directorio temporal; el original
//    no se toca) en el puerto 8840, y las páginas servidas en 8841 con la CSP como cabecera HTTP.
// 4. Navegador: si hay Chrome o Chromium, carga las dos páginas en modo headless por el protocolo de
//    DevTools (puerto 8842), mira el DOM y comprueba que no hay violaciones de CSP ni errores de JS.
// Puertos: 8840-8849.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildFiles, CSP, ASSETS, PAGES, PUBLIC } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(here, 'vendor/restep-server.mjs'), 'utf8');
const API_PORT = 8840, PAGE_PORT = 8841, DEVTOOLS_PORT = 8842;
const API = `http://localhost:${API_PORT}/`, PAGE = `http://localhost:${PAGE_PORT}`;
const EN_PAGE = `${PAGE}/explorer/`, ES_PAGE = `${PAGE}/es/explorador/`;

let passed = 0, failed = 0, skipped = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok    ${name}`); }
  catch (e) { failed++; results.push(`  FALLO ${name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
}
function skip(name, why) { skipped++; results.push(`  omit  ${name} (${why})`); }

// ── 0. La versión publicada está al día con la fuente ─────────────────────────
const built = buildFiles();
const published = (rel) => (existsSync(join(PUBLIC, rel)) ? readFileSync(join(PUBLIC, rel), 'utf8') : null);
await test('public/ está al día con la fuente (si no: node tools/restep-explorer/build.mjs)', () => {
  const stale = Object.keys(built).filter((rel) => published(rel) !== built[rel]);
  assert.deepEqual(stale, [], `desactualizados: ${stale.join(', ')}`);
});

// ── 1. Lógica pura ─────────────────────────────────────────────────────────────
// Se evalúa lo publicado: el diccionario y la lógica, en un contexto vm sin DOM.
const I18N_SRC = published('explorer/explorer-i18n.js') ?? built['explorer/explorer-i18n.js'];
const LOGIC_SRC = published('explorer/explorer-logic.js') ?? built['explorer/explorer-logic.js'];
function loadLogic(lang, crypto = globalThis.crypto) {
  const box = { URL, URLSearchParams, crypto, console };
  box.globalThis = box;
  vm.runInNewContext(I18N_SRC, box, { filename: 'explorer-i18n.js' });
  vm.runInNewContext(LOGIC_SRC, box, { filename: 'explorer-logic.js' });
  box.RestepLogic.setLang(lang);
  return box.RestepLogic;
}
const L = loadLogic('es');
const LE = loadLogic('en');
// Los objetos creados dentro del contexto vm tienen otros prototipos: se comparan como JSON.
const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

// El ejemplo del apartado 4.2 de la especificación, con una subcolección y una acción.
const SPEC_DOC = {
  restep: '1.0', version: '1', profiles: ['core', 'query', 'writes', 'relations', 'sync'], extensions: ['actions', 'batch'],
  batch: { path: '/batch', max_operations: 20 }, idempotency: { ttl: 86400 }, events: '/events',
  collections: {
    books: {
      path: '/books', description: 'Libros del catálogo, uno por edición.', methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'],
      schemas: { create: '/schemas/book-create.json', update: '/schemas/book-update.json' },
      filter: {
        id: { type: 'string', ops: ['eq', 'in'] }, price: { type: 'decimal', ops: ['eq', 'lt', 'le', 'gt', 'ge'] },
        rating: { type: 'number', ops: ['ge', 'null'] }, category: { type: 'enum', values: ['novela-negra', 'poesia'], ops: ['eq', 'in'] },
        'author.id': { type: 'string', ops: ['eq', 'in'] },
      },
      sort: ['id', 'price', 'rating', 'title'], max_limit: 50, count: 'estimated',
      relations: { author: { to: 'authors', include: true }, reviews: { to: 'reviews', many: true, path: '/books/{id}/reviews' } },
      include_depth: 2, sync: { retention: 604800 },
      actions: { reserve: { on: 'item', safe: false, idempotent: true, description: 'Aparta un ejemplar.', input: '/schemas/reserve.json' } },
    },
    authors: { path: '/authors' },
    reviews: { path: '/books/{id}/reviews', sort: ['id', 'created_at'], max_limit: 50 },
    broken: { description: 'sin path: se ignora' },
    'x-raro': 7,
  },
};

await test('normalizeRoot: añade esquema y barra final, quita consulta y fragmento', () => {
  assert.equal(L.normalizeRoot('https://ejemplo.com/api'), 'https://ejemplo.com/api/');
  assert.equal(L.normalizeRoot(' localhost:8080 '), 'http://localhost:8080/');
  assert.equal(L.normalizeRoot('api.ejemplo.com/v1/?x=1#y'), 'https://api.ejemplo.com/v1/');
  assert.throws(() => L.normalizeRoot(''), /URL de la API/);
  assert.throws(() => L.normalizeRoot('ftp://x/'), /http/);
  assert.throws(() => L.normalizeRoot('https://u:p@x/'), /credenciales/);
  assert.throws(() => LE.normalizeRoot(''), /Type the API URL/);
  assert.throws(() => LE.normalizeRoot('ftp://x/'), /has to start with http/);
  assert.throws(() => LE.normalizeRoot('https://u:p@x/'), /credentials/);
  assert.throws(() => LE.normalizeRoot('http://['), /is not a valid URL/);
});

await test('joinRoot y toApiPath: rutas relativas a la raíz (§2) y enlaces de cuerpos (§3)', () => {
  assert.equal(L.joinRoot('https://e.com/api/', '/books'), 'https://e.com/api/books');
  assert.equal(L.joinRoot('http://localhost:8080/', '/books?sort=id'), 'http://localhost:8080/books?sort=id');
  assert.equal(L.toApiPath('https://e.com/api/', '/api/books?cursor=abc'), '/books?cursor=abc');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://e.com/api/orders/2001:cancel'), '/orders/2001:cancel');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://e.com/api/'), '/');
  assert.equal(L.toApiPath('https://e.com/api/', '/otra/books'), null, 'fuera de la ruta de la raíz');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://evil.example/api/books'), null, 'otro origen');
  assert.equal(L.toApiPath('http://localhost:8080/', '/books?filter[price][le]=20&cursor=x.y'), '/books?filter[price][le]=20&cursor=x.y');
});

await test('hash: ida y vuelta, legible y sin token', () => {
  const st = { api: 'http://localhost:8080/', path: '/books?filter[price][le]=20&sort=-price' };
  const hsh = L.writeHash(st);
  assert.ok(hsh.startsWith('#api=http://localhost:8080/&path=/books?filter[price][le]=20%26sort=-price'), hsh);
  same(L.readHash(hsh), st);
  assert.equal(L.writeHash({ api: 'http://x/', path: '/' }), '#api=http://x/');
  same(L.readHash(''), { api: '', path: '' });
});

await test('parseDiscovery: el ejemplo de §4.2', () => {
  const d = L.parseDiscovery(SPEC_DOC);
  assert.equal(d.restep, '1.0');
  assert.ok(L.has(d, 'relations') && L.has(d, 'batch') && !L.has(d, 'oauth'));
  same(d.collections.map((c) => c.name), ['books', 'authors', 'reviews']);
  const b = L.collection(d, 'books');
  same(b.methods, ['GET', 'POST']);
  assert.equal(b.maxLimit, 50);
  assert.equal(b.count, 'estimated');
  same(b.filters.find((f) => f.field === 'category'), { field: 'category', type: 'enum', values: ['novela-negra', 'poesia'], ops: ['eq', 'in'], description: '' });
  same(b.relations.map((r) => [r.name, r.to, r.many, r.include, r.path]), [['author', ['authors'], false, true, null], ['reviews', ['reviews'], true, false, '/books/{id}/reviews']]);
  assert.equal(b.includeDepth, 2);
  same(b.actions, [{ name: 'reserve', on: 'item', safe: false, idempotent: true, method: 'POST', description: 'Aparta un ejemplar.', input: '/schemas/reserve.json' }]);
  const r = L.collection(d, 'reviews');
  assert.ok(r.templated);
  same(r.vars, ['id']);
  assert.equal(L.collection(d, 'authors').methods, null, 'sin methods: no se sabe (§4.3)');
  assert.ok(L.allows(null, 'DELETE') && !L.allows(['GET'], 'DELETE'));
  assert.equal(d.idempotencyTtl, 86400);
});

await test('parseDiscovery: lo que no es documento de descubrimiento es solo core (§4.2)', () => {
  for (const doc of [null, [], { items: [] }, { restep: 1 }, 'restep']) {
    const d = L.parseDiscovery(doc);
    assert.ok(d.coreOnly);
    same(d.profiles, ['core']);
    assert.equal(d.collections.length, 0);
  }
  const d = L.parseDiscovery({ restep: '1.0', profiles: ['query'] });
  same(d.profiles, ['core', 'query'], 'core siempre');
});

await test('matchPath: raíz, colección, elemento, subcolección y desconocido', () => {
  const d = L.parseDiscovery(SPEC_DOC);
  assert.equal(L.matchPath(d, '').kind, 'root');
  assert.equal(L.matchPath(d, '/?x=1').kind, 'root');
  const c = L.matchPath(d, '/books?sort=-price');
  assert.equal(c.kind, 'collection'); assert.equal(c.coll.name, 'books'); assert.equal(c.query, 'sort=-price');
  const i = L.matchPath(d, '/books/7?fields=title');
  assert.equal(i.kind, 'item'); assert.equal(i.id, '7'); assert.equal(i.pathname, '/books/7');
  const s = L.matchPath(d, '/books/7/reviews');
  assert.equal(s.kind, 'collection'); assert.equal(s.coll.name, 'reviews'); same(s.values, ['7']);
  const si = L.matchPath(d, '/books/7/reviews/3');
  assert.equal(si.kind, 'item'); same(si.values, ['7']); assert.equal(si.id, '3');
  assert.equal(L.matchPath(d, '/books/7:reserve').kind, 'unknown', 'una acción no es un elemento');
  assert.equal(L.matchPath(d, '/nada').kind, 'unknown');
});

await test('plantillas: expandir y ruta de elemento (§5.1)', () => {
  assert.equal(L.expandTemplate('/books/{id}/reviews', ['7']), '/books/7/reviews');
  assert.equal(L.expandTemplate('/a/{x}/b/{y}', ['1', 'a b']), '/a/1/b/a%20b');
  assert.throws(() => L.expandTemplate('/a/{x}', []), /Falta un valor/);
  const d = L.parseDiscovery(SPEC_DOC);
  assert.equal(L.itemPath(L.collection(d, 'reviews'), ['7'], '3'), '/books/7/reviews/3');
  assert.equal(L.itemPath(L.collection(d, 'books'), [], '7'), '/books/7');
});

await test('buildQuery: filtros, orden, fields, include, limit y count (§6)', () => {
  const q = {
    filters: [{ field: 'category', op: 'eq', value: 'novela-negra' }, { field: 'price', op: 'le', value: '20' },
      { field: 'category', op: 'in', value: ['poesia', 'ensayo'] }, { field: 'rating', op: 'null', value: 'false' }, { field: '', op: 'eq', value: 'x' }],
    sort: [{ field: 'rating', desc: true }, { field: 'title', desc: false }], fields: ['title', 'price'], include: ['author'], limit: '10', count: true,
    extra: [['lang', 'es & en']], cursor: 'abc',
  };
  assert.equal(L.buildQuery(q),
    'filter[category]=novela-negra&filter[price][le]=20&filter[category][in]=poesia,ensayo&filter[rating][null]=false' +
    '&sort=-rating,title&fields=title,price&include=author&limit=10&count=true&lang=es%20%26%20en');
  assert.ok(L.buildQuery(q, { keepCursor: true }).endsWith('&cursor=abc'));
  assert.equal(L.buildQuery(L.emptyQuery()), '');
  assert.equal(L.buildQuery({ ...L.emptyQuery(), filters: [{ field: 'name.es-mx', op: 'eq', value: 'Goma & Co' }] }), 'filter[name.es-mx]=Goma%20%26%20Co');
  assert.equal(L.withQuery('/books', ''), '/books');
});

await test('filtros con nombre: del descubrimiento a la URL y de vuelta (§6.1)', () => {
  const disc = L.parseDiscovery({ restep: '1.0', profiles: ['core', 'query'], collections: { books: { path: '/books',
    filter: { price: { type: 'decimal', ops: ['le'] } },
    named_filters: { featured: { description: 'Destacados.' }, search: { type: 'string', description: 'Título.' } } } } });
  const books = L.collection(disc, 'books');
  same(books.named, [{ name: 'featured', type: null, values: [], description: 'Destacados.' }, { name: 'search', type: 'string', values: [], description: 'Título.' }]);
  const q = L.parseQuery('filter[featured]=&filter[search]=niebla&filter[price][le]=15&filter[search][eq]=x', books);
  same(q.named, { featured: '', search: 'niebla' });
  same(q.filters, [{ field: 'price', op: 'le', value: '15' }, { field: 'search', op: 'eq', value: 'x' }]); // con operador no es el filtro con nombre
  assert.equal(L.buildQuery({ ...L.emptyQuery(), named: { featured: '', search: 'niebla' } }), 'filter[featured]=&filter[search]=niebla');
  same(L.parseQuery('filter[featured]=').named, {}); // sin la colección, un filtro más
});
await test('parseQuery: inversa de buildQuery, conserva cursor y parámetros propios', () => {
  const qs = 'filter[category]=poesia&filter[price][ge]=10&sort=-rating,title&fields=title&limit=5&count=true&cursor=c1&mio=1&filter=price%20%3C%2020';
  const q = L.parseQuery(qs);
  same(q.filters, [{ field: 'category', op: 'eq', value: 'poesia' }, { field: 'price', op: 'ge', value: '10' }]);
  same(q.sort, [{ field: 'rating', desc: true }, { field: 'title', desc: false }]);
  same(q.fields, ['title']); assert.equal(q.limit, '5'); assert.equal(q.count, true); assert.equal(q.cursor, 'c1');
  same(q.extra, [['mio', '1'], ['filter', 'price < 20']]);
  const back = L.parseQuery(L.buildQuery(q, { keepCursor: true }));
  same(back, q);
});

await test('valueControl: controles según tipo y operador', () => {
  assert.equal(L.valueControl({ type: 'enum', values: ['a', 'b'] }, 'eq').kind, 'select');
  assert.equal(L.valueControl({ type: 'enum', values: ['a', 'b'] }, 'in').placeholder, 'a,b');
  same(L.valueControl({ type: 'number', values: [] }, 'null').options.map((o) => o[0]), ['true', 'false']);
  assert.equal(L.valueControl({ type: 'decimal', values: [] }, 'le').inputmode, 'decimal');
  assert.equal(L.valueControl({ type: 'date', values: [] }, 'ge').type, 'date');
  assert.equal(L.valueControl({ type: 'boolean', values: [] }, 'eq').kind, 'select');
});

await test('mergeDiff: Merge Patch mínimo (RFC 7396) y relaciones enteras (§5.1)', () => {
  const a = { title: 'A', price: '10.00', name: { en: 'Eraser', es: 'Goma' }, category: { id: '3', name: 'X' }, tags: ['a'], gone: 1 };
  const b = { title: 'A', price: '12.00', name: { en: 'Eraser', 'es-mx': 'Goma' }, category: { id: '1', name: 'X' }, tags: ['a', 'b'], nuevo: true };
  same(L.mergeDiff(a, b, ['category']), { gone: null, price: '12.00', name: { es: null, 'es-mx': 'Goma' }, category: { id: '1', name: 'X' }, tags: ['a', 'b'], nuevo: true });
  same(L.mergeDiff(a, a), {});
  assert.ok(L.jsonEqual({ x: 1, y: [1, { a: 2, b: 3 }] }, { y: [1, { b: 3, a: 2 }], x: 1 }));
});

await test('editableCopy y skeleton: sin id, _ ni heredados; obligatorios del esquema', () => {
  const coll = { inherit: [{ field: 'tax_rate' }], schemas: { item: { properties: { stock: { readOnly: true } } } } };
  same(L.editableCopy(coll, { id: '1', name: {}, tax_rate: '21', tax_rate_own: null, stock: 3, _etag: '"x"', _inherited: {} }), { name: {}, tax_rate_own: null });
  const schema = {
    type: 'object', required: ['title', 'price', 'category', 'n', 'kind', 'ro'],
    properties: {
      title: { type: 'string' }, price: { type: 'string', pattern: '^-?\\d+$' }, n: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      category: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, kind: { enum: ['a', 'b'] }, ro: { type: 'string', readOnly: true },
      optional: { type: 'string' },
    },
  };
  same(L.skeleton(schema), { title: '', price: '', category: { id: '' }, n: 0, kind: 'a' });
  same(L.skeleton('/schemas/x.json'), {});
});

await test('formulario (§4.3): skeleton con default en orden; formFields con etiquetas y opciones; acción new', () => {
  const schema = {
    type: 'object', required: ['title'],
    properties: {
      title: { type: 'string', title: 'Título', examples: ['La niebla'] },
      category: { title: 'Categoría', default: 'b', anyOf: [{ type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, { type: 'null' }] },
      price: { type: 'string', description: 'En euros.' },
      signed: { default: false, anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      _x: { default: 1 }, ro: { type: 'string', readOnly: true, default: 'z' },
    },
  };
  const body = L.skeleton(schema);
  same(body, { title: '', category: 'b', signed: false });
  same(Object.keys(body), ['title', 'category', 'signed']);
  same(L.placeholder(schema.properties.category), 'b');
  const f = L.formFields(schema);
  same(f.map((x) => x.name), ['title', 'category', 'price', 'signed', 'ro']);
  same([f[0].title, f[0].required, f[0].examples], ['Título', true, ['La niebla']]);
  same([f[1].type, f[1].nullable, f[1].hasDefault, f[1].default], ['string', true, true, 'b']);
  same(f[1].choices, [{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }]);
  same([f[2].description, f[2].hasDefault], ['En euros.', false]);
  same([f[3].type, f[4].readOnly], ['boolean', true]);
  const disc = { profiles: ['core'], extensions: ['actions'] };
  const coll = { actions: [{ name: 'new', on: 'collection', method: 'GET' }] };
  same(L.newAction(disc, coll)?.name, 'new');
  same(L.newAction({ profiles: ['core'], extensions: [] }, coll), null);
  same(L.newAction(disc, { actions: [{ name: 'new', on: 'item', method: 'GET' }] }), null);
});

await test('Idempotency-Key: cadena de Structured Fields con un UUID (§7.1)', () => {
  const k = L.newIdempotencyKey();
  assert.match(k, /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
  assert.notEqual(k, L.newIdempotencyKey());
  // Sin randomUUID (contexto no seguro): getRandomValues.
  const noUuid = loadLogic('es', { getRandomValues: (b) => globalThis.crypto.getRandomValues(b) });
  assert.match(noUuid.newIdempotencyKey(), /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
});

await test('itemEtag: _etag primero; la cabecera solo en una lectura completa (§7.2)', () => {
  assert.equal(L.itemEtag({ _etag: '"a"' }, '"b"', true), '"a"');
  assert.equal(L.itemEtag({}, '"b"', false), '"b"');
  assert.equal(L.itemEtag({}, '"b"', true), null);
});

await test('relationLinks y subcollections (§3, §8)', () => {
  const d = L.parseDiscovery(SPEC_DOC);
  const b = L.collection(d, 'books');
  const rl = L.relationLinks(d, b, [], { id: '7', author: { id: '3', name: 'Inés' } });
  same(rl.map((r) => [r.rel.name, r.sub ?? null, r.links.map((l) => l.path)]), [['author', null, ['/authors/3']], ['reviews', '/books/7/reviews', []]]);
  assert.ok(L.relationLinks(d, b, [], { id: '7', author: null })[0].empty);
  // Relación polimórfica: type dice la colección (§3).
  const poly = { relations: [{ name: 'owner', to: ['authors', 'books'], many: false, path: null }] };
  same(L.relationLinks(d, poly, [], { owner: { id: '9', type: 'books' } })[0].links.map((l) => l.path), ['/books/9']);
  // reviews ya sale como relación; sin ella, sería subcolección.
  assert.equal(L.subcollections(d, b, [], '7').length, 0);
  const noRel = { ...b, relations: [] };
  same(L.subcollections(d, noRel, [], '7').map((s) => s.path), ['/books/7/reviews']);
});

// ── Borrador 6: lo que §12.2 pide a un cliente ────────────────────────────────
const D6 = {
  restep: '1.0-draft.6', profiles: ['core', 'query', 'writes'], extensions: ['actions', 'inherit'], idempotency: { anonymous: false },
  deprecations: [{ kind: 'version', announced: '2026-12-01T00:00:00Z' }, { kind: 'galaxy', announced: '2026-12-01T00:00:00Z' }],
  collections: {
    tags: {
      path: '/tags', id_from: 'client',
      filter: { geo: { type: 'geo', ops: ['eq'] }, name: { type: 'string', ops: ['near', 'eq'] } },
      named_filters: { fuzzy: { type: 'vector' }, on: {} },
      actions: { go: { on: 'everywhere', safe: true, idempotent: true }, put: { on: 'item', method: 'PUT', safe: false, idempotent: true }, ok: { on: 'item', safe: false, idempotent: false } },
      inherit: { rate: { own: 'rate_own', from: ['parent'] } },
      deprecations: [{ kind: 'field', name: 'x', announced: '2026-12-01T00:00:00Z' }, { kind: 'nebula', name: 'y', announced: '2026-12-01T00:00:00Z' }],
    },
    notes: { path: '/notes', id_from: 'someday' },
    plain: { path: '/plain' },
    reviews: { path: '/tags/{tag_id}/reviews', parent: 'tags' },
  },
  singletons: { me: { path: '/me', methods: ['GET', 'PATCH', 'DELETE'], description: 'Yo.' }, tpl: { path: '/u/{u}/prefs' }, sub: { path: '/x', parent: 'tags' }, bad: { path: 'nope' } },
};

await test('§1.1: versiones con sufijo; otra versión mayor o sin gramática no es Restep 1 ni core', () => {
  for (const v of ['1.0', '1.0-draft.6', '1.0-rc.1', '1.12']) assert.ok(!L.parseDiscovery({ ...D6, restep: v }).notRestep1, v);
  assert.ok(L.parseDiscovery(D6).draft && !L.parseDiscovery({ ...D6, restep: '1.0' }).draft);
  for (const v of ['2.0', '0.9', '1', '1.0-beta', '01.0', '1.0-draft.06', '1.0-draft']) {
    const d = L.parseDiscovery({ ...D6, restep: v });
    assert.ok(d.notRestep1 && !d.coreOnly, `${v}: no es Restep 1 y no se supone core`);
    same([d.profiles, d.collections.length, d.singletons.length], [[], 0, 0]);
  }
});

await test('§4.2: filtros, filtros con nombre, acciones y avisos con valores desconocidos se ignoran', () => {
  const t6 = L.collection(L.parseDiscovery(D6), 'tags');
  same(t6.filters.map((f) => [f.field, f.ops]), [['name', ['eq']]]);
  same(t6.named.map((f) => f.name), ['on']);
  same(t6.actions.map((a) => a.name), ['ok']);
  same(t6.deprecations.map((x) => x.kind), ['field']);
  same(L.parseDiscovery(D6).deprecations.map((x) => x.kind), ['version']);
});

await test('§5.9: recursos sueltos; los de plantilla o parent se ignoran; matchPath los reconoce', () => {
  const d = L.parseDiscovery(D6);
  same(d.singletons.map((x) => [x.name, x.path, x.methods]), [['me', '/me', ['GET', 'PATCH']]]);
  const m = L.matchPath(d, '/me?fields=name');
  assert.equal(m.kind, 'singleton');
  assert.equal(m.singleton.name, 'me');
  assert.equal(m.query, 'fields=name');
  assert.equal(L.matchPath(d, '/x').kind, 'unknown');
});

await test('§5.1: id_from en el alta: client lleva id aleatorio, desconocido nunca lo manda', () => {
  const d = L.parseDiscovery(D6);
  const schema = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } };
  const tags = L.collection(d, 'tags'), notes = L.collection(d, 'notes'), plain = L.collection(d, 'plain');
  same([tags.idFrom, notes.idFrom, plain.idFrom], ['client', 'unknown', null]);
  assert.match(L.createSkeleton(tags, schema).id, /^[0-9a-f-]{36}$/);
  assert.ok(!('id' in L.createSkeleton(notes, schema)) && !('id' in L.createSkeleton(plain, schema)));
  same(L.createPayload(notes, { id: 'a', name: 'b' }), { name: 'b' });
  same(L.createPayload(tags, { id: 'a', name: 'b' }), { id: 'a', name: 'b' });
  same(L.createPayload(plain, { id: 'a', name: 'b' }), { id: 'a', name: 'b' }, 'sin id_from se manda lo escrito: el 422 lo explica el servidor');
});

await test('§1.2 y §11.6: inherit solo con la extensión y el texto que implementa; from desconocido es hidden', () => {
  assert.equal(L.collection(L.parseDiscovery(D6), 'tags').inherit.length, 1);
  assert.equal(L.collection(L.parseDiscovery({ ...D6, restep: '1.1' }), 'tags').inherit.length, 0, 'otra versión: se ignora');
  assert.equal(L.collection(L.parseDiscovery({ ...D6, extensions: ['actions'] }), 'tags').inherit.length, 0, 'sin la extensión: se ignora');
  same(L.parseDiscovery({ ...D6, restep: '1.0', profiles: ['core', 'query', 'sync'] }).experimentalIgnored, ['sync', 'inherit']);
  same(L.parseDiscovery(D6).experimentalIgnored, []);
  same(L.inheritedFrom(undefined, 'rate'), { kind: 'own' });
  same(L.inheritedFrom({ rate: { from: 'default' } }, 'rate'), { kind: 'default' });
  same(L.inheritedFrom({ rate: { from: { href: '/c/2' } } }, 'rate'), { kind: 'href', href: '/c/2' });
  for (const from of ['hidden', 'upstream', { uri: 'x' }, 7]) same(L.inheritedFrom({ rate: { from } }, 'rate'), { kind: 'hidden' });
});

await test('§3: esquemas de enlace; + en la consulta como %2B; relación a una subcolección por href', () => {
  assert.ok(L.allowedScheme('https://x.example/a', 'http://localhost:1/') && L.allowedScheme('http://localhost:2/', 'http://localhost:1/'));
  assert.ok(!L.allowedScheme('http://x.example/', 'https://api.example/') && !L.allowedScheme('file:///etc/passwd', 'http://localhost:1/')
    && !L.allowedScheme('data:application/json,{}', 'https://api.example/'));
  assert.match(L.buildQuery({ ...L.emptyQuery(), filters: [{ field: 'at', op: 'ge', value: '2026-11-12T09:30:00+02:00' }] }), /2026-11-12T09%3A30%3A00%2B02%3A00/);
  const d = L.parseDiscovery(D6);
  const rel = { relations: [{ name: 'review', to: ['reviews'], many: false, path: null }] };
  same(L.relationLinks(d, rel, [], { review: { id: '3', href: '/api/tags/7/reviews/3' } }, 'https://h.example/api/')[0].links.map((l) => l.path), ['/tags/7/reviews/3']);
  same(L.relationLinks(d, rel, [], { review: { id: '3' } })[0].links.map((l) => l.path), [null]);
});

await test('pickTranslation y parseAcceptLanguage: nunca inventa traducciones (§3)', () => {
  const name = { en: 'Eraser', 'en-gb': 'Rubber', 'es-es': 'Goma de borrar', 'es-mx': 'Goma' };
  same(L.pickTranslation(name, ['es-MX']), ['es-mx', 'Goma']);
  same(L.pickTranslation(name, ['en-GB-oed']), ['en-gb', 'Rubber']);
  same(L.pickTranslation(name, ['es']), ['es-es', 'Goma de borrar'], 'otra variante del mismo idioma antes que otro idioma');
  same(L.pickTranslation(name, ['fr']), ['en', 'Eraser']);
  assert.equal(L.pickTranslation({}, ['es']), null);
  same(L.parseAcceptLanguage('en;q=0.5, es-MX, *, fr;q=0'), ['es-mx', 'en']);
});

await test('parseLinks y resourceMetadata', () => {
  const links = L.parseLinks('<https://w3id.org/restep/1/core>; rel="profile", </disc.json>; rel="service-desc"; type="application/json", </openapi>; rel=service-desc');
  same(links.map((l) => [l.href, l.rel, l.type]), [['https://w3id.org/restep/1/core', ['profile'], null], ['/disc.json', ['service-desc'], 'application/json'], ['/openapi', ['service-desc'], null]]);
  same(L.parseLinks(null), []);
  assert.equal(L.resourceMetadata('Bearer realm="restep", resource_metadata="http://x/.well-known/oauth-protected-resource"'), 'http://x/.well-known/oauth-protected-resource');
  assert.equal(L.resourceMetadata(null), null);
});

await test('toCurl: comillas escapadas, -g con corchetes y el token oculto', () => {
  const c = L.toCurl({ method: 'PATCH', url: 'http://x/books/7', headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': '"ab"', Authorization: 'Bearer s3cr3t' }, body: JSON.stringify({ title: "L'ombra" }) });
  assert.equal(c, `curl -i -X PATCH 'http://x/books/7' -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "ab"' -H "Authorization: Bearer $RESTEP_TOKEN" --data-raw '{"title":"L'\\''ombra"}'`);
  assert.ok(!c.includes('s3cr3t'));
  assert.equal(L.toCurl({ url: 'http://x/books?filter[price][le]=20' }), `curl -i -g 'http://x/books?filter[price][le]=20'`);
});

await test('problemHint e isProblem (§5.4)', () => {
  assert.match(L.problemHint({ code: 'unsupported_parameter', status: 400 }), /quítalo/);
  assert.match(L.problemHint({ code: 'invalid_parameter', status: 400 }), /corrígelo/);
  assert.match(L.problemHint({ code: 'algo_nuevo', status: 409 }), /petición/, 'código desconocido: según la clase del estado');
  assert.match(L.problemHint({ code: 'otro', status: 502 }), /servidor/);
  assert.ok(L.isProblem('application/problem+json; charset=utf-8', { code: 'x' }));
  assert.ok(!L.isProblem('text/html', '<html>'));
  assert.match(LE.problemHint({ code: 'unsupported_parameter', status: 400 }), /remove it from the request/);
  assert.match(LE.problemHint({ code: 'invalid_parameter', status: 400 }), /fix it/);
  assert.equal(LE.problemHint({ code: 'algo_nuevo', status: 409 }), 'Error in the request.');
  assert.equal(LE.problemHint({ code: 'otro', status: 502 }), 'Server error.');
  assert.equal(LE.problemHint({ code: 'constructor', status: 400 }), 'Error in the request.', 'un código no es una propiedad heredada');
});

await test('idioma: setLang sigue a <html lang>, con el inglés por defecto', () => {
  assert.equal(L.lang, 'es');
  assert.equal(LE.lang, 'en');
  const x = loadLogic('es-ES');
  assert.equal(x.lang, 'es');
  assert.equal(x.setLang('fr'), 'en', 'un idioma sin diccionario cae al inglés');
  assert.equal(x.setLang(''), 'en');
  // Sin documento, la lógica arranca en inglés; con documento, toma su lang.
  const box = { URL, URLSearchParams, crypto: globalThis.crypto, document: { documentElement: { lang: 'es' } } };
  box.globalThis = box;
  vm.runInNewContext(I18N_SRC, box);
  vm.runInNewContext(LOGIC_SRC, box);
  assert.equal(box.RestepLogic.lang, 'es');
});

await test('idioma: textos de la lógica en los dos idiomas', () => {
  assert.equal(L.opLabel('le'), '≤ menor o igual');
  assert.equal(LE.opLabel('le'), '≤ less or equal');
  assert.equal(LE.opLabel('constructor'), null);
  same(LE.valueControl({ type: 'number', values: [] }, 'null').options, [['true', 'yes: absent or null'], ['false', 'no: has a value']]);
  same(L.valueControl({ type: 'number', values: [] }, 'null').options, [['true', 'sí: ausente o null'], ['false', 'no: tiene valor']]);
  assert.equal(LE.valueControl({ type: 'decimal', values: [] }, 'le').hint, 'Exact decimal, with a point: 18.50');
  assert.equal(L.valueControl({ type: 'decimal', values: [] }, 'le').hint, 'Decimal exacto, con punto: 18.50');
  assert.match(LE.valueControl({ type: 'string', values: [] }, 'in').hint, /Comma-separated/);
  assert.throws(() => LE.expandTemplate('/a/{x}', []), /A value is missing for the template \/a\/\{x\}/);
  assert.equal(LE.t('itemsOnPage', 1), '1 item on this page');
  assert.equal(L.t('itemsOnPage', 2), '2 elementos en esta página');
  assert.equal(LE.t('days', 1), '1 day');
  assert.equal(L.t('days', 7), '7 días');
  assert.equal(LE.t('no-existe'), 'no-existe', 'una clave que falta se ve tal cual');
});

await test('diccionario: inglés y español con las mismas claves, y todas las que usa el código', () => {
  const D = (() => { const b = {}; b.globalThis = b; vm.runInNewContext(I18N_SRC, b); return b.RestepI18n; })();
  const shape = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'object' ? Object.keys(v).sort() : typeof v]));
  same(Object.keys(D).sort(), ['en', 'es']);
  assert.deepEqual(shape(D.es), shape(D.en));
  for (const lang of ['en', 'es']) for (const [k, v] of Object.entries(D[lang])) {
    if (typeof v === 'function') assert.equal(typeof v(1, 2), 'string', `${lang}.${k}`);
    if (typeof v === 'string' && !k.endsWith('Html')) assert.doesNotMatch(v, /[<>]/, `${lang}.${k}: texto plano sin marcado`);
  }
  const code = ['explorer.js', 'explorer-logic.js'].map((f) => published(`explorer/${f}`) ?? '').join('\n');
  const used = new Set([...code.matchAll(/\bt\('([A-Za-z0-9]+)'/g)].map((m) => m[1]));
  // Claves elegidas con un ternario dentro de t(...).
  for (const k of ['exact', 'estimated', 'onItem', 'onColl', 'total', 'totalAbout', 'relEmpty', 'relAbsent']) used.add(k);
  const missing = [...used].filter((k) => !(k in D.en) || !(k in D.es));
  assert.deepEqual(missing, [], 'claves que usa el código y faltan en el diccionario');
  assert.ok(used.size > 150, `solo ${used.size} claves: ¿ha cambiado la forma de llamar a t?`);
});

// ── 2. Integración con el servidor de referencia ──────────────────────────────
// La copia lleva CORS: lo que necesita una API para que el explorador la use desde otro origen.
const CORS = `
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Location, Link, Allow, WWW-Authenticate, Retry-After, Idempotent-Replayed, Preference-Applied, Content-Language, Deprecation, Sunset, Accept-Patch',
};
const PREFLIGHT = {
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key, Prefer, Accept-Language',
  'Access-Control-Max-Age': '600',
};
createServer((req, res) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) { res.writeHead(204, PREFLIGHT); return res.end(); }
  return handle(req, res).catch((e) => {`;
const ORIGINAL = 'createServer((req, res) => handle(req, res).catch((e) => {';
const END_ORIGINAL = "  if (!res.headersSent) problem(res, e, req);\n}))";
assert.ok(SERVER.includes(ORIGINAL) && SERVER.includes(END_ORIGINAL), 'el servidor de referencia ha cambiado: actualiza el parche CORS de test.mjs');
const dir = mkdtempSync(join(tmpdir(), 'restep-explorer-'));
const serverFile = join(dir, 'restep-server-cors.mjs');
writeFileSync(serverFile, SERVER.replace(ORIGINAL, CORS).replace(END_ORIGINAL, "  if (!res.headersSent) problem(res, e, req);\n});\n})"));

const procs = [];
// Las páginas, servidas desde public/ con la CSP como cabecera HTTP, como en producción.
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const SERVED = /^\/(explorer\/|es\/explorador\/|favicon\.svg$|favicon\.ico$|apple-touch-icon\.png$)/;
const page = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, PAGE).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(PUBLIC, path));
  if (!SERVED.test(path) || !file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  res.end(readFileSync(file));
});
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  for (const p of procs) p.kill();
  page.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on('exit', cleanup);

async function startApi() {
  const p = spawn(process.execPath, [serverFile], { env: { ...process.env, PORT: String(API_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('Restep 1')) resolve(); });
    p.on('exit', (c) => reject(new Error(`el servidor de referencia salió con ${c}: ${err}`)));
    setTimeout(() => reject(new Error(`el servidor de referencia no arrancó en ${API_PORT}: ${err}`)), 8000);
  });
}

try {
  await startApi();
  await new Promise((r, j) => page.listen(PAGE_PORT, r).on('error', j));
} catch (e) {
  console.error(`No se pudo arrancar: ${e.message}`);
  process.exit(2);
}

const api = async (method, path, { body, headers = {} } = {}) => {
  const res = await fetch(L.joinRoot(API, path), { method, body, headers: { Accept: 'application/json', Origin: PAGE.slice(0, -1), ...headers } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
};

// ── Páginas construidas ──────────────────────────────────────────────────────
const PAGE_HTML = { en: await (await fetch(EN_PAGE)).text(), es: await (await fetch(ES_PAGE)).text() };
const attrsOf = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => Object.fromEntries(
  [...m[1].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? ''])));
const metaContent = (html, key) => attrsOf(html, 'meta').find((a) => a.property === key || a.name === key)?.content;
const linkHref = (html, rel, extra = {}) => attrsOf(html, 'link').find((a) => a.rel === rel && Object.entries(extra).every(([k, v]) => a[k] === v))?.href;

await test('páginas servidas con la CSP como cabecera; recursos compartidos en /explorer/', async () => {
  for (const url of [EN_PAGE, ES_PAGE, ...ASSETS.map((a) => `${PAGE}/explorer/${a}`)]) {
    const res = await fetch(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-security-policy'), CSP);
  }
});

for (const lang of ['en', 'es']) {
  const html = PAGE_HTML[lang];
  const other = lang === 'en' ? 'es' : 'en';
  const self = `https://restep.wubytes.com${PAGES[lang].path}`;
  await test(`${lang}: nada en línea (ni <script> sin src, ni <style>, ni style=, ni on*=)`, () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="\/explorer\/[\w-]+\.js"/, `script sin src local: <script${m[1]}>`);
      assert.equal(m[2].trim(), '', 'un script con src no lleva cuerpo');
    }
    assert.doesNotMatch(html, /<style\b/i, 'ningún <style>');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'ningún atributo style=');
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, 'ningún manejador on*= en el marcado');
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i, 'la CSP va en la cabecera, no en un meta');
    assert.doesNotMatch(html, /\{\{|\}\}/, 'sin marcadores de plantilla');
  });
  await test(`${lang}: solo recursos propios; precarga no hace falta (scripts clásicos, sin módulos)`, () => {
    assert.doesNotMatch(html, /type="module"|import\(/, 'si un día hay módulos ES, cada página necesita <link rel="modulepreload"> de todo el grafo');
    const scripts = attrsOf(html, 'script').map((a) => a.src);
    same(scripts, ASSETS.filter((a) => a.endsWith('.js')).map((a) => `/explorer/${a}`));
    same(attrsOf(html, 'script').map((a) => 'defer' in a), [false, true, true, true], 'el tema sin defer, para no parpadear; el resto con defer y en orden');
    assert.equal(linkHref(html, 'stylesheet'), '/explorer/explorer.css');
    assert.doesNotMatch(html, /@import|fonts\.googleapis|fonts\.gstatic|cdn\./i, 'ni fuentes ni CDN');
    for (const a of [...attrsOf(html, 'link'), ...attrsOf(html, 'script')]) {
      const u = a.href ?? a.src ?? '';
      if (['canonical', 'alternate'].includes(a.rel)) continue;
      assert.ok(u.startsWith('/'), `recurso que no es del propio sitio: ${u}`);
    }
  });
  await test(`${lang}: lang, título, descripción, canonical, hreflang, og:* y favicon`, () => {
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.match(html, /<title>Restep Explorer: [^<]+<\/title>/);
    assert.ok((metaContent(html, 'description') ?? '').length > 80);
    assert.equal(linkHref(html, 'canonical'), self);
    assert.equal(linkHref(html, 'alternate', { hreflang: 'en' }), 'https://restep.wubytes.com/explorer/');
    assert.equal(linkHref(html, 'alternate', { hreflang: 'es' }), 'https://restep.wubytes.com/es/explorador/');
    assert.equal(linkHref(html, 'alternate', { hreflang: 'x-default' }), 'https://restep.wubytes.com/explorer/');
    assert.equal(metaContent(html, 'og:url'), self);
    assert.equal(metaContent(html, 'og:image'), `https://restep.wubytes.com/${lang === 'en' ? 'og.png' : 'og-es.png'}`);
    assert.equal(metaContent(html, 'og:locale'), lang === 'en' ? 'en_US' : 'es_ES');
    for (const k of ['og:type', 'og:title', 'og:description', 'og:image:alt', 'og:site_name']) assert.ok(metaContent(html, k), k);
    assert.equal(linkHref(html, 'icon', { type: 'image/svg+xml' }), '/favicon.svg');
    assert.equal(linkHref(html, 'icon', { sizes: '32x32' }), '/favicon.ico');
    assert.equal(linkHref(html, 'apple-touch-icon'), '/apple-touch-icon.png');
  });
  await test(`${lang}: cabecera del sitio con la nav, herramientas y cambio de idioma`, () => {
    const header = /<header class="site">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    const links = attrsOf(header, 'a');
    assert.equal(links[0].class, 'brand');
    assert.equal(links[0].href, lang === 'en' ? '/' : '/es/');
    same(links.slice(1).map((a) => a.href), lang === 'en'
      ? ['/', '/1/', '/tools/', '/explorer/', '/ref/restep-server.mjs', '/es/explorador/']
      : ['/es/', '/es/1/', '/es/herramientas/', '/es/explorador/', '/ref/restep-server.mjs', '/explorer/']);
    const current = links.find((a) => a['aria-current'] === 'page');
    assert.equal(current.href, PAGES[lang].path);
    const sw = links.find((a) => a.class === 'lang');
    assert.equal(sw.hreflang, other); assert.equal(sw.lang, other);
    assert.match(header, lang === 'en' ? />Español<\/a>/ : />English<\/a>/);
    assert.match(header, lang === 'en' ? />Tools<\/a>/ : />Herramientas<\/a>/);
    assert.match(html, lang === 'en' ? /<label for="api-url">API URL \(its root\)<\/label>/ : /<label for="api-url">URL de la API \(su raíz\)<\/label>/);
  });
}

await test('JS y CSS: sin innerHTML, sin estilos por atributo, sin eval ni emojis', () => {
  for (const a of ASSETS) {
    const src = published(`explorer/${a}`);
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${a}: sin emojis`);
    if (!a.endsWith('.js')) continue;
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, `${a}: nunca HTML desde cadenas`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]|\bstyle:\s*['"`]|cssText/, `${a}: style por atributo lo bloquea style-src 'self'`);
    assert.doesNotMatch(src, /\beval\(|new Function\(|setTimeout\(\s*['"`]/, `${a}: nada de evaluar cadenas`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]on/, `${a}: manejadores con addEventListener`);
  }
});

await test('CORS de la copia de prueba: preflight con las cabeceras de Restep', async () => {
  const res = await fetch(`${API}books/7`, { method: 'OPTIONS', headers: { Origin: PAGE.slice(0, -1), 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'if-match, content-type, idempotency-key, authorization' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  for (const h of ['If-Match', 'Idempotency-Key', 'Authorization']) assert.match(res.headers.get('access-control-allow-headers'), new RegExp(h));
  const get = await api('GET', '/books/7');
  assert.match(get.headers.get('access-control-expose-headers'), /ETag/);
});

let disc;
await test('descubrimiento real del servidor de referencia', async () => {
  const r = await api('GET', '/');
  assert.equal(r.status, 200);
  disc = L.parseDiscovery(r.json);
  assert.ok(!disc.coreOnly);
  // Las colecciones se leen del descubrimiento: la referencia va creciendo (authors, reviews…).
  same(disc.collections.map((c) => c.name), Object.keys(r.json.collections));
  assert.ok(['books', 'products', 'categories', 'authors', 'reviews'].every((n) => L.collection(disc, n)));
  assert.ok(L.has(disc, 'query') && L.has(disc, 'writes'));
  const p = L.collection(disc, 'products');
  same(p.languageMaps, ['name', 'description']);
  assert.equal(p.inherit[0].own, 'tax_rate_own');
  assert.ok(L.collection(disc, 'books').filters.some((f) => f.field === 'price' && f.type === 'decimal'));
});

await test('consulta construida con buildQuery, recuento y paginación con next', async () => {
  const books = L.collection(disc, 'books');
  const q = { ...L.emptyQuery(), filters: [{ field: 'price', op: 'le', value: '19.90' }], sort: [{ field: 'price', desc: true }], limit: '2', count: true, fields: ['title', 'price'] };
  let path = L.withQuery(books.path, L.buildQuery(q));
  const seen = [];
  let total;
  for (let i = 0; path && i < 10; i++) {
    const r = await api('GET', path);
    assert.equal(r.status, 200, `GET ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    total ??= r.json.total;
    seen.push(...r.json.items.map((it) => it.price));
    for (const it of r.json.items) same(Object.keys(it).filter((k) => !k.startsWith('_')).sort(), ['id', 'price', 'title']); // más _etag (7.2)
    path = r.json.next === null ? null : L.toApiPath(API, r.json.next);
    if (path) {
      const m = L.matchPath(disc, path);
      assert.equal(m.kind, 'collection');
      assert.ok(L.parseQuery(m.query).cursor, 'next lleva cursor');
    }
  }
  same(seen, ['19.90', '18.50', '16.90', '14.95', '12.00', '11.90']);
  assert.equal(total, 6);
});

await test('los parámetros no declarados fallan en voz alta y se leen como problem', async () => {
  const r = await api('GET', `/books?${L.buildQuery({ ...L.emptyQuery(), sort: [{ field: 'category', desc: false }] })}`);
  assert.equal(r.status, 400);
  assert.ok(L.isProblem(r.headers.get('content-type'), r.json));
  assert.equal(r.json.code, 'unsupported_parameter');
  assert.match(L.problemHint(r.json), /quítalo/);
});

await test('editar con mergeDiff e If-Match; If-Match viejo da 412', async () => {
  const products = L.collection(disc, 'products');
  const r = await api('GET', '/products/1');
  const etag = L.itemEtag(r.json, r.headers.get('etag'), false);
  assert.ok(etag);
  const original = L.editableCopy(products, r.json);
  assert.ok(!('tax_rate' in original) && !('id' in original) && !('_inherited' in original));
  const edited = structuredClone(original);
  edited.name['es-mx'] = 'Borrador';
  delete edited.name.en;
  edited.stock = 41;
  const diff = L.mergeDiff(original, edited, products.relations.map((x) => x.name));
  same(diff, { name: { en: null, 'es-mx': 'Borrador' }, stock: 41 });
  const p = await api('PATCH', '/products/1', { body: JSON.stringify(diff), headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': etag } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.name['es-mx'], 'Borrador');
  assert.ok(!('en' in p.json.name));
  const stale = await api('PATCH', '/products/1', { body: '{"stock":1}', headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': etag } });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'precondition_failed');
});

await test('crear con skeleton e Idempotency-Key: la repetición no duplica; luego borrar', async () => {
  const books = L.collection(disc, 'books');
  const body = L.skeleton(books.schemas.create);
  same(Object.keys(body).sort(), ['price', 'title']);
  Object.assign(body, { title: 'Prueba del explorador', price: '9.99' });
  const key = L.newIdempotencyKey();
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key };
  const a = await api('POST', '/books', { body: JSON.stringify(body), headers });
  const b = await api('POST', '/books', { body: JSON.stringify(body), headers });
  assert.equal(a.status, 201);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(a.json.id, b.json.id);
  const loc = L.toApiPath(API, a.headers.get('location'));
  assert.equal(loc, L.itemPath(books, [], a.json.id));
  const m = L.matchPath(disc, loc);
  assert.equal(m.kind, 'item');
  const del = await api('DELETE', loc, { headers: { 'If-Match': a.headers.get('etag') } });
  assert.equal(del.status, 204);
});

await test('relaciones del servidor de referencia: enlaces navegables', async () => {
  const products = L.collection(disc, 'products');
  const r = await api('GET', '/products/2');
  const [rel] = L.relationLinks(disc, products, [], r.json);
  assert.equal(rel.links[0].path, '/categories/1');
  const c = await api('GET', rel.links[0].path);
  assert.equal(c.status, 200);
});

await test('subcolección de la referencia: reviews bajo books, 404 sin padre y borrada con él', async () => {
  const books = L.collection(disc, 'books');
  const [sub] = L.subcollections(disc, books, [], '7');
  assert.equal(sub?.coll.name, 'reviews');
  assert.equal(sub.path, '/books/7/reviews');
  const m = L.matchPath(disc, sub.path);
  assert.equal(m.kind, 'collection'); assert.equal(m.coll.name, 'reviews'); same(m.values, ['7']);
  const r = await api('GET', sub.path);
  assert.equal(r.status, 200); assert.ok(r.json.items.length >= 1);
  const it = L.matchPath(disc, L.itemPath(m.coll, m.values, r.json.items[0].id));
  assert.equal(it.kind, 'item'); assert.equal(it.coll.name, 'reviews');
  assert.equal((await api('GET', L.subcollections(disc, books, [], 'no-existe')[0].path)).status, 404);
  const b = await api('POST', '/books', { body: JSON.stringify({ title: 'Con reseña', price: '3.00', category: 'poesia' }), headers: { 'Content-Type': 'application/json' } });
  const rpath = L.subcollections(disc, books, [], b.json.id)[0].path;
  const rv = await api('POST', rpath, { body: JSON.stringify({ rating: 4, text: 'Corta.' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(rv.status, 201, JSON.stringify(rv.json));
  assert.equal((await api('DELETE', `/books/${b.json.id}`)).status, 204);
  assert.equal((await api('GET', L.itemPath(m.coll, [b.json.id], rv.json.id))).status, 404);
});

await test('include de la referencia: profundidad 2, relación con href y polimórfica con type', async () => {
  const products = L.collection(disc, 'products');
  same(L.includePaths(disc, products), ['category', 'category.parent', 'category.showcase']);
  const r = await api('GET', L.withQuery(products.path, L.buildQuery({ ...L.emptyQuery(), include: ['category.parent'] })));
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((p) => p.category?.parent?.name), 'category.parent incluido');
  same(L.includePaths(disc, L.collection(disc, 'categories')), ['parent', 'showcase']); // sin include_depth: 1
  // highlight lleva a un elemento de la subcolección reviews: se enlaza por su href (§3).
  const books = L.collection(disc, 'books');
  const b = await api('GET', '/books/7?include=highlight');
  const hl = L.relationLinks(disc, books, [], b.json, API).find((x) => x.rel.name === 'highlight');
  assert.equal(hl.links[0].path, `/books/7/reviews/${b.json.highlight.id}`);
  const hm = L.matchPath(disc, hl.links[0].path);
  assert.equal(hm.kind, 'item'); assert.equal(hm.coll.name, 'reviews');
  assert.equal((await api('GET', hl.links[0].path)).json.text, b.json.highlight.text);
  // showcase apunta a books o a products: el type elige la colección.
  const cats = L.collection(disc, 'categories');
  const c = await api('GET', '/categories?include=showcase');
  const links = c.json.items.flatMap((it) => L.relationLinks(disc, cats, [], it, API).find((x) => x.rel.name === 'showcase').links);
  assert.ok(links.length && links.every((l) => ['books', 'products'].includes(l.to) && l.path === `/${l.to}/${l.id}`), JSON.stringify(links));
  for (const l of links) assert.equal((await api('GET', l.path)).status, 200);
});

await test('acciones de la referencia: GET de colección, POST de elemento con input, idempotentes', async () => {
  const products = L.collection(disc, 'products');
  const low = products.actions.find((a) => a.name === 'low_stock');
  assert.equal(low.on, 'collection'); assert.equal(low.method, 'GET');
  const l = await api('GET', `${products.path}:${low.name}`);
  assert.ok(l.json.items.every((x) => x.stock < 5));
  const restock = products.actions.find((a) => a.name === 'restock');
  assert.equal(restock.on, 'item'); assert.equal(restock.idempotent, false); assert.ok(restock.input?.properties?.quantity);
  same(L.skeleton(restock.input), { quantity: 0 });
  const item = await api('GET', '/products/1');
  const href = L.toApiPath(API, item.json._actions.restock.href);
  const after = await api('POST', href, { body: JSON.stringify({ quantity: 2 }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': L.newIdempotencyKey() } });
  assert.equal(after.json.stock, item.json.stock + 2);
  const authors = L.collection(disc, 'authors');
  const foc = authors.actions.find((a) => a.name === 'find_or_create');
  assert.ok(foc.idempotent && foc.on === 'collection');
  const send = () => api('POST', `${authors.path}:${foc.name}`, { body: JSON.stringify({ name: 'Autora del explorador' }), headers: { 'Content-Type': 'application/json' } });
  const a1 = await send(), a2 = await send();
  assert.equal(a1.status, 201); assert.equal(a2.status, 200); assert.equal(a1.json.id, a2.json.id);
  const cat = await api('GET', '/categories/2');
  const t = await api('POST', L.toApiPath(API, cat.json._actions.inherit_tax.href), { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(t.status, 200); assert.equal(t.json.tax_rate_own, null);
});

await test('recurso suelto del servidor de referencia (/shop): GET y PATCH con If-Match', async () => {
  assert.ok(disc.singletons.length >= 1, 'el descubrimiento de la referencia declara recursos sueltos');
  const sg = disc.singletons[0];
  assert.equal(L.matchPath(disc, sg.path).kind, 'singleton');
  const r = await api('GET', sg.path);
  assert.equal(r.status, 200);
  const etag = L.itemEtag(r.json, r.headers.get('etag'), false);
  const original = L.editableCopy({ schemas: sg.schemas }, r.json);
  const diff = L.mergeDiff(original, { ...original, name: `${original.name} (prueba)` });
  const p = await api('PATCH', sg.path, { body: JSON.stringify(diff), headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': etag } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.match(p.json.name, /\(prueba\)$/);
  const back = await api('PATCH', sg.path, { body: JSON.stringify({ name: original.name }), headers: { 'Content-Type': 'application/merge-patch+json' } });
  assert.equal(back.status, 200);
});

// ── 4. Navegador real (si lo hay), por el protocolo de DevTools ───────────────
// Carga las páginas servidas con la CSP en la cabecera y recoge todo lo que acabe en consola: avisos de
// seguridad (CSP), excepciones y console.error. Además escucha securitypolicyviolation desde dentro.
const CHROMES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
const hashFor = (path) => L.writeHash({ api: API, path });
const BROWSER_TESTS = ['en: colección con filtro', 'es: colección con filtro', 'en: elemento con mapas de idioma y relación', 'es: elemento con mapas de idioma y relación',
  'en: error problem+json', 'es: error problem+json', 'en: recurso suelto', 'es: recurso suelto', 'en: bienvenida, tema y enlace de idioma con el hash', 'ninguna violación de CSP ni error de JS en consola'];

async function startChrome() {
  const profile = mkdtempSync(join(dir, 'chrome-'));
  const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${DEVTOOLS_PORT}`, '--lang=en-US', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(p);
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
      const target = list.find((x) => x.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Chrome no abrió DevTools en ${DEVTOOLS_PORT}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const pending = new Map(), listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else for (const l of listeners) l(msg);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('error', () => reject(new Error('no se pudo conectar con DevTools')));
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const id = ++n; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    }));
  });
}

if (!chrome) {
  for (const name of BROWSER_TESTS) skip(`navegador: ${name}`, 'no hay Chrome ni Chromium; CHROME=/ruta para indicarlo');
} else {
  let page$;
  const consoleLog = [];
  try {
    page$ = await cdp(await startChrome());
    page$.on((msg) => {
      if (msg.method === 'Log.entryAdded') consoleLog.push({ kind: `log:${msg.params.entry.source}:${msg.params.entry.level}`, text: msg.params.entry.text, url: msg.params.entry.url });
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(msg.params.type)) {
        consoleLog.push({ kind: `console.${msg.params.type}`, text: msg.params.args.map((a) => a.value ?? a.description).join(' ') });
      }
      if (msg.method === 'Runtime.exceptionThrown') consoleLog.push({ kind: 'exception', text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text });
    });
    await page$.send('Log.enable');
    await page$.send('Runtime.enable');
    await page$.send('Page.enable');
    // Lo inyecta DevTools, no la página: no pasa por la CSP.
    await page$.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber));` });
  } catch (e) {
    page$ = null;
    for (const name of BROWSER_TESTS) skip(`navegador: ${name}`, e.message);
  }
  const evaluate = async (expr) => (await page$.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  const violations = [];
  // Abre una URL desde cero y espera a que el texto de la página cumpla la condición; devuelve el DOM.
  async function open(url, until) {
    await page$.send('Page.navigate', { url: 'about:blank' });
    await page$.send('Page.navigate', { url });
    const deadline = Date.now() + 15000;
    let text = '';
    for (;;) {
      text = (await evaluate('document.body ? document.body.textContent : ""').catch(() => '')) ?? '';
      if (until.test(text)) break;
      if (Date.now() > deadline) throw new Error(`no apareció ${until} en ${url}; texto:\n${text.slice(0, 1500)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const v = await evaluate('window.__csp || []');
    violations.push(...v.map((x) => `${url}: ${x}`));
    return evaluate('document.documentElement.outerHTML');
  }
  const bt = (name, fn) => (page$ ? test(`navegador: ${name}`, fn) : null);

  await bt('en: colección con filtro', async () => {
    const dom = await open(EN_PAGE + hashFor('/books?filter[category]=novela-negra&sort=-price&count=true'), /3 in total/);
    assert.match(dom, /La niebla de Portugalete/);
    assert.match(dom, /Lluvia sobre Deusto/);
    assert.doesNotMatch(dom, /Cuaderno de faros/, 'el filtro deja fuera la poesía');
    assert.match(dom, /3 items on this page · 3 in total/);
    assert.match(dom, /curl -i -g/);
    assert.match(dom, /Filters \(combined with AND\)/);
    assert.match(dom, /eq · = equal to/);
  });
  await bt('es: colección con filtro', async () => {
    const dom = await open(ES_PAGE + hashFor('/books?filter[category]=novela-negra&sort=-price&count=true'), /3 en total/);
    assert.match(dom, /La niebla de Portugalete/);
    assert.doesNotMatch(dom, /Cuaderno de faros/);
    assert.match(dom, /3 elementos en esta página · 3 en total/);
    assert.match(dom, /Filtros \(se combinan con Y\)/);
  });
  await bt('en: elemento con mapas de idioma y relación', async () => {
    const dom = await open(EN_PAGE + hashFor('/products/2'), /Edit \(PATCH\)/);
    assert.match(dom, /Lapicera/);
    assert.match(dom, /href="#api=http:\/\/localhost:8840\/&amp;path=\/categories\/1"/);
    assert.match(dom, /If-Match: <code>&quot;[0-9a-f]+&quot;<\/code>|If-Match: <code>"[0-9a-f]+"<\/code>/);
    assert.match(dom, /Delete \(DELETE\)/);
  });
  await bt('es: elemento con mapas de idioma y relación', async () => {
    const dom = await open(ES_PAGE + hashFor('/products/2'), /Editar \(PATCH\)/);
    assert.match(dom, /Lapicera/);
    assert.match(dom, /href="#api=http:\/\/localhost:8840\/&amp;path=\/categories\/1"/);
    assert.match(dom, /Borrar \(DELETE\)/);
  });
  await bt('en: recurso suelto', async () => {
    const dom = await open(EN_PAGE + hashFor('/shop'), /Edit \(PATCH\)/);
    assert.match(dom, /Singleton · \/shop/);
    assert.match(dom, /max_reservations/);
    assert.match(dom, /If-Match: <code>/);
    const home = await open(EN_PAGE + hashFor('/'), /Singletons \(1\)/);
    assert.match(home, /href="#api=http:\/\/localhost:8840\/&amp;path=\/shop"/);
    assert.match(home, /1\.0-draft\.6" is a draft/);
  });
  await bt('es: recurso suelto', async () => {
    const dom = await open(ES_PAGE + hashFor('/shop'), /Editar \(PATCH\)/);
    assert.match(dom, /Recurso suelto · \/shop/);
  });
  await bt('en: error problem+json', async () => {
    const dom = await open(EN_PAGE + hashFor('/books?sort=category'), /unsupported_parameter/);
    assert.match(dom, /remove it from the request/);
  });
  await bt('es: error problem+json', async () => {
    const dom = await open(ES_PAGE + hashFor('/books?sort=category'), /unsupported_parameter/);
    assert.match(dom, /quítalo de la petición/);
  });
  await bt('en: bienvenida, tema y enlace de idioma con el hash', async () => {
    let dom = await open(EN_PAGE, /Explore a Restep API/);
    assert.match(dom, /Theme: auto/);
    assert.match(dom, /id="other-lang" href="\/es\/explorador\/"/);
    await evaluate(`document.getElementById('theme').click()`);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    assert.match(await evaluate(`document.getElementById('theme').textContent`), /Theme: light/);
    // El tema elegido se aplica antes de pintar en la siguiente carga (explorer-theme.js).
    dom = await open(ES_PAGE + hashFor('/books'), /Página siguiente|No hay más páginas/);
    assert.match(dom, /<html lang="es" data-theme="light">/);
    assert.match(dom, /Tema: claro/);
    const sw = await evaluate(`document.getElementById('other-lang').getAttribute('href')`);
    assert.equal(sw, '/explorer/' + hashFor('/books'));
    await evaluate(`document.getElementById('theme').click(); document.getElementById('theme').click()`);
  });
  await bt('ninguna violación de CSP ni error de JS en consola', async () => {
    const csp = consoleLog.filter((e) => /Content Security Policy|Refused to/i.test(e.text) || e.kind.startsWith('log:security'));
    const js = consoleLog.filter((e) => e.kind === 'exception' || e.kind.startsWith('console.') || e.kind === 'log:javascript:error');
    assert.deepEqual(violations, [], 'securitypolicyviolation');
    assert.deepEqual(csp.map((e) => e.text), [], 'avisos de CSP en consola');
    assert.deepEqual(js.map((e) => `${e.kind}: ${e.text}`), [], 'errores de JS');
    // Lo único admitido en consola son los errores de red de las respuestas 4xx que se piden a propósito.
    const other = consoleLog.filter((e) => !(e.kind === 'log:network:error' && /status of 4\d\d/.test(e.text)));
    assert.deepEqual(other.map((e) => `${e.kind}: ${e.text}`), [], 'otros mensajes en consola');
  });
  page$?.close();
}

console.log('restep-explorer · pruebas\n' + results.join('\n'));
console.log(`\n${passed + failed + skipped} pruebas: ${passed} correctas, ${failed} fallidas, ${skipped} omitidas`);
// Chrome sigue escribiendo en su perfil hasta que sale: se espera a que salga antes de borrar el directorio.
await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); setTimeout(r, 5000); })));
cleanup();
process.exit(failed ? 1 : 0);
