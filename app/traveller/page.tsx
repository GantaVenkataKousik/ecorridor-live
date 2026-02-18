"use client";

import React, { useEffect, useState, useRef, useCallback } from 'react';
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

export default function TravellerView() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState('');

  // Ordered list of camera ids discovered from frames.raw
  const [cameraIds, setCameraIds] = useState<string[]>([]);

  // Per-camera canvas refs
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Alert overlay state: 'green' | 'red'
  const [alertColor, setAlertColor] = useState<'green' | 'red'>('green');
  const alertTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const registerCanvas = useCallback((cameraId: string, el: HTMLCanvasElement | null) => {
    if (el) canvasRefs.current.set(cameraId, el);
    else canvasRefs.current.delete(cameraId);
  }, []);

  useEffect(() => {
    let nc: any;
    let cancelled = false;

    function renderRawFrame(data: RawFrame) {
      const canvas = canvasRefs.current.get(data.camera_id);
      if (!canvas || !data.image) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const img = new Image();
      const blob = new Blob([new Uint8Array(data.image as any)], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        if (canvas.width !== img.width) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }

    async function setupNats() {
      try {
        nc = await connect({
          servers: ["ws://172.20.30.140:7777"],
          waitOnFirstConnect: true
        });
        if (cancelled) { nc.close(); return; }
        setStatus('connected');

        // ── frames.raw ────────────────────────────────────────────────
        const rawSub = nc.subscribe("frames.raw");
        (async () => {
          for await (const m of rawSub) {
            const data = decode(m.data) as RawFrame;

            // Register new cameras dynamically
            setCameraIds(prev => prev.includes(data.camera_id) ? prev : [...prev, data.camera_id]);

            renderRawFrame(data);
          }
        })();

        // ── frames.alert ──────────────────────────────────────────────
        const alertSub = nc.subscribe("frames.alert");
        (async () => {
          for await (const m of alertSub) {
            const alertData = decode(m.data) as AlertMessage;
            const color = alertData.color?.toUpperCase();

            if (color === 'RED') {
              setAlertColor('red');

              // Clear any pending revert
              if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);

              // Revert back to green after 5 seconds
              alertTimeoutRef.current = setTimeout(() => {
                setAlertColor('green');
                alertTimeoutRef.current = null;
              }, 5000);
            } else {
              // Any non-RED alert immediately clears
              if (alertTimeoutRef.current) {
                clearTimeout(alertTimeoutRef.current);
                alertTimeoutRef.current = null;
              }
              setAlertColor('green');
            }
          }
        })();

      } catch (err: any) {
        if (cancelled) return;
        console.error("NATS Error:", err);
        setStatus('error');
        setErrorMessage(err.message);
      }
    }

    setupNats();

    return () => {
      cancelled = true;
      if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
      if (nc) nc.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRed = alertColor === 'red';

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

              {/* NATS status */}
              <div
                className="flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium"
                style={{
                  backgroundColor: status === 'connected' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                  color: status === 'connected' ? '#22c55e' : '#ef4444'
                }}
              >
                <div
                  className={`h-2 w-2 rounded-full ${status === 'connected' ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: status === 'connected' ? '#22c55e' : '#ef4444' }}
                />
                {status === 'connected' ? 'Live' : status === 'error' ? 'Error' : 'Connecting...'}
              </div>

              <a
                href="/"
                className="flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-white/60 hover:text-white transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.15)' }}
              >
                ← Operator
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main — Camera Grid */}
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
                {status === 'connecting' ? (
                  <div className="h-10 w-10 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: '#1f8a70', borderTopColor: 'transparent' }}></div>
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
                  ? 'Connecting to stream...'
                  : status === 'error'
                    ? 'Connection Error'
                    : 'Waiting for cameras...'}
              </p>
              {errorMessage && <p className="mt-2 text-sm" style={{ color: '#fca5a5' }}>{errorMessage}</p>}
              <p className="mt-3 text-sm" style={{ color: '#4ade80' }}>Listening on frames.raw</p>
            </div>
          </div>
        ) : (
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

                {/* Canvas wrapper with alert ring */}
                <div
                  className="rounded-xl overflow-hidden transition-all duration-300"
                  style={{
                    boxShadow: isRed
                      ? '0 0 0 3px #ef4444, 0 0 24px rgba(239,68,68,0.4)'
                      : '0 0 0 1px rgba(31,138,112,0.4)'
                  }}
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
