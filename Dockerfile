FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

COPY src ./src
COPY dashboard/static ./dashboard/static
RUN mkdir -p /app/config /app/sync && chown -R node:node /app

USER node

EXPOSE 6000 6030

CMD ["npm", "start"]
