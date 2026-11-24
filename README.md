# restep-explorer

Web explorer for any Restep 1 API, the equivalent of Swagger UI without OpenAPI: it reads the
discovery document (§4.2) and builds the whole interface from it. No dependencies, no CDN and no
external fonts, in English and Spanish. It is published at `restep.wubytes.com`:
`/explorer/` (English) and `/es/explorador/` (Spanish).

## Files

The source lives here; `build.mjs` generates what is published in `public/`.

| Source | What it is |
|---|---|
| `page.html` | Page template: `{{key}}` (dictionary text, escaped), `{{{keyHtml}}}` (dictionary markup) and `{{=variable}}` (paths and URLs set by `build.mjs`). |
| `explorer-i18n.js` | The text dictionary, `en` and `es`, the only place with text. Used by `build.mjs` and by the page. |
| `explorer-logic.js` | Pure logic, no DOM (`RestepLogic`): tested in Node. Takes the language from `<html lang>`. |
| `explorer.js` | The interface: builds the page with the DOM on top of `RestepLogic`. |
| `explorer-theme.js` | Applies the saved theme before painting (loaded without `defer`). |
| `explorer.css` | Styles. |

```bash
node tools/restep-explorer/build.mjs       # from projects/restep
```

writes `public/explorer/index.html` (`lang="en"`), `public/es/explorador/index.html`
(`lang="es"`) and, in `public/explorer/`, the shared `.css` and `.js` files, which both pages load
with the absolute path `/explorer/…`. They are classic scripts (with `defer`, in order), not ES
modules: no `modulepreload` needed. If they ever become modules, each page has to preload the
whole graph.

### CSP

The pages carry no inline script or style, no `style=`, and no `on*=` handlers (the interface uses
classes and `addEventListener`). The CSP goes in the HTTP header, not in a `<meta>`; for
`/explorer/*` and `/es/explorador/*` it must be:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

The global CSP in `public/_headers` (`script-src 'none'`) does not let the explorer work: those two
paths need their own. `connect-src http: https:` is what allows talking to any API.

## What it does

- **API overview**: Restep and API version, profiles, extensions, announced deprecations (§5.5),
  a button to query the status resource (§4.4) and, per collection, path, description, methods,
  filters with their type and operators, sort, `limit`, `count`, relations, language maps,
  inherited fields, actions and schemas; plus each singleton (§5.9).
- **Collection**: a query form generated from discovery (filters with the control each type and
  operator calls for, sort keys, `fields`, `include` if there are `relations` (with paths up to
  `include_depth`, such as `category.parent`; a relation to several collections only at the end),
  `limit` up to `max_limit` and `count` if declared), an item table, the count (exact or
  estimated), "Next page" following `next` as is (§5.2) and "First page".
- **Item**: every field; language maps with all their translations, and the one shown in tables
  chosen by `Accept-Language` or the browser language, without making up missing ones; inherited
  fields with their source (`_inherited`, §11.6); the item ETag; relations and subcollections as
  navigable links.
- **Writes**: create (`POST` with a starting body derived from the `create` schema), edit
  (`PATCH`: you edit the JSON and only the minimal merge patch is sent, with whole relations,
  §5.1) and delete (with confirmation). With the `writes` profile, `If-Match` comes from `_etag`
  or the `ETag` header, and `Idempotency-Key` is generated automatically on every `POST`; the same
  key is kept until a response arrives, so a retry after a network drop does not duplicate
  anything (§7.1).
- **Singleton** (§5.9): each one in `singletons` gets its link in the sidebar and its own view,
  with its fields, its ETag and, if `methods` includes `PATCH` or is not declared, "Edit"
  (minimal merge patch with `If-Match`).
- **Actions** (§11.1): those in the item's `_actions` if it has them (the ones available in its
  state), otherwise the declared ones; with their `input` schema, `GET` or `POST` method, and
  `Idempotency-Key` on non-idempotent ones.
- **Errors**: `problem+json` responses are shown with `code`, `detail`, `parameter`, `reason`, the
  `errors` table and an explanation of what to do (`unsupported_parameter`: remove it;
  `invalid_parameter`: fix it; an unknown code, by status class, §5.4).
- **Requests**: the last eight, each with its equivalent `curl` (copy button), the response
  headers CORS lets it read, and the body.
- **Free path**: a bar to go to any path relative to the root, also on an API without a discovery
  document (`core` only).
- **State in the URL**: `#api=<root>&path=<path with its query>`, readable and shareable. Example:
  `#api=http://localhost:8080/&path=/books?filter[price][le]=20%26sort=-price`.
- Keyboard support, labels on every control, an `aria-live` region for notices, focus on view
  change, light and dark mode (automatic or chosen), and a mobile layout.

### What it understands from draft 6 (§12.2)

- **Version** (§1.1): `restep` must follow the grammar (`1.0`, `1.0-draft.6`, `1.0-rc.1`…) with
  major version 1. Otherwise the overview says it is not Restep 1 and offers nothing else (nor
  does it assume plain `core`). With a suffix, it warns that it is a draft or a candidate.
- **Experimental parts** (§1.2): the explorer implements the draft 6 text of `inherit` and only
  uses it (read-only effective field when editing, source of `_inherited`) if the API announces
  the `inherit` extension and declares exactly `"restep": "1.0-draft.6"`. With another version it
  ignores those members and says so in the overview. Of `sync` and `batch` it only shows what
  they declare, without using them.
- **Unknown values** (§4.2): a filter with an unknown `type` is not offered, only known operators
  of a filter are offered, a named filter with an unknown `type` is not offered, an action with
  an unknown `on` or `method` (also in `_actions`) is not offered, and a deprecation notice with a
  `kind` that does not match its place is not shown. An unknown `from` in `_inherited` is shown
  as coming from a source you cannot see ("hidden", §11.6).
- **`id_from`** (§5.1): with `"client"` the starting body for a create carries a random `id`; with
  an unknown value the `id` is always removed before sending; without `id_from` or with `"server"`
  whatever you write is sent (and the server answers `422` if you include an `id`).
- **Singletons with a template or `parent`** (§5.9): ignored.
- **Links** (§3): it does not fetch any URL whose scheme is neither `https` nor the root's;
  relations that carry `href` (mandatory towards a subcollection) are linked through it.
- **`idempotency.anonymous: false`** (§7.1): without a token, `POST` requests carry no
  `Idempotency-Key`.
- `POST` requests (create and actions, also with a `{}` body) go with
  `Content-Type: application/json`, and a literal `+` in the query goes out as `%2B` (§3, §5.2).

### Token and privacy

- The Bearer token is stored only in `sessionStorage` (cleared when the tab closes), with one key
  per API origin, and is only sent to that origin: a schema or link on another origin is fetched
  without it (§4.3). So a shared link pointing at another API does not send it your token.
- It never goes in the hash or in the `curl`, which uses `"Authorization: Bearer $RESTEP_TOKEN"`.
- `localStorage` holds only the chosen theme and `Accept-Language`.
- The page is served with a strict CSP (see above; only its own scripts and styles, and
  connecting over `http:` or `https:`), referrer disabled, and it never uses `innerHTML`.
- The link to the other language version keeps the hash (the API and the path, never the token).

## Usage

It is published at <https://restep.wubytes.com/explorer/> (in Spanish,
<https://restep.wubytes.com/es/explorador/>): nothing to install. To try it locally, from the
site folder:

```bash
node vendor/restep-server.mjs                         # a test API on :8080
npx serve public                                          # then open /explorer/ or /es/explorador/
```

Type the API root (for example `http://localhost:8080/`) and press "Explore". If the page and the
API are on different origins (the usual case), the API has to allow CORS: see below. The
reference server does not, so to try it locally you have two options: serve both from the same
origin, or use a copy with CORS, as `test.mjs` does.

## CORS: what the API has to send

The browser only lets the page talk to an API on another origin if the API allows it. For the
explorer, the API needs:

```
# On every response (errors too):
Access-Control-Allow-Origin: *              (or the explorer's origin)
Access-Control-Expose-Headers: ETag, Location, Link, Allow, WWW-Authenticate, Retry-After,
  Idempotent-Replayed, Preference-Applied, Content-Language, Deprecation, Sunset, Accept-Patch

# On the response to the preflight (OPTIONS with Access-Control-Request-Method):
Access-Control-Allow-Methods: GET, HEAD, POST, PATCH, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-None-Match,
  Idempotency-Key, Prefer, Accept-Language
Access-Control-Max-Age: 600
```

- Without `ETag` in `Expose-Headers`, the explorer cannot read the item ETag: to write with
  `If-Match` it then needs `_etag` in the representation. It warns about this.
- Without `Location`, after a create it goes to the item by the `id` in the body.
- Without `WWW-Authenticate`, it cannot show the challenge of a `401` or the link to the OAuth
  metadata (§11.5 already requires exposing it).
- Without `Link`, it cannot follow a `service-desc` when the root is not the discovery document.
- `Access-Control-Allow-Headers: *` does not cover `Authorization`: it has to be named.
- APIs with `Access-Control-Allow-Origin: *` work with a token, because the explorer sends it in
  `Authorization`, not in cookies.
- Published at `https://restep.wubytes.com`, the explorer can call `http://localhost:…` in Chrome
  and Firefox (localhost counts as secure), but Chrome may also ask for
  `Access-Control-Allow-Private-Network: true` on the preflight (Private Network Access). Any
  other API on `http:` is blocked by the browser as mixed content.

## Tests

```bash
node tools/restep-explorer/build.mjs       # from projects/restep
node tools/restep-explorer/test.mjs
```

They test the built version, and fail if `public/` is not up to date with the source.

- **Pure logic**: the published `explorer-i18n.js` and `explorer-logic.js` are evaluated in Node
  (vm), in English and Spanish (discovery parsing, paths and templates, query builder and reader,
  minimal merge patch, starting bodies, ETag, relations, translations, `Link`, `curl`, errors and
  texts). The dictionary has the same keys in both languages and every key the code uses.
- **Pages**: in both, nothing inline (no `<script>` without `src`, no `<style>`, no `style=`, no
  `on*=`), only own resources, `lang`, title, description, canonical, `hreflang`, `og:*`, favicon
  and the site header with its nav and language switch; in the JS, no `innerHTML`,
  `setAttribute('style')` or `eval`.
- **Integration**: copies the reference server to a temporary directory, adds CORS to it (the
  original is untouched), starts it on `:8840` and serves the pages from `public/` on `:8841`, with
  the CSP above as an HTTP header. It checks the CORS preflight and the logic against the real
  API: queries, pagination with `next`, errors, `PATCH` with `If-Match` (and the `412` with a stale
  ETag), a repeated `POST` with the same `Idempotency-Key`, `DELETE`, the `PATCH` of the `/shop`
  singleton, the `reviews` subcollection from its book (404 without it, deleted along with it),
  `include` with depth 2, the `highlight` relation linked through its `href`, the polymorphic
  `showcase` through its `type`, and the actions `low_stock` (collection `GET`), `restock` (item
  `POST` with `input`, through the `href` in `_actions`), `find_or_create` and `inherit_tax`
  (idempotent).
- **Browser**: if it finds Chrome or Chromium (or `CHROME=/path`), it starts it headless with the
  DevTools protocol on `:8842`, loads both pages (a filtered collection, an item with language
  maps and a relation, the `/shop` singleton, an error, the theme and the language link) and fails
  if the console shows any CSP violation (it also listens for `securitypolicyviolation`), an
  exception or a `console.error`. If there is no browser, those tests are skipped.

## Limits

- It does not implement `sync` (`:changes`, SSE notifications), `batch`, `filter-expr` (a
  `filter=…` typed in the path bar is kept, but there is no form) or `query-method`.
- `fields` offers the fields of the `item` schema if it is an embedded object and, otherwise, the
  ones that appear on the current page.
- Schemas are used for the starting body and are shown, but nothing is validated against them
  before sending: the API validates and the explorer shows its `422`.
- Subcollections can only be opened from an item of their parent collection, which is found by
  path prefix, not by `parent` (§4.2).
- It does not show `id_from`, `collations` or `parent` on collection cards, nor does it annotate
  responses that carry `Deprecation` (they only appear in the header log).
- On a singleton there is no `fields` form (§5.9), and its relations are shown as JSON, without
  linking their `href`.
- It does not revalidate discovery according to its `Cache-Control` (§4.2): it reads it again on
  changing API, on saving the token or the language, and with "Reload".
- There is no `Prefer: return=minimal` and no `If-None-Match`: every read goes with
  `cache: no-store`.

## Open questions about the spec

- **CORS for browser clients.** Resolved in §5.8 of draft 5: exposed headers, preflight and `Vary: Origin`. The API configuration is still needed.
- **Which template variable maps to which parent.** Resolved in draft 6: the subcollection
  declares `parent` and its path starts with the parent's (§4.2).
- **Relations to a collection with a template.** Resolved in draft 6: the relation object
  carries `href` (§3), and the explorer links through it.
- **Field list without a schema.** Without `schemas.item` there is no way to know which fields
  `fields` accepts other than looking at items; an item with a missing field hides it.
- **`_actions` with an undeclared action.** Resolved in draft 6: `_actions` only lists declared
  actions, with their method (§11.1). If a server lists another one, the explorer still treats it
  as unsafe and non-idempotent, and gives it an `Idempotency-Key`.
- **Which text of an experimental part a client implements for `"1.0"`.** §1.2 asks the client
  to implement "the text of the version the server declares". The explorer only knows the draft 6
  text; it cannot know whether the published 1.0 will keep it, so with `"1.0"` it ignores
  `inherit` (the checker, by contrast, accepts `1.0-draft.6` and `1.0`).

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-explorer>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
