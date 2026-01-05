# Dockerfile para IFC Viewer (That Open Components)
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar archivos de dependencias
COPY package.json ./

# Instalar dependencias
RUN npm install

# Copiar código fuente
COPY . .

# Build de producción
RUN npm run build

# Etapa de producción con nginx
FROM nginx:alpine

# Copiar build de la etapa anterior
COPY --from=builder /app/dist /usr/share/nginx/html

# Copiar configuración de nginx para SPA con CORS
RUN echo 'server { \
    listen 3000; \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    # Headers CORS para comunicación con Streamlit \
    add_header Access-Control-Allow-Origin *; \
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS"; \
    add_header Access-Control-Allow-Headers "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range"; \
    add_header Cross-Origin-Embedder-Policy "credentialless"; \
    add_header Cross-Origin-Opener-Policy "same-origin"; \
    \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    \
    # Cache para assets estáticos \
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|wasm)$ { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
