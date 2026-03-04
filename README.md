# Open WebUI Wake Stack

This repository runs a server-hosted Open WebUI setup with a server-side engine-control proxy for a separate Ollama machine.

The intended layout is:

- Open WebUI runs on an always-on server or homelab box
- Ollama runs on the gaming PC with the GPU
- a small wake service proxies wake requests to an external engine-control server and tracks engine state locally
- `nginx` sits in front of Open WebUI and injects the header controls at runtime

The goal is simple: keep the UI available all the time, let the gaming PC sleep, and wake it only when you actually want to use the local model.

## How This Stack Is Built

This project is not a full fork of the Open WebUI source code.

Instead, it wraps the stock upstream Open WebUI Docker image and layers custom behavior around it:

- `open-webui`
  - Runs the upstream Open WebUI image from `ghcr.io/open-webui/open-webui`
  - Talks to the remote Ollama host using `OLLAMA_BASE_URL`

- `wake-service`
  - FastAPI service that keeps the existing `/api/wake-engine` route for the UI
  - Proxies wake requests to an external engine-control server
  - Tracks wake state
  - Exposes status and health endpoints
  - Keeps structured logs for troubleshooting

- `web`
  - `nginx` reverse proxy in front of both services
  - Serves Open WebUI
  - Injects the custom header overlay JavaScript into the page

This design matters because it makes updates much easier. Most future changes will be:

- upgrading the Open WebUI image version
- testing whether the overlay still mounts cleanly
- patching only the overlay if the upstream header markup changes

That is much simpler than maintaining a large source fork.

## Repository Layout

- `docker-compose.yml`
  - Main stack definition

- `Dockerfile.wake-service`
  - Container build for the custom wake service

- `wake_service/`
  - FastAPI app, config, models, orchestration, and logging

- `integration/nginx-openwebui.conf`
  - Reverse proxy config and script injection

- `integration/wake-engine-overlay.js`
  - Runtime UI overlay for:
    - `Wake Engine`
    - engine status pill
    - diagnostics modal

- `tests/test_wake_service.py`
  - Basic tests for the Python backend logic

- `CUSTOM_PATCH_NOTES.md`
  - Upgrade checklist and notes about the custom layer

## Current UI Behavior

The header controls are injected at runtime instead of being compiled into Open WebUI.

Current behavior:

- `Wake Engine` is shown when the engine is not fully ready
- the status pill shows:
  - `Offline`
  - `Waking`
  - `Host Online`
  - `Ready`
- when the engine reaches `Ready`, the wake button hides and the status pill remains
- clicking the status pill opens the diagnostics modal
- the diagnostics modal opens from cached state first
- `Refresh Status` inside the modal performs a live health check only when you explicitly ask for it

That last part is important because it avoids waking or probing the sleeping PC just from loading the page.

## Requirements

- Docker and Docker Compose
- a machine that can run this stack continuously
- a gaming PC with:
  - Ollama installed
  - Wake-on-LAN enabled
  - a stable LAN IP or DHCP reservation
- the gaming PC should use wired Ethernet for WoL

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Then edit `.env` and replace the placeholder values.

The most important settings are:

- `OPENWEBUI_IMAGE_TAG`
  - the upstream Open WebUI version to run
  - keep this pinned to a real release, not `latest`, for production

- `OLLAMA_BASE_URL`
  - the gaming PC's Ollama endpoint
  - example: `http://192.168.86.248:11434`

- `ENGINE_CONTROL_URL`
  - base URL for the external engine-control server
  - example: `http://192.168.86.10:8000`

- `ENGINE_CONTROL_API_KEY`
  - bearer token used by this backend when it calls the engine-control server
  - keep this in `.env` only
  - do not expose this to the browser

- `ENGINE_MAC`
  - deprecated for the wake button path
  - no longer required when using `ENGINE_CONTROL_URL`

- `ENGINE_BROADCAST_IP`
  - deprecated for the wake button path
  - no longer required when using `ENGINE_CONTROL_URL`

- `ENGINE_HOST`
  - the gaming PC's actual LAN IP

- `ENGINE_OLLAMA_PORT`
  - normally `11434`

- `ENABLE_WAKE_HEADER`
  - set to `true` to show the custom controls
  - set to `false` to disable the UI controls without removing the backend

- `OPENWEBUI_UPSTREAM_VERSION`
  - should match the Open WebUI image tag
  - used in diagnostics and logs

- `CUSTOM_PATCH_VERSION`
  - your own version number for this custom layer
  - bump this when you change the overlay or wake service

## Running Locally

Start the stack:

```bash
docker compose up -d --build
```

Then open:

- `http://localhost:3000`

Useful test endpoints:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/api/custom/diag
curl http://localhost:3000/api/engine-status
curl http://localhost:3000/api/engine-health
```

## Accessing It From Another Device

If you want to open the UI from a phone or another computer on the same network, use the LAN IP of the machine running this stack.

Example:

- `http://192.168.86.250:3000`

Do not use `localhost` from another device. `localhost` only points back to the device you are currently using.

## Wake Service API

The custom backend exposes these endpoints:

- `POST /api/wake-engine`
  - proxies the wake request to the external engine-control server and begins the wake flow

- `GET /api/engine-status`
  - returns the cached state used by the UI
  - safe for passive page refreshes

- `GET /api/engine-health`
  - performs a deeper live check
  - used by the diagnostics modal when you click `Refresh Status`

- `GET /api/custom/diag`
  - returns config and version metadata for troubleshooting

- `GET /healthz`
  - basic service health check

## Troubleshooting Notes

### If the gaming PC does not wake

Check these in order:

- `ENGINE_CONTROL_URL` points to the correct engine-control server
- `ENGINE_CONTROL_API_KEY` matches the key expected by that server
- the external engine-control server is healthy and reachable from this stack
- the gaming PC is on Ethernet
- Wake-on-LAN is enabled in BIOS / UEFI
- the NIC is allowed to wake the machine
- the NIC is set to wake on magic packet

This repo no longer sends the WoL packet directly when the wake button is pressed. If wake fails, the first place to inspect is the external engine-control service.

### If the UI says `Offline` after a refresh

The status pill uses cached state from the wake service.

That means:

- if the wake service already saw the engine come online, the status will refresh correctly on page load
- if the PC was turned on outside the normal wake flow, the cached state may not know that yet

In that case, open the diagnostics modal and use `Refresh Status`.

### If the header controls disappear after an Open WebUI update

This stack injects the controls as a runtime overlay. If the upstream header markup changes, the overlay may need a small patch.

The first file to check is:

- `integration/wake-engine-overlay.js`

That is the main tradeoff of the wrapper approach: updates are easier overall, but the header placement still depends on the upstream page structure.

## Updating Open WebUI Safely

Do not run production on `latest`.

Instead:

1. Pick a specific Open WebUI release
2. Update:
   - `OPENWEBUI_IMAGE_TAG`
   - `OPENWEBUI_UPSTREAM_VERSION`
3. Commit that version bump
4. Redeploy
5. Test the wake flow and header controls

Typical upgrade flow:

```bash
docker compose pull open-webui
docker compose up -d --build
```

What you should test after an upgrade:

1. Open WebUI loads normally
2. the wake controls appear
3. `Wake Engine` still sends a wake request
4. the status pill updates correctly
5. diagnostics still open
6. a real chat works once the engine is `Ready`

## Git and GitHub Workflow

This repository should be your source of truth for the custom stack.

Recommended workflow:

1. Keep this repo on GitHub
2. Make changes here
3. Commit them locally
4. Push to GitHub
5. Pull those changes on the homelab
6. Redeploy with Docker Compose

For normal updates, you are not merging Open WebUI source code directly. You are usually just updating the pinned Open WebUI image version and keeping your custom files intact.

## Deploying to the Homelab

On the homelab server:

1. Clone this repo
2. Copy `.env.example` to `.env`
3. Fill in the real local values for that machine
4. Start the stack

Example:

```bash
git clone <your-repo-url>
cd <your-repo-folder>
cp .env.example .env
docker compose up -d --build
```

When you make changes later:

```bash
git pull
docker compose up -d --build
```

That keeps the homelab aligned with whatever you committed to GitHub.

## If You Later Want a True Open WebUI Fork

Right now, this project uses a runtime overlay because there is no local Open WebUI source checkout in this repository.

If you later decide you want deeper UI changes, you can move to a real Open WebUI fork:

1. fork Open WebUI on GitHub
2. clone that fork locally
3. move the overlay logic into the actual Open WebUI header component
4. keep the wake service and API contract the same

That gives you tighter UI control, but it also means more merge work when upstream updates their code.

For this project, the wrapper approach is the simpler and lower-maintenance starting point.

## Local Verification

The Python backend can be checked locally with:

```bash
python3 -m unittest tests/test_wake_service.py
python3 -m py_compile wake_service/*.py
```

## Versioning Recommendation

Use two version numbers:

- upstream version
  - example: `0.8.7`

- custom patch version
  - example: `wake15`

This gives you a clear deployment label such as:

- `Open WebUI 0.8.7 + wake15`

That makes future troubleshooting much easier when you need to know whether a problem came from upstream, from your custom code, or from config drift.
