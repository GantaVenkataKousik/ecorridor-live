# eCorridor – Bug Report & UI Issues

> Captured from live demo screenshots · Thu 26 Feb 2026  
> Reference snapshots: `181645`, `181950`, `182241`, `182325`, `182348`, `182455`, `182524`

---

## Issue #1 – Camera Layout Not Responsive on Tablet / Mobile

**Snapshot:** `181645`, `182524`

**Description:**  
Both cameras are rendered side-by-side in a fixed two-column grid regardless of screen width. On narrow viewports (tablets, mobile), the second camera is clipped or squashed instead of wrapping below the first.

**Expected Behavior:**  
- On screens < 768 px, Camera 2 should stack below Camera 1 (single-column layout).
- On tablets (768–1024 px), consider a slightly narrower two-column layout or single column depending on content.

**Fix Suggestion:**  
Use a CSS Grid / Flexbox breakpoint:
```css
.camera-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
@media (max-width: 768px) {
  .camera-grid {
    grid-template-columns: 1fr; /* stack cameras vertically */
  }
}
```

---

## Issue #2 – Detection Count in Stats Box Shows Incorrect / Stale Value

**Snapshot:** `181645`, `181950`, `182241`

**Description:**  
The **Detections** stat card (top summary area) shows `0` even when the Recent Identifications list clearly contains multiple matched faces. The count appears to be correct in the Recent Identifications list but is not reflected in the Detection count card.

**Expected Behavior:**  
The Detection count box should reflect the actual number of active/recent detections, matching (or superseding) what appears in the Recent Identifications list.

**Fix Suggestion:**  
Bind the Detection counter to the same data source that populates Recent Identifications, or derive it from the `frames.matches` NATS topic rather than a separate counter.

---

## Issue #3 – Expanded Camera View Has Excessive Whitespace / Border Issues

**Snapshot:** `182455`, `182524`

**Description:**  
When clicking a camera to open the enlarged/focused view in the Traveller panel, there is a large amount of empty black space below the camera feed. The camera feed does not stretch to fill the available container, leaving an awkward gap that makes the UI look broken.

**Expected Behavior:**  
The expanded camera feed should fill its container proportionally (maintain aspect ratio but use all available height/width without the dead black zone).

**Fix Suggestion:**  
```css
.camera-fullview video,
.camera-fullview img {
  width: 100%;
  height: 100%;
  object-fit: contain; /* or 'cover' depending on design intent */
}
.camera-fullview {
  aspect-ratio: 16 / 9;
  max-height: 80vh;
}
```

---

## Issue #4 – Alert Mode: Both Camera Borders Turn Red Instead of Only the Alerting Camera

**Snapshot:** `182325`, `182348`

**Description:**  
When an alert is triggered (face match on one camera), the Traveller View shows **both** camera borders highlighted red. The alert should only highlight the specific camera that triggered the detection.

Additionally, there is no visible label below the alerted camera saying **"🔴 Red Alert on Cam X"** to make it immediately clear which camera detected the subject.

**Expected Behavior:**  
- Only the camera that triggered the alert should have a red border.
- A label below that camera should read: `🔴 Red Alert on Camera: Tawaren.Cam12` (or whichever camera is alerting).
- Non-alerting cameras should maintain their normal green border.

**Fix Suggestion:**  
Track alert state per camera ID. Apply `border: 2px solid red` conditionally:
```js
// pseudo-code
cameras.forEach(cam => {
  cam.isAlerting = alertEvent.cameraId === cam.id;
});
```
And render the label below each alerting camera:
```html
<div v-if="cam.isAlerting" class="alert-label">🔴 Red Alert on {{ cam.name }}</div>
```

---

## Issue #5 – Traveller Fullscreen Camera View: Video Stutter / Freezing

**Snapshot:** `182455`

**Description:**  
When a camera is opened in the Traveller fullscreen (single large view) mode, the video feed stutters or freezes. The same feed plays smoothly in the side-by-side (normal) Operator view.

**Root Cause (Suspected):**  
The fullscreen view likely creates a new WebSocket connection or re-subscribes to the NATS `frames.raw` topic independently, causing frame loss or a race condition when both views are active simultaneously.

**Expected Behavior:**  
Fullscreen camera should reuse the already-established frame stream, not reconnect.

**Fix Suggestion:**  
- Share a single NATS/WebSocket connection and fan-out frames to all active consumers via an event bus or shared store (e.g., Vuex/Pinia/Zustand).
- Do not create a new subscription on route/view change; instead subscribe once globally and broadcast to views.

---

## Issue #6 – Flickering and Unequal Camera Heights in Side-by-Side View

**Snapshot:** `181950`, `182241`, `182325`

**Description:**  
1. **Flickering:** When the NATS stream experiences a brief interruption or the server drops a frame, the camera feed briefly disappears or goes black, causing a visible flicker.
2. **Unequal Heights:** The two side-by-side cameras render at slightly different heights, creating a misaligned layout.

**Expected Behavior:**  
- On stream interruption, hold the last valid frame instead of blanking the feed.
- Both cameras must have identical heights at all times regardless of source resolution.

**Fix Suggestion:**  
For flicker: buffer the last received frame and display it while waiting for the next frame (add a `lastFrame` fallback).  
For equal heights:
```css
.camera-row {
  display: flex;
  align-items: stretch;
}
.camera-cell {
  flex: 1;
  aspect-ratio: 16 / 9; /* enforce consistent ratio */
  overflow: hidden;
}
.camera-cell img, .camera-cell video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
```

---

## Issue #7 – Data Loss on Stream Interruption (No Persistence Until Manual Refresh)

**Snapshot:** `181645`, `182241`

**Description:**  
When the NATS stream is interrupted or the backend briefly disconnects, the Recent Identifications list, frame counts, and detection counts reset or become stale. Users have to manually refresh the page to restore the correct state.

**Expected Behavior:**  
- All UI data (identifications list, total frames, detection count) should be maintained client-side until explicitly cleared by the user.
- On reconnect, the UI should resume updating from where it left off — not reset.
- The **Clear** button (badge count `6`) should be the only way to wipe the Recent Identifications list.

**Fix Suggestion:**  
- Store all incoming identification events in a persistent in-memory array (or `localStorage`) and render from that store.
- On WebSocket/NATS reconnect, do not clear this store; only append new events.
- Reconnect logic should be silent (no flicker, no reset):
```js
natsClient.on('disconnect', () => {
  // do not reset state — just mark as reconnecting
  setStatus('reconnecting');
});
natsClient.on('reconnect', () => {
  setStatus('connected');
  // resume subscription — state is preserved
});
```

---

## Additional Issues Observed in Snapshots

| # | Observation | Snapshot | Priority |
|---|-------------|----------|----------|
| A | `Camera: Tawaren.Cam12` sometimes shows fully black feed (not just "no faces") with no loading indicator or error state | `181645`, `182524` | Medium |
| B | Traveller View "Show All" button appears only when one camera is selected — it should always be visible to allow switching back to multi-camera view | `182455`, `182524` | Low |
| C | Confidence scores in Recent Identifications (e.g., `54.5%`, `71.9%`) are shown in red for all entries — if these are acceptable match scores, the red color is misleading. Consider colour-coding by threshold (green ≥ 70%, yellow 50–70%, red < 50%) | All | Low |
| D | "NATS Stream" info at the bottom of the Operator panel (`ws://172.20.30.140:7777`) is visible to end users — this internal debug info should be hidden in production or moved to a dev/settings panel | `181645` | Low |
| E | Frame counter (`Frame #53 · 0 faces`) resets to low numbers after reconnect, suggesting frame numbering is per-session rather than cumulative | `182241` | Low |

---

## Summary Table

| # | Issue | View | Severity |
|---|-------|------|----------|
| 1 | Cameras not responsive — second camera doesn't stack on mobile/tablet | Operator | High |
| 2 | Detection count box shows 0 despite active detections | Operator | High |
| 3 | Expanded camera has dead black space / bad border fill | Traveller | High |
| 4 | Both camera borders go red on alert instead of only the alerting cam + missing label | Traveller | High |
| 5 | Fullscreen camera feed stutters/freezes | Traveller | High |
| 6 | Flickering on disconnect + unequal camera heights side-by-side | Both | Medium |
| 7 | State resets on stream interruption — requires manual refresh | Both | High |

---

*Document generated for engineering handoff — ready for Claude 4.6 model execution.*