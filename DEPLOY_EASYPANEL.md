# Guía de Despliegue - IFC Validator

Este proyecto consta de **2 servicios**:
- **ifc-validator**: Backend Streamlit (puerto 8501)
- **ifc-viewer**: Frontend visor 3D (puerto 3000)

---

## Despliegue en Docker Desktop (Local)

### Requisitos
- Docker Desktop instalado y ejecutándose
- Al menos 4GB de RAM disponibles

### Paso 1: Clonar/Navegar al proyecto

```bash
cd C:\Users\USER\Documents\GitHub\ifc-validator
```

### Paso 2: Construir y ejecutar

```bash
# Construir las imágenes
docker-compose build

# Ejecutar los servicios
docker-compose up -d
```

### Paso 3: Verificar el despliegue

```bash
# Ver estado de los contenedores
docker-compose ps

# Ver logs
docker-compose logs -f
```

### Paso 4: Acceder a la aplicación

| Servicio | URL |
|----------|-----|
| **Streamlit (Backend)** | http://localhost:8501 |
| **Visor 3D (Frontend)** | http://localhost:3000 |

### Comandos útiles

```bash
# Detener servicios
docker-compose down

# Reiniciar servicios
docker-compose restart

# Reconstruir después de cambios
docker-compose up -d --build

# Ver logs de un servicio específico
docker-compose logs -f ifc-validator
docker-compose logs -f ifc-viewer

# Limpiar todo (incluye volúmenes)
docker-compose down -v
```

---

## Despliegue en EasyPanel (Producción)

### Opción 1: Despliegue con docker-compose (Recomendado)

EasyPanel soporta docker-compose nativamente.

#### Paso 1: Subir a GitHub

```bash
git init
git add .
git commit -m "Initial commit - IFC Validator"
git remote add origin https://github.com/tu-usuario/ifc-validator.git
git push -u origin main
```

#### Paso 2: Crear proyecto en EasyPanel

1. Accede a tu panel de EasyPanel
2. Click en **"Create Project"**
3. Nombra el proyecto: `ifc-validator`

#### Paso 3: Crear servicio ifc-validator (Backend)

1. Dentro del proyecto, click **"+ Service"** > **"App"**
2. Configura:

| Campo | Valor |
|-------|-------|
| **Name** | `ifc-validator` |
| **Source** | GitHub |
| **Repository** | `tu-usuario/ifc-validator` |
| **Branch** | `main` |
| **Build Method** | Dockerfile |
| **Dockerfile Path** | `./Dockerfile` |

3. En **"Environment"**:
```
STREAMLIT_SERVER_PORT=8501
STREAMLIT_SERVER_ADDRESS=0.0.0.0
STREAMLIT_SERVER_HEADLESS=true
STREAMLIT_SERVER_MAX_UPLOAD_SIZE=500
STREAMLIT_BROWSER_GATHER_USAGE_STATS=false
IFC_VIEWER_URL=https://viewer.tudominio.com
```

4. En **"Domains"**: Configura tu dominio (ej: `ifc.tudominio.com`)

5. En **"Resources"**:
   - CPU: 0.5 - 2 cores
   - RAM: 1GB - 4GB (según tamaño de archivos IFC)

6. Click **"Deploy"**

#### Paso 4: Crear servicio ifc-viewer (Frontend)

1. Click **"+ Service"** > **"App"**
2. Configura:

| Campo | Valor |
|-------|-------|
| **Name** | `ifc-viewer` |
| **Source** | GitHub |
| **Repository** | `tu-usuario/ifc-validator` |
| **Branch** | `main` |
| **Build Method** | Dockerfile |
| **Dockerfile Path** | `./viewer/Dockerfile` |
| **Context Path** | `./viewer` |

3. En **"Domains"**: Configura subdominio (ej: `viewer.tudominio.com`)

4. En **"Resources"**:
   - CPU: 0.25 cores
   - RAM: 256MB - 512MB

5. Click **"Deploy"**

#### Paso 5: Actualizar URL del visor

Una vez desplegado el viewer, actualiza la variable `IFC_VIEWER_URL` del backend:
```
IFC_VIEWER_URL=https://viewer.tudominio.com
```

---

### Opción 2: Despliegue con Docker Images

#### Paso 1: Construir y publicar imágenes

```bash
# Backend
docker build -t tu-usuario/ifc-validator:latest .
docker push tu-usuario/ifc-validator:latest

# Frontend
docker build -t tu-usuario/ifc-viewer:latest ./viewer
docker push tu-usuario/ifc-viewer:latest
```

#### Paso 2: Crear servicios en EasyPanel

**Servicio ifc-validator:**

| Campo | Valor |
|-------|-------|
| **Source** | Docker Image |
| **Image** | `tu-usuario/ifc-validator:latest` |
| **Port** | `8501` |

**Servicio ifc-viewer:**

| Campo | Valor |
|-------|-------|
| **Source** | Docker Image |
| **Image** | `tu-usuario/ifc-viewer:latest` |
| **Port** | `3000` |

---

## Configuración de Recursos

### Mínimos (desarrollo/pruebas)

| Servicio | CPU | RAM |
|----------|-----|-----|
| ifc-validator | 0.5 cores | 512MB |
| ifc-viewer | 0.25 cores | 128MB |

### Recomendados (producción)

| Servicio | CPU | RAM |
|----------|-----|-----|
| ifc-validator | 1-2 cores | 2-4GB |
| ifc-viewer | 0.5 cores | 256MB |

---

## Variables de Entorno

### Backend (ifc-validator)

```bash
# Servidor Streamlit
STREAMLIT_SERVER_PORT=8501
STREAMLIT_SERVER_ADDRESS=0.0.0.0
STREAMLIT_SERVER_HEADLESS=true
STREAMLIT_SERVER_MAX_UPLOAD_SIZE=500
STREAMLIT_BROWSER_GATHER_USAGE_STATS=false

# URL del visor 3D (importante para producción)
IFC_VIEWER_URL=https://viewer.tudominio.com
```

---

## Healthchecks

Los servicios incluyen healthchecks automáticos:

| Servicio | Endpoint |
|----------|----------|
| ifc-validator | `http://localhost:8501/_stcore/health` |
| ifc-viewer | `http://localhost:3000` |

---

## Troubleshooting

### Error: "ifcopenshell not found"

Las dependencias del sistema están incluidas en el Dockerfile. Si persiste:
```bash
docker exec -it ifc-quality-validator pip install ifcopenshell
```

### Error: CORS en visor 3D

Verifica que `IFC_VIEWER_URL` apunte correctamente al dominio del visor.

### Error: "Out of memory"

Aumenta límites de memoria:
- En docker-compose.yml: `deploy.resources.limits.memory`
- En EasyPanel: sección "Resources"

### Visor no carga el modelo

1. Verifica que ambos servicios estén corriendo
2. Comprueba que el navegador permite popups/iframes
3. Revisa la consola del navegador para errores

### Ver logs

```bash
# Docker local
docker-compose logs -f ifc-validator
docker-compose logs -f ifc-viewer

# EasyPanel
Ver sección "Logs" en cada servicio
```

---

## Arquitectura

```
                    ┌─────────────────┐
                    │   Usuario       │
                    │   (Navegador)   │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
     ┌────────────────┐           ┌────────────────┐
     │  ifc-validator │           │   ifc-viewer   │
     │   (Streamlit)  │◄─────────►│    (Nginx)     │
     │   Puerto 8501  │  iframe   │   Puerto 3000  │
     └────────────────┘           └────────────────┘
              │
              ▼
     ┌────────────────┐
     │ Volumen Docker │
     │  (ifc_temp_data)│
     └────────────────┘
```

---

## Estructura del Proyecto

```
ifc-validator/
├── app.py                 # Backend Streamlit
├── requirements.txt       # Dependencias Python
├── Dockerfile            # Dockerfile backend
├── .dockerignore         # Exclusiones backend
├── docker-compose.yml    # Orquestación
├── DEPLOY_EASYPANEL.md   # Esta guía
└── viewer/               # Frontend visor 3D
    ├── src/
    │   ├── main.ts       # Lógica del visor
    │   └── style.css     # Estilos
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── Dockerfile        # Dockerfile frontend
    └── .dockerignore     # Exclusiones frontend
```
