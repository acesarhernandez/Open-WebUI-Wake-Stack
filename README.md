# Open WebUI Wake Engine Integration

This workspace implements the operational pieces of a troubleshootable Wake-on-LAN integration for a server-hosted Open WebUI deployment:

- a standalone FastAPI wake service with structured logs, correlation IDs, health endpoints, and feature flags
- Docker wiring for `open-webui`, the wake service, and an `nginx` front door
- a drop-in browser overlay script that injects a `Wake Engine` button and a diagnostics button into the Open WebUI header at runtime
- upgrade notes so the same wake backend can later be moved into a real Open WebUI fork with minimal change

The Open WebUI source code is not present in this workspace, so the header integration is implemented as an overlay script instead of a direct source patch. Once you clone your Open WebUI fork locally, you can move that overlay logic into the real header component and keep the wake service unchanged.

## What runs where

- `open-webui`: stock upstream image, pointed at your remote Ollama host
- `wake-service`: sends WoL packets and tracks engine state
- `web`: `nginx` reverse proxy that serves Open WebUI and injects the header overlay script

The example configuration in this workspace is pinned to `0.8.7` instead of `latest`. That is the safer production pattern:

- `OPENWEBUI_IMAGE_TAG` should be a specific upstream release you chose on purpose
- `OPENWEBUI_UPSTREAM_VERSION` should match that same release for diagnostics
- `CUSTOM_PATCH_VERSION` should track your own custom layer separately

When you decide to upgrade, change the pinned version intentionally, test, and then commit that version bump.

## Quick start

1. Copy `.env.example` to `.env` and replace the placeholder values:
   - `ENGINE_MAC`
   - `ENGINE_BROADCAST_IP`
   - `ENGINE_HOST`
   - `OLLAMA_BASE_URL`
2. Start the stack:
   ```bash
   docker compose up --build
   ```
3. Open `http://localhost:3000`.
4. Use the `Wake Engine` button in the header.
5. Click the status pill to open engine diagnostics.

## Important operational notes

- If Wake-on-LAN broadcasts do not leave the container on your server, move `wake-service` to host networking on Linux. Docker bridge networking can block or alter broadcast behavior depending on the host setup.
- The wake service logs to stdout in JSON so Docker captures the full event stream.
- `ENABLE_WAKE_HEADER=false` disables the injected header controls without changing the backend.
- `WAKE_API_TOKEN` is optional. If you set it, the overlay sends it automatically only if you expose the token through your reverse proxy or replace the overlay with a source patch. For pure same-origin use behind `nginx`, leaving it unset is the simplest starting point.

## API summary

- `POST /api/wake-engine`
- `GET /api/engine-status`
- `GET /api/engine-health`
- `GET /api/custom/diag`
- `GET /healthz`

## Local verification

The pure-Python pieces can be validated without installing FastAPI:

```bash
python3 -m unittest tests/test_wake_service.py
python3 -m py_compile wake_service/*.py
```

## Converting the overlay into a real Open WebUI patch later

When you have your Open WebUI fork checked out:

1. Keep `wake_service` unchanged.
2. Move the logic from `integration/wake-engine-overlay.js` into the real Open WebUI header/navbar component.
3. Preserve the same API paths and response shapes.
4. Keep `ENABLE_WAKE_HEADER` as the feature flag so you can disable the UI quickly after upstream updates.
5. Reuse `CUSTOM_PATCH_NOTES.md` as your merge checklist.
