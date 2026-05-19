FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENTRYPOINT ["npx", "tsx", "src/index.ts"]
