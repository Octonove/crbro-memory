# Cómo publicar una versión de CRBRO

Guía interna. El orden importa: **npm primero, registry MCP después** — el MCP
Registry valida la propiedad leyendo el campo `mcpName` del `package.json` que
está PUBLICADO en npm, no el local.

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

## 1. Publicar en npm

```bash
npm run build
npm test
npm pack --dry-run   # revisar que el tarball lleva dist/, bin/, README y LICENSE
npm publish
```

## 2. Publicar en el MCP Registry

Con la versión ya en npm, basta con empujar el tag — el workflow
`.github/workflows/publish-mcp.yml` hace el resto vía OIDC (sin tokens):

```bash
git tag v1.4.0
git push origin v1.4.0
```

Verificar después:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Octonove/crbro-memory"
```

## 3. Sincronizar Glama

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
