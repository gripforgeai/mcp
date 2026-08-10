# GripForge MCP server — stdio transport.
# Starts and answers introspection without GRIPFORGE_API_KEY (the key is only
# required when a tool is actually invoked).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/server.js"]
