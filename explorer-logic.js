// Lógica pura del explorador, sin DOM: se puede evaluar en Node (test.mjs la carga en un contexto vm
// junto con explorer-i18n.js y la prueba en los dos idiomas).
(function () {
  'use strict';
  const L = {};
  // ── Idioma de los textos ──────────────────────────────────────────────────
  // El de <html lang> si hay documento; el diccionario es globalThis.RestepI18n (explorer-i18n.js).
  const dicts = () => globalThis.RestepI18n || {};
  L.setLang = (lang) => {
    const base = String(lang || '').toLowerCase().split('-')[0];
    L.lang = Object.hasOwn(dicts(), base) ? base : 'en';
    return L.lang;
  };
  L.setLang(globalThis.document?.documentElement?.lang || 'en');
  // L.t(clave, ...args): el texto en el idioma actual; si es una función, se llama con args.
  // Si falta en ese idioma, el inglés; si tampoco está, la propia clave (así se nota en pantalla).
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

  // ── URL de la API y rutas ──────────────────────────────────────────────────
  // La raíz es la URL con la que se configura el cliente; las rutas del descubrimiento son relativas a ella (§2).
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
  // Un enlace de un cuerpo o cabecera (absoluto o ruta absoluta, §3) pasado a ruta relativa a la raíz,
  // o null si queda fuera de la API (otro origen u otra ruta base).
  L.toApiPath = (root, href, base) => {
    let u, r;
    try { u = new URL(href, base || root); r = new URL(root); } catch { return null; }
    if (u.origin !== r.origin) return null;
    const rp = r.pathname.replace(/\/+$/, '');
    if (u.pathname !== rp && !u.pathname.startsWith(rp + '/')) return null;
    return (u.pathname.slice(rp.length) || '/') + u.search;
  };
  L.sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

  // ── Estado en el hash: #api=<raíz>&path=<ruta con su consulta> ─────────────
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
  // Solo es documento de descubrimiento un objeto con un miembro restep de tipo cadena; si no, solo core.
  L.isDiscovery = (doc) => isObj(doc) && typeof doc.restep === 'string';
  L.parseDiscovery = (doc) => {
    if (!L.isDiscovery(doc)) return { restep: null, version: '', profiles: ['core'], extensions: [], collections: [], deprecations: [], coreOnly: true, raw: doc ?? null };
    const obj = (v) => (isObj(v) ? v : {});
    const profiles = [...new Set(strs(doc.profiles))];
    if (!profiles.includes('core')) profiles.unshift('core');
    const collections = [];
    for (const [name, c] of Object.entries(obj(doc.collections))) {
      if (!isObj(c) || typeof c.path !== 'string' || !c.path.startsWith('/')) continue;
      const vars = L.templateVars(c.path);
      collections.push({
        name, path: c.path, vars, templated: vars.length > 0,
        description: str(c.description),
        methods: Array.isArray(c.methods) ? strs(c.methods) : null, // ausente: no se sabe (§4.3)
        itemMethods: Array.isArray(c.item_methods) ? strs(c.item_methods) : null,
        schemas: obj(c.schemas),
        filters: Object.entries(obj(c.filter)).filter(([, f]) => isObj(f)).map(([field, f]) => ({
          field, type: str(f.type) || 'string', values: strs(f.values), ops: strs(f.ops), description: str(f.description),
        })).filter((f) => f.ops.length),
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
        inherit: Object.entries(obj(c.inherit)).filter(([, i]) => isObj(i)).map(([field, i]) => ({
          field, own: str(i.own), from: strs(i.from), default: i.default === true, description: str(i.description),
        })),
        actions: Object.entries(obj(c.actions)).filter(([, a]) => isObj(a)).map(([aname, a]) => ({
          name: aname, on: a.on === 'collection' ? 'collection' : 'item', safe: a.safe === true, idempotent: a.idempotent === true,
          method: a.method === 'GET' ? 'GET' : 'POST', description: str(a.description), input: a.input ?? null,
        })),
        sync: isObj(c.sync) ? c.sync : null,
        deprecations: Array.isArray(c.deprecations) ? c.deprecations.filter(isObj) : [],
      });
    }
    return {
      restep: doc.restep, version: str(doc.version), profiles, extensions: [...new Set(strs(doc.extensions))], collections,
      status: str(doc.status), events: str(doc.events), batch: isObj(doc.batch) ? doc.batch : null,
      idempotencyTtl: isObj(doc.idempotency) && Number.isInteger(doc.idempotency.ttl) ? doc.idempotency.ttl : null,
      deprecations: Array.isArray(doc.deprecations) ? doc.deprecations.filter(isObj) : [], coreOnly: false, raw: doc,
    };
  };
  L.has = (disc, name) => !!disc && (disc.profiles.includes(name) || disc.extensions.includes(name));
  L.collection = (disc, name) => disc?.collections.find((c) => c.name === name) ?? null;
  // Una lista de métodos declarada es exacta; si falta, no se sabe y se ofrece la operación (§4.3).
  L.allows = (list, method) => list === null || list === undefined || list.includes(method);

  // ── Plantillas de ruta (RFC 6570, solo {var}) ──────────────────────────────
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
  // La ruta de un elemento: la de su colección expandida, sin / final, seguida de / e id (§5.1).
  L.itemPath = (coll, values, id) => L.expandTemplate(coll.path, values).replace(/\/+$/, '') + '/' + encodeURIComponent(id);

  // Qué es una ruta: la raíz, una colección, un elemento o algo desconocido.
  L.matchPath = (disc, path) => {
    const s = String(path || '/');
    const q = s.indexOf('?');
    const pathname = (q < 0 ? s : s.slice(0, q)) || '/';
    const query = q < 0 ? '' : s.slice(q + 1);
    if (pathname === '/') return { kind: 'root', pathname, query };
    const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
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

  // ── Consulta (§6): del formulario a la URL y de vuelta ─────────────────────
  // Corchetes y comas sin codificar, para que la URL se lea; el servidor la descodifica igual.
  L.encodeQueryPart = (s) => encodeURIComponent(String(s)).replace(/%5B/gi, '[').replace(/%5D/gi, ']').replace(/%2C/gi, ',');
  L.emptyQuery = () => ({ filters: [], sort: [], fields: [], include: [], limit: '', count: false, cursor: '', extra: [] });
  L.parseQuery = (qs) => {
    const q = L.emptyQuery();
    for (const [k, v] of new URLSearchParams(String(qs ?? '').replace(/^\?/, ''))) {
      const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k);
      if (m) q.filters.push({ field: m[1], op: m[2] || 'eq', value: v });
      else if (k === 'sort') q.sort = v.split(',').filter((x) => x && x !== '-').map((x) => ({ field: x.replace(/^-/, ''), desc: x.startsWith('-') }));
      else if (k === 'fields' || k === 'include') q[k] = v.split(',').filter(Boolean);
      else if (k === 'limit') q.limit = v;
      else if (k === 'count') q.count = v === 'true';
      else if (k === 'cursor') q.cursor = v;
      else q.extra.push([k, v]); // filter=… (filter-expr), parámetros propios de la API: se conservan
    }
    return q;
  };
  // filter[campo]=v es lo mismo que filter[campo][eq]=v (§6.1): se usa la forma corta.
  L.buildQuery = (q, { keepCursor = false } = {}) => {
    const p = [];
    for (const f of q.filters ?? []) {
      if (!f || !f.field || !f.op) continue;
      const value = Array.isArray(f.value) ? f.value.join(',') : String(f.value ?? '');
      p.push([f.op === 'eq' ? `filter[${f.field}]` : `filter[${f.field}][${f.op}]`, value]);
    }
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

  // Nombre legible de un operador de filtro (§6.1), o null si no es uno de los de Restep.
  L.opLabel = (op) => { const o = t('ops'); return isObj(o) && Object.hasOwn(o, op) ? o[op] : null; };
  // El control para el valor de un filtro, según su tipo y operador (§4.2, §6.1).
  L.valueControl = (filter, op) => {
    if (op === 'null') return { kind: 'select', options: [['true', t('nullYes')], ['false', t('nullNo')]] };
    if (filter.type === 'boolean') return { kind: 'select', options: [['true', 'true'], ['false', 'false']] };
    if (filter.type === 'enum' && op !== 'in' && filter.values.length) return { kind: 'select', options: filter.values.map((v) => [v, v]) };
    const ph = { integer: '42', number: '4.5', decimal: '18.50', date: '2026-11-12', datetime: '2026-11-12T09:30:00Z', duration: 'PT90S' }[filter.type] ?? '';
    if (op === 'in') {
      const sample = filter.type === 'enum' ? filter.values.slice(0, 2) : ph ? [ph, ph] : ['a', 'b'];
      return { kind: 'input', type: 'text', inputmode: null, placeholder: sample.join(','), hint: t('hintIn') };
    }
    return {
      kind: 'input', type: filter.type === 'date' ? 'date' : 'text', placeholder: ph,
      inputmode: filter.type === 'integer' ? 'numeric' : filter.type === 'number' || filter.type === 'decimal' ? 'decimal' : null,
      hint: filter.type === 'decimal' ? t('hintDecimal') : filter.type === 'datetime' ? t('hintDatetime') : filter.type === 'duration' ? t('hintDuration') : '',
    };
  };

  // ── Escrituras (§5.1, §7) ──────────────────────────────────────────────────
  const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
  L.jsonEqual = (a, b) => canonical(a) === canonical(b);
  // El merge patch (RFC 7396) que lleva de a a b: lo quitado va a null, lo igual no va.
  // Los campos de whole (relaciones, §5.1) se mandan enteros: un objeto de relación no se fusiona.
  L.mergeDiff = (a, b, whole = []) => {
    const out = {};
    for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out[k] = null;
    for (const [k, v] of Object.entries(b)) {
      if (Object.hasOwn(a, k) && L.jsonEqual(a[k], v)) continue;
      out[k] = Object.hasOwn(a, k) && isObj(a[k]) && isObj(v) && !whole.includes(k) ? L.mergeDiff(a[k], v) : v;
    }
    return out;
  };
  // Lo que se puede editar de un elemento: sin id, sin miembros _ y sin campos efectivos heredados (§5.7).
  L.editableCopy = (coll, item) => {
    const ro = new Set(['id', ...(coll?.inherit ?? []).map((i) => i.field)]);
    const s = coll?.schemas?.item;
    if (isObj(s) && isObj(s.properties)) for (const [k, p] of Object.entries(s.properties)) if (isObj(p) && p.readOnly === true) ro.add(k);
    return Object.fromEntries(Object.entries(isObj(item) ? item : {}).filter(([k]) => !k.startsWith('_') && !ro.has(k)));
  };
  // Un cuerpo de partida a partir de un esquema JSON: los miembros obligatorios con un valor de su tipo.
  L.skeleton = (schema) => {
    if (!isObj(schema) || !isObj(schema.properties)) return {};
    const out = {};
    for (const k of strs(schema.required)) {
      const p = schema.properties[k];
      if (k.startsWith('_') || (isObj(p) && p.readOnly === true)) continue;
      out[k] = L.placeholder(p);
    }
    return out;
  };
  L.placeholder = (s) => {
    if (!isObj(s)) return null;
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
  // Idempotency-Key: una cadena de Structured Fields (RFC 9651), entre comillas (§7.1).
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
  // La ETag de elemento: _etag si la trae (con fields o include, §7.2), si no la cabecera ETag de una lectura completa.
  L.itemEtag = (item, headerEtag, partial) => (isObj(item) && typeof item._etag === 'string' ? item._etag : partial ? null : headerEtag || null);

  // ── Relaciones (§3, §8) ────────────────────────────────────────────────────
  // Para cada relación declarada: enlaces navegables a los elementos relacionados o a su subcolección.
  L.relationLinks = (disc, coll, values, item) => {
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
        return { id: o.id, to: toName, path: target && !target.templated ? L.itemPath(target, [], o.id) : null, obj: o };
      });
      out.push({ rel, links, empty: v === null || v === undefined || (Array.isArray(v) && !v.length) });
    }
    return out;
  };
  // Subcolecciones de un elemento que no salen como relación: plantillas que cuelgan de la ruta de su colección.
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
  // Qué traducción mostrar de un mapa de idioma: la preferida que exista (recortando la etiqueta),
  // si no otra del mismo idioma, si no la primera. Nunca se inventa una que falta.
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
  // El token nunca sale en el comando: se cambia por $RESTEP_TOKEN.
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
    if (body !== undefined && body !== null) parts.push('--data-raw', q(body));
    return parts.join(' ');
  };

  // ── Errores (§5.4) ─────────────────────────────────────────────────────────
  L.isProblem = (contentType, body) => /^application\/problem\+json\b/i.test(contentType ?? '') && isObj(body) || (isObj(body) && typeof body.code === 'string' && Number.isInteger(body.status));
  // Qué hacer ante cada código de error de Restep (§5.4); uno desconocido, según la clase del estado.
  L.problemHint = (p) => {
    if (!isObj(p)) return '';
    const hints = t('hints');
    const known = typeof p.code === 'string' && isObj(hints) && Object.hasOwn(hints, p.code) ? hints[p.code] : undefined;
    if (known) return known;
    return p.status >= 500 ? t('hintServer') : p.status >= 400 ? t('hintClient') : '';
  };

  globalThis.RestepLogic = L;
})();
