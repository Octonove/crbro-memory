# CRBRO in a container — used by registries that build servers in a sandbox
# (Glama) and by anyone who prefers Docker to npx.
#
# The brain lives in $HOME/.crbro inside the container. Mount a volume there
# if the memory has to outlive the container:
#   docker run -i -v crbro-brain:/root/.crbro crbro-memory
#
# Node 22: the build uses TypeScript 6 and the tests use Vitest 4, both of
# which want a current Node. Runtime needs nothing beyond Node itself — no
# Python, no database, no native modules.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production

# MCP over stdio: the client talks to the process's stdin/stdout.
CMD ["node", "dist/index.js"]
