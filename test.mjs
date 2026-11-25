// Tests of restep-explorer, on the built version (public/explorer/ and public/es/explorador/).
//   node tools/restep-explorer/build.mjs       (from projects/restep; the tests fail if it is not up to date)
//   node tools/restep-explorer/test.mjs
// 1. Pure logic: the published explorer-i18n.js and explorer-logic.js are evaluated in Node (vm), in English and Spanish.
// 2. Built pages: texts, metadata, links and nothing inline (no script, style, style= or on*=).
// 3. Integration: a copy of the reference server with CORS (in a temporary directory; the original
//    is not touched) on port 8840, and the pages served on 8841 with the CSP as an HTTP header.
// 4. Browser: if Chrome or Chromium is available, loads both pages headless through the
//    DevTools protocol (port 8842), inspects the DOM and checks there are no CSP violations or JS errors.
// Ports: 8840-8849.
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
// RESTEP_REF names another copy of the reference server to test against.
const SERVER = readFileSync(process.env.RESTEP_REF || join(here, 'vendor/restep-server.mjs'), 'utf8');
const API_PORT = 8840, PAGE_PORT = 8841, DEVTOOLS_PORT = 8842;
const API = `http://localhost:${API_PORT}/`, PAGE = `http://localhost:${PAGE_PORT}`;
const EN_PAGE = `${PAGE}/explorer/`, ES_PAGE = `${PAGE}/es/explorador/`;

let passed = 0, failed = 0, skipped = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok    ${name}`); }
  catch (e) { failed++; results.push(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
}
function skip(name, why) { skipped++; results.push(`  omit  ${name} (${why})`); }

// ── 0. The published version is up to date with the source ─────────────────────────
const built = buildFiles();
const published = (rel) => (existsSync(join(PUBLIC, rel)) ? readFileSync(join(PUBLIC, rel), 'utf8') : null);
// With RESTEP_EXPLORER_UNBUILT=1 a stale public/ is reported as omitted, not failed: the rest of the
// tests run on the build made in memory from the source, as they always do.
const stale = Object.keys(built).filter((rel) => published(rel) !== built[rel]);
if (stale.length && process.env.RESTEP_EXPLORER_UNBUILT === '1') skip('public/ is up to date with the source', `out of date: ${stale.join(', ')}; node tools/restep-explorer/build.mjs`);
else await test('public/ is up to date with the source (if not: node tools/restep-explorer/build.mjs)', () => {
  assert.deepEqual(stale, [], `out of date: ${stale.join(', ')}`);
});

// ── 1. Pure logic ─────────────────────────────────────────────────────────────
// The build made from the source is evaluated (equal to what is published when the test above passes):
// the dictionary and the logic, in a vm context without DOM.
const I18N_SRC = built['explorer/explorer-i18n.js'];
const LOGIC_SRC = built['explorer/explorer-logic.js'];
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
// Objects created inside the vm context have other prototypes: they are compared as JSON.
const same = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

// The example from section 4.2 of the specification, with a subcollection and an action.
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

await test('normalizeRoot: adds scheme and trailing slash, drops query and fragment', () => {
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

await test('joinRoot and toApiPath: paths relative to the root (§2) and body links (§3)', () => {
  assert.equal(L.joinRoot('https://e.com/api/', '/books'), 'https://e.com/api/books');
  assert.equal(L.joinRoot('http://localhost:8080/', '/books?sort=id'), 'http://localhost:8080/books?sort=id');
  assert.equal(L.toApiPath('https://e.com/api/', '/api/books?cursor=abc'), '/books?cursor=abc');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://e.com/api/orders/2001:cancel'), '/orders/2001:cancel');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://e.com/api/'), '/');
  assert.equal(L.toApiPath('https://e.com/api/', '/otra/books'), null, 'outside the root path');
  assert.equal(L.toApiPath('https://e.com/api/', 'https://evil.example/api/books'), null, 'otro origen');
  assert.equal(L.toApiPath('http://localhost:8080/', '/books?filter[price][le]=20&cursor=x.y'), '/books?filter[price][le]=20&cursor=x.y');
});

await test('hash: round trip, readable and without the token', () => {
  const st = { api: 'http://localhost:8080/', path: '/books?filter[price][le]=20&sort=-price' };
  const hsh = L.writeHash(st);
  assert.ok(hsh.startsWith('#api=http://localhost:8080/&path=/books?filter[price][le]=20%26sort=-price'), hsh);
  same(L.readHash(hsh), st);
  assert.equal(L.writeHash({ api: 'http://x/', path: '/' }), '#api=http://x/');
  same(L.readHash(''), { api: '', path: '' });
});

await test('parseDiscovery: the example of §4.2', () => {
  const d = L.parseDiscovery(SPEC_DOC);
  assert.equal(d.restep, '1.0');
  assert.ok(L.has(d, 'relations') && L.has(d, 'batch') && !L.has(d, 'oauth'));
  same(d.collections.map((c) => c.name), ['books', 'authors', 'reviews']);
  const b = L.collection(d, 'books');
  same(b.methods, ['GET', 'POST']);
  assert.equal(b.maxLimit, 50);
  assert.equal(b.count, 'estimated');
  same(b.filters.find((f) => f.field === 'category'), { field: 'category', type: 'enum', values: ['novela-negra', 'poesia'], ops: ['eq', 'in'], description: '', quantifier: null, required: false, group: false });
  same(b.relations.map((r) => [r.name, r.to, r.many, r.include, r.path]), [['author', ['authors'], false, true, null], ['reviews', ['reviews'], true, false, '/books/{id}/reviews']]);
  assert.equal(b.includeDepth, 2);
  same(b.actions, [{ name: 'reserve', on: 'item', safe: false, idempotent: true, method: 'POST', description: 'Aparta un ejemplar.', input: '/schemas/reserve.json', params: [], output: null }]);
  const r = L.collection(d, 'reviews');
  assert.ok(r.templated);
  same(r.vars, ['id']);
  assert.equal(L.collection(d, 'authors').methods, null, 'without methods: unknown (§4.3)');
  assert.ok(L.allows(null, 'DELETE') && !L.allows(['GET'], 'DELETE'));
  assert.equal(d.idempotencyTtl, 86400);
});

await test('parseDiscovery: what is not a discovery document is only core (§4.2)', () => {
  for (const doc of [null, [], { items: [] }, { restep: 1 }, 'restep']) {
    const d = L.parseDiscovery(doc);
    assert.ok(d.coreOnly);
    same(d.profiles, ['core']);
    assert.equal(d.collections.length, 0);
  }
  const d = L.parseDiscovery({ restep: '1.0', profiles: ['query'] });
  same(d.profiles, ['core', 'query'], 'core siempre');
});

await test('matchPath: root, collection, item, subcollection and unknown', () => {
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
  assert.equal(L.matchPath(d, '/books/7:reserve').kind, 'unknown', 'an action is not an item');
  assert.equal(L.matchPath(d, '/nada').kind, 'unknown');
});

await test('templates: expand and item path (§5.1)', () => {
  assert.equal(L.expandTemplate('/books/{id}/reviews', ['7']), '/books/7/reviews');
  assert.equal(L.expandTemplate('/a/{x}/b/{y}', ['1', 'a b']), '/a/1/b/a%20b');
  assert.throws(() => L.expandTemplate('/a/{x}', []), /Falta un valor/);
  const d = L.parseDiscovery(SPEC_DOC);
  assert.equal(L.itemPath(L.collection(d, 'reviews'), ['7'], '3'), '/books/7/reviews/3');
  assert.equal(L.itemPath(L.collection(d, 'books'), [], '7'), '/books/7');
});

await test('buildQuery: filters, order, fields, include, limit and count (§6)', () => {
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

await test('named filters: from discovery to the URL and back (§6.1)', () => {
  const disc = L.parseDiscovery({ restep: '1.0', profiles: ['core', 'query'], collections: { books: { path: '/books',
    filter: { price: { type: 'decimal', ops: ['le'] } },
    named_filters: { featured: { description: 'Destacados.' }, search: { type: 'string', description: 'Título.' } } } } });
  const books = L.collection(disc, 'books');
  same(books.named, [{ name: 'featured', type: null, values: [], description: 'Destacados.', default: false, required: false }, { name: 'search', type: 'string', values: [], description: 'Título.', default: false, required: false }]);
  const q = L.parseQuery('filter[featured]=&filter[search]=niebla&filter[price][le]=15&filter[search][eq]=x', books);
  same(q.named, { featured: '', search: 'niebla' });
  same(q.filters, [{ field: 'price', op: 'le', value: '15' }, { field: 'search', op: 'eq', value: 'x' }]); // with an operator it is not the named filter
  assert.equal(L.buildQuery({ ...L.emptyQuery(), named: { featured: '', search: 'niebla' } }), 'filter[featured]=&filter[search]=niebla');
  same(L.parseQuery('filter[featured]=').named, {}); // without the collection, one more filter
});
await test('parseQuery: inverse of buildQuery, keeps cursor and own parameters', () => {
  const qs = 'filter[category]=poesia&filter[price][ge]=10&sort=-rating,title&fields=title&limit=5&count=true&cursor=c1&mio=1&filter=price%20%3C%2020';
  const q = L.parseQuery(qs);
  same(q.filters, [{ field: 'category', op: 'eq', value: 'poesia' }, { field: 'price', op: 'ge', value: '10' }]);
  same(q.sort, [{ field: 'rating', desc: true }, { field: 'title', desc: false }]);
  same(q.fields, ['title']); assert.equal(q.limit, '5'); assert.equal(q.count, true); assert.equal(q.cursor, 'c1');
  same(q.extra, [['mio', '1'], ['filter', 'price < 20']]);
  const back = L.parseQuery(L.buildQuery(q, { keepCursor: true }));
  same(back, q);
});

await test('valueControl: controls by type and operator', () => {
  assert.equal(L.valueControl({ type: 'enum', values: ['a', 'b'] }, 'eq').kind, 'select');
  assert.equal(L.valueControl({ type: 'enum', values: ['a', 'b'] }, 'in').placeholder, 'a,b');
  same(L.valueControl({ type: 'number', values: [] }, 'null').options.map((o) => o[0]), ['true', 'false']);
  assert.equal(L.valueControl({ type: 'decimal', values: [] }, 'le').inputmode, 'decimal');
  assert.equal(L.valueControl({ type: 'date', values: [] }, 'ge').type, 'date');
  assert.equal(L.valueControl({ type: 'boolean', values: [] }, 'eq').kind, 'select');
});

await test('mergeDiff: minimal Merge Patch (RFC 7396) and whole relations (§5.1)', () => {
  const a = { title: 'A', price: '10.00', name: { en: 'Eraser', es: 'Goma' }, category: { id: '3', name: 'X' }, tags: ['a'], gone: 1 };
  const b = { title: 'A', price: '12.00', name: { en: 'Eraser', 'es-mx': 'Goma' }, category: { id: '1', name: 'X' }, tags: ['a', 'b'], nuevo: true };
  same(L.mergeDiff(a, b, ['category']), { gone: null, price: '12.00', name: { es: null, 'es-mx': 'Goma' }, category: { id: '1', name: 'X' }, tags: ['a', 'b'], nuevo: true });
  same(L.mergeDiff(a, a), {});
  assert.ok(L.jsonEqual({ x: 1, y: [1, { a: 2, b: 3 }] }, { y: [1, { b: 3, a: 2 }], x: 1 }));
});

await test('editableCopy and skeleton: without id, _ or inherited; required ones from the schema', () => {
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

await test('form (§4.3): skeleton with defaults in order; formFields with labels and options; action new', () => {
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
  const coll = { actions: [{ name: 'new', on: 'collection', method: 'GET', safe: true }] };
  same(L.newAction(disc, coll)?.name, 'new');
  same(L.newAction({ profiles: ['core'], extensions: [] }, coll), null);
  same(L.newAction(disc, { actions: [{ name: 'new', on: 'item', method: 'GET' }] }), null);
});

await test('Idempotency-Key: Structured Fields string with a UUID (§7.1)', () => {
  const k = L.newIdempotencyKey();
  assert.match(k, /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
  assert.notEqual(k, L.newIdempotencyKey());
  // Without randomUUID (insecure context): getRandomValues.
  const noUuid = loadLogic('es', { getRandomValues: (b) => globalThis.crypto.getRandomValues(b) });
  assert.match(noUuid.newIdempotencyKey(), /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
});

await test('itemEtag: _etag first; the header only on a full read (§7.2)', () => {
  assert.equal(L.itemEtag({ _etag: '"a"' }, '"b"', true), '"a"');
  assert.equal(L.itemEtag({}, '"b"', false), '"b"');
  assert.equal(L.itemEtag({}, '"b"', true), null);
});

await test('relationLinks and subcollections (§3, §8)', () => {
  const d = L.parseDiscovery(SPEC_DOC);
  const b = L.collection(d, 'books');
  const rl = L.relationLinks(d, b, [], { id: '7', author: { id: '3', name: 'Inés' } });
  same(rl.map((r) => [r.rel.name, r.sub ?? null, r.links.map((l) => l.path)]), [['author', null, ['/authors/3']], ['reviews', '/books/7/reviews', []]]);
  assert.ok(L.relationLinks(d, b, [], { id: '7', author: null })[0].empty);
  // Polymorphic relation: type names the collection (§3).
  const poly = { relations: [{ name: 'owner', to: ['authors', 'books'], many: false, path: null }] };
  same(L.relationLinks(d, poly, [], { owner: { id: '9', type: 'books' } })[0].links.map((l) => l.path), ['/books/9']);
  // reviews already appears as a relation; without it, it would be a subcollection.
  assert.equal(L.subcollections(d, b, [], '7').length, 0);
  const noRel = { ...b, relations: [] };
  same(L.subcollections(d, noRel, [], '7').map((s) => s.path), ['/books/7/reviews']);
});

// ── Draft 7: what §12.2 asks of a client (the fixture keeps its old name) ──────
const D6 = {
  restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions', 'inherit'], idempotency: { anonymous: false },
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

await test('§1.1: versions with a suffix; another major version or no grammar is neither Restep 1 nor core', () => {
  for (const v of ['1.0', '1.0-draft.6', '1.0-rc.1', '1.12']) assert.ok(!L.parseDiscovery({ ...D6, restep: v }).notRestep1, v);
  assert.ok(L.parseDiscovery(D6).draft && !L.parseDiscovery({ ...D6, restep: '1.0' }).draft);
  for (const v of ['2.0', '0.9', '1', '1.0-beta', '01.0', '1.0-draft.06', '1.0-draft']) {
    const d = L.parseDiscovery({ ...D6, restep: v });
    assert.ok(d.notRestep1 && !d.coreOnly, `${v}: not Restep 1 and core is not assumed`);
    same([d.profiles, d.collections.length, d.singletons.length], [[], 0, 0]);
  }
});

await test('§4.2: filters, named filters, actions and notices with unknown values are ignored', () => {
  const t6 = L.collection(L.parseDiscovery(D6), 'tags');
  same(t6.filters.map((f) => [f.field, f.ops]), [['name', ['eq']]]);
  same(t6.named.map((f) => f.name), ['on']);
  same(t6.actions.map((a) => a.name), ['ok']);
  same(t6.deprecations.map((x) => x.kind), ['field']);
  same(L.parseDiscovery(D6).deprecations.map((x) => x.kind), ['version']);
});

await test('§5.9: singletons; template ones without parent, or with a parent that does not exist, are ignored; matchPath recognizes them', () => {
  const d = L.parseDiscovery(D6);
  // sub (parent tags, a fixed path) is used now: only a template without parent, or a parent that names nothing, is ignored (C-76).
  same(d.singletons.map((x) => [x.name, x.path, x.methods]), [['me', '/me', ['GET', 'PATCH']], ['sub', '/x', null]]);
  const m = L.matchPath(d, '/me?fields=name');
  assert.equal(m.kind, 'singleton');
  assert.equal(m.singleton.name, 'me');
  assert.equal(m.query, 'fields=name');
  assert.equal(L.matchPath(d, '/y').kind, 'unknown');
});

await test('§5.1: id_from on creation: client carries a random id, unknown never sends it', () => {
  const d = L.parseDiscovery(D6);
  const schema = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } };
  const tags = L.collection(d, 'tags'), notes = L.collection(d, 'notes'), plain = L.collection(d, 'plain');
  same([tags.idFrom, notes.idFrom, plain.idFrom], ['client', 'unknown', null]);
  assert.match(L.createSkeleton(tags, schema).id, /^[0-9a-f-]{36}$/);
  assert.ok(!('id' in L.createSkeleton(notes, schema)) && !('id' in L.createSkeleton(plain, schema)));
  same(L.createPayload(notes, { id: 'a', name: 'b' }), { name: 'b' });
  same(L.createPayload(tags, { id: 'a', name: 'b' }), { id: 'a', name: 'b' });
  same(L.createPayload(plain, { id: 'a', name: 'b' }), { id: 'a', name: 'b' }, 'without id_from what was typed is sent: the server explains the 422');
});

await test('§1.2 and §11.6: inherit only with the extension and the text it implements; unknown from is hidden', () => {
  assert.equal(L.collection(L.parseDiscovery(D6), 'tags').inherit.length, 1);
  assert.equal(L.collection(L.parseDiscovery({ ...D6, restep: '1.1' }), 'tags').inherit.length, 0, 'another version: ignored');
  assert.equal(L.collection(L.parseDiscovery({ ...D6, extensions: ['actions'] }), 'tags').inherit.length, 0, 'without the extension: ignored');
  same(L.parseDiscovery({ ...D6, restep: '1.0', profiles: ['core', 'query', 'sync'] }).experimentalIgnored, ['sync', 'inherit']);
  same(L.parseDiscovery(D6).experimentalIgnored, []);
  same(L.inheritedFrom(undefined, 'rate'), { kind: 'own' });
  same(L.inheritedFrom({ rate: { from: 'default' } }, 'rate'), { kind: 'default' });
  same(L.inheritedFrom({ rate: { from: { href: '/c/2' } } }, 'rate'), { kind: 'href', href: '/c/2' });
  for (const from of ['hidden', 'upstream', { uri: 'x' }, 7]) same(L.inheritedFrom({ rate: { from } }, 'rate'), { kind: 'hidden' });
});

await test('§3: link schemes; + in the query as %2B; relation to a subcollection by href', () => {
  assert.ok(L.allowedScheme('https://x.example/a', 'http://localhost:1/') && L.allowedScheme('http://localhost:2/', 'http://localhost:1/'));
  assert.ok(!L.allowedScheme('http://x.example/', 'https://api.example/') && !L.allowedScheme('file:///etc/passwd', 'http://localhost:1/')
    && !L.allowedScheme('data:application/json,{}', 'https://api.example/'));
  assert.match(L.buildQuery({ ...L.emptyQuery(), filters: [{ field: 'at', op: 'ge', value: '2026-11-12T09:30:00+02:00' }] }), /2026-11-12T09%3A30%3A00%2B02%3A00/);
  const d = L.parseDiscovery(D6);
  const rel = { relations: [{ name: 'review', to: ['reviews'], many: false, path: null }] };
  same(L.relationLinks(d, rel, [], { review: { id: '3', href: '/api/tags/7/reviews/3' } }, 'https://h.example/api/')[0].links.map((l) => l.path), ['/tags/7/reviews/3']);
  same(L.relationLinks(d, rel, [], { review: { id: '3' } })[0].links.map((l) => l.path), [null]);
});

await test('pickTranslation and parseAcceptLanguage: never invents translations (§3)', () => {
  const name = { en: 'Eraser', 'en-gb': 'Rubber', 'es-es': 'Goma de borrar', 'es-mx': 'Goma' };
  same(L.pickTranslation(name, ['es-MX']), ['es-mx', 'Goma']);
  same(L.pickTranslation(name, ['en-GB-oed']), ['en-gb', 'Rubber']);
  same(L.pickTranslation(name, ['es']), ['es-es', 'Goma de borrar'], 'another variant of the same language before another language');
  same(L.pickTranslation(name, ['fr']), ['en', 'Eraser']);
  assert.equal(L.pickTranslation({}, ['es']), null);
  same(L.parseAcceptLanguage('en;q=0.5, es-MX, *, fr;q=0'), ['es-mx', 'en']);
});

await test('parseLinks and resourceMetadata', () => {
  const links = L.parseLinks('<https://w3id.org/restep/1/core>; rel="profile", </disc.json>; rel="service-desc"; type="application/json", </openapi>; rel=service-desc');
  same(links.map((l) => [l.href, l.rel, l.type]), [['https://w3id.org/restep/1/core', ['profile'], null], ['/disc.json', ['service-desc'], 'application/json'], ['/openapi', ['service-desc'], null]]);
  same(L.parseLinks(null), []);
  assert.equal(L.resourceMetadata('Bearer realm="restep", resource_metadata="http://x/.well-known/oauth-protected-resource"'), 'http://x/.well-known/oauth-protected-resource');
  assert.equal(L.resourceMetadata(null), null);
});

await test('toCurl: escaped quotes, -g with brackets and the token hidden', () => {
  const c = L.toCurl({ method: 'PATCH', url: 'http://x/books/7', headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': '"ab"', Authorization: 'Bearer s3cr3t' }, body: JSON.stringify({ title: "L'ombra" }) });
  assert.equal(c, `curl -i -X PATCH 'http://x/books/7' -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "ab"' -H "Authorization: Bearer $RESTEP_TOKEN" --data-raw '{"title":"L'\\''ombra"}'`);
  assert.ok(!c.includes('s3cr3t'));
  assert.equal(L.toCurl({ url: 'http://x/books?filter[price][le]=20' }), `curl -i -g 'http://x/books?filter[price][le]=20'`);
});

await test('problemHint and isProblem (§5.4)', () => {
  assert.match(L.problemHint({ code: 'unsupported_parameter', status: 400 }), /quítalo/);
  assert.match(L.problemHint({ code: 'invalid_parameter', status: 400 }), /corrígelo/);
  assert.match(L.problemHint({ code: 'algo_nuevo', status: 409 }), /petición/, 'unknown code: by the class of the status');
  assert.match(L.problemHint({ code: 'otro', status: 502 }), /servidor/);
  assert.ok(L.isProblem('application/problem+json; charset=utf-8', { code: 'x' }));
  assert.ok(!L.isProblem('text/html', '<html>'));
  assert.match(LE.problemHint({ code: 'unsupported_parameter', status: 400 }), /remove it from the request/);
  assert.match(LE.problemHint({ code: 'invalid_parameter', status: 400 }), /fix it/);
  assert.equal(LE.problemHint({ code: 'algo_nuevo', status: 409 }), 'Error in the request.');
  assert.equal(LE.problemHint({ code: 'otro', status: 502 }), 'Server error.');
  assert.equal(LE.problemHint({ code: 'constructor', status: 400 }), 'Error in the request.', 'a code is not an inherited property');
});

await test('language: setLang follows <html lang>, English by default', () => {
  assert.equal(L.lang, 'es');
  assert.equal(LE.lang, 'en');
  const x = loadLogic('es-ES');
  assert.equal(x.lang, 'es');
  assert.equal(x.setLang('fr'), 'en', 'a language without a dictionary falls back to English');
  assert.equal(x.setLang(''), 'en');
  // Without a document, the logic starts in English; with a document, it takes its lang.
  const box = { URL, URLSearchParams, crypto: globalThis.crypto, document: { documentElement: { lang: 'es' } } };
  box.globalThis = box;
  vm.runInNewContext(I18N_SRC, box);
  vm.runInNewContext(LOGIC_SRC, box);
  assert.equal(box.RestepLogic.lang, 'es');
});

await test('language: logic texts in both languages', () => {
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
  assert.equal(LE.t('no-existe'), 'no-existe', 'a missing key shows as it is');
});

await test('dictionary: English and Spanish with the same keys, and all those the code uses', () => {
  const D = (() => { const b = {}; b.globalThis = b; vm.runInNewContext(I18N_SRC, b); return b.RestepI18n; })();
  const shape = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'object' ? Object.keys(v).sort() : typeof v]));
  same(Object.keys(D).sort(), ['en', 'es']);
  assert.deepEqual(shape(D.es), shape(D.en));
  for (const lang of ['en', 'es']) for (const [k, v] of Object.entries(D[lang])) {
    if (typeof v === 'function') assert.equal(typeof v(1, 2), 'string', `${lang}.${k}`);
    if (typeof v === 'string' && !k.endsWith('Html')) assert.doesNotMatch(v, /[<>]/, `${lang}.${k}: plain text without markup`);
  }
  const code = ['explorer.js', 'explorer-logic.js'].map((f) => built[`explorer/${f}`] ?? '').join('\n');
  const used = new Set([...code.matchAll(/\bt\('([A-Za-z0-9]+)'/g)].map((m) => m[1]));
  // Keys chosen with a ternary inside t(...).
  for (const k of ['exact', 'estimated', 'onItem', 'onColl', 'total', 'totalAbout', 'relEmpty', 'relAbsent']) used.add(k);
  const missing = [...used].filter((k) => !(k in D.en) || !(k in D.es));
  assert.deepEqual(missing, [], 'keys the code uses that are missing from the dictionary');
  assert.ok(used.size > 150, `only ${used.size} keys: has the way of calling t changed?`);
});

// ── Draft 7: new client rules ─────────────────────────────────────────────────
const D7 = {
  restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions', 'inherit'],
  collections: {
    orders: {
      path: '/orders', methods: ['GET', 'POST'], item_methods: ['GET', 'PATCH', 'DELETE'],
      method_effects: { POST: ['charges'] }, item_method_effects: { PATCH: [], DELETE: [] },
      filter: { 'lines.sku': { type: 'string', ops: ['eq', 'nin'], quantifier: 'some' }, tags: { type: 'string', ops: ['eq'], quantifier: 'every' },
        title: { type: 'string', ops: ['prefix', 'contains', 'regex'], required: true }, at: { type: 'localdatetime', ops: ['ge'] }, tz: { type: 'timezone', ops: ['eq'] } },
      named_filters: { active: { default: true, description: 'Not archived.' }, mine: { description: 'Mine.' }, q: { type: 'string', default: true } },
      language_maps: { name_i18n: {} }, localized: { name: { source: 'name_i18n' }, bad: { from: 'x' } },
      upload: { media_types: ['image/*', 'application/pdf'], max_size: 100 },
      actions: {
        compare: { on: 'item', safe: true, idempotent: true, method: 'GET', params: { with: { type: 'string', required: true }, ids: { type: 'string', list: true } }, output: { type: 'object' } },
        pay: { on: 'item', safe: false, idempotent: false, effects: ['charges', 'external'] },
        new: { on: 'collection', safe: true, idempotent: true, method: 'GET', output: { type: 'object' } },
      },
    },
    stores: { path: '/stores', inherit: { rate: { own: 'rate_own', from: [], 'x-acme-note': 1 }, fee: { own: 'fee_own', from: [], switch: { field: 'takes', initial: true } }, tax: { own: 'tax_own', from: [], mode: 'x' } } },
    prefs: { path: '/stores/{store_id}/prefs', parent: 'stores', inherit_items: { from: ['chain'], key: ['publisher'] } },
    payments: { path: '/payments', methods: ['POST'] },
  },
  singletons: {
    settings: { path: '/stores/{store_id}/settings', parent: 'stores', actions: { reset: { safe: false, idempotent: true, effects: [] }, odd: { on: 'item', safe: true, idempotent: true } } },
    orphan: { path: '/x/{id}/y', parent: 'nothing' }, tpl: { path: '/u/{id}' },
  },
};

await test('§4.2 (B-06, C-21): core only after a 2xx without restep or a 404; another error assumes nothing', () => {
  assert.ok(L.discoveryOutcome(200, { items: [] }).coreOnly);
  assert.ok(L.discoveryOutcome(404, null).coreOnly);
  for (const st of [401, 403, 500, 503, 0]) { const d = L.discoveryOutcome(st, D7); assert.ok(d.unavailable && !d.coreOnly, String(st)); same(d.profiles, []); }
  assert.equal(L.discoveryOutcome(200, D7).restep, '1.0-draft.7');
  assert.ok(L.isRestep1(D7) && !L.isRestep1({ restep: '2.0' }) && !L.isRestep1({ items: [] }));
});

await test('§4.3, §11.1, §13.1 (C-32, C-115): effects of methods and actions, and when to confirm', () => {
  const o = L.collection(L.parseDiscovery(D7), 'orders');
  same(L.methodEffects(o.methodEffects, 'POST'), ['charges']);
  same(L.methodEffects(o.itemMethodEffects, 'DELETE'), []);
  same(L.methodEffects({}, 'DELETE'), ['destroys']);
  same(L.methodEffects({}, 'PATCH'), ['destroys', 'external', 'charges']);
  same(L.methodEffects({ PATCH: ['teleports'] }, 'PATCH'), ['destroys', 'external', 'charges'], 'an unknown value counts as all three');
  same(L.actionEffects(o.actions.find((a) => a.name === 'pay')), ['charges', 'external']);
  same(L.actionEffects(o.actions.find((a) => a.name === 'new')), [], 'a safe action without effects');
  same(L.actionEffects({ safe: false }), ['destroys', 'external', 'charges']);
  same(L.actionEffects({ safe: true, effects: ['teleports'] }), ['destroys', 'external', 'charges'], 'an unknown value counts as all three, also on a safe action');
  assert.ok(L.needsConfirm(L.actionEffects({ safe: true, effects: ['teleports'] }), { safe: true, trusted: true }));
  assert.ok(L.needsConfirm([], {}) && !L.needsConfirm([], { trusted: true }) && L.needsConfirm(['charges'], { trusted: true }));
  assert.ok(!L.needsConfirm([], { safe: true }) && L.needsConfirm(['charges'], { safe: true, trusted: true }));
  for (const lang of [L, LE]) assert.match(lang.t('confirmEffects', 'POST /x', 'charges'), /POST \/x/);
});

await test('§6.1 (C-80, C-83, C-86): quantifier, new operators and types, default and required filters', () => {
  const o = L.collection(L.parseDiscovery(D7), 'orders');
  same(o.filters.map((f) => [f.field, f.ops, f.quantifier, f.required]), [['lines.sku', ['eq', 'nin'], 'some', false], ['title', ['prefix', 'contains'], null, true], ['at', ['ge'], null, false], ['tz', ['eq'], null, false]]);
  same(o.named.map((f) => [f.name, f.default]), [['active', true], ['mine', false], ['q', false]], 'default only on a switch');
  const q = L.parseQuery('filter[active]=false&filter[title][prefix]=La', o);
  same(q.named, { active: 'false' });
  assert.equal(L.buildQuery(q), 'filter[title][prefix]=La&filter[active]=false');
  assert.equal(LE.opLabel('nin'), 'not in the list');
  assert.equal(L.opLabel('contains'), 'contiene');
  assert.equal(L.valueControl(o.filters[2], 'ge').placeholder, '2027-03-30T19:00:00');
  assert.equal(L.valueControl(o.filters[3], 'eq').placeholder, 'Europe/Madrid');
  assert.equal(L.valueControl({ type: 'duration', values: [] }, 'eq').placeholder, 'PT1.5S');
  assert.equal(L.valueControl({ type: 'enum', values: ['a', 'b'] }, 'nin').kind, 'input');
});

await test('§3, §5.1 (C-19, C-48): localized fields are read-only; uploads by type and size', () => {
  const o = L.collection(L.parseDiscovery(D7), 'orders');
  same(o.localized, { name: 'name_i18n' });
  same(L.editableCopy(o, { id: '1', name: 'Goma', name_i18n: { es: 'Goma' }, qty: 2 }), { name_i18n: { es: 'Goma' }, qty: 2 });
  assert.ok(!('name' in L.createSkeleton(o, { type: 'object', required: ['name', 'qty'], properties: { name: { type: 'string' }, qty: { type: 'integer' } } })));
  same(o.upload, { mediaTypes: ['image/*', 'application/pdf'], maxSize: 100, multipart: false });
  assert.equal(L.uploadProblem(o.upload, { type: 'image/png', size: 10 }), null);
  assert.equal(L.uploadProblem(o.upload, { type: 'application/pdf', size: 10 }), null);
  assert.equal(L.uploadProblem(o.upload, { type: 'text/plain', size: 10 }), 'type');
  assert.equal(L.uploadProblem(o.upload, { type: '', size: 10 }), 'type');
  assert.equal(L.uploadProblem(o.upload, { type: 'image/jpeg', size: 101 }), 'size');
  assert.equal(L.contentDisposition('cover.jpg'), 'attachment; filename="cover.jpg"');
  assert.equal(L.contentDisposition('portada ñ.jpg'), `attachment; filename="portada _.jpg"; filename*=UTF-8''portada%20%C3%B1.jpg`);
});

await test('§11.1 (C-113, C-116): params of a GET action and the action new', () => {
  const o = L.collection(L.parseDiscovery(D7), 'orders');
  const cmp = o.actions.find((a) => a.name === 'compare');
  same(cmp.params.map((p) => [p.name, p.list, p.required]), [['with', false, true], ['ids', true, false]]);
  assert.ok(cmp.output);
  same(L.actionQuery(cmp.params, { with: '12', ids: 'a,b' }), { query: 'with=12&ids=a,b' });
  same(L.actionQuery(cmp.params, { ids: 'a' }), { error: 'required', param: 'with' });
  same(L.actionQuery(cmp.params, { with: 'a b' }), { query: 'with=a%20b' });
  assert.equal(L.newAction(L.parseDiscovery(D7), o)?.name, 'new');
  same(L.newStart({ values: { qty: 1 }, schema: { type: 'object' } }), { values: { qty: 1 }, schema: { type: 'object' } });
  same(L.newStart({ qty: 1 }), { values: {}, schema: null }, 'a result without values gives nothing to start with');
});

await test('§5.9 (C-76, C-77): singletons under an item, and their actions', () => {
  const d = L.parseDiscovery(D7);
  same(d.singletons.map((x) => [x.name, x.parent, x.templated]), [['settings', 'stores', true]]);
  same(d.singletons[0].actions.map((a) => [a.name, a.on]), [['reset', 'singleton']], 'a singleton action carries no on');
  const m = L.matchPath(d, '/stores/7/settings');
  same([m.kind, m.singleton?.name, m.values], ['singleton', 'settings', ['7']]);
  assert.equal(L.matchPath(d, '/stores/7').kind, 'item');
});

await test('council round 1 (§4.3, §5.9, §6.1, §11.1): null without quantifier, 20.0, GET action without params, a singleton\'s method_effects', () => {
  const d = L.parseDiscovery({
    restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions'],
    collections: { books: { path: '/books', relations: { reviews: { to: 'reviews', many: true } },
      filter: { reviews: { type: 'string', ops: ['null'] }, formats: { type: 'string', ops: ['null'] }, pages: { type: 'integer', ops: ['eq'] } },
      actions: { ping: { on: 'item', safe: true, idempotent: true, method: 'GET' } } } },
    singletons: { profile: { path: '/profile', methods: ['GET', 'PATCH'], method_effects: { PATCH: ['external'] } },
      quiet: { path: '/quiet', method_effects: { PATCH: [] } }, loud: { path: '/loud' }, odd: { path: '/odd', method_effects: { PATCH: ['teleports'] } } },
  });
  const b = L.collection(d, 'books');
  // 1: null on a to-many relationship or a list field, declared without quantifier, is offered.
  same(b.filters.map((f) => [f.field, f.ops, f.quantifier]), [['reviews', ['null'], null], ['formats', ['null'], null], ['pages', ['eq'], null]]);
  assert.equal(L.valueControl(b.filters[0], 'null').kind, 'select');
  const q = L.parseQuery('filter[reviews][null]=true&filter[pages]=20.0', b);
  assert.equal(L.buildQuery(q), 'filter[reviews][null]=true&filter[pages]=20.0', '3: 20.0 goes as is');
  // 6: a GET action without params has none, and its query is empty.
  const ping = b.actions.find((a) => a.name === 'ping');
  same(ping.params, []);
  same(L.actionQuery(ping.params, { x: '1' }), { query: '' });
  // 8: a singleton's PATCH has its method_effects; undeclared or unknown, all three.
  const fx = (n) => L.methodEffects(L.singleton(d, n).methodEffects, 'PATCH');
  same(fx('profile'), ['external']);
  same(fx('quiet'), []);
  same(fx('loud'), ['destroys', 'external', 'charges']);
  same(fx('odd'), ['destroys', 'external', 'charges']);
  assert.ok(L.needsConfirm(fx('quiet'), {}) && !L.needsConfirm(fx('quiet'), { trusted: true }));
});

await test('council round 3 (§5.1, §6.1): create only from schemas.create with upload, JSON files as multipart, null on a group', () => {
  const d = L.parseDiscovery({
    restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'],
    collections: {
      scans: { path: '/scans', methods: ['POST'], upload: { media_types: ['image/*', 'application/json'] } },
      docs: { path: '/docs', methods: ['POST'], upload: { media_types: ['application/*'], multipart: true }, schemas: { create: { type: 'object' } } },
      raw: { path: '/raw', methods: ['POST'], upload: { media_types: ['application/*'] }, schemas: { create: { type: 'object' } } },
      books: { path: '/books', relations: { reviews: { to: 'reviews', many: true }, author: { to: 'authors' } },
        filter: { reviews: { type: 'string', ops: ['null'] }, author: { type: 'string', ops: ['null'] }, tags: { type: 'string', ops: ['in', 'null'], quantifier: 'some' },
          formats: { type: 'string', ops: ['null'], quantifier: 'some' } } },
    },
  });
  const [scans, docs, raw, books] = ['scans', 'docs', 'raw', 'books'].map((n) => L.collection(d, n));
  // 1: schemas.create announces creation from JSON; without it, a collection with upload only takes files.
  assert.ok(!L.createsFromJson(scans) && L.createsFromJson(docs) && L.createsFromJson(books));
  // 2: a JSON file goes as its bytes to an upload-only collection, and as multipart to one that also creates from JSON.
  const json = { type: 'application/json', size: 2 }, png = { type: 'image/png', size: 2 };
  assert.equal(L.uploadMode(scans, json), 'raw');
  assert.equal(L.uploadMode(docs, json), 'multipart');
  assert.equal(L.uploadMode(raw, json), 'none');
  assert.equal(L.uploadMode(docs, { type: 'application/pdf' }), 'raw');
  assert.equal(L.uploadMode(scans, png), 'raw');
  // 8 and 9: null on a list (with or without quantifier some) or a to-many relationship tests the whole group.
  same(books.filters.map((f) => [f.field, f.group]), [['reviews', true], ['author', false], ['tags', true], ['formats', true]]);
  same(L.valueControl(books.filters[2], 'null').options.map(([v]) => v), ['true', 'false']);
  assert.match(L.valueControl(books.filters[2], 'null').hint, /whole list|lista entera/);
  assert.equal(L.valueControl(books.filters[1], 'null').hint, undefined);
  // 5.1: the curl of an upload says what goes.
  const fd = new FormData();
  fd.append('file', new Blob(['{}'], { type: 'application/json' }), 'a.json');
  assert.match(L.toCurl({ method: 'POST', url: 'https://x.test/docs', body: fd }), /-F 'file=@a\.json;type=application\/json'/);
});

await test('Council, round 4 (§5.1, §6.1): */*, +json, filename on the file part and one null filter per group', () => {
  const d = L.parseDiscovery({
    restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'],
    collections: {
      any: { path: '/any', methods: ['POST'], upload: { media_types: ['*/*'] } },
      mixed: { path: '/mixed', methods: ['POST'], upload: { media_types: ['*/*'], multipart: true }, schemas: { create: { type: 'object' } } },
      ld: { path: '/ld', methods: ['POST'], upload: { media_types: ['application/ld+json'] }, schemas: { create: { type: 'object' } } },
      books: { path: '/books', relations: { reviews: { to: 'reviews', many: true }, author: { to: 'authors' } },
        filter: { reviews: { type: 'string', ops: ['null'] }, 'reviews.id': { type: 'string', ops: ['null'], quantifier: 'some' }, 'reviews.rating': { type: 'integer', ops: ['eq', 'null'], quantifier: 'some' },
          author: { type: 'string', ops: ['null'] }, 'author.name': { type: 'string', ops: ['null'] }, tags: { type: 'string', ops: ['in', 'null'], quantifier: 'some' } } },
    },
  });
  const [any, mixed, ld, books] = ['any', 'mixed', 'ld', 'books'].map((n) => L.collection(d, n));
  const json = { type: 'application/json', size: 2 };
  // 1a and 2: */* admits any typed file, JSON included, which goes as its bytes where the collection does not create from JSON.
  assert.equal(L.uploadProblem(any.upload, json), null);
  assert.equal(L.uploadProblem(any.upload, { type: 'text/plain', size: 2 }), null);
  assert.equal(L.uploadProblem(any.upload, { type: '', size: 2 }), 'type');
  assert.equal(L.uploadMode(any, json), 'raw');
  assert.equal(L.uploadMode(mixed, json), 'multipart');
  // 1b: a +json file is a file like any other: its bytes, also where the collection creates from JSON.
  assert.equal(L.uploadProblem(ld.upload, { type: 'application/ld+json', size: 2 }), null);
  assert.equal(L.uploadMode(ld, { type: 'application/ld+json', size: 2 }), 'raw');
  // 4b: the file part always carries a filename.
  assert.equal(L.multipartFileName({ name: 'a.json' }), 'a.json');
  assert.equal(L.multipartFileName({ name: '' }), 'file');
  assert.equal(L.multipartFileName(new Blob(['{}'])), 'file');
  // 5a: two null filters on one group, through a path too, are never sent.
  assert.equal(L.nullGroupClash(books, [{ field: 'reviews', op: 'null', value: 'true' }, { field: 'reviews.id', op: 'null', value: 'true' }]), 'reviews');
  assert.equal(L.nullGroupClash(books, [{ field: 'reviews.rating', op: 'null', value: 'false' }, { field: 'reviews', op: 'null', value: 'true' }]), 'reviews');
  assert.equal(L.nullGroupClash(books, [{ field: 'reviews', op: 'null', value: 'true' }, { field: 'reviews.rating', op: 'eq', value: '1' }, { field: 'tags', op: 'null', value: 'true' }]), null);
  assert.equal(L.nullGroupClash(books, [{ field: 'author', op: 'null', value: 'true' }, { field: 'author.name', op: 'null', value: 'true' }]), null, 'a to-one relationship is not a group');
  assert.match(L.t('nullTwice', 'reviews'), /reviews.*invalid_parameter/);
});

await test('§11.6 (C-25, C-131): unknown inherit members; inherited items read-only', () => {
  const d = L.parseDiscovery(D7);
  same(L.collection(d, 'stores').inherit.map((i) => [i.field, i.switchField]), [['rate', null], ['fee', 'takes']], 'an x- member is ignored; another unknown one makes the field not inherited');
  const prefs = L.collection(d, 'prefs');
  same(prefs.inheritItems, { from: ['chain'], key: ['publisher'], switchField: null });
  assert.equal(L.inheritedItemSource(prefs, { id: 'p1', _from: { href: '/chains/1/prefs/x' } }), '/chains/1/prefs/x');
  assert.equal(L.inheritedItemSource(prefs, { id: 'p2' }), null);
  assert.equal(L.inheritedItemSource(L.collection(d, 'stores'), { _from: { href: '/x' } }), null);
  const own = L.parseDiscovery({ ...D7, collections: { prefs: { ...D7.collections.prefs, inherit_items: { from: [], 'x-acme': 1 } } } });
  assert.ok(L.collection(own, 'prefs').inheritItems, 'an x- member is the server\'s own');
  const bad = L.parseDiscovery({ ...D7, collections: { prefs: { ...D7.collections.prefs, inherit_items: { from: [], mode: 'x' } } } });
  assert.equal(L.collection(bad, 'prefs').inheritItems, null, 'an unknown member: not inherited');
});

await test('§5.4 (C-63): hints for the new codes in both languages, and unknown codes by class', () => {
  for (const lang of [L, LE]) {
    for (const code of ['request_timeout', 'misdirected_request', 'too_early', 'bad_gateway', 'gateway_timeout']) assert.ok(lang.problemHint({ code, status: 400 }).length > 10, code);
    assert.equal(lang.problemHint({ code: 'http_418', status: 418 }), lang.t('hintClient'));
    assert.equal(lang.problemHint({ code: 'http_599', status: 599 }), lang.t('hintServer'));
  }
});

// ── 2. Integration with the reference server ──────────────────────────────
// The copy has CORS: what an API needs for the explorer to use it from another origin.
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
assert.ok(SERVER.includes(ORIGINAL) && SERVER.includes(END_ORIGINAL), 'the reference server has changed: update the CORS patch in test.mjs');
const dir = mkdtempSync(join(tmpdir(), 'restep-explorer-'));
const serverFile = join(dir, 'restep-server-cors.mjs');
writeFileSync(serverFile, SERVER.replace(ORIGINAL, CORS).replace(END_ORIGINAL, "  if (!res.headersSent) problem(res, e, req);\n});\n})"));

const procs = [];
// The pages, served from public/ with the CSP as an HTTP header, as in production.
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const SERVED = /^\/(explorer\/|es\/explorador\/|favicon\.svg$|favicon\.ico$|apple-touch-icon\.png$)/;
const page = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, PAGE).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(PUBLIC, path));
  // The explorer's own files come from the build made in memory; the rest (icons) from public/.
  const fresh = built[path.slice(1)];
  if (!SERVED.test(path) || !file.startsWith(PUBLIC) || (fresh === undefined && !existsSync(file))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  res.end(fresh ?? readFileSync(file));
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
    p.on('exit', (c) => reject(new Error(`the reference server exited with ${c}: ${err}`)));
    setTimeout(() => reject(new Error(`the reference server did not start on ${API_PORT}: ${err}`)), 8000);
  });
}

try {
  await startApi();
  await new Promise((r, j) => page.listen(PAGE_PORT, r).on('error', j));
} catch (e) {
  console.error(`Could not start: ${e.message}`);
  process.exit(2);
}

const api = async (method, path, { body, headers = {} } = {}) => {
  const res = await fetch(L.joinRoot(API, path), { method, body, headers: { Accept: 'application/json', Origin: PAGE.slice(0, -1), ...headers } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
};

// ── Built pages ──────────────────────────────────────────────────────
const PAGE_HTML = { en: await (await fetch(EN_PAGE)).text(), es: await (await fetch(ES_PAGE)).text() };
const attrsOf = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))].map((m) => Object.fromEntries(
  [...m[1].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? ''])));
const metaContent = (html, key) => attrsOf(html, 'meta').find((a) => a.property === key || a.name === key)?.content;
const linkHref = (html, rel, extra = {}) => attrsOf(html, 'link').find((a) => a.rel === rel && Object.entries(extra).every(([k, v]) => a[k] === v))?.href;

await test('pages served with the CSP as a header; shared resources in /explorer/', async () => {
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
  await test(`${lang}: nothing inline (no <script> without src, no <style>, no style=, no on*=)`, () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="\/explorer\/[\w-]+\.js"/, `script sin src local: <script${m[1]}>`);
      assert.equal(m[2].trim(), '', 'a script with src has no body');
    }
    assert.doesNotMatch(html, /<style\b/i, 'no <style>');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style= attribute');
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, 'no on*= handler in the markup');
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i, 'the CSP goes in the header, not in a meta');
    assert.doesNotMatch(html, /\{\{|\}\}/, 'no template placeholders');
  });
  await test(`${lang}: only own resources; no preload needed (classic scripts, no modules)`, () => {
    assert.doesNotMatch(html, /type="module"|import\(/, 'if ES modules ever appear, each page needs <link rel="modulepreload"> for the whole graph');
    const scripts = attrsOf(html, 'script').map((a) => a.src);
    same(scripts, ASSETS.filter((a) => a.endsWith('.js')).map((a) => `/explorer/${a}`));
    same(attrsOf(html, 'script').map((a) => 'defer' in a), [false, true, true, true], 'the theme without defer, to avoid flashing; the rest with defer and in order');
    assert.equal(linkHref(html, 'stylesheet'), '/explorer/explorer.css');
    assert.doesNotMatch(html, /@import|fonts\.googleapis|fonts\.gstatic|cdn\./i, 'ni fuentes ni CDN');
    for (const a of [...attrsOf(html, 'link'), ...attrsOf(html, 'script')]) {
      const u = a.href ?? a.src ?? '';
      if (['canonical', 'alternate'].includes(a.rel)) continue;
      assert.ok(u.startsWith('/'), `resource that is not from the site itself: ${u}`);
    }
  });
  await test(`${lang}: lang, title, description, canonical, hreflang, og:* and favicon`, () => {
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
  await test(`${lang}: site header with the nav, tools and language switch`, () => {
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

await test('JS and CSS: no innerHTML, no style attributes, no eval or emojis', () => {
  for (const a of ASSETS) {
    const src = built[`explorer/${a}`];
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${a}: sin emojis`);
    if (!a.endsWith('.js')) continue;
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, `${a}: never HTML from strings`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]|\bstyle:\s*['"`]|cssText/, `${a}: style by attribute is blocked by style-src 'self'`);
    assert.doesNotMatch(src, /\beval\(|new Function\(|setTimeout\(\s*['"`]/, `${a}: no evaluating strings`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]on/, `${a}: manejadores con addEventListener`);
  }
});

await test('CORS of the test copy: preflight with the Restep headers', async () => {
  const res = await fetch(`${API}books/7`, { method: 'OPTIONS', headers: { Origin: PAGE.slice(0, -1), 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'if-match, content-type, idempotency-key, authorization' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  for (const h of ['If-Match', 'Idempotency-Key', 'Authorization']) assert.match(res.headers.get('access-control-allow-headers'), new RegExp(h));
  const get = await api('GET', '/books/7');
  assert.match(get.headers.get('access-control-expose-headers'), /ETag/);
});

let disc;
await test('real discovery of the reference server', async () => {
  const r = await api('GET', '/');
  assert.equal(r.status, 200);
  disc = L.parseDiscovery(r.json);
  assert.ok(!disc.coreOnly);
  // The collections are read from discovery: the reference keeps growing (authors, reviews…).
  same(disc.collections.map((c) => c.name), Object.keys(r.json.collections));
  assert.ok(['books', 'products', 'categories', 'authors', 'reviews'].every((n) => L.collection(disc, n)));
  assert.ok(L.has(disc, 'query') && L.has(disc, 'writes'));
  const p = L.collection(disc, 'products');
  same(p.languageMaps, ['name', 'description']);
  // 1.2: inherit is used only under the draft whose text the explorer implements.
  if (L.implementsExperimental(r.json.restep)) assert.equal(p.inherit[0].own, 'tax_rate_own');
  else assert.equal(p.inherit.length, 0, `${r.json.restep}: inherit is ignored`);
  assert.ok(L.collection(disc, 'books').filters.some((f) => f.field === 'price' && f.type === 'decimal'));
});

await test('query built with buildQuery, count and pagination with next', async () => {
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
    for (const it of r.json.items) same(Object.keys(it).filter((k) => !k.startsWith('_')).sort(), ['id', 'price', 'title']); // plus _etag (7.2)
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

await test('undeclared parameters fail loudly and are read as problem', async () => {
  const r = await api('GET', `/books?${L.buildQuery({ ...L.emptyQuery(), sort: [{ field: 'category', desc: false }] })}`);
  assert.equal(r.status, 400);
  assert.ok(L.isProblem(r.headers.get('content-type'), r.json));
  assert.equal(r.json.code, 'unsupported_parameter');
  assert.match(L.problemHint(r.json), /quítalo/);
});

await test('edit with mergeDiff and If-Match; a stale If-Match gives 412', async () => {
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

await test('create with skeleton and Idempotency-Key: the repetition does not duplicate; then delete', async () => {
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

await test('reference server relations: navigable links', async () => {
  const products = L.collection(disc, 'products');
  const r = await api('GET', '/products/2');
  const [rel] = L.relationLinks(disc, products, [], r.json);
  assert.equal(rel.links[0].path, '/categories/1');
  const c = await api('GET', rel.links[0].path);
  assert.equal(c.status, 200);
});

await test('reference subcollection: reviews under books, 404 without a parent and deleted with it', async () => {
  const books = L.collection(disc, 'books');
  // reviews is reached through its relationship's path when books declares one (§9), otherwise as a bare subcollection.
  const reviewsPath = (id) => L.relationLinks(disc, books, [], { id }).find((r) => r.rel.name === 'reviews')?.sub
    ?? L.subcollections(disc, books, [], id).find((x) => x.coll.name === 'reviews')?.path;
  const sub = { coll: L.collection(disc, 'reviews'), path: reviewsPath('7') };
  assert.equal(sub?.coll.name, 'reviews');
  assert.equal(sub.path, '/books/7/reviews');
  const m = L.matchPath(disc, sub.path);
  assert.equal(m.kind, 'collection'); assert.equal(m.coll.name, 'reviews'); same(m.values, ['7']);
  const r = await api('GET', sub.path);
  assert.equal(r.status, 200); assert.ok(r.json.items.length >= 1);
  const it = L.matchPath(disc, L.itemPath(m.coll, m.values, r.json.items[0].id));
  assert.equal(it.kind, 'item'); assert.equal(it.coll.name, 'reviews');
  assert.equal((await api('GET', reviewsPath('no-existe'))).status, 404);
  const b = await api('POST', '/books', { body: JSON.stringify({ title: 'Con reseña', price: '3.00', category: 'poesia' }), headers: { 'Content-Type': 'application/json' } });
  const rpath = reviewsPath(b.json.id);
  const rv = await api('POST', rpath, { body: JSON.stringify({ rating: 4, text: 'Corta.' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(rv.status, 201, JSON.stringify(rv.json));
  assert.equal((await api('DELETE', `/books/${b.json.id}`)).status, 204);
  assert.equal((await api('GET', L.itemPath(m.coll, [b.json.id], rv.json.id))).status, 404);
});

await test('reference include: depth 2, relation with href and polymorphic with type', async () => {
  const products = L.collection(disc, 'products');
  same(L.includePaths(disc, products), ['category', 'category.parent', 'category.showcase']);
  const r = await api('GET', L.withQuery(products.path, L.buildQuery({ ...L.emptyQuery(), include: ['category.parent'] })));
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((p) => p.category?.parent?.name), 'category.parent incluido');
  same(L.includePaths(disc, L.collection(disc, 'categories')), ['parent', 'showcase']); // sin include_depth: 1
  // highlight leads to an item of the reviews subcollection: it is linked by its href (§3).
  const books = L.collection(disc, 'books');
  const b = await api('GET', '/books/7?include=highlight');
  const hl = L.relationLinks(disc, books, [], b.json, API).find((x) => x.rel.name === 'highlight');
  assert.equal(hl.links[0].path, `/books/7/reviews/${b.json.highlight.id}`);
  const hm = L.matchPath(disc, hl.links[0].path);
  assert.equal(hm.kind, 'item'); assert.equal(hm.coll.name, 'reviews');
  assert.equal((await api('GET', hl.links[0].path)).json.text, b.json.highlight.text);
  // showcase points to books or to products: the type chooses the collection.
  const cats = L.collection(disc, 'categories');
  const c = await api('GET', '/categories?include=showcase');
  const links = c.json.items.flatMap((it) => L.relationLinks(disc, cats, [], it, API).find((x) => x.rel.name === 'showcase').links);
  assert.ok(links.length && links.every((l) => ['books', 'products'].includes(l.to) && l.path === `/${l.to}/${l.id}`), JSON.stringify(links));
  for (const l of links) assert.equal((await api('GET', l.path)).status, 200);
});

await test('reference actions: collection GET, item POST with input, idempotent', async () => {
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
  // 11.1: an unsafe action on a collection answers 201 with Location or 204, never 200.
  assert.equal(a1.status, 201); assert.ok([201, 204].includes(a2.status), String(a2.status));
  if (a2.status === 201) assert.equal(a2.headers.get('location'), a1.headers.get('location'));
  const cat = await api('GET', '/categories/2');
  const t = await api('POST', L.toApiPath(API, cat.json._actions.inherit_tax.href), { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(t.status, 200); assert.equal(t.json.tax_rate_own, null);
});

await test('reference server singleton (/shop): GET and PATCH with If-Match', async () => {
  assert.ok(disc.singletons.length >= 1, 'the reference discovery declares singletons');
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

// ── 4. Real browser (if there is one), through the DevTools protocol ───────────────
// Loads the pages served with the CSP in the header and collects everything that ends up in the console: security
// warnings (CSP), exceptions and console.error. It also listens to securitypolicyviolation from the inside.
const CHROMES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = CHROMES.find((p) => existsSync(p));
const hashFor = (path) => L.writeHash({ api: API, path });
const BROWSER_TESTS = ['en: collection with filter', 'es: collection with filter', 'en: item with language maps and relation', 'es: item with language maps and relation',
  'en: error problem+json', 'es: error problem+json', 'en: singleton', 'es: singleton', 'en: welcome, theme and language link with the hash', 'no CSP violation or JS error in the console'];

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
    if (Date.now() > deadline) throw new Error(`Chrome did not open DevTools on ${DEVTOOLS_PORT}`);
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
    ws.addEventListener('error', () => reject(new Error('could not connect to DevTools')));
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const id = ++n; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    }));
  });
}

if (!chrome) {
  for (const name of BROWSER_TESTS) skip(`browser: ${name}`, 'no Chrome or Chromium; CHROME=/path to point to it');
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
    // DevTools injects it, not the page: it does not go through the CSP.
    await page$.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber));` });
  } catch (e) {
    page$ = null;
    for (const name of BROWSER_TESTS) skip(`browser: ${name}`, e.message);
  }
  const evaluate = async (expr) => (await page$.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  const violations = [];
  // Opens a URL from scratch and waits for the page text to meet the condition; returns the DOM.
  async function open(url, until) {
    await page$.send('Page.navigate', { url: 'about:blank' });
    await page$.send('Page.navigate', { url });
    const deadline = Date.now() + 15000;
    let text = '';
    for (;;) {
      text = (await evaluate('document.body ? document.body.textContent : ""').catch(() => '')) ?? '';
      if (until.test(text)) break;
      if (Date.now() > deadline) throw new Error(`${until} did not appear at ${url}; text:\n${text.slice(0, 1500)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const v = await evaluate('window.__csp || []');
    violations.push(...v.map((x) => `${url}: ${x}`));
    return evaluate('document.documentElement.outerHTML');
  }
  const bt = (name, fn) => (page$ ? test(`browser: ${name}`, fn) : null);

  await bt('en: collection with filter', async () => {
    const dom = await open(EN_PAGE + hashFor('/books?filter[category]=novela-negra&sort=-price&count=true'), /3 in total/);
    assert.match(dom, /La niebla de Portugalete/);
    assert.match(dom, /Lluvia sobre Deusto/);
    assert.doesNotMatch(dom, /Cuaderno de faros/, 'the filter leaves out the poetry');
    assert.match(dom, /3 items on this page · 3 in total/);
    assert.match(dom, /curl -i -g/);
    assert.match(dom, /Filters \(combined with AND\)/);
    assert.match(dom, /eq · = equal to/);
  });
  await bt('es: collection with filter', async () => {
    const dom = await open(ES_PAGE + hashFor('/books?filter[category]=novela-negra&sort=-price&count=true'), /3 en total/);
    assert.match(dom, /La niebla de Portugalete/);
    assert.doesNotMatch(dom, /Cuaderno de faros/);
    assert.match(dom, /3 elementos en esta página · 3 en total/);
    assert.match(dom, /Filtros \(se combinan con Y\)/);
  });
  await bt('en: item with language maps and relation', async () => {
    const dom = await open(EN_PAGE + hashFor('/products/2'), /Edit \(PATCH\)/);
    assert.match(dom, /Lapicera/);
    assert.match(dom, /href="#api=http:\/\/localhost:8840\/&amp;path=\/categories\/1"/);
    assert.match(dom, /If-Match: <code>&quot;[0-9a-f]+&quot;<\/code>|If-Match: <code>"[0-9a-f]+"<\/code>/);
    assert.match(dom, /Delete \(DELETE\)/);
  });
  await bt('es: item with language maps and relation', async () => {
    const dom = await open(ES_PAGE + hashFor('/products/2'), /Editar \(PATCH\)/);
    assert.match(dom, /Lapicera/);
    assert.match(dom, /href="#api=http:\/\/localhost:8840\/&amp;path=\/categories\/1"/);
    assert.match(dom, /Borrar \(DELETE\)/);
  });
  await bt('en: singleton', async () => {
    const dom = await open(EN_PAGE + hashFor('/shop'), /Edit \(PATCH\)/);
    assert.match(dom, /Singleton · \/shop/);
    assert.match(dom, /max_reservations/);
    assert.match(dom, /If-Match: <code>/);
    const home = await open(EN_PAGE + hashFor('/'), /Singletons \(\d+\)/);
    assert.match(home, /href="#api=http:\/\/localhost:8840\/&amp;path=\/shop"/);
    assert.match(home, /1\.0-draft\.\d+" is a draft/);
  });
  await bt('es: singleton', async () => {
    const dom = await open(ES_PAGE + hashFor('/shop'), /Editar \(PATCH\)/);
    assert.match(dom, /Recurso suelto · \/shop/);
  });
  // Draft 7 in the reference: default filter, collection without GET, upload, localized field,
  // singleton under an item and a singleton action with effects.
  await bt('en: default filter, no GET, upload, localized field (§3, §4.3, §5.1, §6.1)', async () => {
    const orders = await open(EN_PAGE + hashFor('/orders'), /on by default/);
    assert.match(orders, /It applies unless you uncheck it \(filter\[active\]=false\)/);
    const pay = await open(EN_PAGE + hashFor('/payments'), /cannot be listed/);
    assert.match(pay, /Create an item|Create/);
    const files = await open(EN_PAGE + hashFor('/files'), /Upload a file \(POST\)/);
    assert.match(files, /type="file"/);
    assert.match(files, /accept="image\/\*"/);
    // 5.1 (council, round 3, decision 1): /files has no schemas.create, so it only takes files.
    assert.doesNotMatch(files, /Create an item \(POST\)/);
    assert.match(files, /only takes files/);
    const f1 = await open(EN_PAGE + hashFor('/files/f1'), /File bytes/);
    assert.match(f1, /\/files\/f1\/content/);
    const genre = await open(EN_PAGE + hashFor('/genres/ensayo'), /Localized, read-only: write name_i18n/);
    assert.match(genre, /Language of the response: /);
  });
  await bt('es: singleton under an item and its action with effects (§5.9, §11.1)', async () => {
    const st = await open(ES_PAGE + hashFor('/readers/1/settings'), /cuelga de readers/);
    assert.match(st, /newsletter/);
    const me = await open(ES_PAGE + hashFor('/me'), /verify_email/);
    assert.match(me, /external/);
    const home = await open(ES_PAGE + hashFor('/'), /Confiar en los efectos que declara esta API/);
    assert.match(home, /settings/);
  });
  await bt('en: error problem+json', async () => {
    const dom = await open(EN_PAGE + hashFor('/books?sort=category'), /unsupported_parameter/);
    assert.match(dom, /remove it from the request/);
  });
  await bt('es: error problem+json', async () => {
    const dom = await open(ES_PAGE + hashFor('/books?sort=category'), /unsupported_parameter/);
    assert.match(dom, /quítalo de la petición/);
  });
  await bt('en: welcome, theme and language link with the hash', async () => {
    let dom = await open(EN_PAGE, /Explore a Restep API/);
    assert.match(dom, /Theme: auto/);
    assert.match(dom, /id="other-lang" href="\/es\/explorador\/"/);
    await evaluate(`document.getElementById('theme').click()`);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    assert.match(await evaluate(`document.getElementById('theme').textContent`), /Theme: light/);
    // The chosen theme is applied before painting on the next load (explorer-theme.js).
    dom = await open(ES_PAGE + hashFor('/books'), /Página siguiente|No hay más páginas/);
    assert.match(dom, /<html lang="es" data-theme="light">/);
    assert.match(dom, /Tema: claro/);
    const sw = await evaluate(`document.getElementById('other-lang').getAttribute('href')`);
    assert.equal(sw, '/explorer/' + hashFor('/books'));
    await evaluate(`document.getElementById('theme').click(); document.getElementById('theme').click()`);
  });
  await bt('no CSP violation or JS error in the console', async () => {
    const csp = consoleLog.filter((e) => /Content Security Policy|Refused to/i.test(e.text) || e.kind.startsWith('log:security'));
    const js = consoleLog.filter((e) => e.kind === 'exception' || e.kind.startsWith('console.') || e.kind === 'log:javascript:error');
    assert.deepEqual(violations, [], 'securitypolicyviolation');
    assert.deepEqual(csp.map((e) => e.text), [], 'CSP warnings in the console');
    assert.deepEqual(js.map((e) => `${e.kind}: ${e.text}`), [], 'errores de JS');
    // The only thing allowed in the console is the network errors of the 4xx responses requested on purpose.
    const other = consoleLog.filter((e) => !(e.kind === 'log:network:error' && /status of 4\d\d/.test(e.text)));
    assert.deepEqual(other.map((e) => `${e.kind}: ${e.text}`), [], 'other messages in the console');
  });
  page$?.close();
}

console.log('restep-explorer · tests\n' + results.join('\n'));
console.log(`\n${passed + failed + skipped} tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
// Chrome keeps writing to its profile until it exits: wait for it to exit before deleting the directory.
await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); p.kill(); setTimeout(r, 5000); })));
cleanup();
process.exit(failed ? 1 : 0);
