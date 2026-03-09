# Custom Patch Notes

This workspace started without a local Open WebUI git checkout, and outbound `git clone` was blocked by the environment. Because of that, the "header button" customization is implemented here as a runtime overlay (`integration/wake-engine-overlay.js`) instead of a direct edit to an Open WebUI source file.

## Next Release Notes (Draft)

- Improved mobile wake reliability:
  - if the wake request succeeds but early status polls fail transiently, the UI now stays in wake recovery mode and continues polling instead of sticking on `Error`
  - this removes the case where mobile required a full app/browser restart to recover status
- Added diagnostics version chip:
  - the Engine Diagnostics modal now shows `Open WebUI + custom patch` version in the header (right side of the title)

## Files added in this implementation

- `wake_service/config.py`: environment parsing and feature flags
- `wake_service/log_config.py`: JSON logging formatter
- `wake_service/models.py`: FastAPI request/response schemas
- `wake_service/service.py`: Wake-on-LAN orchestration, status tracking, polling, and diagnostics
- `wake_service/main.py`: FastAPI app
- `integration/wake-engine-overlay.js`: header button and diagnostics overlay
- `integration/nginx-openwebui.conf`: reverse proxy and HTML script injection
- `docker-compose.yml`: stack wiring
- `Dockerfile.wake-service`: wake service image build

## Upgrade checklist

1. Start with `ENABLE_WAKE_HEADER=false` and confirm stock Open WebUI still works through `nginx`.
2. Set `ENABLE_WAKE_HEADER=true` and confirm the overlay inserts the buttons.
3. Click `Wake Engine` and verify the wake service logs:
   - `wake_request_received`
   - `wake_request_sent`
   - `status_poll_started`
   - `status_changed`
4. Check `GET /api/engine-health` and confirm versions and feature flags match the deployed image.
5. Send a real chat request after the engine reports `online`.

## Converting to a source patch once your fork exists

When you have the real Open WebUI repository checked out locally:

1. Identify the current header component in your pinned Open WebUI version.
2. Move the fetch, state, and diagnostics logic from `integration/wake-engine-overlay.js` into that component.
3. Keep the API contract unchanged so the wake backend does not need to be retested beyond smoke checks.
4. Keep the visible controls small and isolated to avoid merge pain.
5. Keep the feature flag and diagnostics behavior exactly as-is so troubleshooting stays consistent after the migration.

## Known failure signs

- `Wake Engine` never appears:
  - `ENABLE_WAKE_HEADER` is false
  - `nginx` did not inject the overlay script
  - upstream HTML markup changed enough that the overlay cannot find a header target

- `Wake Engine` appears but always errors:
  - `wake-service` is unreachable from `nginx`
  - `WAKE_API_TOKEN` mismatch
  - browser console shows `wake_api_fetch_failed`

- wake request succeeds but machine never boots:
  - wrong MAC address
  - wrong broadcast IP
  - Docker bridge networking is swallowing the broadcast packet
  - BIOS / NIC WoL is not enabled on the gaming PC
