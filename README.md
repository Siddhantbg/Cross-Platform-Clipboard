# Cross Clipboard PWA

Minimal cross-device clipboard: paste text on your laptop, read and copy it on your phone.

## Structure
- `frontend/` React + Vite PWA
- `server/` Node + WebSocket API

## Local dev

### 1) Start server
```
cd server
npm install
npm run dev
```

### 2) Start frontend
```
cd frontend
npm install
npm run dev
```

Open the frontend URL, it will generate a share link with a secret. Open the same link on your phone.

## Env

Frontend (optional):
- `VITE_API_BASE` (e.g. `https://your-server.com`)

Server:
- `PORT` (default 8787)
- `CORS_ORIGIN` (default `*`)
- `CLIPBOARD_STORE_PATH` (optional JSON file path for persistence)
- `CLIPBOARD_PASSWORD` (required)

## Deployment
### Server (Render)
This repo includes [render.yaml](render.yaml) for one-click setup.

Required env vars:
- `CLIPBOARD_PASSWORD`
- `CORS_ORIGIN` (set to your Vercel frontend URL)

Optional:
- `CLIPBOARD_STORE_PATH` (default in render.yaml)

### Frontend (Vercel)
Set the project Root Directory to `frontend/` and deploy. This repo includes [frontend/vercel.json](frontend/vercel.json).

Env vars:
- `VITE_API_BASE` (your Render server URL)
