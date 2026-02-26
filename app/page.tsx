"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { connect } from 'nats.ws';
import { decode } from '@msgpack/msgpack';

/* ─── Types ────────────────────────────────────────────────────────────── */

interface TrackedFace {
  person_id?: string;
  tracker_id: number;
  distance?: number;
  bbox: [number, number, number, number];
}

interface TrackerData {
  frame_id: number;
  camera_id: string;
  tracked_faces?: TrackedFace[];
  image: Uint8Array;
}

interface MatchData {
  person_id: string;
  tracker_id: number;
  score: number;
  face_crop: Uint8Array;
}

interface RecentMatch {
  id: string;
  image: string;        // compressed base64 data-URL — never blob
  score: string;
  time: string;
  tracker_id: number;
}

interface ColorMessage {
  colorCode: string;
  tracker_id?: number;
}

/* ─── Storage ──────────────────────────────────────────────────────────── */
// FIXED: #7 - sessionStorage persists matches + camera IDs across stream interruptions
// Matches are saved on every update and restored on reload; cameras are re-discovered automatically
const SS_MATCHES_KEY  = 'ecorridor_recent_matches';
const SS_CAMERAS_KEY  = 'ecorridor_camera_ids';
const MAX_MATCHES     = 50;

function loadFromSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

function saveToSession(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/* ─── Image compression ───────────────────────────────────────────────── */
// Resize face crop to ≤96 px thumbnail, JPEG quality 0.6 → ~3-8 KB base64
function compressImageToBase64(raw: Uint8Array, maxPx = 96): Promise<string> {
  return new Promise((resolve) => {
    const blob = new Blob([new Uint8Array(raw)], { type: 'image/jpeg' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c   = document.createElement('canvas');
      const s   = Math.min(maxPx / Math.max(img.width, 1), maxPx / Math.max(img.height, 1), 1);
      c.width   = Math.max(Math.round(img.width * s), 1);
      c.height  = Math.max(Math.round(img.height * s), 1);
      const ctx = c.getContext('2d');
      if (!ctx) { resolve(''); return; }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

/* ─── Component ────────────────────────────────────────────────────────── */
export default function LiveTrackerDashboard() {
  /* ── Connection state ─────────────────────────────────────────── */
  const [status, setStatus]           = useState<'connecting' | 'connected' | 'reconnecting' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState('');

  /* ── Camera state ─────────────────────────────────────────────── */
  const [cameraMeta, setCameraMeta] = useState<Map<string, { frame_id: number; faces: number }>>(new Map());
  const [cameraIds, setCameraIds]   = useState<string[]>(() => loadFromSession<string[]>(SS_CAMERAS_KEY, []));

  const canvasRefs      = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const lastFrameRef    = useRef<Map<string, string>>(new Map());

  /* ── Expand state — inline (not modal) ────────────────────────── */
  const [expandedCamera, setExpandedCamera]   = useState<string | null>(null);
  const expandedCameraRef  = useRef<string | null>(null);
  const expandedCanvasRef  = useRef<HTMLCanvasElement>(null);

  /* ── Matches ──────────────────────────────────────────────────── */
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>(() => loadFromSession<RecentMatch[]>(SS_MATCHES_KEY, []));
  const recentMatchesRef = useRef<RecentMatch[]>(recentMatches);

  /* ── Tracker colours ──────────────────────────────────────────── */
  const trackerColorsRef  = useRef<Map<number, string>>(new Map());
  const [trackerColors, setTrackerColors] = useState<Map<number, string>>(new Map());
  const colorTimeoutsRef  = useRef<Map<number, NodeJS.Timeout>>(new Map());

  /* ── Keep refs in sync ────────────────────────────────────────── */
  useEffect(() => { recentMatchesRef.current = recentMatches; }, [recentMatches]);
  useEffect(() => { expandedCameraRef.current = expandedCamera; }, [expandedCamera]);
  useEffect(() => { trackerColorsRef.current = trackerColors; }, [trackerColors]);

  /* ── Flush state to sessionStorage on unload ──────────────────── */
  useEffect(() => {
    const flush = () => saveToSession(SS_MATCHES_KEY, recentMatchesRef.current);
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  /* ── ESC to collapse expanded camera ──────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedCamera(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── Repaint expanded canvas when switching cameras ────────────── */
  useEffect(() => {
    if (!expandedCamera || !expandedCanvasRef.current) return;
    const src = lastFrameRef.current.get(expandedCamera);
    if (!src) return;
    const canvas = expandedCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => { canvas.width = img.width; canvas.height = img.height; ctx.drawImage(img, 0, 0); };
    img.src = src;
  }, [expandedCamera]);

  const registerCanvas = useCallback((cameraId: string, el: HTMLCanvasElement | null) => {
    if (el) canvasRefs.current.set(cameraId, el);
    else canvasRefs.current.delete(cameraId);
  }, []);

  /* ══════════════════════════════════════════════════════════════════
     NATS connection with auto-reconnect — NEVER triggers page reload
     ══════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    let cancelled  = false;
    let reconnectDelay = 1000;
    const MAX_DELAY = 30000;

    async function connectLoop() {
      while (!cancelled) {
        let nc: any = null;
        try {
          setStatus('connecting');
          setErrorMessage('');

          nc = await connect({
            servers: ["ws://172.20.30.140:7777"],
            reconnect: true,
            maxReconnectAttempts: -1,
            reconnectTimeWait: 2000,
          });

          if (cancelled) { nc.close(); return; }
          setStatus('connected');
          reconnectDelay = 1000; // reset

          /* ── frames.color ──────────────────────────────────────── */
          const colorSub = nc.subscribe("frames.color");
          (async () => {
            for await (const m of colorSub) {
              if (cancelled) return;
              const colorData = decode(m.data) as ColorMessage;
              const trackerId = colorData.tracker_id;
              const color     = colorData.colorCode.toLowerCase();
              if (trackerId === undefined) continue;

              setTrackerColors(prev => { const n = new Map(prev); n.set(trackerId, color); return n; });

              if (color === 'red') {
                if (colorTimeoutsRef.current.has(trackerId))
                  clearTimeout(colorTimeoutsRef.current.get(trackerId)!);
                const tid = setTimeout(() => {
                  setTrackerColors(prev => { const n = new Map(prev); n.set(trackerId, 'green'); return n; });
                  colorTimeoutsRef.current.delete(trackerId);
                }, 5000);
                colorTimeoutsRef.current.set(trackerId, tid);
              }
            }
          })();

          /* ── frames.matches — compressed base64 images ─────────── */
          const matchSub = nc.subscribe("frames.matches");
          (async () => {
            for await (const m of matchSub) {
              if (cancelled) return;
              const matchData = decode(m.data) as MatchData;

              // Compress face crop → small base64 thumbnail (never blob URL)
              const thumb = await compressImageToBase64(matchData.face_crop as unknown as Uint8Array);

              setRecentMatches(prev => {
                const entry: RecentMatch = {
                  id:         matchData.person_id,
                  image:      thumb,
                  score:      (matchData.score * 100).toFixed(1),
                  time:       new Date().toLocaleTimeString(),
                  tracker_id: matchData.tracker_id,
                };
                const existingIdx = prev.findIndex(p => p.id === matchData.person_id);
                let next: RecentMatch[];
                if (existingIdx !== -1) {
                  // Same person → update image + move to top
                  next = [entry, ...prev.filter((_, i) => i !== existingIdx)];
                } else {
                  next = [entry, ...prev];
                }
                next = next.slice(0, MAX_MATCHES);
                // Persist synchronously with images included
                saveToSession(SS_MATCHES_KEY, next);
                return next;
              });
            }
          })();

          /* ── frames.tracker ────────────────────────────────────── */
          const trackerSub = nc.subscribe("frames.tracker");
          (async () => {
            for await (const m of trackerSub) {
              if (cancelled) return;
              const data = decode(m.data) as TrackerData;

              setCameraIds(prev => {
                if (prev.includes(data.camera_id)) return prev;
                const next = [...prev, data.camera_id];
                saveToSession(SS_CAMERAS_KEY, next);
                return next;
              });
              setCameraMeta(prev => {
                const next = new Map(prev);
                next.set(data.camera_id, { frame_id: data.frame_id, faces: data.tracked_faces?.length || 0 });
                return next;
              });

              renderToCanvas(data);
            }
          })();

          // Wait until the connection closes (server down, network drop, etc.)
          await nc.closed();
          if (cancelled) return;

          // Connection lost — keep all state, just update status
          setStatus('reconnecting');
          setErrorMessage('Stream interrupted — reconnecting…');
        } catch (err: any) {
          if (cancelled) return;
          setStatus('reconnecting');
          setErrorMessage(`Reconnecting in ${Math.round(reconnectDelay / 1000)}s… (${err?.message || 'unknown error'})`);
        }

        // Exponential back-off
        if (!cancelled) {
          await new Promise(r => setTimeout(r, reconnectDelay));
          reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
        }
      }
    }

    function renderToCanvas(data: TrackerData) {
      const canvas = canvasRefs.current.get(data.camera_id);
      if (!canvas || !data.image) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      const base64 = btoa(
        new Uint8Array(data.image as any).reduce((d, byte) => d + String.fromCharCode(byte), '')
      );
      img.src = `data:image/jpeg;base64,${base64}`;
      lastFrameRef.current.set(data.camera_id, img.src);

      img.onload = () => {
        if (canvas.width !== img.width) { canvas.width = img.width; canvas.height = img.height; }
        ctx.drawImage(img, 0, 0);

        // Mirror to expanded canvas if this camera is expanded
        const expCanvas = expandedCanvasRef.current;
        if (expCanvas && expandedCameraRef.current === data.camera_id) {
          const expCtx = expCanvas.getContext('2d');
          if (expCtx) {
            if (expCanvas.width !== img.width) { expCanvas.width = img.width; expCanvas.height = img.height; }
            expCtx.drawImage(canvas, 0, 0);
          }
        }

        // Draw bounding boxes
        data.tracked_faces?.forEach((face) => {
          const { person_id, bbox, tracker_id } = face;
          const [x, y, w, h] = bbox;
          const trackerColor = trackerColorsRef.current.get(tracker_id);
          let boxColor: string, bgColor: string, textColor: string;

          if (trackerColor === 'red')        { boxColor = '#ef4444'; bgColor = '#ef4444'; textColor = '#ffffff'; }
          else if (trackerColor === 'green')  { boxColor = '#22c55e'; bgColor = '#22c55e'; textColor = '#ffffff'; }
          else { boxColor = person_id ? '#1f8a70' : '#f4d35e'; bgColor = boxColor; textColor = person_id ? '#ffffff' : '#1e2a2f'; }

          ctx.strokeStyle = boxColor; ctx.lineWidth = 3;
          ctx.strokeRect(x, y, w, h);

          if (trackerColor) {
            const cx2 = x + w / 2, cy2 = y + 15, r = 12;
            ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
            ctx.fillStyle = trackerColor === 'red' ? '#ef4444' : '#22c55e';
            ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, 2 * Math.PI); ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, 2 * Math.PI); ctx.stroke();
          }

          const label = person_id ? `ID: ${person_id}` : 'Unknown';
          ctx.font = 'bold 16px Montserrat, sans-serif';
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = bgColor;
          ctx.fillRect(x, y - 28, tw + 12, 24);
          ctx.fillStyle = textColor;
          ctx.fillText(label, x + 6, y - 10);
        });
      };
    }

    connectLoop();

    return () => {
      cancelled = true;
      colorTimeoutsRef.current.forEach(t => clearTimeout(t));
      colorTimeoutsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Derived helpers ──────────────────────────────────────────── */
  const otherCameras = expandedCamera ? cameraIds.filter(id => id !== expandedCamera) : [];

  /* ══════════════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="border-b border-border bg-card shadow-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary">
                <svg className="h-7 w-7 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">eCorridor</h1>
                <p className="text-sm text-muted">Operator Dashboard</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Status badge — includes reconnecting state */}
              <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${
                status === 'connected'    ? 'bg-success-soft text-success'
                : status === 'reconnecting' ? 'bg-warning-soft text-warning'
                : status === 'error'        ? 'bg-destructive-soft text-destructive'
                :                             'bg-warning-soft text-warning'
              }`}>
                <div className={`h-2 w-2 rounded-full ${
                  status === 'connected'    ? 'bg-success animate-pulse'
                  : status === 'reconnecting' ? 'bg-warning animate-pulse'
                  : status === 'error'        ? 'bg-destructive'
                  :                             'bg-warning animate-pulse'
                }`} />
                {status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting…' : status === 'error' ? 'Error' : 'Connecting…'}
              </div>
              <Link
                href="/traveller"
                className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium bg-primary-soft text-primary hover:bg-primary hover:text-white transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Traveller View
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* ── Main Content ────────────────────────────────────────── */}
      <div className="container mx-auto px-6 py-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* ── Camera Feeds ────────────────────────────────────── */}
          <div className="space-y-4">
            {cameraIds.length === 0 ? (
              <div className="rounded-lg bg-card p-1 shadow-panel">
                <div className="relative overflow-hidden rounded-md bg-black" style={{ minHeight: 360 }}>
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                    <div className="text-center">
                      <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
                        {status === 'connecting' || status === 'reconnecting' ? (
                          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                        ) : status === 'error' ? (
                          <svg className="h-8 w-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        ) : (
                          <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        )}
                      </div>
                      <p className="text-lg font-semibold text-white">
                        {status === 'connecting' ? 'Connecting to stream…' : status === 'reconnecting' ? 'Reconnecting…' : status === 'error' ? 'Connection Error' : 'Waiting for cameras…'}
                      </p>
                      {errorMessage && <p className="mt-2 text-sm text-gray-400">{errorMessage}</p>}
                    </div>
                  </div>
                </div>
              </div>
            ) : expandedCamera ? (
              /* ── Expanded single-camera view (inline, NOT modal) ── */
              <div className="space-y-2">
                {/* Floating mini-thumbnails for other cameras */}
                {otherCameras.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {otherCameras.map(camId => (
                      <button
                        key={camId}
                        onClick={() => setExpandedCamera(camId)}
                        className="flex items-center gap-2 rounded-lg bg-card border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-primary-soft hover:text-primary transition-colors shadow-sm"
                        title={`Switch to ${camId}`}
                      >
                        <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
                        <span>Camera: {camId}</span>
                      </button>
                    ))}
                    <button
                      onClick={() => setExpandedCamera(null)}
                      className="flex items-center gap-2 rounded-lg bg-primary text-white px-3 py-2 text-xs font-medium hover:bg-primary-hover transition-colors shadow-sm"
                      title="Show all cameras"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                      </svg>
                      Show All
                    </button>
                  </div>
                )}

                {/* Expanded camera header */}
                <div className="flex items-center gap-2 px-1">
                  <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
                  <span className="text-sm font-semibold text-foreground">Camera: {expandedCamera}</span>
                  {cameraMeta.get(expandedCamera) && (
                    <span className="ml-auto text-xs text-muted">
                      Frame #{cameraMeta.get(expandedCamera)!.frame_id.toLocaleString()} · {cameraMeta.get(expandedCamera)!.faces} face{cameraMeta.get(expandedCamera)!.faces !== 1 ? 's' : ''}
                    </span>
                  )}
                  {otherCameras.length === 0 && (
                    <button onClick={() => setExpandedCamera(null)} className="ml-auto text-xs text-muted hover:text-foreground transition-colors">
                      ✕ Collapse
                    </button>
                  )}
                </div>

                {/* FIXED: #3 - expanded canvas fills container, no black gap below */}
                <div className="rounded-lg bg-card p-1 shadow-panel">
                  <div className="relative overflow-hidden rounded-md bg-black" style={{ aspectRatio: '16/9', maxHeight: '80vh' }}>
                    <canvas
                      ref={expandedCanvasRef}
                      className="w-full h-full block"
                    />
                  </div>
                </div>
              </div>
            ) : (
              /* FIXED: #1 - responsive grid: single column on mobile, 2-col on sm+ */
              /* ── Normal camera grid ────────────────────────────── */
              <div className={`grid gap-4 ${cameraIds.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                {cameraIds.map(cameraId => {
                  const meta = cameraMeta.get(cameraId);
                  return (
                    <div key={cameraId} className="space-y-2">
                      <div className="flex items-center gap-2 px-1">
                        <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
                        <span className="text-sm font-semibold text-foreground">Camera: {cameraId}</span>
                        {meta && (
                          <span className="ml-auto text-xs text-muted">
                            Frame #{meta.frame_id.toLocaleString()} · {meta.faces} face{meta.faces !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <div
                        className="rounded-lg bg-card p-1 shadow-panel cursor-pointer group"
                        onClick={() => setExpandedCamera(cameraId)}
                        title="Click to expand"
                      >
                        {/* FIXED: #6 - aspect-ratio container ensures equal heights across cameras */}
                        <div className="relative overflow-hidden rounded-md bg-black" style={{ aspectRatio: '16/9' }}>
                          <canvas
                            ref={el => registerCanvas(cameraId, el)}
                            className="w-full h-full block"
                          />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-all pointer-events-none">
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 rounded-full p-2">
                              <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                              </svg>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Reconnecting banner (non-intrusive, no refresh) ── */}
            {(status === 'reconnecting' || (status === 'error' && cameraIds.length > 0)) && (
              <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-warning border-t-transparent shrink-0" />
                <span>{errorMessage || 'Stream interrupted — reconnecting automatically…'}</span>
              </div>
            )}

            {/* ── Aggregate Stats ────────────────────────────────── */}
            {cameraIds.length > 0 && (
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg bg-card p-4 shadow-sm border border-border">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft">
                      <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted">Cameras</p>
                      <p className="text-lg font-semibold text-foreground">{cameraIds.length}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-card p-4 shadow-sm border border-border">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft">
                      <svg className="h-5 w-5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted">Total Frames</p>
                      <p className="text-lg font-semibold text-foreground">
                        {Array.from(cameraMeta.values()).reduce((s, m) => s + m.frame_id, 0).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-card p-4 shadow-sm border border-border">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-soft">
                      <svg className="h-5 w-5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                    </div>
                    <div>
                      {/* FIXED: #2 - bind Detections to recentMatches count, not per-frame face count */}
                      <p className="text-xs font-medium text-muted">Detections</p>
                      <p className="text-lg font-semibold text-foreground">
                        {recentMatches.length}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Sidebar — Recent Identifications (top 50, scrollable) ── */}
          <div className="space-y-4">
            <div className="rounded-lg bg-card p-5 shadow-panel border border-border">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Recent Identifications</h2>
                <div className="flex items-center gap-2">
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground">
                    {recentMatches.length}
                  </span>
                  {recentMatches.length > 0 && (
                    <button
                      onClick={() => { setRecentMatches([]); sessionStorage.removeItem(SS_MATCHES_KEY); }}
                      className="text-xs text-muted hover:text-destructive transition-colors"
                      title="Clear history"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Scrollable list — max 50 items */}
              <div className="space-y-3 max-h-[calc(100vh-280px)] overflow-y-auto pr-1"
                style={{ scrollbarGutter: 'stable' }}>
                {recentMatches.length === 0 ? (
                  <div className="py-12 text-center">
                    <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted/20">
                      <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-muted">No identifications yet</p>
                    <p className="mt-1 text-xs text-muted/70">Matches will appear here</p>
                  </div>
                ) : (
                  recentMatches.map((match) => {
                    const trackerColor = trackerColors.get(match.tracker_id);
                    return (
                      <div
                        key={`${match.id}-${match.tracker_id}`}
                        className="group rounded-lg border bg-background-secondary p-3 transition-all hover:shadow-md"
                        style={{
                          borderColor: trackerColor === 'red' ? '#ef4444' : trackerColor === 'green' ? '#22c55e' : undefined
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2"
                            style={{
                              borderColor: trackerColor === 'red' ? '#ef4444' : trackerColor === 'green' ? '#22c55e' : '#1f8a70'
                            }}>
                            {match.image ? (
                              <img src={match.image} alt={`Person ${match.id}`} className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                              <div className="h-full w-full flex items-center justify-center bg-muted/20">
                                <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                              </div>
                            )}
                            {trackerColor && (
                              <div className="absolute -top-1 -right-1 h-5 w-5 rounded-full border-2 border-white shadow-md"
                                style={{ backgroundColor: trackerColor === 'red' ? '#ef4444' : '#22c55e' }} />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <p className="font-semibold text-foreground truncate">ID: {match.id}</p>
                                {trackerColor && (
                                  <span className="flex items-center gap-1 text-xs font-semibold"
                                    style={{ color: trackerColor === 'red' ? '#ef4444' : '#22c55e' }}>
                                    <span className="h-2 w-2 rounded-full"
                                      style={{ backgroundColor: trackerColor === 'red' ? '#ef4444' : '#22c55e' }} />
                                    {trackerColor.toUpperCase()}
                                  </span>
                                )}
                              </div>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                parseFloat(match.score) >= 80 ? 'bg-success-soft text-success'
                                : parseFloat(match.score) >= 60 ? 'bg-warning-soft text-warning'
                                : 'bg-destructive-soft text-destructive'
                              }`}>
                                {match.score}%
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted">Tracker #{match.tracker_id}</p>
                            <p className="mt-0.5 text-xs text-muted">{match.time}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Connection Info */}
            <div className="rounded-lg bg-linear-to-br from-primary/5 to-accent/5 p-4 border border-primary/20">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">NATS Stream</p>
                  <p className="mt-1 text-xs text-muted">ws://172.20.30.140:7777</p>
                  <p className="mt-2 text-xs text-muted/70">Topics: frames.tracker · frames.matches · frames.color</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
