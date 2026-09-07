# Single small image -- no build step needed since the frontend is plain HTML/CSS/JS.
FROM node:22-alpine

WORKDIR /app

# Copy just the manifest first so `npm install` is cached by Docker as long as dependencies
# haven't changed, even if application code has.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
