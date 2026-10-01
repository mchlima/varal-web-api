# syntax=docker/dockerfile:1
# Imagem de produção da API do Varal (plano, seção 2.4). Prisma 7 não depende de motor em Rust.

FROM node:26-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Dependências completas para gerar o Prisma Client e compilar.
FROM base AS build
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
# O postinstall roda `prisma generate` em src/generated/prisma.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

# Só dependências de produção (sem scripts: o client já foi gerado e compilado em dist/).
# Inclui o CLI `prisma`, usado pelo deploy para `prisma migrate deploy` num container temporário.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
