# Homelab Deployment Checklist

This file is the repeatable process for installing, updating, and verifying this stack on the homelab.

The goal is to make deployment boring:

- pull the repo
- use the right `.env`
- start the stack
- verify the wake flow

If something breaks later, this file should be the first place you check.

## What This Server Should Do

The homelab machine should be the always-on control plane.

It will run:

- Open WebUI
- the custom wake service
- `nginx` in front of both

The gaming PC stays separate and only needs to run Ollama when it is awake.

## Before You Start

Make sure the homelab machine has:

- Docker installed
- Docker Compose available
- network access to the gaming PC on your LAN
- network access to the external engine-control server

Make sure the gaming PC has:

- a stable LAN IP or DHCP reservation
- Wake-on-LAN enabled
- Ollama installed and set to use port `11434` unless you changed it
- a wired Ethernet connection for WoL

## First-Time Install On the Homelab

### 1. Clone the repository

Run this on the homelab:

```bash
git clone https://github.com/acesarhernandez/Open-WebUI-Wake-Stack.git
cd Open-WebUI-Wake-Stack
```

What this does:

- downloads the repo from GitHub
- creates a local copy on the server
- moves you into the project folder

### 2. Create the real environment file

```bash
cp .env.example .env
```

What this does:

- copies the safe example file
- creates the real local config file the server will actually use

You do not commit `.env` to Git. It is server-specific.

### 3. Edit `.env`

Open the file with `nano`:

```bash
nano .env
```

Set these values carefully:

- `OPENWEBUI_IMAGE_TAG`
  - keep this pinned to a real release
  - example: `0.8.7`

- `OPENWEBUI_UPSTREAM_VERSION`
  - should match `OPENWEBUI_IMAGE_TAG`

- `CUSTOM_PATCH_VERSION`
  - your custom stack version
  - example: `wake15`

- `OLLAMA_BASE_URL`
  - the gaming PC's Ollama address
  - example: `http://192.168.86.248:11434`

- `ENGINE_CONTROL_URL`
  - the base URL for the external engine-control server
  - example: `http://192.168.86.10:8000`

- `ENGINE_CONTROL_API_KEY`
  - the bearer token this backend uses when it calls the engine-control server
  - keep this in `.env` only

- `ENGINE_MAC`
  - deprecated for the wake button path
  - no longer required when using `ENGINE_CONTROL_URL`

- `ENGINE_BROADCAST_IP`
  - deprecated for the wake button path
  - no longer required when using `ENGINE_CONTROL_URL`

- `ENGINE_HOST`
  - the gaming PC's LAN IP

- `ENGINE_OLLAMA_PORT`
  - usually `11434`

- `ENABLE_WAKE_HEADER`
  - `true` if you want the UI controls visible

- `WEB_PORT`
  - the port you want to use on the homelab
  - default is `3000`

- `WAKE_API_ALLOWED_ORIGINS`
  - set this to the URL you actually use to open the app
  - example: `http://192.168.86.10:3000`

Save in `nano`:

1. Press `Ctrl + O`
2. Press `Enter`
3. Press `Ctrl + X`

### 4. Start the stack

```bash
docker compose up -d --build
```

What this does:

- pulls the pinned Open WebUI image
- builds the custom wake-service image
- starts the containers in the background

### 5. Confirm the containers are running

```bash
docker compose ps
```

You want to see:

- `open-webui`
- `wake-service`
- `web`

The `open-webui` container may show `starting` for a while on the first boot. That is normal.

### 6. Verify the service endpoints

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/api/custom/diag
curl http://localhost:3000/api/engine-status
```

What these tell you:

- `/healthz`
  - basic service path is alive

- `/api/custom/diag`
  - the custom config and version values loaded correctly

- `/api/engine-status`
  - the wake service is returning the cached engine state

### 7. Open the UI

In a browser, open:

```text
http://YOUR_HOMELAB_IP:3000
```

Then confirm:

- Open WebUI loads
- the wake controls appear
- the status pill opens diagnostics

### 8. Test the wake flow

Put the gaming PC to sleep, then:

1. Open the UI
2. Click `Wake Engine`
3. Watch the status change
4. Wait for `Ready`
5. Send a real test prompt

That confirms the full path:

- browser
- nginx
- wake service
- engine-control server
- gaming PC wake
- Ollama ready
- Open WebUI chat

## Normal Update Workflow

When you change code on your Mac and push it to GitHub, update the homelab like this:

### 1. Pull the latest repo changes

```bash
git pull
```

What this does:

- downloads the newest committed files from GitHub
- updates the local copy on the homelab

### 2. Rebuild and restart

```bash
docker compose up -d --build
```

What this does:

- rebuilds the custom image if code changed
- restarts containers if needed
- keeps the stack aligned with the code you just pulled

### 3. Smoke test

Check these after every update:

1. The UI loads
2. The wake controls are visible
3. The diagnostics modal opens
4. `Wake Engine` still works
5. A real chat works once the engine is ready

## Updating Open WebUI Itself

This is different from updating your own code.

Because this repo wraps the stock Open WebUI Docker image, updating upstream usually means changing the pinned image version.

### 1. Edit `.env`

Update these two values together:

```env
OPENWEBUI_IMAGE_TAG=0.8.8
OPENWEBUI_UPSTREAM_VERSION=0.8.8
```

Do not update one without the other.

### 2. Pull the new image

```bash
docker compose pull open-webui
```

What this does:

- downloads the newer upstream Open WebUI image
- does not restart the stack yet

### 3. Restart the stack

```bash
docker compose up -d --build
```

### 4. Test the custom layer

This is the important part after an upstream update.

Check:

1. The page still loads
2. The header controls still appear
3. The controls stay in the correct place
4. The status pill still opens diagnostics
5. The wake flow still works

If something is wrong after an upstream update, the most likely file to patch is:

- `integration/wake-engine-overlay.js`

That is because the overlay depends on the upstream header structure.

## Rollback Plan

If an update causes trouble, go back to the last known-good version.

### 1. Set the previous Open WebUI version in `.env`

Example:

```env
OPENWEBUI_IMAGE_TAG=0.8.7
OPENWEBUI_UPSTREAM_VERSION=0.8.7
```

### 2. Restart the stack

```bash
docker compose up -d --build
```

### 3. Confirm recovery

Check:

- the UI loads
- the wake controls return
- the wake flow works again

## Useful Commands

Check container status:

```bash
docker compose ps
```

Follow all logs:

```bash
docker compose logs -f
```

Follow only the wake service:

```bash
docker compose logs -f wake-service
```

Restart only the web proxy:

```bash
docker compose up -d --force-recreate web
```

Restart the full stack:

```bash
docker compose up -d --build
```

## Git Workflow For This Repo

This repo is your custom layer.

Use this basic cycle when you make changes on your Mac:

```bash
git status
git add .
git commit -m "Describe the change"
git push
```

Then on the homelab:

```bash
git pull
docker compose up -d --build
```

That is the normal long-term maintenance pattern for this project.
