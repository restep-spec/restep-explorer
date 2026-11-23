// Interfaz: construye la página con DOM (nunca innerHTML con datos de la API) a partir de RestepLogic.
// Sin estilos en línea ni manejadores en atributos: la CSP de la página no los permite.
(function () {
  'use strict';
  const L = window.RestepLogic;
  L.setLang(document.documentElement.lang);
  const t = L.t;
  const $ = (s) => document.querySelector(s);
  const isObj = L.isObj;
  const state = { root: '', disc: null, discEntry: null, routeId: 0, log: [], schemaCache: new Map(), userNav: false, pendingNote: null };
  const LOG_MAX = 8;

  // ── Almacenamiento: comodidades locales, siempre con try/catch ─────────────
  const safe = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null || v === undefined || v === '') window[kind].removeItem(k); else window[kind].setItem(k, v); } catch {} },
  });
  const local = safe('localStorage'), session = safe('sessionStorage');
  const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const tokenKey = (root) => `restep-explorer:token:${originOf(root)}`;
  const getToken = () => (state.root ? session.get(tokenKey(state.root)) : null);
  const langPref = () => local.get('restep-explorer:lang') || '';
  const prefs = () => { const l = L.parseAcceptLanguage(langPref()); return l.length ? l : [...(navigator.languages || [navigator.language || 'en'])]; };

  // ── DOM ─────────────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    const u = document.createElementNS(ns, 'use'); u.setAttribute('href', `#i-${name}`); s.append(u);
    return s;
  }
  const code = (x) => h('code', { text: x });
  const badge = (t, cls = '') => h('span', { class: `badge ${cls}`, text: t });
  const safeHref = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : null);
  const DEMO_API = 'https://demo.restep.wubytes.com/';
  const hashFor = (path) => L.writeHash({ api: state.root, path });
  const navLink = (path, label, attrs = {}) => h('a', { href: hashFor(path), ...attrs }, label);
  let uid = 0;
  const nextId = (p) => `${p}-${++uid}`;
  function setStatus(msg) { $('#status').textContent = msg || ''; }
  function go(path) { state.userNav = true; const hsh = hashFor(path); if (location.hash === hsh) route(); else location.hash = hsh; }
  function pretty(entry) {
    if (entry.json !== undefined) return JSON.stringify(entry.json, null, 2);
    return entry.text || '';
  }
  const hdr = (entry, name) => entry?.headers?.get?.(name) ?? null;

  // ── Peticiones ──────────────────────────────────────────────────────────────
  // Las credenciales solo van al origen de la API (§4.3).
  async function request(method, target, { body, headers = {} } = {}) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : L.joinRoot(state.root, target);
    const sent = { Accept: 'application/json', ...headers };
    const lang = langPref();
    if (lang) sent['Accept-Language'] = lang;
    const token = getToken();
    if (token && L.sameOrigin(url, state.root)) sent.Authorization = `Bearer ${token}`;
    const entry = { method, url, sent, body, at: new Date() };
    // §3: no se sigue un enlace cuyo esquema no es https ni el de la raíz.
    if (!L.allowedScheme(url, state.root)) { entry.networkError = t('errLinkScheme', url); entry.ms = 0; addLog(entry); return entry; }
    const t0 = performance.now();
    try {
      const res = await fetch(url, { method, headers: sent, body, cache: 'no-store', redirect: 'follow' });
      const text = method === 'HEAD' ? '' : await res.text();
      let json;
      if (text) { try { json = JSON.parse(text); } catch {} }
      Object.assign(entry, {
        status: res.status, ok: res.ok, headers: res.headers, contentType: res.headers.get('content-type') || '', text, json,
        responseUrl: res.url || url,
      });
      entry.problem = res.status >= 400 && L.isProblem(entry.contentType, json) ? json : null;
    } catch (e) {
      entry.networkError = e && e.message ? e.message : String(e);
    }
    entry.ms = Math.round(performance.now() - t0);
    addLog(entry);
    return entry;
  }

  // ── Registro de peticiones ──────────────────────────────────────────────────
  function addLog(entry) {
    state.log.unshift(entry);
    state.log.length = Math.min(state.log.length, LOG_MAX);
    renderLog();
  }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); setStatus(t('copied')); }
    catch { setStatus(t('copyFailed')); }
    btn?.focus();
  }
  function curlBlock(entry) {
    const cmd = L.toCurl({ method: entry.method, url: entry.url, headers: entry.sent, body: entry.body });
    const id = nextId('curl');
    const btn = h('button', { type: 'button', class: 'btn small', 'aria-describedby': id, onclick: () => copy(cmd, btn) }, icon('copy'), t('copy'));
    return h('div', null, h('div', { class: 'copyline' }, h('span', { class: 'lbl', id }, t('asCurl')), btn), h('pre', { tabindex: '0' }, h('code', { text: cmd })));
  }
  function statusText(entry) {
    if (entry.networkError) return h('span', { class: 'st e', text: t('noResponseShort') });
    return h('span', { class: `st ${entry.status >= 400 ? 'e' : 'k'}`, text: String(entry.status) });
  }
  function renderLog() {
    const list = $('#log-list');
    list.replaceChildren(...state.log.map((e, i) => {
      const shown = L.toApiPath(state.root, e.url) ?? e.url;
      const heads = e.headers ? [...e.headers].map(([k, v]) => `${k}: ${v}`).join('\n') : '';
      return h('details', { open: i === 0 ? true : null },
        h('summary', null, `${e.method} ${shown} → `, statusText(e), h('span', { class: 'mute', text: ` · ${e.ms} ms` })),
        curlBlock(e),
        e.networkError ? networkProblem(e) : [
          h('span', { class: 'lbl' }, t('respHeaders')),
          h('pre', { tabindex: '0' }, h('code', { text: heads || t('noneParen') })),
          h('span', { class: 'lbl' }, t('body')),
          h('pre', { tabindex: '0' }, h('code', { text: truncate(pretty(e), 40000) || t('emptyParen') })),
        ]);
    }));
    $('#log').hidden = state.log.length === 0;
  }
  const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… ${t('moreChars', s.length - n)}` : s);

  // ── Errores problem+json (§5.4) ─────────────────────────────────────────────
  function networkProblem(entry) {
    return h('div', { class: 'problem' },
      h('h4', null, t('noResponse')),
      h('p', null, t('noResponseText')),
      h('p', { class: 'mute' }, t('browserDetail', entry.networkError)));
  }
  function problemBox(entry, { alert = false } = {}) {
    if (entry.networkError) return networkProblem(entry);
    const p = entry.problem;
    const box = h('div', { class: 'problem', role: alert ? 'alert' : null });
    if (!p) {
      box.append(h('h4', null, t('noProblemTitle', entry.status)),
        h('p', null, t('noProblemText')),
        h('pre', { tabindex: '0' }, h('code', { text: truncate(pretty(entry), 4000) || t('emptyParen') })));
      return box;
    }
    const str = (v) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
    box.append(h('h4', null, `${p.status ?? entry.status} · ${str(p.title) || t('error')}`));
    const hint = L.problemHint(p);
    if (hint) box.append(h('p', { class: 'why', text: hint }));
    const dl = h('dl', { class: 'kv' });
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '') dl.append(h('dt', { text: k }), h('dd', null, v)); };
    add('code', code(str(p.code)));
    add('detail', str(p.detail));
    add('parameter', p.parameter !== undefined ? code(str(p.parameter)) : null);
    add('reason', p.reason !== undefined ? code(str(p.reason)) : null);
    const typeHref = safeHref(p.type);
    add('type', typeHref ? h('a', { href: typeHref, rel: 'noopener noreferrer', target: '_blank' }, typeHref) : str(p.type));
    add('instance', str(p.instance));
    const allow = hdr(entry, 'allow');
    if (entry.status === 405 && allow) add('Allow', code(allow));
    const retry = hdr(entry, 'retry-after');
    if (retry) add('Retry-After', code(retry));
    if (entry.status === 401) {
      const www = hdr(entry, 'www-authenticate');
      add('WWW-Authenticate', www ? code(www) : h('span', { class: 'mute' }, t('wwwHidden')));
      const meta = L.resourceMetadata(www);
      if (meta && safeHref(meta)) add(t('oauthMeta'), h('a', { href: meta, target: '_blank', rel: 'noopener noreferrer' }, meta));
    }
    box.append(dl);
    if (Array.isArray(p.errors) && p.errors.length) {
      box.append(h('div', { class: 'tbl', tabindex: '0', role: 'region', 'aria-label': t('validationErrors') },
        h('table', null,
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('where')), h('th', { scope: 'col' }, 'code'), h('th', { scope: 'col' }, 'detail'))),
          h('tbody', null, p.errors.map((e) => h('tr', null,
            h('td', null, code(str(isObj(e) ? e.pointer ?? e.parameter ?? e.header : e))),
            h('td', null, code(str(isObj(e) ? e.code : ''))),
            h('td', null, str(isObj(e) ? e.detail : ''))))))));
    }
    return box;
  }

  // ── Descubrimiento ──────────────────────────────────────────────────────────
  async function loadDiscovery() {
    setStatus(t('readingDiscovery'));
    let entry = await request('GET', state.root);
    // Si la raíz no es el documento, puede enlazarlo con rel="service-desc": vale el primero que lo sea (§4.2).
    if (entry.ok && !L.isDiscovery(entry.json)) {
      for (const l of L.parseLinks(hdr(entry, 'link')).filter((x) => x.rel.includes('service-desc'))) {
        let u;
        try { u = new URL(l.href, entry.responseUrl).href; } catch { continue; }
        const e2 = await request('GET', u);
        if (e2.ok && L.isDiscovery(e2.json)) { entry = e2; break; }
      }
    }
    state.discEntry = entry;
    state.disc = L.parseDiscovery(entry.ok ? entry.json : null);
    setStatus('');
  }

  // ── Barra lateral ───────────────────────────────────────────────────────────
  function renderSide(current) {
    const side = $('#side');
    const items = [h('li', null, navLink('/', h('span', null, t('apiOverview')), { 'aria-current': current === '/' ? 'page' : null }))];
    for (const c of state.disc?.collections ?? []) {
      const inner = [c.name, h('small', { text: c.path })];
      if (c.templated) items.push(h('li', null, h('span', { class: 't', title: t('subTitle') }, inner, h('small', null, t('subSmall')))));
      else items.push(h('li', null, navLink(c.path, inner, { 'aria-current': current === c.name ? 'page' : null })));
    }
    const sgs = state.disc?.singletons ?? [];
    const sgList = sgs.length ? [h('h2', { id: 'side-s' }, t('singletons')), h('ul', null, sgs.map((sg) => h('li', null,
      navLink(sg.path, [sg.name, h('small', { text: sg.path })], { 'aria-current': current === `singleton:${sg.name}` ? 'page' : null }))))] : [];
    side.replaceChildren(h('h2', { id: 'side-h' }, t('collections')), h('ul', null, items), ...sgList);
  }

  // ── Vistas ──────────────────────────────────────────────────────────────────
  function view(...kids) {
    const v = $('#view');
    v.replaceChildren(...kids.flat().filter(Boolean));
    if (state.userNav) { state.userNav = false; ($('#view h2') || v).setAttribute('tabindex', '-1'); ($('#view h2') || v).focus(); }
  }
  const header = (title, sub) => [h('p', { class: 'kicker', text: sub }), h('h2', { id: 'view-title' }, title)];

  function renderWelcome() {
    $('#layout').hidden = true; $('#pathbar').hidden = true;
    $('#welcome').replaceChildren(h('section', { class: 'panel ink', 'aria-labelledby': 'w-h' },
      h('h2', { id: 'w-h' }, t('welcomeTitle')),
      h('p', null, t('welcome1')),
      h('p', null, t('welcome2')),
      h('p', null, t('welcomeDemo1'), h('a', { href: L.writeHash({ api: DEMO_API, path: '/' }) }, t('welcomeDemoLink')), t('welcomeDemo2')),
      h('p', { class: 'hint' }, t('welcomeLocal1'), code('PORT=8080 node restep-server.mjs'), t('welcomeLocal2'), code('http://localhost:8080/'), t('welcomeLocal3'))));
  }

  function renderOverview() {
    renderSide('/');
    const d = state.disc, e = state.discEntry;
    const parts = [...header(state.root, 'API')];
    if (!e.ok) {
      parts.push(problemBox(e));
      if (e.status === 401) parts.push(h('p', { class: 'note' }, t('needsToken')));
    } else if (d.coreOnly) {
      parts.push(h('p', { class: 'note' }, t('coreOnly')));
    } else if (d.notRestep1) {
      parts.push(h('p', { class: 'note' }, t('notRestep1', String(d.restep))));
      parts.push(h('details', { class: 'box ink' }, h('summary', null, t('fullDiscovery')), h('pre', { tabindex: '0' }, h('code', { text: JSON.stringify(d.raw, null, 2) }))));
    }
    if (!d.coreOnly && !d.notRestep1) {
      if (d.draft) parts.push(h('p', { class: 'note' }, t('draftNote', d.restep)));
      if (d.experimentalIgnored.length) parts.push(h('p', { class: 'note' }, t('experimentalOff', d.experimentalIgnored.join(', '), d.restep)));
      const dl = h('dl', { class: 'kv' });
      const add = (k, v) => { if (v !== null && v !== undefined && v !== '') dl.append(h('dt', { text: k }), h('dd', null, v)); };
      add('Restep', code(d.restep));
      add(t('apiVersion'), d.version ? code(d.version) : null);
      add(t('profiles'), h('span', { class: 'badges' }, d.profiles.map((p) => badge(p, 'p'))));
      add(t('extensions'), d.extensions.length ? h('span', { class: 'badges' }, d.extensions.map((x) => badge(x, 'x'))) : h('span', { class: 'mute' }, t('noneF')));
      add('Idempotency-Key', d.idempotencyTtl ? t('keptFor', fmtSeconds(d.idempotencyTtl)) : null);
      add(t('batch'), d.batch ? h('span', null, code(String(d.batch.path ?? '')), d.batch.max_operations ? t('upToOps', d.batch.max_operations) : '') : null);
      add(t('events'), d.events ? code(d.events) : null);
      if (d.status) {
        const out = h('span', { class: 'mute', 'aria-live': 'polite' });
        const btn = h('button', { type: 'button', class: 'btn small', onclick: async () => {
          out.textContent = ' ' + t('checking');
          let u; try { u = new URL(d.status, e.responseUrl).href; } catch { out.textContent = ' ' + t('badLink'); return; }
          const r = await request('GET', u);
          out.textContent = ' ' + (r.networkError ? t('noResponseShort') : r.status === 200 ? t('status200') : r.status === 503 ? t('status503', hdr(r, 'retry-after')) : String(r.status));
        } }, t('check'));
        add(t('statusRes'), h('span', null, code(d.status), ' ', btn, out));
      }
      parts.push(h('section', { class: 'panel ink', 'aria-label': t('apiData') }, dl));
      if (d.deprecations.length) parts.push(deprecationsBox(d.deprecations));
      parts.push(h('h3', null, `${t('collections')} (${d.collections.length})`));
      parts.push(h('div', { class: 'cards' }, d.collections.map(collectionCard)));
      if (d.singletons.length) {
        parts.push(h('h3', null, `${t('singletons')} (${d.singletons.length})`));
        parts.push(h('div', { class: 'cards' }, d.singletons.map(singletonCard)));
      }
      parts.push(h('details', { class: 'box ink' }, h('summary', null, t('fullDiscovery')), h('pre', { tabindex: '0' }, h('code', { text: JSON.stringify(d.raw, null, 2) }))));
    }
    view(parts);
  }
  const fmtSeconds = (s) => (s % 86400 === 0 ? t('days', s / 86400) : s % 3600 === 0 ? `${s / 3600} h` : `${s} s`);
  function deprecationsBox(list) {
    return h('div', { class: 'note' }, h('strong', null, t('deprecations')),
      h('ul', null, list.map((x) => h('li', null, `${x.kind ?? '?'}${x.name ? ` ${x.name}` : ''}${x.op ? ` ${x.op}` : ''}${x.value !== undefined ? ` ${x.value}` : ''}${typeof x.announced === 'string' ? t('announcedOn', x.announced) : ''}${x.sunset ? t('sunsetOn', x.sunset) : ''}`))));
  }
  function singletonCard(sg) {
    const b = sg.methods ? h('div', { class: 'badges', 'aria-label': t('declaredMethods') }, sg.methods.map((m) => badge(m, 'm'))) : null;
    const dl = h('dl', { class: 'kv' });
    if (Object.keys(sg.schemas).length) dl.append(h('dt', { text: t('schemas') }), h('dd', null, Object.keys(sg.schemas).map((k) => code(k)).flatMap((x, i) => (i ? [', ', x] : [x]))));
    return h('article', { class: 'card ink' }, h('h3', null, navLink(sg.path, sg.name)), h('p', null, code(sg.path)),
      sg.description ? h('p', { text: sg.description }) : null, b, dl, sg.deprecations.length ? deprecationsBox(sg.deprecations) : null);
  }
  function methodBadges(c) {
    const b = [];
    if (c.methods) b.push(...c.methods.map((m) => badge(t('methodColl', m), 'm')));
    if (c.itemMethods) b.push(...c.itemMethods.map((m) => badge(t('methodItem', m), 'm')));
    return b.length ? h('div', { class: 'badges', 'aria-label': t('declaredMethods') }, b) : null;
  }
  function collectionCard(c) {
    const title = c.templated ? h('span', null, c.name) : navLink(c.path, c.name);
    const dl = h('dl', { class: 'kv' });
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) dl.append(h('dt', { text: k }), h('dd', null, v)); };
    add(t('sort'), c.sort.length ? c.sort.map((s) => code(s)).flatMap((x, i) => (i ? [', ', x] : [x])) : null);
    add('limit', c.maxLimit ? t('oneTo', c.maxLimit) : null);
    add('count', c.count ? t(c.count === 'exact' ? 'exact' : 'estimated') : null);
    add(t('relations'), c.relations.map((r) => h('div', null, code(r.name), ` → ${r.to.join(' | ') || '?'}${r.many ? t('toMany') : ''}${r.include ? t('includable') : ''}`, r.description ? h('span', { class: 'mute' }, ` · ${r.description}`) : null)));
    add(t('languageMaps'), c.languageMaps.map((m) => code(m)).flatMap((x, i) => (i ? [', ', x] : [x])));
    add(t('inherited'), c.inherit.map((i) => h('div', null, code(i.field), t('writtenIn'), code(i.own), i.from.length ? t('fromList', i.from.join(', ')) : '', i.default ? t('withDefault') : '')));
    add(t('actions'), c.actions.map((a) => h('div', null, code(`:${a.name}`), ` ${t(a.on === 'item' ? 'onItem' : 'onColl', a.method)}`, a.description ? h('span', { class: 'mute' }, ` · ${a.description}`) : null)));
    add(t('schemas'), Object.keys(c.schemas).map((k) => code(k)).flatMap((x, i) => (i ? [', ', x] : [x])));
    if (c.sync) add('sync', c.sync.retention ? t('changesKept', fmtSeconds(c.sync.retention)) : t('yes'));
    return h('article', { class: 'card ink' },
      h('h3', null, title), h('p', null, code(c.path)), c.description ? h('p', { text: c.description }) : null,
      methodBadges(c), c.filters.length ? filtersTable(c) : null, c.named.length ? namedTable(c) : null, dl,
      c.deprecations.length ? deprecationsBox(c.deprecations) : null);
  }
  function filtersTable(c) {
    return h('div', { class: 'tbl', tabindex: '0', role: 'region', 'aria-label': t('filtersOf', c.name) }, h('table', null,
      h('caption', { class: 'sr' }, t('filtersOf', c.name)),
      h('thead', null, h('tr', null, [t('filter'), t('type'), t('operators')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, c.filters.map((f) => h('tr', null,
        h('th', { scope: 'row' }, code(f.field), f.description ? h('div', { class: 'mute', text: f.description }) : null),
        h('td', null, f.type, f.values.length ? h('div', { class: 'mute', text: f.values.join(', ') }) : null),
        h('td', null, f.ops.join(' ')))))));
  }

  function namedTable(c) {
    return h('div', { class: 'tbl', tabindex: '0', role: 'region', 'aria-label': t('namedOf', c.name) }, h('table', null,
      h('caption', { class: 'sr' }, t('namedOf', c.name)),
      h('thead', null, h('tr', null, [t('namedFilter'), t('value'), t('description')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, c.named.map((f) => h('tr', null,
        h('th', { scope: 'row' }, code(f.name)),
        h('td', null, f.type ?? t('switchNoValue'), f.values.length ? h('div', { class: 'mute', text: f.values.join(', ') }) : null),
        h('td', { text: f.description }))))));
  }

  // Los campos del alta tal como los describe el esquema create (§4.3), en su orden: etiqueta, ayuda,
  // tipo, opciones, default y ejemplos. Lo que un formulario de verdad pintaría como controles.
  function formFieldsTable(coll, fields) {
    const json = (v) => JSON.stringify(v);
    return h('div', { class: 'tbl', tabindex: '0', role: 'region', 'aria-label': t('formFieldsOf', coll.name) }, h('table', null,
      h('caption', { class: 'sr' }, t('formFieldsOf', coll.name)),
      h('thead', null, h('tr', null, [t('formField'), t('type'), t('formValues')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, fields.map((f) => h('tr', null,
        h('th', { scope: 'row' }, f.title ? h('div', { text: f.title }) : null, code(f.name),
          f.required ? h('span', { class: 'mute', text: ` · ${t('formRequired')}` }) : null,
          f.readOnly ? h('span', { class: 'mute', text: ` · ${t('formReadOnly')}` }) : null,
          f.description ? h('div', { class: 'mute', text: f.description }) : null),
        h('td', null, [f.type, f.format].filter(Boolean).join(' · ') || '—', f.nullable ? h('span', { class: 'mute', text: ' | null' }) : null),
        h('td', null,
          f.choices.length ? h('div', { text: f.choices.map((c) => (c.title ? `${c.title} (${json(c.value)})` : json(c.value))).join(', ') }) : null,
          f.hasDefault ? h('div', { class: 'mute', text: t('formDefault', json(f.default)) }) : null,
          f.examples.length ? h('div', { class: 'mute', text: t('formExamples', f.examples.map(json).join(', ')) }) : null,
          !f.choices.length && !f.hasDefault && !f.examples.length ? '—' : null))))));
  }

  // ── Valores ─────────────────────────────────────────────────────────────────
  function renderValue(v, field, coll, values, compact) {
    if (v === undefined) return h('span', { class: 'mute', text: '—' });
    if (v === null) return h('span', { class: 'mute', text: 'null' });
    if (coll && coll.languageMaps.includes(field) && isObj(v)) {
      const pick = L.pickTranslation(v, prefs());
      if (!pick) return h('span', { class: 'mute', text: t('noTranslations') });
      if (compact) return h('span', null, String(pick[1]), h('span', { class: 'tag', lang: pick[0], text: pick[0] }));
      return h('ul', { class: 'tr' }, Object.entries(v).map(([tag, s]) => h('li', { class: tag === pick[0] ? 'pick' : null }, h('span', { class: 'tag', text: tag }), ' ', h('span', { lang: tag, text: String(s) }))));
    }
    const rel = coll?.relations.find((r) => r.name === field);
    if (rel && !rel.path && (isObj(v) || Array.isArray(v))) {
      const [info] = L.relationLinks(state.disc, { relations: [rel] }, values, { [field]: v }, state.root);
      if (info.links.length) return h('span', null, info.links.map((l, i) => [i ? ', ' : '', l.path ? navLink(l.path, `${l.to}/${l.id}`) : code(`${l.to}/${l.id}`)]));
    }
    if (typeof v === 'string') return compact && v.length > 120 ? h('span', { title: v }, `${v.slice(0, 117)}…`) : h('span', { text: v });
    if (typeof v !== 'object') return code(String(v));
    const json = JSON.stringify(v);
    if (compact) return code(json.length > 80 ? `${json.slice(0, 77)}…` : json);
    return h('pre', { tabindex: '0' }, h('code', { text: JSON.stringify(v, null, 2) }));
  }

  // ── Colección ───────────────────────────────────────────────────────────────
  async function renderCollection(m, path, id) {
    const coll = m.coll;
    renderSide(coll.name);
    setStatus(t('loading', m.pathname));
    const e = await request('GET', path);
    if (id !== state.routeId) return;
    setStatus('');
    const q = L.parseQuery(m.query, coll);
    const parts = [...header(coll.name, t('collectionKicker', m.pathname))];
    if (state.pendingNote) { parts.push(h('p', { class: 'okmsg', role: 'status' }, state.pendingNote)); state.pendingNote = null; }
    if (coll.description) parts.push(h('p', { text: coll.description }));
    parts.push(methodBadges(coll));
    if (L.has(state.disc, 'query')) parts.push(queryForm(coll, m, q, e));
    else if (m.query) parts.push(h('p', { class: 'note' }, t('noQueryProfile')));
    parts.push(...resultsBlock(coll, m, q, e));
    if (L.has(state.disc, 'actions')) {
      const acts = coll.actions.filter((a) => a.on === 'collection').map((a) => ({ ...a, href: `${m.pathname}:${a.name}` }));
      if (acts.length) parts.push(actionsBox(coll, acts, false));
    }
    if (L.allows(coll.methods, 'POST')) parts.push(createBox(coll, m));
    view(parts);
  }

  function resultsBlock(coll, m, q, e) {
    if (!e.ok) return [h('h3', null, t('result')), problemBox(e)];
    const body = e.json;
    if (!isObj(body) || !Array.isArray(body.items)) {
      return [h('h3', null, t('result')), h('p', { class: 'note' }, t('notItems')), h('pre', { tabindex: '0' }, h('code', { text: truncate(pretty(e), 8000) }))];
    }
    const items = body.items.filter(isObj);
    const out = [h('h3', null, t('result'))];
    const summary = [t('itemsOnPage', items.length)];
    if (typeof body.total === 'number') summary.push(t(body.total_estimated ? 'totalAbout' : 'total', body.total));
    out.push(h('p', { 'aria-live': 'polite' }, summary.join(' · ')));
    if (!('next' in body)) out.push(h('p', { class: 'note' }, t('missingNext')));
    if (items.length) out.push(itemsTable(coll, m, q, items));
    else out.push(h('p', { class: 'mute' }, t('noItems')));
    const pager = h('nav', { class: 'pager', 'aria-label': t('pagination') });
    if (q.cursor) pager.append(navLink(L.withQuery(m.pathname, L.buildQuery(q)), h('span', null, icon('back'), ' ' + t('firstPage')), { class: 'btn small' }));
    if (typeof body.next === 'string') {
      const p = L.toApiPath(state.root, body.next, e.responseUrl);
      if (p) pager.append(navLink(p, h('span', null, t('nextPage') + ' ', icon('go')), { class: 'btn small hot', rel: 'next' }));
      else pager.append(h('span', { class: 'note' }, t('nextOutside'), code(body.next)));
    } else if (body.next === null) pager.append(h('span', { class: 'mute' }, t('noMorePages')));
    out.push(pager);
    return out;
  }

  function itemsTable(coll, m, q, items) {
    let cols;
    if (q.fields.length) cols = q.fields.filter((f) => f !== 'id');
    else {
      const seen = new Set();
      for (const it of items) for (const k of Object.keys(it)) if (k !== 'id' && !k.startsWith('_')) seen.add(k);
      cols = [...seen];
    }
    return h('div', { class: 'tbl', tabindex: '0', role: 'region', 'aria-label': t('itemsOf', coll.name) }, h('table', null,
      h('caption', { class: 'sr' }, t('itemsCaption', coll.name)),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'id'), cols.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, items.map((it) => h('tr', null,
        h('th', { scope: 'row' }, typeof it.id === 'string' ? navLink(L.itemPath(coll, m.values, it.id), it.id) : renderValue(it.id)),
        cols.map((c) => h('td', { class: typeof it[c] === 'object' && it[c] !== null ? 'json' : null }, renderValue(it[c], c, coll, m.values, true))))))));
  }

  function queryForm(coll, m, q, e) {
    const form = h('form', { class: 'panel ink', novalidate: true, 'aria-labelledby': 'qf-h' });
    form.append(h('h3', { id: 'qf-h', class: 'mt0' }, t('query')));
    // Filtros (§6.1)
    const fRows = h('div');
    const addFilter = (f) => fRows.append(filterRow(coll, f));
    if (coll.filters.length) {
      q.filters.forEach(addFilter);
      form.append(h('fieldset', null, h('legend', null, t('filtersLegend')), fRows,
        h('button', { type: 'button', class: 'btn small', onclick: () => { addFilter(null); fRows.lastElementChild.querySelector('select').focus(); } }, icon('plus'), t('addFilter'))));
    } else form.append(h('p', { class: 'hint' }, t('noFilters')));
    // Filtros con nombre (§6.1): un interruptor es una casilla; uno con type, un valor de su tipo.
    const namedRows = [];
    if (coll.named.length) {
      const box = h('div', { class: 'named' });
      for (const f of coll.named) {
        const id = nextId('nf'), hid = nextId('nh');
        const on = Object.hasOwn(q.named, f.name);
        if (!f.type) {
          const el = h('input', { id, type: 'checkbox', checked: on, 'aria-describedby': f.description ? hid : null });
          namedRows.push(() => [f.name, el.checked ? '' : null]);
          box.append(h('div', { class: 'checks' }, h('label', { for: id }, el, code(f.name))), f.description ? h('p', { class: 'hint', id: hid, text: f.description }) : null);
        } else {
          const c = L.valueControl(f, 'eq');
          const el = c.kind === 'select'
            ? h('select', { id, 'aria-describedby': f.description ? hid : null }, h('option', { value: '' }, t('notApplied')), c.options.map(([v, label]) => h('option', { value: v }, label)))
            : h('input', { id, type: c.type, inputmode: c.inputmode, placeholder: c.placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': f.description ? hid : null });
          el.value = on ? q.named[f.name] : '';
          namedRows.push(() => [f.name, el.value === '' ? null : el.value]);
          box.append(h('div', null, h('label', { for: id }, code(f.name), ` · ${f.type}`), el), f.description ? h('p', { class: 'hint', id: hid, text: f.description }) : null);
        }
      }
      form.append(h('fieldset', null, h('legend', null, t('namedLegend')), box));
    }
    // Orden (§6.2)
    const sRows = h('div');
    const addSort = (s) => sRows.append(sortRow(coll, s));
    if (coll.sort.length) {
      q.sort.forEach(addSort);
      form.append(h('fieldset', null, h('legend', null, t('sort')), sRows,
        h('button', { type: 'button', class: 'btn small', onclick: () => { addSort(null); sRows.lastElementChild.querySelector('select').focus(); } }, icon('plus'), t('addSort'))));
    }
    // Campos (§6.3): del esquema del elemento si es un objeto; si no, de los elementos de esta página.
    const known = new Set();
    const schema = coll.schemas.item;
    if (isObj(schema) && isObj(schema.properties)) Object.keys(schema.properties).forEach((k) => known.add(k));
    if (isObj(e.json) && Array.isArray(e.json.items)) for (const it of e.json.items) if (isObj(it)) Object.keys(it).forEach((k) => known.add(k));
    q.fields.forEach((f) => known.add(f));
    known.delete('id');
    const fieldNames = [...known].filter((k) => !k.startsWith('_'));
    if (fieldNames.length) {
      form.append(h('fieldset', null, h('legend', null, t('fieldsLegend')),
        h('div', { class: 'checks' }, fieldNames.map((f) => h('label', null, h('input', { type: 'checkbox', name: 'fields', value: f, checked: q.fields.includes(f) }), f)))));
    }
    // include (§9): las relaciones incluibles y, hasta include_depth, las de sus destinos (category.parent).
    const incl = L.includePaths(state.disc, coll);
    if (L.has(state.disc, 'relations') && incl.length) {
      form.append(h('fieldset', null, h('legend', null, t('includeLegend')),
        h('div', { class: 'checks' }, incl.map((p) => h('label', null, h('input', { type: 'checkbox', name: 'include', value: p, checked: q.include.includes(p) }), p)))));
    }
    // limit y count (§6.4, §6.5)
    const limId = nextId('limit'), cntId = nextId('count');
    const row = h('div', { class: 'row' },
      h('div', null, h('label', { for: limId }, 'limit'), h('input', { id: limId, name: 'limit', type: 'number', inputmode: 'numeric', min: '1', max: coll.maxLimit ? String(coll.maxLimit) : null, value: q.limit, placeholder: coll.maxLimit ? `1–${coll.maxLimit}` : '', class: 'w9' })));
    if (coll.count) row.append(h('div', { class: 'checks tall' }, h('label', { for: cntId }, h('input', { id: cntId, type: 'checkbox', name: 'count', checked: q.count }), t('countTotal', t(coll.count === 'exact' ? 'exact' : 'estimated')))));
    form.append(row);
    const preview = h('p', { class: 'hint', 'aria-live': 'polite' });
    const read = () => {
      const nq = L.emptyQuery();
      nq.extra = q.extra;
      for (const r of fRows.children) nq.filters.push(r.readFilter());
      for (const read of namedRows) { const [name, v] = read(); if (v !== null) nq.named[name] = v; }
      for (const r of sRows.children) nq.sort.push(r.readSort());
      nq.fields = [...form.querySelectorAll('input[name=fields]:checked')].map((x) => x.value);
      nq.include = [...form.querySelectorAll('input[name=include]:checked')].map((x) => x.value);
      nq.limit = form.querySelector('input[name=limit]').value.trim();
      nq.count = !!form.querySelector('input[name=count]')?.checked;
      return nq;
    };
    const update = () => { preview.textContent = `GET ${L.withQuery(m.pathname, L.buildQuery(read()))}`; };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('click', (ev) => { if (ev.target.closest('button')) setTimeout(update); });
    form.addEventListener('submit', (ev) => { ev.preventDefault(); go(L.withQuery(m.pathname, L.buildQuery(read()))); });
    form.append(preview, h('div', { class: 'row mt8' },
      h('button', { type: 'submit', class: 'btn hot' }, icon('go'), t('runQuery')),
      h('button', { type: 'button', class: 'btn', onclick: () => go(m.pathname) }, t('clear'))));
    update();
    return form;
  }

  function filterRow(coll, f) {
    const row = h('div', { class: 'frow' });
    const ids = { field: nextId('ff'), op: nextId('fo'), val: nextId('fv'), hint: nextId('fh') };
    const fieldSel = h('select', { id: ids.field }, coll.filters.map((x) => h('option', { value: x.field }, x.field)));
    const opSel = h('select', { id: ids.op });
    const valBox = h('div', { class: 'v' });
    let valueEl;
    const current = () => coll.filters.find((x) => x.field === fieldSel.value) ?? coll.filters[0];
    const rebuildOps = (want) => {
      const flt = current();
      opSel.replaceChildren(...flt.ops.map((o) => h('option', { value: o }, `${o} · ${L.opLabel(o) ?? o}`)));
      if (want && flt.ops.includes(want)) opSel.value = want;
    };
    const rebuildValue = (val) => {
      const c = L.valueControl(current(), opSel.value);
      valueEl = c.kind === 'select'
        ? h('select', { id: ids.val }, c.options.map(([v, label]) => h('option', { value: v }, label)))
        : h('input', { id: ids.val, type: c.type, inputmode: c.inputmode, placeholder: c.placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': c.hint ? ids.hint : null });
      if (val !== undefined) valueEl.value = val;
      valBox.replaceChildren(h('label', { for: ids.val }, t('value')), valueEl, c.hint ? h('p', { class: 'hint', id: ids.hint, text: c.hint }) : null);
    };
    if (f && coll.filters.some((x) => x.field === f.field)) fieldSel.value = f.field;
    else if (f) fieldSel.prepend(h('option', { value: f.field }, `${f.field} ${t('undeclared')}`)), fieldSel.value = f.field;
    const known = coll.filters.some((x) => x.field === fieldSel.value);
    if (known) rebuildOps(f?.op);
    else opSel.append(h('option', { value: f.op }, f.op));
    if (known) rebuildValue(f?.value);
    else { valueEl = h('input', { id: ids.val, value: f.value }); valBox.replaceChildren(h('label', { for: ids.val }, t('value')), valueEl); }
    fieldSel.addEventListener('change', () => { rebuildOps(opSel.value); rebuildValue(); });
    opSel.addEventListener('change', () => rebuildValue(opSel.value === 'null' || valueEl.tagName === 'SELECT' ? undefined : valueEl.value));
    row.readFilter = () => ({ field: fieldSel.value, op: opSel.value, value: valueEl.value });
    row.append(
      h('div', null, h('label', { for: ids.field }, t('field')), fieldSel),
      h('div', null, h('label', { for: ids.op }, t('operator')), opSel),
      valBox,
      h('button', { type: 'button', class: 'btn small x', 'aria-label': t('removeFilter'), onclick: () => { const form = row.closest('form'); row.remove(); form?.dispatchEvent(new Event('change')); } }, icon('x')));
    return row;
  }

  function sortRow(coll, s) {
    const row = h('div', { class: 'srow' });
    const idf = nextId('sf'), idd = nextId('sd');
    const fieldSel = h('select', { id: idf }, coll.sort.map((x) => h('option', { value: x }, x)));
    if (s && !coll.sort.includes(s.field)) fieldSel.prepend(h('option', { value: s.field }, `${s.field} ${t('undeclared')}`));
    if (s) fieldSel.value = s.field;
    const dirSel = h('select', { id: idd }, h('option', { value: 'asc' }, t('asc')), h('option', { value: 'desc' }, t('desc')));
    if (s?.desc) dirSel.value = 'desc';
    row.readSort = () => ({ field: fieldSel.value, desc: dirSel.value === 'desc' });
    row.append(h('div', null, h('label', { for: idf }, t('field')), fieldSel), h('div', null, h('label', { for: idd }, t('direction')), dirSel),
      h('button', { type: 'button', class: 'btn small x', 'aria-label': t('removeSort'), onclick: () => { const form = row.closest('form'); row.remove(); form?.dispatchEvent(new Event('change')); } }, icon('x')));
    return row;
  }

  // ── Esquemas (§4.3): objeto o enlace; los de otro origen se piden sin credenciales ──
  async function resolveSchema(s) {
    if (isObj(s)) return s;
    if (typeof s !== 'string') return null;
    let u;
    try { u = new URL(s, state.discEntry?.responseUrl || state.root).href; } catch { return null; }
    if (state.schemaCache.has(u)) return state.schemaCache.get(u);
    const r = await request('GET', u);
    const out = r.ok && isObj(r.json) ? r.json : null;
    state.schemaCache.set(u, out);
    return out;
  }
  function schemaDetails(schema) {
    if (!schema) return null;
    return h('details', null, h('summary', null, t('seeSchema')), h('pre', { tabindex: '0' }, h('code', { text: JSON.stringify(schema, null, 2) })));
  }

  // Un formulario de cuerpo JSON con Idempotency-Key automática: la misma clave mientras no llegue
  // respuesta, para que un reintento tras un fallo de red no duplique nada (§7.1).
  function jsonForm({ title, intro, initial, schema, method, idempotency, ifMatch, submitLabel, submitIcon, onDone, makeRequest, danger, noBody, emptyMessage = t('noChanges') }) {
    const form = h('form', { novalidate: true });
    const taId = nextId('body'), hintId = nextId('bh');
    let key = idempotency ? L.newIdempotencyKey() : null;
    const keyOut = h('code', { text: key ?? '' });
    const result = h('div', { 'aria-live': 'polite' });
    const ta = noBody ? null : h('textarea', { id: taId, rows: String(Math.min(18, Math.max(5, JSON.stringify(initial ?? {}, null, 2).split('\n').length + 1))), spellcheck: 'false', 'aria-describedby': hintId, value: JSON.stringify(initial ?? {}, null, 2) });
    if (title) form.append(h('h4', null, title));
    if (intro) form.append(h('p', { class: 'hint', id: hintId }, intro));
    if (ta) form.append(h('label', { for: taId }, t('bodyJson')), ta);
    if (schema) form.append(schemaDetails(schema));
    const meta = h('p', { class: 'hint' });
    if (idempotency) meta.append('Idempotency-Key: ', keyOut, ` ${t('keyRenewed')} `);
    if (ifMatch !== undefined) meta.append(ifMatch ? h('span', null, 'If-Match: ', code(ifMatch)) : h('span', null, t('noIfMatch')));
    if (meta.childNodes.length) form.append(meta);
    form.append(h('div', { class: 'row mt8' }, h('button', { type: 'submit', class: `btn ${danger ? 'warn' : 'hot'}` }, icon(submitIcon), submitLabel)), result);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      let body;
      if (ta) {
        try { body = JSON.parse(ta.value); } catch (err) { result.replaceChildren(h('p', { class: 'problem', role: 'alert' }, t('badJson', err.message))); ta.focus(); return; }
      }
      const req = makeRequest(body);
      if (!req) { result.replaceChildren(h('p', { class: 'note', role: 'status' }, emptyMessage)); return; }
      const headers = { ...req.headers };
      if (key) headers['Idempotency-Key'] = key;
      if (ifMatch) headers['If-Match'] = ifMatch;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      setStatus(`${method} ${req.path}…`);
      const r = await request(method, req.path, { body: req.body, headers });
      btn.disabled = false;
      setStatus('');
      if (r.networkError) {
        result.replaceChildren(networkProblem(r), key ? h('p', { class: 'hint' }, t('retrySameKey')) : null);
        return;
      }
      if (key) { key = L.newIdempotencyKey(); keyOut.textContent = key; }
      if (!r.ok) { result.replaceChildren(problemBox(r, { alert: true })); return; }
      result.replaceChildren(h('p', { class: 'okmsg', role: 'status' }, `${r.status}${hdr(r, 'idempotent-replayed') === 'true' ? ` ${t('replayed')}` : ''}`));
      onDone?.(r);
    });
    return form;
  }

  function createBox(coll, m) {
    const box = h('details', { class: 'box ink' }, h('summary', null, t('createItem')));
    const writes = L.has(state.disc, 'writes');
    let built = false;
    box.addEventListener('toggle', async () => {
      if (!box.open || built) return;
      built = true;
      const loading = h('p', { class: 'mute' }, t('preparingForm'));
      box.append(loading);
      const schema = await resolveSchema(coll.schemas.create);
      // §4.3: el cuerpo empieza con los obligatorios y los default; con la acción new (§12), con lo que
      // devuelva GET colección:new para este cliente y este momento.
      let initial = L.createSkeleton(coll, schema), from = null;
      const act = L.newAction(state.disc, coll);
      if (act) {
        const path = `${m.pathname}:${act.name}`;
        const r = await request('GET', path);
        from = r.ok && isObj(r.json) ? t('newFilled', path) : t('newFailed', path, r.networkError ? '—' : String(r.status));
        if (r.ok && isObj(r.json)) initial = { ...initial, ...r.json };
      }
      loading.remove();
      const fields = L.formFields(schema);
      if (fields.length) box.append(formFieldsTable(coll, fields));
      box.append(jsonForm({
        intro: [t('createIntro', m.pathname, !!schema), coll.idFrom === 'client' ? t('idFromClient') : coll.idFrom === 'either' ? t('idFromEither') : coll.idFrom === 'unknown' ? t('idFromUnknown') : t('idFromServer'), from].filter(Boolean).join(' '),
        initial, schema, method: 'POST', idempotency: writes && (state.disc.idempotencyAnonymous || !!getToken()), submitLabel: t('create'), submitIcon: 'plus',
        makeRequest: (body) => ({ path: m.pathname, body: JSON.stringify(L.createPayload(coll, body)), headers: { 'Content-Type': 'application/json' } }),
        onDone: (r) => {
          const loc = hdr(r, 'location');
          const p = (loc && L.toApiPath(state.root, loc, r.responseUrl)) || (isObj(r.json) && typeof r.json.id === 'string' ? L.itemPath(coll, m.values, r.json.id) : null);
          if (p) { state.pendingNote = t('created', p); go(p); }
        },
      }));
    });
    return box;
  }

  // ── Acciones (§11.1) ────────────────────────────────────────────────────────
  function actionsBox(coll, acts, onItem, reload) {
    const writes = L.has(state.disc, 'writes');
    const sec = h('section', { class: 'panel ink', 'aria-labelledby': 'act-h' }, h('h3', { id: 'act-h', class: 'mt0' }, t('actions')));
    for (const a of acts) {
      const art = h('div', { class: 'action' });
      const badges = h('div', { class: 'badges' }, badge(a.method, 'm'), a.safe ? badge(t('safe')) : badge(t('unsafe'), 'x'), a.idempotent ? badge(t('idempotent')) : null);
      art.append(h('h4', null, code(`:${a.name}`)), badges, a.description ? h('p', { text: a.description }) : null);
      const build = async () => {
        const schema = a.method === 'POST' ? await resolveSchema(a.input) : null;
        art.append(jsonForm({
          intro: `${a.method} ${a.href}`, initial: schema ? L.skeleton(schema) : {}, schema, method: a.method, noBody: a.method === 'GET',
          idempotency: writes && a.method === 'POST' && !a.idempotent && (state.disc.idempotencyAnonymous || !!getToken()), submitLabel: t('run'), submitIcon: 'bolt',
          makeRequest: (body) => ({ path: a.href, body: a.method === 'GET' ? undefined : JSON.stringify(body), headers: a.method === 'GET' ? {} : { 'Content-Type': 'application/json' } }),
          onDone: (r) => {
            const loc = r.status === 201 ? hdr(r, 'location') : null;
            const p = loc && L.toApiPath(state.root, loc, r.responseUrl);
            if (p) { state.pendingNote = t('actionCreated', a.name, p); go(p); }
            else if (onItem && !a.safe && reload) { state.pendingNote = t('actionStatus', a.name, r.status); reload(); }
          },
        }));
      };
      build();
      sec.append(art);
    }
    return sec;
  }

  // ── Elemento ────────────────────────────────────────────────────────────────
  async function renderItem(m, path, id) {
    const coll = m.coll;
    renderSide(coll.templated ? null : coll.name);
    setStatus(t('loading', m.pathname));
    const e = await request('GET', path);
    if (id !== state.routeId) return;
    setStatus('');
    const collPath = L.expandTemplate(coll.path, m.values);
    const parts = [...header(`${coll.name} / ${m.id}`, t('itemKicker', m.pathname))];
    parts.push(h('p', null, navLink(collPath, h('span', null, icon('back'), ` ${t('backTo', collPath)}`))));
    if (state.pendingNote) { parts.push(h('p', { class: 'okmsg', role: 'status' }, state.pendingNote)); state.pendingNote = null; }
    if (!e.ok) { parts.push(problemBox(e)); view(parts); return; }
    const item = e.json;
    if (!isObj(item)) { parts.push(h('p', { class: 'note' }, t('notObject')), h('pre', null, h('code', { text: pretty(e) }))); view(parts); return; }
    const partial = /(^|&)(fields|include)=/.test(m.query);
    const etag = L.itemEtag(item, hdr(e, 'etag'), partial);
    // Campos
    const dl = h('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(item)) {
      if (k.startsWith('_')) continue;
      const dd = h('dd', null, renderValue(v, k, coll, m.values, false));
      const inh = coll.inherit.find((i) => i.field === k);
      if (inh) {
        const src = L.inheritedFrom(item._inherited, k);
        const p = src.kind === 'href' ? L.toApiPath(state.root, src.href, e.responseUrl) : null;
        dd.append(h('div', { class: 'hint' }, t('effective1'), code(inh.own), '. ',
          src.kind === 'default' ? t('fromDefault') : src.kind === 'own' ? t('ownValue') : p ? h('span', null, t('inheritedFrom'), navLink(p, p), '.')
            : src.kind === 'href' ? h('span', null, t('inheritedFrom'), code(src.href), '.') : t('fromHidden')));
      }
      dl.append(h('dt', { text: k }), dd);
    }
    parts.push(h('section', { class: 'panel ink', 'aria-label': t('fields') }, dl,
      h('p', { class: 'hint' }, t('itemEtag'), etag ? code(etag) : t('etagUnavailable'))));
    // Relaciones y subcolecciones (§9)
    const rels = L.relationLinks(state.disc, coll, m.values, item, state.root);
    const subs = L.subcollections(state.disc, coll, m.values, m.id);
    if (rels.length || subs.length) {
      const ul = h('ul');
      for (const r of rels) {
        const what = r.sub ? navLink(r.sub, r.sub) : r.links.length ? r.links.map((l, i) => [i ? ', ' : '', l.path ? navLink(l.path, `${l.to}/${l.id}`) : code(`${l.to}/${l.id}`)]) : h('span', { class: 'mute' }, t(r.empty ? 'relEmpty' : 'relAbsent'));
        ul.append(h('li', null, code(r.rel.name), ` → ${r.rel.to.join(' | ') || '?'}${r.rel.many ? t('toMany') : ''}: `, what));
      }
      for (const s of subs) ul.append(h('li', null, t('subcollection'), code(s.coll.name), ': ', navLink(s.path, s.path)));
      parts.push(h('section', { class: 'panel ink', 'aria-labelledby': 'rel-h' }, h('h3', { id: 'rel-h', class: 'mt0' }, t('relations')), ul));
    }
    // Acciones: _actions dice cuáles están disponibles ahora; si no lo trae, las declaradas.
    const reload = () => route();
    if (L.has(state.disc, 'actions') || isObj(item._actions)) {
      let acts;
      if (isObj(item._actions)) {
        // §11.1: un method desconocido en _actions: la acción no se ofrece.
        acts = Object.entries(item._actions).filter(([, a]) => isObj(a) && typeof a.href === 'string' && [undefined, 'GET', 'POST'].includes(a.method)).map(([name, a]) => {
          const decl = coll.actions.find((x) => x.name === name) ?? { name, on: 'item', safe: false, idempotent: false, description: '', input: null };
          return { ...decl, name, method: a.method === 'GET' ? 'GET' : 'POST', href: L.toApiPath(state.root, a.href, e.responseUrl) ?? a.href };
        });
      } else acts = coll.actions.filter((a) => a.on === 'item').map((a) => ({ ...a, href: `${m.pathname}:${a.name}` }));
      if (acts.length) parts.push(actionsBox(coll, acts, true, reload));
    }
    const writes = L.has(state.disc, 'writes');
    // Editar (§5.1: PATCH con Merge Patch; §7.2: If-Match)
    if (L.allows(coll.itemMethods, 'PATCH')) {
      const original = L.editableCopy(coll, item);
      const whole = coll.relations.map((r) => r.name);
      parts.push(h('details', { class: 'box ink' }, h('summary', null, t('editPatch')), jsonForm({
        intro: t('editIntro'),
        initial: original, method: 'PATCH', ifMatch: writes ? etag ?? null : undefined, submitLabel: t('saveChanges'), submitIcon: 'save',
        makeRequest: (body) => {
          if (!isObj(body)) return { path: m.pathname, body: JSON.stringify(body), headers: { 'Content-Type': 'application/merge-patch+json' } };
          const diff = L.mergeDiff(original, body, whole);
          return Object.keys(diff).length ? { path: m.pathname, body: JSON.stringify(diff), headers: { 'Content-Type': 'application/merge-patch+json' } } : null;
        },
        onDone: () => { state.pendingNote = t('saved'); reload(); },
      })));
    }
    // Borrar
    if (L.allows(coll.itemMethods, 'DELETE')) {
      const form = jsonForm({
        intro: t('deleteIntro'), noBody: true, method: 'DELETE', ifMatch: writes ? etag ?? null : undefined,
        submitLabel: t('delete'), submitIcon: 'trash', danger: true, emptyMessage: t('nothingDeleted'),
        makeRequest: () => (window.confirm(t('confirmDelete', m.pathname)) ? { path: m.pathname, headers: {} } : null),
        onDone: () => { state.pendingNote = t('deleted', m.pathname); go(collPath); },
      });
      parts.push(h('details', { class: 'box ink' }, h('summary', null, t('deleteBox')), form));
    }
    view(parts);
  }

  // ── Recurso suelto (§5.9): se lee y, si admite PATCH, se edita con Merge Patch e If-Match ──
  async function renderSingleton(m, path, id) {
    const sg = m.singleton;
    renderSide(`singleton:${sg.name}`);
    setStatus(t('loading', m.pathname));
    const e = await request('GET', path);
    if (id !== state.routeId) return;
    setStatus('');
    const parts = [...header(sg.name, t('singletonKicker', m.pathname))];
    if (state.pendingNote) { parts.push(h('p', { class: 'okmsg', role: 'status' }, state.pendingNote)); state.pendingNote = null; }
    if (sg.description) parts.push(h('p', { text: sg.description }));
    if (sg.methods) parts.push(h('div', { class: 'badges', 'aria-label': t('declaredMethods') }, sg.methods.map((x) => badge(x, 'm'))));
    if (sg.deprecations.length) parts.push(deprecationsBox(sg.deprecations));
    if (!e.ok) { parts.push(problemBox(e)); view(parts); return; }
    const item = e.json;
    if (!isObj(item)) { parts.push(h('p', { class: 'note' }, t('notObject')), h('pre', null, h('code', { text: pretty(e) }))); view(parts); return; }
    const partial = /(^|&)fields=/.test(m.query);
    const etag = L.itemEtag(item, hdr(e, 'etag'), partial);
    const dl = h('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(item)) if (!k.startsWith('_')) dl.append(h('dt', { text: k }), h('dd', null, renderValue(v, k, null, [], false)));
    parts.push(h('section', { class: 'panel ink', 'aria-label': t('fields') }, dl,
      h('p', { class: 'hint' }, t('itemEtag'), etag ? code(etag) : t('etagUnavailable'))));
    if (L.allows(sg.methods, 'PATCH')) {
      // Sin id ni colección; los readOnly del esquema item no se ofrecen (§5.1, §5.9).
      const original = L.editableCopy({ schemas: sg.schemas }, item);
      const writes = L.has(state.disc, 'writes');
      parts.push(h('details', { class: 'box ink' }, h('summary', null, t('editPatch')), jsonForm({
        intro: t('editIntro'), initial: original, method: 'PATCH', ifMatch: writes ? etag ?? null : undefined, submitLabel: t('saveChanges'), submitIcon: 'save',
        makeRequest: (body) => {
          if (!isObj(body)) return { path: m.pathname, body: JSON.stringify(body), headers: { 'Content-Type': 'application/merge-patch+json' } };
          const diff = L.mergeDiff(original, body);
          return Object.keys(diff).length ? { path: m.pathname, body: JSON.stringify(diff), headers: { 'Content-Type': 'application/merge-patch+json' } } : null;
        },
        onDone: () => { state.pendingNote = t('saved'); route(); },
      })));
    }
    view(parts);
  }

  // ── Cualquier otra ruta ─────────────────────────────────────────────────────
  async function renderRaw(path, id) {
    renderSide(null);
    setStatus(t('loading', path));
    const e = await request('GET', path);
    if (id !== state.routeId) return;
    setStatus('');
    const parts = [...header(path, t('undeclaredPath'))];
    if (!e.ok) parts.push(problemBox(e));
    else parts.push(h('p', null, `${e.status} · ${e.contentType || t('noContentType')}`), h('pre', { tabindex: '0' }, h('code', { text: truncate(pretty(e), 40000) })));
    view(parts);
  }

  // ── Enrutado ────────────────────────────────────────────────────────────────
  // El enlace a la otra versión de idioma conserva dónde estás (el hash nunca lleva el token).
  const otherLang = $('#other-lang');
  const otherLangBase = otherLang ? otherLang.getAttribute('href').replace(/#.*$/, '') : '';
  async function route() {
    const id = ++state.routeId;
    const { api, path } = L.readHash(location.hash);
    if (otherLang) otherLang.setAttribute('href', otherLangBase + (api ? location.hash : ''));
    $('#welcome').replaceChildren();
    if (!api) { state.root = ''; renderWelcome(); return; }
    let root;
    try { root = L.normalizeRoot(api); } catch (err) { setStatus(err.message); renderWelcome(); return; }
    $('#api-url').value = root;
    if (root !== state.root || !state.disc) {
      state.root = root; state.disc = null; state.schemaCache.clear();
      $('#token').value = getToken() ?? '';
      await loadDiscovery();
      if (id !== state.routeId) return;
    }
    $('#layout').hidden = false; $('#pathbar').hidden = false;
    $('#path').value = path || '/';
    const m = L.matchPath(state.disc, path || '/');
    if (m.kind === 'root') { renderOverview(); return; }
    if (m.kind === 'collection') return renderCollection(m, path, id);
    if (m.kind === 'item') return renderItem(m, path, id);
    if (m.kind === 'singleton') return renderSingleton(m, path, id);
    return renderRaw(path, id);
  }

  // ── Controles fijos ─────────────────────────────────────────────────────────
  $('#connect').addEventListener('submit', (ev) => {
    ev.preventDefault();
    let root;
    try { root = L.normalizeRoot($('#api-url').value); } catch (err) { setStatus(err.message); $('#api-url').focus(); return; }
    state.disc = null; // vuelve a leer el descubrimiento aunque sea la misma API
    state.root = root;
    go('/');
  });
  $('#pathbar').addEventListener('submit', (ev) => {
    ev.preventDefault();
    let p = $('#path').value.trim() || '/';
    const asApi = /^[a-z][a-z0-9+.-]*:/i.test(p) ? L.toApiPath(state.root, p) : null;
    if (asApi) p = asApi;
    else if (!p.startsWith('/')) p = '/' + p;
    go(p);
  });
  $('#reload').addEventListener('click', () => { state.disc = null; state.userNav = false; route(); });
  $('#token-save').addEventListener('click', () => {
    const root = state.root || (() => { try { return L.normalizeRoot($('#api-url').value); } catch { return ''; } })();
    if (!root) { setStatus(t('urlFirst')); return; }
    session.set(tokenKey(root), $('#token').value.trim());
    setStatus($('#token').value.trim() ? t('tokenSaved', originOf(root)) : t('tokenRemoved'));
    state.disc = null;
    if (state.root) route();
  });
  $('#token-forget').addEventListener('click', () => {
    if (state.root) session.set(tokenKey(state.root), null);
    $('#token').value = '';
    setStatus(t('tokenForgotten'));
    state.disc = null;
    if (state.root) route();
  });
  $('#lang').value = langPref();
  $('#lang-save').addEventListener('click', () => {
    local.set('restep-explorer:lang', $('#lang').value.trim());
    setStatus(t('langApplied'));
    state.disc = null;
    if (state.root) route();
  });
  // Tema: automático, claro u oscuro.
  const THEMES = { auto: [t('themeAuto'), 'auto'], light: [t('themeLight'), 'sun'], dark: [t('themeDark'), 'moon'] };
  const themeBtn = $('#theme');
  const paintTheme = () => {
    const th = document.documentElement.dataset.theme || 'auto';
    themeBtn.replaceChildren(icon(THEMES[th][1]), t('theme', THEMES[th][0]));
  };
  themeBtn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const th = order[(order.indexOf(document.documentElement.dataset.theme || 'auto') + 1) % 3];
    if (th === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
    local.set('restep-explorer:theme', th === 'auto' ? null : th);
    paintTheme();
  });
  paintTheme();
  window.addEventListener('hashchange', () => { state.userNav = true; route(); });
  route();
})();
