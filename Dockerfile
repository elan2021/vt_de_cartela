# === Stage 1: compilar Go backend ===
FROM golang:1.25-alpine AS go-builder
WORKDIR /build
COPY vt-backend/go.mod vt-backend/go.sum ./
RUN go mod download
COPY vt-backend/main.go .
RUN CGO_ENABLED=0 go build -o /vt-backend .

# === Stage 2: imagem final com Node + Go ===
FROM node:20-alpine
WORKDIR /app

# Instalar dependencias Node
COPY package*.json ./
RUN npm install --production

# Copiar codigo do cartelas
COPY api.js builder.html chat.html ./
COPY generate.js render_async.js tts.js ./
COPY data.json dados_*.json ./
COPY templates/ ./templates/

# Copiar binario Go compilado
COPY --from=go-builder /vt-backend ./vt-backend/

# Copiar prompt e criar diretorio de sessoes
COPY vt-backend/prompt.md ./vt-backend/
RUN mkdir -p /app/vt-backend/sessions

EXPOSE 3460
EXPOSE 3461
EXPOSE 3470

# Script que sobe tudo
RUN printf '#!/bin/sh\n\
/app/vt-backend/vt-backend &\nsleep 1\n\
node /app/render_async.js --port=3461 &\nsleep 1\n\
node /app/api.js --port=3460\n' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
