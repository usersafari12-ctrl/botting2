# Voxiom Bot Server

Server-side bot manager. Bots run on the server and send WebSocket packets directly — no browser required after setup.

## Local dev

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Render

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Done — open your Render URL to see the control panel

The `render.yaml` file handles all config automatically if you use Blueprint deploys.

## API

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/deploy` | `{url, mode, count, lifeSeconds}` | Deploy bots |
| POST | `/api/kill` | `{id}` or `{id:"all"}` | Kill bot(s) |
| GET  | `/api/status` | — | JSON stats |

### Modes
- `lag` — BSG CTG lag bot (jump + hold LMB, drift yaw/pitch)
- `pillar` — Pillar builder (look down, place blocks at jump peak)
- `roam` — Random walk + shoot (random WASD, extreme look, always firing)

## Notes
- Bots stagger 250ms apart when deploying multiple
- Each bot auto-kills after `lifeSeconds` 
- Click a bot card in the UI to kill it individually
- WebSocket panel auto-reconnects if the server restarts
