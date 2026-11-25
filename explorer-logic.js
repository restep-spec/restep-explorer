// Pure explorer logic, without the DOM: it can be evaluated in Node (test.mjs loads it in a vm context
// together with explorer-i18n.js and tests it in both languages).
(function () {
  'use strict';
  const L = {};
  // ── Language of the texts ──────────────────────────────────────────────────
  // That of <html lang> if there is a document; the dictionary is globalThis.RestepI18n (explorer-i18n.js).
  const dicts = () => globalThis.RestepI18n || {};
  L.setLang = (lang) => {
    const base = String(lang || '').toLowerCase().split('-')[0];
    L.lang = Object.hasOwn(dicts(), base) ? base : 'en';
    return L.lang;
  };
  L.setLang(globalThis.document?.documentElement?.lang || 'en');
  // L.t(key, ...args): the text in the current language; if it is a function, it is called with args.
  // If missing in that language, the English one; if that is missing too, the key itself (so it shows on screen).
  L.t = (key, ...args) => {
    const d = dicts();
    const v = d[L.lang]?.[key] ?? d.en?.[key];
    return typeof v === 'function' ? v(...args) : v ?? key;
  };
  const t = L.t;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : '');
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  L.isObj = isObj;

  // ── API URL and paths ──────────────────────────────────────────────────
  // The root is the URL the client is configured with; the discovery paths are relative to it (§2).
  L.normalizeRoot = (input) => {
    let s = String(input ?? '').trim();
    if (!s) throw new Error(t('errNoUrl'));
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
    let u;
    try { u = new URL(s); } catch { throw new Error(t('errBadUrl', input)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(t('errScheme'));
    if (u.username || u.password) throw new Error(t('errCreds'));
    u.hash = ''; u.search = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  };
  L.joinRoot = (root, path) => root.replace(/\/+$/, '') + (String(path).startsWith('/') ? path : '/' + path);
  // A link from a body or header (absolute or absolute path, §3) turned into a path relative to the root,
  // or null if it falls outside the API (another origin or another base path).
  L.toApiPath = (root, href, base) => {
    let u, r;
    try { u = new URL(href, base || root); r = new URL(root); } catch { return null; }
    if (u.origin !== r.origin) return null;
    const rp = r.pathname.replace(/\/+$/, '');
    if (u.pathname !== rp && !u.pathname.startsWith(rp + '/')) return null;
    return (u.pathname.slice(rp.length) || '/') + u.search;
  };
  L.sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
  // §3: a client MUST NOT follow a link whose scheme is neither https nor the root's (file:, data:…).
  L.allowedScheme = (url, root) => { try { const p = new URL(url).protocol; return p === 'https:' || p === new URL(root).protocol; } catch { return false; } };

  // ── State in the hash: #api=<root>&path=<path with its query> ─────────────
  const hashEnc = (s) => encodeURIComponent(s).replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']').replace(/%2C/gi, ',').replace(/%3F/gi, '?').replace(/%3D/gi, '=').replace(/%40/gi, '@');
  L.readHash = (hash) => {
    const p = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
    return { api: p.get('api') || '', path: p.get('path') || '' };
  };
  L.writeHash = ({ api, path }) => {
    const parts = [];
    if (api) parts.push(`api=${hashEnc(api)}`);
    if (path && path !== '/') parts.push(`path=${hashEnc(path)}`);
    return '#' + parts.join('&');
  };

  // ── Descubrimiento (§4.2) ──────────────────────────────────────────────────
  // Only an object with a string member restep is a discovery document; otherwise, only core.
  L.isDiscovery = (doc) => isObj(doc) && typeof doc.restep === 'string';
  // §1.1: the version, with the grammar of restep. null if it does not follow it; draft is true with a suffix.
  L.restepVersion = (v) => {
    const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(draft|rc)\.(0|[1-9][0-9]*))?$/.exec(typeof v === 'string' ? v : '');
    return m ? { major: Number(m[1]), minor: Number(m[2]), pre: m[3] ?? null, draft: !!m[3] } : null;
  };
  // §1.2: the experimental parts are only used if restep declares a version whose text the
  // explorer implements; with a draft, that same one. The explorer implements the inherit text of draft 7.
  L.EXPERIMENTAL_TEXTS = ['1.0-draft.7'];
  L.EXPERIMENTAL = ['sync', 'batch', 'filter-expr', 'query-method', 'inherit'];
  L.implementsExperimental = (restep) => L.EXPERIMENTAL_TEXTS.includes(restep);
  // Values the explorer knows; a filter, an action or a notice with another one is treated as not declared (§4.2).
  const FILTER_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'localdatetime', 'timezone', 'duration', 'enum'];
  const FILTER_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];
  // 11.1 and 4.3: effects. Without effects, or with a value the explorer does not know, an operation
  // has all three; a DELETE that method effects do not declare has ["destroys"].
  L.EFFECTS = ['destroys', 'external', 'charges'];
  L.effectsOf = (list) => (Array.isArray(list) && list.every((e) => L.EFFECTS.includes(e)) ? [...new Set(list)] : [...L.EFFECTS]);
  L.methodEffects = (declared, method) => (isObj(declared) && Object.hasOwn(declared, method) ? L.effectsOf(declared[method])
    : method === 'DELETE' ? ['destroys'] : [...L.EFFECTS]);
  // A safe action may declare only charges; one that declares nothing has no effect to confirm.
  L.actionEffects = (a) => (a?.safe && a.effects === undefined ? [] : L.effectsOf(a?.effects));
  // 11.1 and 13.1: confirm before any declared effect, and before [] unless the server is trusted; a safe
  // operation only when it declares an effect.
  L.needsConfirm = (effects, { safe = false, trusted = false } = {}) => effects.length > 0 || (!safe && !trusted);
  // 11.6: the members of an inherit field and of inherit_items the explorer knows; a declaration with
  // any other member whose name does not start with x- (the server's own, 4.2), or a value it does not
  // know, is treated as not inherited.
  const INHERIT_MEMBERS = ['own', 'from', 'default', 'description', 'combine', 'switch'];
  const knownMember = (allowed) => (k) => allowed.includes(k) || k.startsWith('x-');
  const knownSwitch = (s) => s === undefined || (isObj(s) && typeof s.field === 'string');
  L.knownInherit = (i) => isObj(i) && typeof i.own === 'string' && Object.keys(i).every(knownMember(INHERIT_MEMBERS))
    && [undefined, 'replace', 'fields'].includes(i.combine) && knownSwitch(i.switch);
  L.knownInheritItems = (i) => isObj(i) && Object.keys(i).every(knownMember(['from', 'key', 'switch'])) && knownSwitch(i.switch);
  // 4.2: a 2xx whose body is a JSON object with a string restep is a discovery document; a 2xx without
  // one, or a 404, means core only; any other error says nothing about the profiles.
  L.discoveryOutcome = (status, body) => {
    if (status >= 200 && status < 300 && L.isDiscovery(body)) return L.parseDiscovery(body);
    if ((status >= 200 && status < 300) || status === 404) return L.parseDiscovery(null);
    return { restep: null, version: '', profiles: [], extensions: [], collections: [], singletons: [], deprecations: [], coreOnly: false, unavailable: true, raw: null };
  };
  L.isRestep1 = (doc) => L.isDiscovery(doc) && L.restepVersion(doc.restep)?.major === 1;
  const KINDS_ROOT = ['version', 'profile', 'extension', 'collection', 'singleton', 'reason'];
  const KINDS_COLL = ['field', 'filter', 'operator', 'value', 'sort', 'relation', 'include', 'count', 'max_limit', 'action', 'method', 'item_method'];
  const KINDS_SINGLETON = ['field', 'method', 'action'];
  const notices = (v, kinds) => (Array.isArray(v) ? v.filter((x) => isObj(x) && kinds.includes(x.kind)) : []);
  // §5.1: who chooses the id. null: missing (the server assigns it); 'unknown': a value that is not known.
  const idFrom = (v) => (v === undefined ? null : ['server', 'client', 'either'].includes(v) ? v : 'unknown');
  L.parseDiscovery = (doc) => {
    if (!L.isDiscovery(doc)) return { restep: null, version: '', profiles: ['core'], extensions: [], collections: [], singletons: [], deprecations: [], coreOnly: true, raw: doc ?? null };
    // §1.1: with a major version other than 1, or without the grammar, it is not a Restep 1 discovery,
    // and core is not assumed either: that API cannot be used as Restep 1.
    const ver = L.restepVersion(doc.restep);
    if (!ver || ver.major !== 1) return { restep: doc.restep, version: '', profiles: [], extensions: [], collections: [], singletons: [], deprecations: [], coreOnly: false, notRestep1: true, raw: doc };
    const obj = (v) => (isObj(v) ? v : {});
    const extensions = [...new Set(strs(doc.extensions))];
    // inherit (§11.6) is experimental: without the extension announced or with a version whose text is not
    // implemented, its members are ignored.
    const useInherit = extensions.includes('inherit') && L.implementsExperimental(doc.restep);
    const profiles = [...new Set(strs(doc.profiles))];
    if (!profiles.includes('core')) profiles.unshift('core');
    const collections = [];
    for (const [name, c] of Object.entries(obj(doc.collections))) {
      if (!isObj(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) continue;
      const vars = L.templateVars(c.path);
      collections.push({
        name, path: c.path, vars, templated: vars.length > 0,
        description: str(c.description),
        methods: Array.isArray(c.methods) ? strs(c.methods) : null, // absent: unknown (§4.3)
        itemMethods: Array.isArray(c.item_methods) ? strs(c.item_methods) : null,
        schemas: obj(c.schemas),
        // 6.1: a filter whose quantifier is not known is not used; an operator not known is dropped alone.
        filters: Object.entries(obj(c.filter)).filter(([, f]) => isObj(f) && FILTER_TYPES.includes(f.type) && [undefined, 'some'].includes(f.quantifier)).map(([field, f]) => ({
          field, type: f.type, values: strs(f.values), ops: strs(f.ops).filter((o) => FILTER_OPS.includes(o)), description: str(f.description),
          quantifier: f.quantifier ?? null, required: f.required === true,
          // 6.1 (council, round 3, decisions 8 and 9): null on a list or a to-many relationship tests the whole group.
          group: f.quantifier === 'some' || (isObj(obj(c.relations)[field]) && obj(c.relations)[field].many === true),
        })).filter((f) => f.ops.length),
        // §6.1: named filters; type null is a switch, which carries no value. With an unknown type, it is not used.
        named: Object.entries(obj(c.named_filters)).filter(([, f]) => isObj(f) && (f.type === undefined || FILTER_TYPES.includes(f.type))).map(([name, f]) => ({
          name, type: str(f.type) || null, values: strs(f.values), description: str(f.description),
          default: f.type === undefined && f.default === true, required: f.required === true,
        })),
        idFrom: idFrom(c.id_from),
        sort: strs(c.sort),
        maxLimit: Number.isInteger(c.max_limit) && c.max_limit >= 1 ? c.max_limit : null,
        count: c.count === 'exact' || c.count === 'estimated' ? c.count : null,
        relations: Object.entries(obj(c.relations)).filter(([, r]) => isObj(r)).map(([rname, r]) => ({
          name: rname, to: Array.isArray(r.to) ? strs(r.to) : typeof r.to === 'string' ? [r.to] : [],
          many: r.many === true, include: r.include === true, path: typeof r.path === 'string' ? r.path : null,
          description: str(r.description),
        })),
        includeDepth: Number.isInteger(c.include_depth) && c.include_depth >= 1 ? c.include_depth : 1,
        languageMaps: Object.keys(obj(c.language_maps)),
        // 3: localized fields, read-only, with the language map each one comes from.
        localized: Object.fromEntries(Object.entries(obj(c.localized)).filter(([, d]) => isObj(d) && typeof d.source === 'string').map(([f, d]) => [f, d.source])),
        inherit: Object.entries(useInherit ? obj(c.inherit) : {}).filter(([, i]) => L.knownInherit(i)).map(([field, i]) => ({
          field, own: str(i.own), from: strs(i.from), default: i.default === true, description: str(i.description),
          switchField: isObj(i.switch) ? i.switch.field : null,
        })),
        inheritItems: useInherit && L.knownInheritItems(c.inherit_items) ? { from: strs(c.inherit_items.from), key: strs(c.inherit_items.key), switchField: isObj(c.inherit_items.switch) ? c.inherit_items.switch.field : null } : null,
        // 5.1: a collection that takes files.
        upload: isObj(c.upload) ? { mediaTypes: strs(c.upload.media_types), maxSize: Number.isInteger(c.upload.max_size) && c.upload.max_size > 0 ? c.upload.max_size : null, multipart: c.upload.multipart === true } : null,
        methodEffects: obj(c.method_effects), itemMethodEffects: obj(c.item_method_effects),
        actions: L.parseActions(c.actions, false),
        sync: isObj(c.sync) ? c.sync : null,
        deprecations: notices(c.deprecations, KINDS_COLL),
      });
    }
    // 5.9: singletons. One whose path is a template without parent, or whose parent names no collection
    // or singleton of the document, is ignored; one with parent hangs from an item or another singleton.
    const singletons = [];
    const parents = new Set([...Object.keys(obj(doc.collections)), ...Object.keys(obj(doc.singletons))]);
    for (const [name, sg] of Object.entries(obj(doc.singletons))) {
      if (!isObj(sg) || typeof sg.path !== 'string' || !sg.path.startsWith('/')) continue;
      if (sg.parent === undefined ? /[{}]/.test(sg.path) : typeof sg.parent !== 'string' || sg.parent === name || !parents.has(sg.parent)) continue;
      const vars = L.templateVars(sg.path);
      singletons.push({
        name, path: sg.path, vars, templated: vars.length > 0, parent: typeof sg.parent === 'string' ? sg.parent : null, description: str(sg.description),
        methods: Array.isArray(sg.methods) ? strs(sg.methods).filter((m) => m === 'GET' || m === 'PATCH') : null,
        schemas: obj(sg.schemas), deprecations: notices(sg.deprecations, KINDS_SINGLETON), actions: L.parseActions(sg.actions, true),
        // 4.3 and 5.9: the effects of its PATCH; undeclared, all three (L.methodEffects).
        methodEffects: obj(sg.method_effects),
      });
    }
    return {
      restep: doc.restep, draft: ver.draft, version: str(doc.version), profiles, extensions, collections, singletons,
      // Announced experimental parts whose text the explorer does not implement for this version (§1.2).
      experimentalIgnored: L.implementsExperimental(doc.restep) ? [] : [...profiles, ...extensions].filter((x) => L.EXPERIMENTAL.includes(x)),
      status: str(doc.status), events: str(doc.events), batch: isObj(doc.batch) ? doc.batch : null,
      idempotencyTtl: isObj(doc.idempotency) && Number.isInteger(doc.idempotency.ttl) ? doc.idempotency.ttl : null,
      idempotencyAnonymous: !(isObj(doc.idempotency) && doc.idempotency.anonymous === false),
      deprecations: notices(doc.deprecations, KINDS_ROOT), coreOnly: false, raw: doc,
    };
  };
  // 11.1: actions of a collection (with on) or of a singleton (without on); one with an on or a method the
  // explorer does not know is treated as not declared.
  L.parseActions = (acts, singleton) => Object.entries(isObj(acts) ? acts : {})
    .filter(([, a]) => isObj(a) && (singleton ? a.on === undefined : ['item', 'collection'].includes(a.on)) && [undefined, 'GET', 'POST'].includes(a.method))
    .map(([aname, a]) => ({
      name: aname, on: singleton ? 'singleton' : a.on, safe: a.safe === true, idempotent: a.idempotent === true,
      method: a.method === 'GET' ? 'GET' : 'POST', description: str(a.description), input: a.input ?? null,
      effects: a.effects, params: Object.entries(isObj(a.params) ? a.params : {}).filter(([, p]) => isObj(p)).map(([pname, p]) => ({
        name: pname, type: str(p.type), list: p.list === true, required: p.required === true, description: str(p.description),
      })), output: a.output ?? null,
    }));
  L.has = (disc, name) => !!disc && (disc.profiles.includes(name) || disc.extensions.includes(name));
  L.collection = (disc, name) => disc?.collections.find((c) => c.name === name) ?? null;
  L.singleton = (disc, name) => disc?.singletons?.find((s) => s.name === name) ?? null;
  // A declared list of methods is exact; if missing, it is unknown and the operation is offered (§4.3).
  L.allows = (list, method) => list === null || list === undefined || list.includes(method);

  // ── Path templates (RFC 6570, only {var}) ──────────────────────────────
  L.templateVars = (t) => [...String(t).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const reEsc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  L.templateSource = (t) => String(t).split(/\{[^}]*\}/).map(reEsc).join('([^/]+)');
  L.expandTemplate = (t, values) => {
    let i = 0;
    return String(t).replace(/\{[^}]*\}/g, () => {
      if (i >= values.length) throw new Error(L.t('errTemplate', t));
      return encodeURIComponent(values[i++]);
    });
  };
  // The path of an item: that of its expanded collection, without a trailing /, followed by / and the id (§5.1).
  L.itemPath = (coll, values, id) => L.expandTemplate(coll.path, values).replace(/\/+$/, '') + '/' + encodeURIComponent(id);

  // What a path is: the root, a collection, an item or something unknown.
  L.matchPath = (disc, path) => {
    const s = String(path || '/');
    const q = s.indexOf('?');
    const pathname = (q < 0 ? s : s.slice(0, q)) || '/';
    const query = q < 0 ? '' : s.slice(q + 1);
    if (pathname === '/') return { kind: 'root', pathname, query };
    const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    // A singleton has a fixed path that cannot be that of a collection or an item (§5.9).
    const sg = (disc?.singletons ?? []).find((x) => !x.templated && x.path.replace(/\/+$/, '') === pathname.replace(/\/+$/, ''));
    if (sg) return { kind: 'singleton', singleton: sg, values: [], pathname, query };
    // 5.9: a singleton under an item: its template expanded with the ids of the parent items.
    for (const t of (disc?.singletons ?? []).filter((x) => x.templated)) {
      const m = new RegExp(`^${L.templateSource(t.path.replace(/\/+$/, ''))}/?$`).exec(pathname);
      if (m) return { kind: 'singleton', singleton: t, values: m.slice(1).map(dec), pathname, query };
    }
    const colls = [...(disc?.collections ?? [])].sort((a, b) => b.path.length - a.path.length);
    for (const coll of colls) {
      const src = L.templateSource(coll.path.replace(/\/+$/, ''));
      let m = new RegExp(`^${src}/?$`).exec(pathname);
      if (m) return { kind: 'collection', coll, values: m.slice(1).map(dec), pathname, query };
      m = new RegExp(`^${src}/([^/:]+)$`).exec(pathname);
      if (m) {
        const v = m.slice(1).map(dec);
        return { kind: 'item', coll, values: v.slice(0, -1), id: v[v.length - 1], pathname, query };
      }
    }
    return { kind: 'unknown', pathname, query };
  };

  // ── Query (§6): from the form to the URL and back ─────────────────────
  // Brackets and commas unencoded, so the URL reads well; the server decodes it the same.
  L.encodeQueryPart = (s) => encodeURIComponent(String(s)).replace(/%5B/gi, '[').replace(/%5D/gi, ']').replace(/%2C/gi, ',');
  L.emptyQuery = () => ({ filters: [], named: {}, sort: [], fields: [], include: [], limit: '', count: false, cursor: '', extra: [] });
  // With the collection, filter[name] of one of its named filters (§6.1) goes to q.named.
  L.parseQuery = (qs, coll = null) => {
    const q = L.emptyQuery();
    const named = new Set((coll?.named ?? []).map((n) => n.name));
    for (const [k, v] of new URLSearchParams(String(qs ?? '').replace(/^\?/, ''))) {
      const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k);
      if (m && !m[2] && named.has(m[1]) && !Object.hasOwn(q.named, m[1])) q.named[m[1]] = v;
      else if (m) q.filters.push({ field: m[1], op: m[2] || 'eq', value: v });
      else if (k === 'sort') q.sort = v.split(',').filter((x) => x && x !== '-').map((x) => ({ field: x.replace(/^-/, ''), desc: x.startsWith('-') }));
      else if (k === 'fields' || k === 'include') q[k] = v.split(',').filter(Boolean);
      else if (k === 'limit') q.limit = v;
      else if (k === 'count') q.count = v === 'true';
      else if (k === 'cursor') q.cursor = v;
      else q.extra.push([k, v]); // filter=… (filter-expr), the API's own parameters: kept
    }
    return q;
  };
  // filter[field]=v is the same as filter[field][eq]=v (§6.1): the short form is used.
  L.buildQuery = (q, { keepCursor = false } = {}) => {
    const p = [];
    for (const f of q.filters ?? []) {
      if (!f || !f.field || !f.op) continue;
      const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
      p.push([f.op === 'eq' ? `filter[${f.field}]` : `filter[${f.field}][${f.op}]`, value]);
    }
    // A named filter has no operator; a switch goes without a value (§6.1). null: not applied.
    for (const [name, v] of Object.entries(q.named ?? {})) if (v !== null && v !== undefined) p.push([`filter[${name}]`, String(v)]);
    const sort = (q.sort ?? []).filter((s) => s && s.field).map((s) => (s.desc ? '-' : '') + s.field).join(',');
    if (sort) p.push(['sort', sort]);
    if (q.fields?.length) p.push(['fields', q.fields.join(',')]);
    if (q.include?.length) p.push(['include', q.include.join(',')]);
    if (q.limit !== '' && q.limit !== null && q.limit !== undefined) p.push(['limit', String(q.limit)]);
    if (q.count) p.push(['count', 'true']);
    for (const e of q.extra ?? []) p.push(e);
    if (keepCursor && q.cursor) p.push(['cursor', q.cursor]);
    return p.map(([k, v]) => `${L.encodeQueryPart(k)}=${L.encodeQueryPart(v)}`).join('&');
  };
  L.withQuery = (pathname, qs) => (qs ? `${pathname}?${qs}` : pathname);

  // Readable name of a filter operator (§6.1), or null if it is not one of Restep's.
  L.opLabel = (op) => { const o = t('ops'); return isObj(o) && Object.hasOwn(o, op) ? o[op] : null; };
  // The control for a filter's value, by its type and operator (§4.2, §6.1).
  L.valueControl = (filter, op) => {
    // 6.1 (council, round 3, decision 9): on a group, null tests the whole list, never each element.
    if (op === 'null' && filter.group) return { kind: 'select', options: [['true', t('nullGroupYes')], ['false', t('nullGroupNo')]], hint: t('nullGroupHint') };
    if (op === 'null') return { kind: 'select', options: [['true', t('nullYes')], ['false', t('nullNo')]] };
    if (filter.type === 'boolean') return { kind: 'select', options: [['true', 'true'], ['false', 'false']] };
    if (filter.type === 'enum' && op !== 'in' && op !== 'nin' && filter.values.length) return { kind: 'select', options: filter.values.map((v) => [v, v]) };
    const ph = { integer: '42', number: '4.5', decimal: '18.50', date: '2026-11-12', datetime: '2026-11-12T09:30:00Z', localdatetime: '2027-03-30T19:00:00', timezone: 'Europe/Madrid', duration: 'PT1.5S' }[filter.type] ?? '';
    if (op === 'in' || op === 'nin') {
      const sample = filter.type === 'enum' ? filter.values.slice(0, 2) : ph ? [ph, ph] : ['a', 'b'];
      return { kind: 'input', type: 'text', inputmode: null, placeholder: sample.join(','), hint: t('hintIn') };
    }
    return {
      kind: 'input', type: filter.type === 'date' ? 'date' : 'text', placeholder: ph,
      inputmode: filter.type === 'integer' ? 'numeric' : filter.type === 'number' || filter.type === 'decimal' ? 'decimal' : null,
      hint: filter.type === 'decimal' ? t('hintDecimal') : filter.type === 'datetime' ? t('hintDatetime') : filter.type === 'duration' ? t('hintDuration')
        : filter.type === 'localdatetime' ? t('hintLocalDatetime') : filter.type === 'timezone' ? t('hintTimezone') : op === 'prefix' || op === 'contains' ? t('hintNotEmpty') : '',
    };
  };

  // ── Escrituras (§5.1, §7) ──────────────────────────────────────────────────
  const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
  L.jsonEqual = (a, b) => canonical(a) === canonical(b);
  // The merge patch (RFC 7396) that takes a to b: what was removed goes to null, what is equal is left out.
  // The whole fields (relations, §5.1) are sent whole: a relation object is not merged.
  L.mergeDiff = (a, b, whole = []) => {
    const out = {};
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out[k] = null;
    for (const [k, v] of Object.entries(b)) {
      if (Object.hasOwn(a, k) && L.jsonEqual(a[k], v)) continue;
      out[k] = Object.hasOwn(a, k) && isObj(a[k]) && isObj(v) && !whole.includes(k) ? L.mergeDiff(a[k], v) : v;
    }
    return out;
  };
  // What can be edited of an item: no id, no _ members and no inherited effective fields (§11.6).
  // Localized fields (3) are read-only too: their language map is what is written.
  L.editableCopy = (coll, item) => {
    const ro = new Set(['id', ...(coll?.inherit ?? []).map((i) => i.field), ...Object.keys(coll?.localized ?? {})]);
    const s = coll?.schemas?.item;
    if (isObj(s) && isObj(s.properties)) for (const [k, p] of Object.entries(s.properties)) if (isObj(p) && p.readOnly === true) ro.add(k);
    return Object.fromEntries(Object.entries(isObj(item) ? item : {}).filter(([k]) => !k.startsWith('_') && !ro.has(k)));
  };
  // A starting body from a JSON schema (§4.3): the required members with a value of
  // their type and the optional ones with default, in the order of properties, which is the display order.
  L.skeleton = (schema) => {
    if (!isObj(schema) || !isObj(schema.properties)) return {};
    const required = new Set(strs(schema.required));
    const out = {};
    for (const [k, p] of Object.entries(schema.properties)) {
      if (k.startsWith('_') || (isObj(p) && p.readOnly === true)) continue;
      if (required.has(k)) out[k] = L.placeholder(p);
      else if (isObj(p) && Object.hasOwn(p, 'default')) out[k] = p.default;
    }
    return out;
  };
  L.placeholder = (s) => {
    if (!isObj(s)) return null;
    if (Object.hasOwn(s, 'default')) return s.default; // the annotation goes on the property, outside the anyOf
    for (const alt of [s.anyOf, s.oneOf]) {
      if (!Array.isArray(alt)) continue;
      const first = alt.find((a) => isObj(a) && a.type !== 'null');
      if (first) return L.placeholder(first);
    }
    if (Object.hasOwn(s, 'default')) return s.default;
    if (Object.hasOwn(s, 'const')) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    switch (t) {
      case 'string': return '';
      case 'integer': case 'number': return 0;
      case 'boolean': return false;
      case 'array': return [];
      case 'object': return L.skeleton(s);
      default: return null;
    }
  };
  // The fields of a form, in the order of properties (§4.3): label (title), help
  // (description), whether required, default, examples, options (enum, or oneOf of const with title)
  // and the type and format of the first non-null type of an anyOf.
  L.formFields = (schema) => {
    if (!isObj(schema) || !isObj(schema.properties)) return [];
    const required = new Set(strs(schema.required));
    return Object.entries(schema.properties).filter(([k, p]) => !k.startsWith('_') && isObj(p)).map(([name, p]) => {
      const alt = [p.anyOf, p.oneOf].find((a) => Array.isArray(a) && a.some((x) => isObj(x) && Object.hasOwn(x, 'type') && x.type !== 'null'));
      const inner = alt ? alt.find((x) => isObj(x) && x.type !== 'null') : p;
      const pick = (k) => (Object.hasOwn(p, k) ? p[k] : isObj(inner) ? inner[k] : undefined);
      const t = pick('type');
      const consts = [inner?.oneOf, inner?.anyOf, p.oneOf].find((a) => Array.isArray(a) && a.length && a.every((x) => isObj(x) && Object.hasOwn(x, 'const')));
      const choices = consts ? consts.map((x) => ({ value: x.const, title: str(x.title) }))
        : Array.isArray(pick('enum')) ? pick('enum').map((v) => ({ value: v, title: '' })) : [];
      return {
        name, title: str(p.title), description: str(pick('description')), required: required.has(name),
        readOnly: p.readOnly === true, writeOnly: p.writeOnly === true, deprecated: p.deprecated === true,
        type: Array.isArray(t) ? t.filter((x) => x !== 'null').join(' | ') : str(t), format: str(pick('format')),
        nullable: !!alt?.some((x) => isObj(x) && x.type === 'null'),
        hasDefault: Object.hasOwn(p, 'default'), default: p.default, examples: Array.isArray(p.examples) ? p.examples : [], choices,
      };
    });
  };
  // 11.1: a collection's action new, safe and with GET, gives {"values", "schema"}: the starting values of
  // a new item and an effective schema, advisory (the POST still decides).
  L.newAction = (disc, coll) => (L.has(disc, 'actions')
    ? coll?.actions.find((a) => a.name === 'new' && a.on === 'collection' && a.method === 'GET' && a.safe) ?? null : null);
  L.newStart = (result) => (isObj(result) ? { values: isObj(result.values) ? result.values : {}, schema: isObj(result.schema) ? result.schema : null } : null);
  // 11.1: the query of a GET action from the values of its declared params. A list takes values
  // separated by commas, none of which may contain one. Returns { query } or { error, param }.
  L.actionQuery = (params, values) => {
    const out = [];
    for (const p of params ?? []) {
      const raw = String(values?.[p.name] ?? '').trim();
      if (raw === '') { if (p.required) return { error: 'required', param: p.name }; continue; }
      out.push(`${L.encodeQueryPart(p.name)}=${L.encodeQueryPart(raw)}`);
    }
    return { query: out.join('&') };
  };
  // 5.1 (council, round 3, decision 1): schemas.create announces creation from JSON; a collection with upload
  // and without it only takes files.
  L.createsFromJson = (coll) => !coll.upload || Object.hasOwn(coll.schemas, 'create');
  // 5.1 (decision 2): how a file goes to a collection: as its bytes ('raw') or, a JSON file to one that creates items
  // from JSON, as the file part of multipart/form-data ('multipart'), which needs "multipart": true ('none' without it).
  L.uploadMode = (coll, file) => {
    const type = String(file?.type ?? '').toLowerCase().split(';')[0].trim();
    if (type !== 'application/json' || !L.createsFromJson(coll)) return 'raw';
    return coll.upload?.multipart ? 'multipart' : 'none';
  };
  // 5.1: whether a file fits a collection's upload: one of its media types (* matches any subtype) and
  // no larger than max_size. Returns null or the reason: 'type' or 'size'.
  L.uploadProblem = (upload, file) => {
    if (!upload) return 'type';
    const type = String(file?.type ?? '').toLowerCase().split(';')[0].trim();
    // Council, round 4, decision 2: */* admits every media type.
    const ok = upload.mediaTypes.some((m) => { const [a, b] = m.toLowerCase().split('/'); const [x, y] = type.split('/'); return (a === '*' && b === '*' && !!type) || (a === x && (b === '*' || b === y)); });
    if (!ok) return 'type';
    if (upload.maxSize !== null && Number(file?.size) > upload.maxSize) return 'size';
    return null;
  };
  // 5.1 (council, round 4, decision 4b): the file part of multipart/form-data always carries a filename, a generic
  // one when the file has no name.
  L.multipartFileName = (file) => (typeof file?.name === 'string' && file.name !== '' ? file.name : 'file');
  // 6.1 (council, round 4, decision 5a): the group a filter joins (a to-many relationship, its own or the first step
  // of a path, or a field declared with quantifier), and the first group that two null filters would share, which
  // the server answers with invalid_parameter. null when there is none.
  L.filterGroup = (coll, field) => {
    const seg = String(field ?? '').split('.')[0];
    if ((coll?.relations ?? []).some((r) => r.name === seg && r.many)) return seg;
    return (coll?.filters ?? []).some((f) => f.field === field && f.quantifier) ? field : null;
  };
  L.nullGroupClash = (coll, filters) => {
    const seen = new Set();
    for (const f of filters ?? []) {
      const g = f && f.op === 'null' ? L.filterGroup(coll, f.field) : null;
      if (g === null) continue;
      if (seen.has(g)) return g;
      seen.add(g);
    }
    return null;
  };
  // 5.1: Content-Disposition with the file's name (RFC 6266), with filename* for names outside ASCII.
  L.contentDisposition = (name) => {
    const n = String(name ?? '');
    const ascii = n.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return /^[\x20-\x7e]*$/.test(n) && !/["\\]/.test(n) ? `attachment; filename="${n}"` : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n)}`;
  };
  // 11.6: an item of a subcollection with inherit_items that carries _from is inherited and read-only.
  L.inheritedItemSource = (coll, item) => (coll?.inheritItems && isObj(item?._from) && typeof item._from.href === 'string' ? item._from.href : null);
  // Idempotency-Key: a Structured Fields string (RFC 9651), in quotes (§7.1).
  L.newIdempotencyKey = () => {
    const c = globalThis.crypto;
    let id;
    if (c && typeof c.randomUUID === 'function') id = c.randomUUID();
    else {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
      id = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
    }
    return `"${id}"`;
  };
  // §5.1: the body of a POST according to id_from. The starting one has an id only with "client" (a random one,
  // §13.6). When sending, with an unknown id_from value the id is always removed (a client MUST NOT
  // send it); without id_from or with "server" what the user types is kept, and the server answers 422.
  L.newId = () => L.newIdempotencyKey().slice(1, -1);
  L.createSkeleton = (coll, schema) => {
    const out = L.skeleton(schema);
    for (const f of Object.keys(coll?.localized ?? {})) delete out[f];
    const { id, ...rest } = out;
    return coll?.idFrom === 'client' ? { id: L.newId(), ...rest } : rest;
  };
  L.createPayload = (coll, body) => {
    if (!isObj(body)) return body;
    if (coll?.idFrom !== 'unknown') return body;
    const { id, ...rest } = body;
    return rest;
  };
  // §11.6: where an effective field comes from according to _inherited. 'own' if it is absent; an unknown from is 'hidden'.
  L.inheritedFrom = (inherited, field) => {
    const why = isObj(inherited) ? inherited[field] : undefined;
    if (why === undefined) return { kind: 'own' };
    const from = isObj(why) ? why.from : undefined;
    if (from === 'default') return { kind: 'default' };
    if (isObj(from) && typeof from.href === 'string' && from.href) return { kind: 'href', href: from.href };
    return { kind: 'hidden' };
  };
  // The item's ETag: _etag if it has one (with fields or include, §7.2), otherwise the ETag header of a full read.
  L.itemEtag = (item, headerEtag, partial) => (isObj(item) && typeof item._etag === 'string' ? item._etag : partial ? null : headerEtag || null);

  // ── Relaciones (§3, §9) ────────────────────────────────────────────────────
  // For each declared relation: navigable links to the related items or to their subcollection.
  // With root, an object that carries href (required towards a subcollection, §3) is linked through it.
  L.relationLinks = (disc, coll, values, item, root) => {
    const out = [];
    for (const rel of coll?.relations ?? []) {
      if (rel.path) {
        let path = null;
        try { path = L.expandTemplate(rel.path, [...values, item.id]); } catch {}
        out.push({ rel, sub: path, links: [] });
        continue;
      }
      const v = item?.[rel.name];
      const list = Array.isArray(v) ? v : isObj(v) ? [v] : [];
      const links = list.filter((o) => isObj(o) && typeof o.id === 'string').map((o) => {
        const toName = typeof o.type === 'string' ? o.type : rel.to[0];
        const target = L.collection(disc, toName);
        const byHref = root && typeof o.href === 'string' ? L.toApiPath(root, o.href) : null;
        return { id: o.id, to: toName, path: byHref ?? (target && !target.templated ? L.itemPath(target, [], o.id) : null), obj: o };
      });
      out.push({ rel, links, empty: v === null || v === undefined || (Array.isArray(v) && !v.length) });
    }
    return out;
  };
  // §9: the include paths that can be requested on a collection, up to its include_depth: each segment
  // is a declared relation with "include": true; a relation to several collections only goes last,
  // because the explorer does not know which relations to follow after it.
  L.includePaths = (disc, coll) => {
    const out = [];
    const walk = (c, prefix, depth, seen) => {
      for (const r of c?.relations ?? []) {
        if (!r.include) continue;
        const path = prefix ? `${prefix}.${r.name}` : r.name;
        out.push(path);
        if (depth > 1 && r.to.length === 1 && !seen.has(`${c.name}.${r.name}`)) {
          walk(L.collection(disc, r.to[0]), path, depth - 1, new Set([...seen, `${c.name}.${r.name}`]));
        }
      }
    };
    walk(coll, '', coll?.includeDepth ?? 1, new Set());
    return out;
  };
  // Subcollections of an item that do not appear as a relation: templates that hang from its collection's path.
  L.subcollections = (disc, coll, values, id) => {
    const base = coll.path.replace(/\/+$/, '') + '/{';
    const used = new Set((coll.relations ?? []).map((r) => r.path).filter(Boolean));
    return (disc?.collections ?? []).filter((c) => c.path.startsWith(base) && c.vars.length === values.length + 1 && !used.has(c.path))
      .map((c) => ({ coll: c, path: L.expandTemplate(c.path, [...values, id]) }));
  };

  // ── Idioma (§3, §5.6) ──────────────────────────────────────────────────────
  L.parseAcceptLanguage = (h) => String(h ?? '').split(',').map((part, i) => {
    const [range, ...params] = part.split(';').map((x) => x.trim());
    const qp = params.find((p) => /^q=/i.test(p));
    return { range: range.toLowerCase(), q: qp ? Number(qp.slice(2)) : 1, i };
  }).filter((r) => r.range && r.range !== '*' && r.q > 0 && !Number.isNaN(r.q)).sort((a, b) => b.q - a.q || a.i - b.i).map((r) => r.range);
  // Which translation to show from a language map: the preferred one that exists (trimming the tag),
  // otherwise another of the same language, otherwise the first. A missing one is never invented.
  L.pickTranslation = (map, prefs) => {
    if (!isObj(map)) return null;
    const keys = Object.keys(map);
    if (!keys.length) return null;
    for (const raw of prefs ?? []) {
      for (let tag = String(raw).toLowerCase(); tag; tag = tag.includes('-') ? tag.slice(0, tag.lastIndexOf('-')) : '')
        if (Object.hasOwn(map, tag)) return [tag, map[tag]];
    }
    for (const raw of prefs ?? []) {
      const lang = String(raw).toLowerCase().split('-')[0];
      const k = keys.find((x) => x.split('-')[0] === lang);
      if (k) return [k, map[k]];
    }
    return [keys[0], map[keys[0]]];
  };

  // ── Cabeceras ──────────────────────────────────────────────────────────────
  L.parseLinks = (h) => {
    const out = [];
    for (const part of String(h ?? '').split(/,\s*(?=<)/)) {
      const m = /^\s*<([^>]*)>(.*)$/s.exec(part);
      if (!m) continue;
      const params = {};
      for (const p of m[2].matchAll(/;\s*([a-zA-Z*-]+)\s*=\s*(?:"([^"]*)"|([^;,\s]*))/g)) params[p[1].toLowerCase()] = p[2] ?? p[3];
      out.push({ href: m[1], rel: (params.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean), type: params.type ?? null });
    }
    return out;
  };
  L.resourceMetadata = (wwwAuthenticate) => /resource_metadata="([^"]+)"/i.exec(String(wwwAuthenticate ?? ''))?.[1] ?? null;

  // ── curl ───────────────────────────────────────────────────────────────────
  // The token never appears in the command: it is replaced by $RESTEP_TOKEN.
  L.toCurl = ({ method = 'GET', url, headers = {}, body }) => {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const parts = ['curl', '-i'];
    if (/[[\]{}]/.test(url)) parts.push('-g');
    if (method === 'HEAD') parts.push('-I');
    else if (method !== 'GET') parts.push('-X', method);
    parts.push(q(url));
    for (const [k, v] of Object.entries(headers)) {
      if (/^authorization$/i.test(k)) parts.push('-H', /^bearer /i.test(v) ? '"Authorization: Bearer $RESTEP_TOKEN"' : '"Authorization: $RESTEP_AUTHORIZATION"');
      else parts.push('-H', q(`${k}: ${v}`));
    }
    // 5.1: a file goes as its bytes, or as the file part of multipart/form-data.
    const kind = Object.prototype.toString.call(body);
    if (kind === '[object FormData]') for (const [k, v] of body) parts.push('-F', q(`${k}=@${v?.name || 'file'};type=${v?.type || 'application/octet-stream'}`));
    else if (kind === '[object File]' || kind === '[object Blob]') parts.push('--data-binary', q(`@${body.name || 'file'}`));
    else if (body !== undefined && body !== null) parts.push('--data-raw', q(body));
    return parts.join(' ');
  };

  // ── Errores (§5.4) ─────────────────────────────────────────────────────────
  L.isProblem = (contentType, body) => /^application\/problem\+json\b/i.test(contentType ?? '') && isObj(body) || (isObj(body) && typeof body.code === 'string' && Number.isInteger(body.status));
  // What to do for each Restep error code (§5.4); an unknown one, by the class of the status.
  L.problemHint = (p) => {
    if (!isObj(p)) return '';
    const hints = t('hints');
    const known = typeof p.code === 'string' && isObj(hints) && Object.hasOwn(hints, p.code) ? hints[p.code] : undefined;
    if (known) return known;
    return p.status >= 500 ? t('hintServer') : p.status >= 400 ? t('hintClient') : '';
  };

  globalThis.RestepLogic = L;
})();
