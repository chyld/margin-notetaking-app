FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5555

USER node
EXPOSE 5555
CMD ["node", "src/server.js"]
