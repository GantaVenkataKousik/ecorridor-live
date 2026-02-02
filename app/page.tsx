"use client";

import React, { useEffect, useState, useRef } from 'react';
import { connect } from 'nats.ws';
import { decode } from '@msgpack/msgpack';

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
  image: string;
  score: string;
  time: string;
  tracker_id: number;
}

export default function LiveTrackerDashboard() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState('');
  const [meta, setMeta] = useState({ frame_id: 0, camera_id: "", faces: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [recentMatches, setRecentMatches] = useState<RecentMatch[]>([]);

  useEffect(() => {
    let nc: any;

    async function setupNats() {
      try {
        nc = await connect({
          servers: ["ws://172.20.30.140:7777"],
          waitOnFirstConnect: true
        });
        setStatus('connected');

        const matchSub = nc.subscribe("frames.matches");
        (async () => {
          for await (const m of matchSub) {
            const matchData = decode(m.data) as MatchData;

            const blob = new Blob([new Uint8Array(matchData.face_crop as any)], { type: 'image/jpeg' });
            const cropUrl = URL.createObjectURL(blob);

            setRecentMatches(prev => [
              {
                id: matchData.person_id,
                image: cropUrl,
                score: (matchData.score * 100).toFixed(1),
                time: new Date().toLocaleTimeString(),
                tracker_id: matchData.tracker_id
              },
              ...prev
            ].slice(0, 10));
          }
        })();

        const sub = nc.subscribe("frames.tracker");

        for await (const m of sub) {
          const data = decode(m.data) as TrackerData;

          setMeta({
            frame_id: data.frame_id,
            camera_id: data.camera_id,
            faces: data.tracked_faces?.length || 0
          });

          renderToCanvas(data);
        }
      } catch (err: any) {
        console.error("NATS Error:", err);
        setStatus('error');
        setErrorMessage(err.message);
      }
    }

    function renderToCanvas(data: TrackerData) {
      const canvas = canvasRef.current;
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

        // Draw Bounding Boxes
        data.tracked_faces?.forEach((face) => {
          const { person_id, bbox } = face;
          const [x, y, w, h] = bbox;

          // Draw box
          ctx.strokeStyle = person_id ? '#1f8a70' : '#f4d35e';
          ctx.lineWidth = 3;
          ctx.strokeRect(x, y, w, h);

          // Draw label background
          const label = person_id ? `ID: ${person_id}` : `Tracking...`;
          ctx.font = 'bold 16px Montserrat, sans-serif';
          const textMetrics = ctx.measureText(label);
          const textHeight = 24;

          ctx.fillStyle = person_id ? '#1f8a70' : '#f4d35e';
          ctx.fillRect(x, y - textHeight - 4, textMetrics.width + 12, textHeight);

          // Draw label text
          ctx.fillStyle = person_id ? '#ffffff' : '#1e2a2f';
          ctx.fillText(label, x + 6, y - 10);
        });

        URL.revokeObjectURL(url);
      };
      img.src = url;
    }

    setupNats();

    return () => {
      if (nc) nc.close();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
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
                <p className="text-sm text-muted">Live Tracker Dashboard</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${status === 'connected'
                ? 'bg-success-soft text-success'
                : status === 'error'
                  ? 'bg-destructive-soft text-destructive'
                  : 'bg-warning-soft text-warning'
                }`}>
                <div className={`h-2 w-2 rounded-full ${status === 'connected'
                  ? 'bg-success animate-pulse'
                  : status === 'error'
                    ? 'bg-destructive'
                    : 'bg-warning animate-pulse'
                  }`}></div>
                {status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : 'Connecting...'}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* Video Feed */}
          <div className="space-y-4">
            <div className="rounded-lg bg-card p-1 shadow-panel">
              <div className="relative overflow-hidden rounded-md bg-black">
                <canvas
                  ref={canvasRef}
                  className="w-full h-auto"
                  style={{ maxHeight: 'calc(100vh - 240px)' }}
                />
                {status !== 'connected' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                    <div className="text-center">
                      <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
                        {status === 'connecting' ? (
                          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
                        ) : (
                          <svg className="h-8 w-8 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                      </div>
                      <p className="text-lg font-semibold text-white">
                        {status === 'connecting' ? 'Connecting to stream...' : 'Connection Error'}
                      </p>
                      {errorMessage && (
                        <p className="mt-2 text-sm text-gray-400">{errorMessage}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Stream Info */}
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-card p-4 shadow-sm border border-border">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft">
                    <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted">Camera ID</p>
                    <p className="text-lg font-semibold text-foreground">{meta.camera_id || 'N/A'}</p>
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
                    <p className="text-xs font-medium text-muted">Frame</p>
                    <p className="text-lg font-semibold text-foreground">{meta.frame_id.toLocaleString()}</p>
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
                    <p className="text-xs font-medium text-muted">Detections</p>
                    <p className="text-lg font-semibold text-foreground">{meta.faces}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar - Recent Matches */}
          <div className="space-y-4">
            <div className="rounded-lg bg-card p-5 shadow-panel border border-border">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Recent Identifications</h2>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  {recentMatches.length}
                </span>
              </div>

              <div className="space-y-3 max-h-[calc(100vh-280px)] overflow-y-auto pr-2">
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
                  recentMatches.map((match, idx) => (
                    <div
                      key={`${match.tracker_id}-${idx}`}
                      className="group rounded-lg border border-border bg-background-secondary p-3 transition-all hover:border-primary hover:shadow-md"
                    >
                      <div className="flex items-start gap-3">
                        <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border-2 border-primary">
                          <img
                            src={match.image}
                            alt={`Person ${match.id}`}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-semibold text-foreground truncate">ID: {match.id}</p>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${parseFloat(match.score) >= 80
                              ? 'bg-success-soft text-success'
                              : parseFloat(match.score) >= 60
                                ? 'bg-warning-soft text-warning'
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
                  ))
                )}
              </div>
            </div>

            {/* Connection Info */}
            <div className="rounded-lg bg-gradient-to-br from-primary/5 to-accent/5 p-4 border border-primary/20">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">NATS Stream</p>
                  <p className="mt-1 text-xs text-muted">ws://172.20.30.140:7777</p>
                  <p className="mt-2 text-xs text-muted/70">Topics: frames.tracker, frames.matches</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
