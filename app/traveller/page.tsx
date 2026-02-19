"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { connect } from 'nats.ws';
import { decode } from '@msgpack/msgpack';

/**
 * frames.raw  — raw JPEG feed per camera
 *   msgpack: { camera_id: string, image: Uint8Array, frame_id: number }
 *
 * frames.alert — alert signal
 *   msgpack: { color: "RED" | "GREEN" | ... }
 *   On RED  → flash red overlay on all cameras, then revert to green after 5 s
 */

interface RawFrame {
  camera_id: string;
  frame_id: number;
  image: Uint8Array;
}

interface AlertMessage {
  color: string;
}

/* ── Session-storage helpers ──────────────────────────────────────────── */
const SS_CAMERAS_KEY = 'ecorridor_traveller_cameras';

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


export default function TravellerView() {
  const [status, setStatus]             = useState<'connecting' | 'connected' | 'reconnecting' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState('');

  // Ordered list of camera ids — restored from session so grid survives reconnect
  const [cameraIds, setCameraIds] = useState<string[]>(() => loadFromSession<string[]>(SS_CAMERAS_KEY, []));

  // Per-camera canvas refs
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // Cache last frame per camera for expanded view
  const lastFrameRef = useRef<Map<string, string>>(new Map());

  // Alert overlay state: 'green' | 'red'
  const [alertColor, setAlertColor] = useState<'green' | 'red'>('green');
  const alertTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Multi-camera expand
  const [expandedCamera, setExpandedCamera] = useState<string | null>(null);
  const expandedCameraRef = useRef<string | null>(null);
  const expandedCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { expandedCameraRef.current = expandedCamera; }, [expandedCamera]);

  // Repaint expanded canvas on switch
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

  // ESC to exit expanded view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedCamera(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const registerCanvas = useCallback((cameraId: string, el: HTMLCanvasElement | null) => {
    if (el) canvasRefs.current.set(cameraId, el);
    else canvasRefs.current.delete(cameraId);
  }, []);

  /* ══════════════════════════════════════════════════════════════════
     NATS auto-reconnect loop — never reloads the page
     ══════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    let cancelled = false;
    let reconnectDelay = 1000;
    const MAX_DELAY = 30000;

    function renderRawFrame(data: RawFrame) {
      const canvas = canvasRefs.current.get(data.camera_id);
      if (!canvas || !data.image) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      const base64 = btoa(
        new Uint8Array(data.image as any)
          .reduce((d, byte) => d + String.fromCharCode(byte), '')
      );
      img.src = `data:image/jpeg;base64,${base64}`;
      lastFrameRef.current.set(data.camera_id, img.src);

      img.onload = () => {
        if (canvas.width !== img.width) { canvas.width = img.width; canvas.height = img.height; }
        ctx.drawImage(img, 0, 0);

        // Mirror to expanded canvas if active
        const expCanvas = expandedCanvasRef.current;
        if (expCanvas && expandedCameraRef.current === data.camera_id) {
          const expCtx = expCanvas.getContext('2d');
          if (expCtx) {
            if (expCanvas.width !== img.width) { expCanvas.width = img.width; expCanvas.height = img.height; }
            expCtx.drawImage(canvas, 0, 0);
          }
        }
      };
    }

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
          reconnectDelay = 1000;

          // ── frames.raw ────────────────────────────────────────
          const rawSub = nc.subscribe("frames.raw");
          (async () => {
            for await (const m of rawSub) {
              if (cancelled) return;
              const data = decode(m.data) as RawFrame;

              setCameraIds(prev => {
                if (prev.includes(data.camera_id)) return prev;
                const next = [...prev, data.camera_id];
                saveToSession(SS_CAMERAS_KEY, next);
                return next;
              });

              renderRawFrame(data);
            }
          })();

          // ── frames.alert ──────────────────────────────────────
          const alertSub = nc.subscribe("frames.alert");
          (async () => {
            for await (const m of alertSub) {
              if (cancelled) return;
              const alertData = decode(m.data) as AlertMessage;
              const color = alertData.color?.toUpperCase();

              if (color === 'RED') {
                setAlertColor('red');
                if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
                alertTimeoutRef.current = setTimeout(() => {
                  setAlertColor('green');
                  alertTimeoutRef.current = null;
                }, 5000);
              } else {
                if (alertTimeoutRef.current) { clearTimeout(alertTimeoutRef.current); alertTimeoutRef.current = null; }
                setAlertColor('green');
              }
            }
          })();

          // Wait until connection closes
          await nc.closed();
          if (cancelled) return;
          setStatus('reconnecting');
          setErrorMessage('Stream interrupted — reconnecting…');
        } catch (err: any) {
          if (cancelled) return;
          setStatus('reconnecting');
          setErrorMessage(`Reconnecting in ${Math.round(reconnectDelay / 1000)}s…`);
        }

        // Exponential back-off
        if (!cancelled) {
          await new Promise(r => setTimeout(r, reconnectDelay));
          reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_DELAY);
        }
      }
    }

    connectLoop();

    return () => {
      cancelled = true;
      if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRed = alertColor === 'red';
  const otherCameras = expandedCamera ? cameraIds.filter(id => id !== expandedCamera) : [];

  return (
    <div
      className="min-h-screen flex flex-col transition-colors duration-500"
      style={{ backgroundColor: isRed ? '#1a0000' : '#0a1a0f' }}
    >
      {/* Alert border pulse */}
      {isRed && (
        <div
          className="fixed inset-0 pointer-events-none z-50 animate-pulse"
          style={{ boxShadow: 'inset 0 0 60px 20px rgba(239,68,68,0.5)' }}
        />
      )}

      {/* Header */}
      <header
        className="border-b shadow-sm transition-colors duration-500"
        style={{
          backgroundColor: isRed ? '#2d0000' : '#0f2318',
          borderColor: isRed ? '#ef4444' : '#1f8a70'
        }}
      >
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div
                className="flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-500"
                style={{ backgroundColor: isRed ? '#ef4444' : '#1f8a70' }}
              >
                <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">eCorridor</h1>
                <p className="text-sm" style={{ color: isRed ? '#fca5a5' : '#6ee7b7' }}>Traveller View</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Alert badge */}
              <div
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-all duration-300 ${isRed ? 'animate-pulse' : ''}`}
                style={{
                  backgroundColor: isRed ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)',
                  color: isRed ? '#ef4444' : '#22c55e',
                  border: `1px solid ${isRed ? '#ef4444' : '#22c55e'}`
                }}
              >
                <div
                  className={`h-2.5 w-2.5 rounded-full ${isRed ? 'animate-ping' : 'animate-pulse'}`}
                  style={{ backgroundColor: isRed ? '#ef4444' : '#22c55e' }}
                />
                {isRed ? '⚠ ALERT' : 'CLEAR'}
              </div>

              {/* NATS status — includes reconnecting */}
              <div
                className="flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium"
                style={{
                  backgroundColor: status === 'connected' ? 'rgba(34,197,94,0.1)' : status === 'reconnecting' ? 'rgba(244,180,0,0.1)' : 'rgba(239,68,68,0.1)',
                  color: status === 'connected' ? '#22c55e' : status === 'reconnecting' ? '#f4b400' : '#ef4444'
                }}
              >
                <div
                  className={`h-2 w-2 rounded-full ${status === 'connected' || status === 'reconnecting' ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: status === 'connected' ? '#22c55e' : status === 'reconnecting' ? '#f4b400' : '#ef4444' }}
                />
                {status === 'connected' ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : status === 'error' ? 'Error' : 'Connecting…'}
              </div>

              <Link
                href="/"
                className="flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-white/60 hover:text-white transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.15)' }}
              >
                ← Operator
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Reconnecting banner — keeps all camera state, never refreshes */}
      {status === 'reconnecting' && (
        <div className="px-6 py-2 text-center text-sm font-medium" style={{ backgroundColor: 'rgba(244,180,0,0.15)', color: '#f4b400' }}>
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {errorMessage || 'Stream interrupted — reconnecting automatically…'}
          </span>
        </div>
      )}

      {/* Main — Camera Grid / Expanded View */}
      <main className="flex-1 container mx-auto px-6 py-6">
        {cameraIds.length === 0 ? (
          /* Waiting placeholder */
          <div
            className="rounded-2xl overflow-hidden flex items-center justify-center"
            style={{ minHeight: 'calc(100vh - 180px)', backgroundColor: '#0f1f14' }}
          >
            <div className="text-center">
              <div
                className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full"
                style={{ backgroundColor: 'rgba(31,138,112,0.15)' }}
              >
                {status === 'connecting' || status === 'reconnecting' ? (
                  <div className="h-10 w-10 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: '#1f8a70', borderTopColor: 'transparent' }} />
                ) : status === 'error' ? (
                  <svg className="h-10 w-10" style={{ color: '#ef4444' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="h-10 w-10" style={{ color: '#1f8a70' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </div>
              <p className="text-xl font-semibold text-white">
                {status === 'connecting'
                  ? 'Connecting to stream…'
                  : status === 'reconnecting'
                    ? 'Reconnecting…'
                    : status === 'error'
                      ? 'Connection Error'
                      : 'Waiting for cameras…'}
              </p>
              {errorMessage && <p className="mt-2 text-sm" style={{ color: '#fca5a5' }}>{errorMessage}</p>}
              <p className="mt-3 text-sm" style={{ color: '#4ade80' }}>Listening on frames.raw</p>
            </div>
          </div>
        ) : expandedCamera ? (
          /* ── Expanded single-camera view (inline) ──────────────── */
          <div className="flex flex-col gap-3" style={{ minHeight: 'calc(100vh - 200px)' }}>
            {/* Mini-toggles for other cameras */}
            {otherCameras.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {otherCameras.map(camId => (
                  <button
                    key={camId}
                    onClick={() => setExpandedCamera(camId)}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-white/70 hover:text-white transition-colors"
                    style={{ backgroundColor: 'rgba(31,138,112,0.2)', border: '1px solid rgba(31,138,112,0.4)' }}
                    title={`Switch to ${camId}`}
                  >
                    <div className="h-2 w-2 rounded-full animate-pulse" style={{ backgroundColor: isRed ? '#ef4444' : '#22c55e' }} />
                    Camera: {camId}
                  </button>
                ))}
                <button
                  onClick={() => setExpandedCamera(null)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                  style={{ backgroundColor: '#1f8a70', color: '#ffffff' }}
                  title="Show all cameras"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  Show All
                </button>
              </div>
            )}

            {/* Camera label */}
            <div className="flex items-center gap-2 px-1">
              <div className="h-2 w-2 rounded-full animate-pulse" style={{ backgroundColor: isRed ? '#ef4444' : '#22c55e' }} />
              <span className="text-sm font-semibold" style={{ color: isRed ? '#fca5a5' : '#6ee7b7' }}>
                Camera: {expandedCamera}
              </span>
              {otherCameras.length === 0 && (
                <button onClick={() => setExpandedCamera(null)} className="ml-auto text-xs text-white/40 hover:text-white transition-colors">
                  ✕ Collapse
                </button>
              )}
            </div>

            {/* Full-width canvas */}
            <div
              className="rounded-xl overflow-hidden flex-1 transition-all duration-300"
              style={{
                boxShadow: isRed
                  ? '0 0 0 3px #ef4444, 0 0 24px rgba(239,68,68,0.4)'
                  : '0 0 0 1px rgba(31,138,112,0.4)'
              }}
            >
              <div className="relative bg-black h-full">
                <canvas
                  ref={expandedCanvasRef}
                  className="w-full h-auto block"
                  style={{ maxHeight: 'calc(100vh - 260px)' }}
                />
                {isRed && (
                  <div className="absolute inset-0 pointer-events-none animate-pulse"
                    style={{ backgroundColor: 'rgba(239,68,68,0.12)' }} />
                )}
              </div>
            </div>
          </div>
        ) : (
          /* ── Normal Camera Grid ────────────────────────────────── */
          <div className={`grid gap-4 h-full ${cameraIds.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {cameraIds.map(cameraId => (
              <div key={cameraId} className="flex flex-col gap-2">
                {/* Camera label */}
                <div className="flex items-center gap-2 px-1">
                  <div
                    className="h-2 w-2 rounded-full animate-pulse"
                    style={{ backgroundColor: isRed ? '#ef4444' : '#22c55e' }}
                  />
                  <span className="text-sm font-semibold" style={{ color: isRed ? '#fca5a5' : '#6ee7b7' }}>
                    Camera: {cameraId}
                  </span>
                </div>

                {/* Canvas wrapper with alert ring — click to expand */}
                <div
                  className="rounded-xl overflow-hidden transition-all duration-300 cursor-pointer group"
                  style={{
                    boxShadow: isRed
                      ? '0 0 0 3px #ef4444, 0 0 24px rgba(239,68,68,0.4)'
                      : '0 0 0 1px rgba(31,138,112,0.4)'
                  }}
                  onClick={() => cameraIds.length > 1 ? setExpandedCamera(cameraId) : undefined}
                  title={cameraIds.length > 1 ? 'Click to expand' : undefined}
                >
                  <div className="relative bg-black">
                    <canvas
                      ref={el => registerCanvas(cameraId, el)}
                      className="w-full h-auto block"
                      style={{ maxHeight: cameraIds.length > 1 ? 'calc(50vh - 100px)' : 'calc(100vh - 200px)' }}
                    />
                    {/* Alert overlay on canvas */}
                    {isRed && (
                      <div
                        className="absolute inset-0 pointer-events-none animate-pulse"
                        style={{ backgroundColor: 'rgba(239,68,68,0.12)' }}
                      />
                    )}
                    {/* Expand hint */}
                    {cameraIds.length > 1 && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-all pointer-events-none">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 rounded-full p-2">
                          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                          </svg>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer info */}
      <footer
        className="border-t px-6 py-3 flex items-center justify-between"
        style={{
          borderColor: isRed ? '#7f1d1d' : '#14532d',
          backgroundColor: isRed ? '#2d0000' : '#0f2318'
        }}
      >
        <p className="text-xs" style={{ color: isRed ? '#fca5a5' : '#6ee7b7' }}>
          NATS: ws://172.20.30.140:7777 · frames.raw · frames.alert
        </p>
        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>
          {cameraIds.length} camera{cameraIds.length !== 1 ? 's' : ''} active
        </p>
      </footer>
    </div>
  );
}
