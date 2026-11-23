# restep-explorer

Explorador web de cualquier API Restep 1, el equivalente a Swagger UI sin OpenAPI: lee el
documento de descubrimiento (§4.2) y construye a partir de él toda la interfaz. Sin dependencias,
sin CDN y sin fuentes externas, en inglés y en español. Se publica en `restep.wubytes.com`:
`/explorer/` (inglés) y `/es/explorador/` (español).

## Archivos

La fuente está aquí; `build.mjs` genera lo publicado en `public/`.

| Fuente | Qué es |
|---|---|
| `page.html` | Plantilla de la página: `{{clave}}` (texto del diccionario, escapado), `{{{claveHtml}}}` (marcado del diccionario) y `{{=variable}}` (rutas y URL que pone `build.mjs`). |
| `explorer-i18n.js` | El diccionario de textos, `en` y `es`, el único sitio con textos. Lo usan `build.mjs` y la página. |
| `explorer-logic.js` | Lógica pura, sin DOM (`RestepLogic`): se prueba en Node. Toma el idioma de `<html lang>`. |
| `explorer.js` | La interfaz: construye la página con DOM a partir de `RestepLogic`. |
| `explorer-theme.js` | Aplica el tema guardado antes de pintar (se carga sin `defer`). |
| `explorer.css` | Estilos. |

```bash
node tools/restep-explorer/build.mjs       # desde projects/restep
```

escribe `public/explorer/index.html` (`lang="en"`), `public/es/explorador/index.html`
(`lang="es"`) y, en `public/explorer/`, los `.css` y `.js` compartidos, que las dos páginas cargan
con ruta absoluta `/explorer/…`. Son scripts clásicos (con `defer`, en orden), no módulos ES: no
hace falta `modulepreload`. Si algún día pasan a módulos, cada página tiene que precargar todo el
grafo.

### CSP

Las páginas no llevan ningún script ni estilo en línea, ni `style=`, ni manejadores `on*=` (la
interfaz usa clases y `addEventListener`). La CSP va en la cabecera HTTP, no en un `<meta>`; para
`/explorer/*` y `/es/explorador/*` tiene que ser:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

La CSP global de `public/_headers` (`script-src 'none'`) no deja funcionar el explorador: esas dos
rutas necesitan la suya. `connect-src http: https:` es lo que permite hablar con cualquier API.

## Qué hace

- **Resumen de la API**: versión de Restep y de la API, perfiles, extensiones, retiradas
  anunciadas (§5.5), botón para consultar el recurso de estado (§4.4) y, por colección, ruta,
  descripción, métodos, filtros con su tipo y operadores, orden, `limit`, `count`, relaciones,
  mapas de idioma, campos heredados, acciones y esquemas; y cada recurso suelto (§5.9).
- **Colección**: formulario de consulta generado del descubrimiento (filtros con el control que
  pide cada tipo y operador, claves de orden, `fields`, `include` si hay `relations` (con las rutas hasta
  `include_depth`, como `category.parent`; una relación a varias colecciones solo al final), `limit`
  hasta `max_limit` y `count` si se declara), tabla de elementos, recuento (exacto o
  estimado), «Página siguiente» siguiendo `next` tal cual (§5.2) y «Primera página».
- **Elemento**: todos los campos; los mapas de idioma con todas sus traducciones y la que se
  muestra en las tablas elegida por `Accept-Language` o el idioma del navegador, sin inventar
  las que faltan; los campos heredados con su origen (`_inherited`, §11.6); la ETag de
  elemento; las relaciones y subcolecciones como enlaces navegables.
- **Escrituras**: crear (`POST` con un cuerpo de partida sacado del esquema `create`), editar
  (`PATCH`: editas el JSON y se envía solo el merge patch mínimo, con las relaciones enteras,
  §5.1) y borrar (con confirmación). Con el perfil `writes`, `If-Match` sale de `_etag` o de la
  cabecera `ETag` y `Idempotency-Key` se genera sola en cada `POST`; se conserva la misma clave
  mientras no llegue respuesta, para que un reintento tras un corte de red no duplique nada
  (§7.1).
- **Recurso suelto** (§5.9): cada uno de `singletons` tiene su enlace en la barra lateral y su
  vista, con sus campos, su ETag y, si `methods` incluye `PATCH` o no se declara, «Editar»
  (merge patch mínimo con `If-Match`).
- **Acciones** (§11.1): las de `_actions` del elemento si las trae (las disponibles en su
  estado) y si no las declaradas; con su esquema `input`, método `GET` o `POST` e
  `Idempotency-Key` en las no idempotentes.
- **Errores**: los `problem+json` se muestran con `code`, `detail`, `parameter`, `reason`, la
  tabla de `errors` y una explicación de qué hacer (`unsupported_parameter`: quítalo;
  `invalid_parameter`: corrígelo; un código desconocido, según la clase del estado, §5.4).
- **Peticiones**: las ocho últimas, cada una con su `curl` equivalente (botón de copiar), las
  cabeceras de la respuesta que deja leer CORS y el cuerpo.
- **Ruta libre**: una barra para ir a cualquier ruta relativa a la raíz, también a una API sin
  documento de descubrimiento (solo `core`).
- **Estado en la URL**: `#api=<raíz>&path=<ruta con su consulta>`, legible y compartible. Ejemplo:
  `#api=http://localhost:8080/&path=/books?filter[price][le]=20%26sort=-price`.
- Teclado, etiquetas en todos los controles, región `aria-live` para avisos, foco al cambiar de
  vista, modo claro y oscuro (automático o elegido), y diseño para móvil.

### Lo que entiende del borrador 6 (§12.2)

- **Versión** (§1.1): `restep` tiene que seguir la gramática (`1.0`, `1.0-draft.6`, `1.0-rc.1`…)
  con versión mayor 1. Si no, el resumen dice que no es Restep 1 y no ofrece nada más (tampoco
  supone solo `core`). Con sufijo, avisa de que es un borrador o un candidato.
- **Partes experimentales** (§1.2): el explorador implementa el texto de `inherit` del borrador 6
  y solo lo usa (campo efectivo de solo lectura en la edición, origen de `_inherited`) si la API
  anuncia la extensión `inherit` y declara exactamente `"restep": "1.0-draft.6"`. Con otra
  versión ignora esos miembros y lo dice en el resumen. De `sync` y `batch` solo muestra lo que
  declaran, sin usarlos.
- **Valores desconocidos** (§4.2): un filtro con un `type` desconocido no se ofrece, de un filtro
  solo se ofrecen los operadores conocidos, un filtro con nombre con un `type` desconocido no
  se ofrece, una acción con un `on` o un `method` desconocidos (también en `_actions`) no se
  ofrece, y un aviso de retirada con un `kind` que no corresponde a su sitio no se muestra. Un
  `from` desconocido en `_inherited` se muestra como de una fuente que no se ve («hidden», §11.6).
- **`id_from`** (§5.1): con `"client"` el cuerpo de partida del alta lleva un `id` aleatorio; con
  un valor desconocido el `id` se quita siempre antes de enviar; sin `id_from` o con `"server"`
  se envía lo que escribas (y el servidor responde `422` si pones un `id`).
- **Recursos sueltos con plantilla o `parent`** (§5.9): se ignoran.
- **Enlaces** (§3): no pide ninguna URL cuyo esquema no sea `https` ni el de la raíz; las
  relaciones que traen `href` (obligatorio hacia una subcolección) se enlazan por él.
- **`idempotency.anonymous: false`** (§7.1): sin token, los `POST` no llevan `Idempotency-Key`.
- Los `POST` (alta y acciones, también con cuerpo `{}`) van con `Content-Type: application/json`
  y un `+` literal en la consulta sale como `%2B` (§3, §5.2).

### Token y privacidad

- El token Bearer se guarda solo en `sessionStorage` (se borra al cerrar la pestaña), con una
  clave por origen de la API, y solo se envía a ese origen: un esquema o un enlace de otro
  origen se pide sin él (§4.3). Así, un enlace compartido que apunte a otra API no le manda tu
  token.
- Nunca va en el hash ni en el `curl`, que usa `"Authorization: Bearer $RESTEP_TOKEN"`.
- En `localStorage` solo van el tema y el `Accept-Language` elegidos.
- La página se sirve con una CSP estricta (ver arriba; solo scripts y estilos propios, y conectar
  por `http:` o `https:`), `referrer` desactivado y nunca usa `innerHTML`.
- El enlace a la otra versión de idioma conserva el hash (la API y la ruta, nunca el token).

## Uso

```bash
node vendor/restep-server.mjs                         # una API de prueba en :8080
npx serve public                                          # y abre /explorer/ o /es/explorador/
```

Escribe la raíz de la API (por ejemplo `http://localhost:8080/`) y pulsa «Explorar». Si la
página y la API están en orígenes distintos (lo normal), la API tiene que permitir CORS: ver
abajo. El servidor de referencia no lo hace, así que para probarlo en local tienes dos
opciones: servir ambos desde el mismo origen, o usar una copia con CORS, como hace `test.mjs`.

## CORS: qué tiene que mandar la API

El navegador solo deja a la página hablar con una API de otro origen si esta lo permite. Para
el explorador, la API necesita:

```
# En toda respuesta (también en los errores):
Access-Control-Allow-Origin: *              (o el origen del explorador)
Access-Control-Expose-Headers: ETag, Location, Link, Allow, WWW-Authenticate, Retry-After,
  Idempotent-Replayed, Preference-Applied, Content-Language, Deprecation, Sunset, Accept-Patch

# En la respuesta a la petición previa (OPTIONS con Access-Control-Request-Method):
Access-Control-Allow-Methods: GET, HEAD, POST, PATCH, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-None-Match,
  Idempotency-Key, Prefer, Accept-Language
Access-Control-Max-Age: 600
```

- Sin `ETag` en `Expose-Headers`, el explorador no puede leer la ETag de elemento: para
  escribir con `If-Match` necesita entonces `_etag` en la representación. Lo avisa.
- Sin `Location`, después de crear va al elemento por el `id` del cuerpo.
- Sin `WWW-Authenticate`, no puede mostrar el reto de un `401` ni el enlace a los metadatos de
  OAuth (§11.5 ya pide exponerla).
- Sin `Link`, no puede seguir un `service-desc` cuando la raíz no es el documento de
  descubrimiento.
- `Access-Control-Allow-Headers: *` no cubre `Authorization`: hay que nombrarla.
- Las API con `Access-Control-Allow-Origin: *` funcionan con token, porque el explorador lo
  manda en `Authorization`, no en cookies.
- Publicado en `https://restep.wubytes.com`, el explorador puede llamar a
  `http://localhost:…` en Chrome y Firefox (localhost cuenta como seguro), pero Chrome puede
  pedir también `Access-Control-Allow-Private-Network: true` en la petición previa (Private
  Network Access). Cualquier otra API en `http:` la bloquea el navegador por contenido mixto.

## Pruebas

```bash
node tools/restep-explorer/build.mjs       # desde projects/restep
node tools/restep-explorer/test.mjs
```

Prueban la versión construida, y fallan si `public/` no está al día con la fuente.

- **Lógica pura**: `explorer-i18n.js` y `explorer-logic.js` publicados se evalúan en Node (vm), en
  inglés y en español (parseo del descubrimiento, rutas y plantillas, constructor y lector de
  consultas, merge patch mínimo, cuerpos de partida, ETag, relaciones, traducciones, `Link`,
  `curl`, errores y textos). El diccionario tiene las mismas claves en los dos idiomas y todas
  las que usa el código.
- **Páginas**: en las dos, nada en línea (ni `<script>` sin `src`, ni `<style>`, ni `style=`, ni
  `on*=`), solo recursos propios, `lang`, título, descripción, canonical, `hreflang`, `og:*`,
  favicon y la cabecera del sitio con su nav y el cambio de idioma; en el JS, nada de
  `innerHTML`, `setAttribute('style')` ni `eval`.
- **Integración**: copia el servidor de referencia a un directorio temporal, le añade CORS (el
  original no se toca), lo arranca en `:8840` y sirve las páginas desde `public/` en `:8841`, con
  la CSP de arriba como cabecera HTTP. Comprueba la petición previa de CORS y la lógica contra la
  API real: consultas, paginación con `next`, errores, `PATCH` con `If-Match` (y el `412` con una
  ETag vieja), `POST` repetido con la misma `Idempotency-Key`, `DELETE`, el `PATCH` del recurso
  suelto `/shop`, la subcolección `reviews` desde su libro (404 sin él, borrada con él), `include`
  con profundidad 2, la relación `highlight` enlazada por su `href`, la polimórfica `showcase`
  por su `type`, y las acciones `low_stock` (`GET` de colección), `restock` (`POST` de elemento
  con `input`, por el `href` de `_actions`), `find_or_create` e `inherit_tax` (idempotentes).
- **Navegador**: si encuentra Chrome o Chromium (o `CHROME=/ruta`), lo arranca en modo headless
  con el protocolo de DevTools en `:8842`, carga las dos páginas (una colección filtrada, un
  elemento con mapas de idioma y relación, el recurso suelto `/shop`, un error, el tema y el
  enlace de idioma) y falla si
  hay en consola alguna violación de CSP (también escucha `securitypolicyviolation`), una
  excepción o un `console.error`. Si no lo hay, esas pruebas se omiten.

## Límites

- No implementa `sync` (`:changes`, avisos SSE), `batch`, `filter-expr` (un `filter=…` escrito
  en la barra de ruta se conserva, pero no hay formulario) ni `query-method`.
- `fields` ofrece los campos del esquema `item` si es un objeto incrustado y, si no, los que
  aparecen en la página actual.
- Los esquemas se usan para el cuerpo de partida y se muestran, pero no se valida contra ellos
  antes de enviar: la API valida y el explorador muestra su `422`.
- Las subcolecciones solo se abren desde un elemento de su colección padre, que se busca por
  prefijo de ruta, no por `parent` (§4.2).
- No muestra `id_from`, `collations` ni `parent` en las fichas de colección, ni anota con
  `Deprecation` las respuestas que lo traen (solo salen en el registro de cabeceras).
- En un recurso suelto no hay formulario de `fields` (§5.9), y sus relaciones se muestran como
  JSON, sin enlazar su `href`.
- No revalida el descubrimiento según su `Cache-Control` (§4.2): lo vuelve a leer al cambiar de
  API, al guardar el token o el idioma y con «Recargar».
- No hay `Prefer: return=minimal` ni `If-None-Match`: todas las lecturas van con
  `cache: no-store`.

## Dudas sobre la spec

- **CORS para clientes de navegador.** Resuelto en §5.8 del borrador 5: cabeceras expuestas, preflight y `Vary: Origin`. La configuración de la API sigue siendo necesaria.
- **Qué variable de plantilla corresponde a qué padre.** Resuelto en el borrador 6: la
  subcolección declara `parent` y su ruta empieza por la del padre (§4.2).
- **Relaciones a una colección con plantilla.** Resuelto en el borrador 6: el objeto de relación
  lleva `href` (§3), y el explorador lo enlaza por él.
- **Lista de campos sin esquema.** Sin `schemas.item` no hay forma de saber qué campos admite
  `fields` salvo mirando elementos; un elemento con un campo ausente lo oculta.
- **`_actions` de una acción sin declarar.** Resuelto en el borrador 6: `_actions` solo lista
  acciones declaradas, con su método (§11.1). Si un servidor lista otra, el explorador la sigue
  tratando como no segura y no idempotente, y le pone `Idempotency-Key`.
- **Qué texto de una parte experimental implementa un cliente para `"1.0"`.** §1.2 pide que el
  cliente implemente «el texto de la versión que declara el servidor». El explorador solo
  conoce el del borrador 6; no puede saber si la 1.0 publicada lo mantendrá, así que con
  `"1.0"` ignora `inherit` (el comprobador, en cambio, acepta `1.0-draft.6` y `1.0`).

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-explorer>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
