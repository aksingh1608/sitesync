# Backup plan for the live demo

## Before you leave
- **Record a full run** of `docs/demo-script.md` as a screen video (laptop screen plus the phone mirrored or filmed). Keep it on the laptop (offline), not only in the cloud.
- Charge the phone and laptop; bring a cable.
- Know the access code by heart; it is not written in the app.
- Run `Demo control → Reset demo` and check the health strip is green.

## The venue Wi-Fi fails
1. **Phone hotspot** for the laptop (the phone itself stays on mobile data).
2. If there is no signal at all: play the recorded video.
3. Offline parts still work live without any network: the phone app opens, shows tasks and records clock-ins and notes (they sync later). That is the point of the product, so say so.

## Airplane mode is awkward on stage
Use the **Simulate offline** switch instead: phone → Me → Debug console → *Simulate offline* (demo mode). The app behaves exactly as without signal, and you can switch it back without waiting for the radio.

## Something is slow or fails
| Symptom | What to do |
| --- | --- |
| First dashboard load is slow | The database wakes after idling (about 1 s). Open the dashboard 5 minutes before. |
| AI step takes long or says "Fallback (AI unavailable)" | Keep talking: the fallback output is real and labelled. Explain that this is the design ("the demo never breaks"). |
| Phone task did not arrive | Me → **Sync now**. Check the top bar of the phone (sync status). |
| Push did not arrive | Show the SMS log and the Alerts panel instead; on iPhone, push only works from the Home Screen app. |
| Dashboard shows "Database briefly unavailable" | Wait 5 s; it retries. The phone keeps everything in its outbox meanwhile. |
| Something looks wrong mid-demo | Demo control → **Reset demo**, phone → Me → **Reset this device** → Sam Novak. About 30 s. |

## Reset quickly between runs
1. Laptop: Demo control → **Reset demo** (tap twice). About 10 s.
2. Phone: Me → **Reset this device** (tap twice) → pick **Sam Novak**.
3. Optional check: the health strip, and the Live board shows Sam not clocked in.
