# Cómo publicar una versión de CRBRO

Guía interna. El orden importa: **cartas antes o junto con el servidor, npm
primero, registry MCP después** — el MCP Registry valida la propiedad leyendo
el campo `mcpName` del `package.json` que está PUBLICADO en npm, no el local.

## 0. Prerrequisitos (una sola vez)

- [ ] Renovar la sesión de npm (el token actual está caducado — `npm whoami` da 401):
  ```bash
  npm login
  ```
- [ ] Comprobar que `~/.npmrc` no lleva `strict-ssl=false` (mala práctica de seguridad)
      y que la línea del token acaba en LF, no en CRLF: con `\r` pegado, npm envía
      el retorno de carro dentro de la credencial y devuelve un 401 desconcertante.
- [ ] Decidir si el repo pasa a público (`gh repo edit Octonove/crbro-memory --visibility public`).
  No es obligatorio para el registry, pero el `server.json` enlaza al repo y
  presentarlo como open source con un repo en 404 resta credibilidad.

## 1. Las cartas: antes o junto con el servidor, nunca después

La carta zero-crbro (`~/.claude/skills/zero-crbro/SKILL.md` y sus copias en
synthetica-decks: `skills/{raíz,de,en,fr,it}/zero-crbro.md` y
`.invokard/skills/ídem`) enseña al modelo qué herramientas llamar. Si la
release toca la superficie de `tools/list` — retira, renombra o pliega una
herramienta, como hizo 2.0.0 con `crbro_sync` → `crbro_space action=sync` —
las copias tienen que estar publicadas ANTES o JUNTO con el paquete de npm.
Una carta vieja contra un servidor nuevo ordena llamar a una herramienta que
ya no existe; un servidor viejo contra una carta nueva solo pierde la línea
nueva. Por eso el orden no es negociable.

- [ ] Las copias de zero-crbro nombran exactamente los 15 nombres que devuelve
      `tools/list` y ninguno retirado; `scripts/check-card-copies.mjs` (en el
      repo de decks) lo afirma.
- [ ] `RETIRED_TOOLS` en `src/server.ts`, la tabla del README y la del
      CHANGELOG dicen lo mismo, nombre por nombre.
- [ ] Los hooks de Claude Code no nombran herramientas retiradas
      (`~/.claude/settings.json` — matchers — y `crbro-session-start.txt`).
- [ ] El README de los decks fija la versión mínima del servidor
      (`crbro-memory >= 2.0.0`) y el aviso a clientes sale la misma semana.

## 2. Publicar en npm

El bump va en TRES archivos: `package.json`, `server.json` y el campo
`version` de `package-lock.json` (dos sitios: la raíz y `packages[""]`).
Editar solo package.json deja el lock atrás — llegó a decir 1.8.2 con el
paquete en 1.16.0. `npm version <x.y.z> --no-git-tag-version` hace los dos
primeros de una vez.

```bash
npm run build
npm test
npm pack --dry-run   # revisar que el tarball lleva dist/, bin/, README y LICENSE
npm publish
```

## 3. Publicar en el MCP Registry

Con la versión ya en npm, basta con empujar el tag — el workflow
`.github/workflows/publish-mcp.yml` hace el resto vía OIDC (sin tokens):

```bash
git tag v2.0.0
git push origin v2.0.0
```

Verificar después:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Octonove/crbro-memory"
```

## 4. Sincronizar Glama

Glama rescanea el repo una vez al día o cuando se pulsa **Sync Server** en
`glama.ai/mcp/servers/Octonove/crbro-memory/admin/repository` (hace falta la
sesión del maintainer, `glama.json` lo declara). Tras cada release, pulsar y
comprobar que «Last commit» es el commit del tag; el TDQS se recalcula solo.

## Reglas que no hay que olvidar

- **El namespace respeta mayúsculas**: es `io.github.Octonove/...` con O mayúscula,
  exactamente como el login de GitHub. En minúsculas el publish falla con
  "no tienes permiso".
- **Publicar es irreversible**: una versión en el registry no se puede editar ni
  despublicar. Los errores se corrigen sacando otra versión.
- **`version` sin rangos**: ni `^`, ni `~`, ni `1.x`. Versión exacta.
- **`description` ≤ 100 caracteres** en `server.json`.
- `package.json.mcpName` y `server.json.name` deben ser idénticos.
- **Quitar o renombrar una herramienta es versión mayor.** Un cliente MCP de
  terceros que la llame recibe `unknown tool`; el mapa `retired_tools` de
  `crbro_boot` solo ayuda al que ya ha arrancado. Se entra en el CHANGELOG con
  la tabla viejo → nuevo y se sigue el paso 1.
