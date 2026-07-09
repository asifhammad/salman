FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ENV HEADLESS=true
ENV HEALTH_CHECK_PORT=3000

CMD ["node", "src/index.js"]
