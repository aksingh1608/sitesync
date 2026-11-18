# Real-device test pass

Run against the **production URL** after `Demo control → Reset demo`. Record each result as
PASS / FAIL + a note. Failures get a workaround in `docs/backup-plan.md`.

Setup: laptop on `/office` as Marcus Bell (manager). Phone person: Sam Novak.

## Android (Chrome)
| # | Step | Expected | Result |
| --- | --- | --- | --- |
| A1 | Open the URL, enter the access code, pick Sam Novak | Task list appears | |
| A2 | Chrome menu → Install app (or the install prompt) | SiteSync icon (sync ring) on the home screen; opens full screen | |
| A3 | Me → Enable notifications → Allow | "Notifications on" | |
| A4 | Airplane mode on → Clock → pick site → safety check → Clock in | Clocked in, "waiting to sync" marker; location asked once | |
| A5 | Still offline: Notes → Text → dictate with the keyboard mic (20+ words) → Save | Note listed, waiting to sync | |
| A6 | Airplane mode off (app open) | Within seconds: synced; the dashboard shows Sam clocked in | |
| A7 | ~20-30 s later | The note shows the report agent log and "Created by report agent" links | |
| A8 | Office approves a task for Sam (Dispatch drafts) | Push notification arrives | |
| A9 | Tap the notification | Opens that task in the app; dashboard shows Seen | |
| A10 | Tap Got it | Dashboard: Acknowledged | |
| A11 | Voice note (record 10 s, save) | Saved and uploaded; plays back; shows "not transcribed in this demo" after sync | |
| A12 | After a redeploy, reopen the app | "Update available, tap to reload" banner; tap → reloads, nothing lost | |

## iPhone (Safari)
| # | Step | Expected | Result |
| --- | --- | --- | --- |
| I1 | Open the URL in Safari, access code, Sam Novak | Task list | |
| I2 | Me → Enable notifications in Safari (not installed) | Shows Add-to-Home-Screen steps instead (iOS only pushes to installed apps) | |
| I3 | Share → Add to Home Screen → open from the icon | Full screen app; the access code is asked again once (separate storage) | |
| I4 | Me → Enable notifications → Allow | "Notifications on" | |
| I5 | A4-A7 as on Android | Same | |
| I6 | A8-A10 as on Android | Same (push only from the Home Screen app) | |
| I7 | Voice note | Records (audio/mp4), uploads, plays back | |
| I8 | Close the app (swipe away), wait 10+ min, office creates a task | Push arrives; opening the app syncs (no background sync on iOS) | |
| I9 | Leave closed overnight, open | Opens offline-capable, syncs on open; access cookie still valid | |
| I10 | After a redeploy | Update banner, as A12 | |

## Laptop (office dashboard)
| # | Step | Expected | Result |
| --- | --- | --- | --- |
| L1 | During A4-A10, watch the Live board and the task drawer | Updates within ~5 s of each phone sync; "Updated Xs ago" keeps ticking | |
| L2 | Enable notifications in the demo clock bar (Chrome) | Alerts arrive as desktop notifications | |
| L3 | Demo control → +30 min ×3 | Push to the phone, SMS log row, Alerts panel entry | |
| L4 | Lighthouse in Chrome DevTools on `/field` (mobile) and `/office` (desktop) | Record Performance / Accessibility / Best practices scores | |
| L5 | DevTools → Application → Manifest | Installable, icons shown, no errors | |

## Results log
| Date | Device / OS / browser | Passed | Failed (with note) |
| --- | --- | --- | --- |
| | | | |
