# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build
RUN mkdir -p /app/public && if [ -d apps/web/dist ]; then cp -r apps/web/dist/. /app/public/; fi
RUN node -e "const p=require('/app/apps/server/package.json');delete p.devDependencies;delete p.scripts;delete p.dependencies['@mim/shared'];require('fs').writeFileSync('/app/runtime-package.json',JSON.stringify(p,null,2))"

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /app/runtime-package.json ./package.json
RUN npm install --omit=dev --no-package-lock --ignore-scripts && npm cache clean --force
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--max-old-space-size=384", "dist/main.js"]
