import type { RunEvent } from "../shared/types.js";

/**
 * AUD-17 / AT-UI-006, AT-UI-007, AT-REL-008 — bounded, lossless run event stream.
 *
 * Race being fixed: the previous route replayed every stored page first and only
 * subscribed afterwards, so an event appended between the last replayed page and
 * the subscription was lost forever. Here the subscription is established BEFORE
 * replay; live events that arrive during replay are captured and, once the replay
 * watermark is known, the ones beyond it are flushed in `seq` order. Every emitted
 * event advances a monotonic `seq` watermark, so duplicates are dropped.
 *
 * Memory bound: the replay buffer and the live buffer are each capped
 * (`queueMax`). When a slow client exceeds the cap — or the socket stays
 * backpressured beyond `highWaterMarkBytes` — the documented policy is to CLOSE
 * the connection (`overflow`). The route writes an `overflow` notice and ends the
 * response; the browser `EventSource` reconnects automatically with its
 * `Last-Event-ID` header, and the next connection replays from there. Nothing is
 * silently dropped, and one connection can never grow without bound.
 */

export type EventStreamCloseReason = "overflow" | "error";

export interface RunEventStreamOptions {
  runId: string;
  /** Reads a bounded page of events strictly after `after`, ascending by seq. */
  fetchPage: (after: number, limit: number) => Promise<RunEvent[]>;
  /** Registers a live listener; returns an unsubscribe function. */
  subscribe: (listener: (event: RunEvent) => void) => () => void;
  /** Writes one event. Return `false` when the socket is backpressured. */
  send: (event: RunEvent) => boolean | void;
  /** Invoked exactly once when the connection must be closed. */
  close: (reason: EventStreamCloseReason, detail?: string) => void;
  /** Bytes currently queued by the socket, combined with `send` for backpressure. */
  bufferedBytes?: () => number;
  /** Optional liveness comment written while live. */
  heartbeat?: () => void;
  heartbeatMs?: number;
  /** Maximum buffered events (replay + live) before the connection is closed. */
  queueMax?: number;
  /** Replay page size. */
  pageSize?: number;
  /** Socket-side buffered-byte ceiling that triggers a pause. */
  highWaterMarkBytes?: number;
  /** Resume cursor (Last-Event-ID / `since`); defaults to 0. */
  cursor?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

const DEFAULTS = {
  heartbeatMs: 15_000,
  queueMax: 1_000,
  pageSize: 500,
  highWaterMarkBytes: 1_048_576,
};

export class RunEventStream {
  private readonly queueMax: number;
  private readonly pageSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly heartbeatMs: number;

  private mode: "replay" | "live" = "replay";
  /** Highest contiguously emitted seq; also the resume cursor. */
  private lastSent: number;
  /** Highest seq observed in a replayed page (the replay watermark). */
  private replayWatermark: number;
  private replayDone = false;
  /** Unsent replay events, always ascending and contiguous above `lastSent`. */
  private queue: RunEvent[] = [];
  /** Live events observed before the replay watermark was known. */
  private liveBuffer: RunEvent[] = [];
  private paused = false;
  private closed = false;
  private unsubscribe?: () => void;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private readonly options: RunEventStreamOptions) {
    this.queueMax = Math.max(1, options.queueMax ?? DEFAULTS.queueMax);
    this.pageSize = Math.max(1, options.pageSize ?? DEFAULTS.pageSize);
    this.highWaterMarkBytes = Math.max(1, options.highWaterMarkBytes ?? DEFAULTS.highWaterMarkBytes);
    this.heartbeatMs = Math.max(0, options.heartbeatMs ?? DEFAULTS.heartbeatMs);
    this.lastSent = Math.max(0, options.cursor ?? 0);
    this.replayWatermark = this.lastSent;
  }

  /** Highest sequence this connection has emitted (watermark). */
  get watermark() {
    return this.lastSent;
  }

  get buffered() {
    return this.queue.length + this.liveBuffer.length;
  }

  async start(): Promise<void> {
    if (this.closed) return;
    // (a) subscribe BEFORE reading pages so nothing appended in between is lost.
    this.unsubscribe = this.options.subscribe((event) => this.onLive(event));
    if (this.options.heartbeat && this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.mode === "live" && !this.closed) this.safe(() => this.options.heartbeat?.());
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
    // (b) replay from the cursor up to a definite watermark.
    await this.pumpReplay();
    if (this.closed) return;
    if (this.replayDone) this.enterLive();
  }

  /** Socket drained: resume writing and, if needed, continue the replay. */
  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    if (!this.replayDone) {
      this.flushQueue();
      if (this.closed || this.paused) return;
      void this.pumpReplay().then(() => {
        if (!this.closed && this.replayDone) this.enterLive();
      });
      return;
    }
    this.flushQueue();
    if (this.closed || this.paused) return;
    this.flushLive();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.unsubscribe?.();
    this.queue = [];
    this.liveBuffer = [];
  }

  private async pumpReplay(): Promise<void> {
    while (!this.closed && !this.paused && this.queue.length === 0) {
      const page = await this.options.fetchPage(this.lastSent, this.pageSize);
      if (this.closed) return;
      if (page.length === 0) {
        this.replayDone = true;
        return;
      }
      this.replayWatermark = Math.max(this.replayWatermark, page[page.length - 1].seq);
      let index = 0;
      for (; index < page.length; index += 1) {
        const event = page[index];
        if (event.seq <= this.lastSent) continue;
        if (this.paused || this.queue.length > 0) break;
        this.sendNow(event);
      }
      if (index < page.length) {
        // Socket backpressure: keep the rest of this page until the drain event.
        // `lastSent` did not advance past it, so the page can be re-fetched safely.
        for (const event of page.slice(index)) {
          if (this.closed) return;
          if (event.seq > this.lastSent) this.pushQueue(event);
        }
        return;
      }
      if (page.length < this.pageSize) {
        this.replayDone = true;
        return;
      }
    }
  }

  private enterLive() {
    if (this.closed) return;
    this.mode = "live";
    this.flushQueue();
    if (this.closed || this.paused) return;
    this.flushLive();
  }

  private onLive(event: RunEvent) {
    if (this.closed) return;
    if (event.seq <= this.lastSent) return; // dedupe: already emitted
    if (this.mode === "replay" || this.paused) {
      this.pushLive(event);
      return;
    }
    this.sendNow(event);
  }

  private sendNow(event: RunEvent) {
    if (event.seq <= this.lastSent) return;
    this.lastSent = event.seq;
    let ok = true;
    this.safe(
      () => { ok = this.options.send(event) !== false; },
      () => { ok = false; },
    );
    const buffered = this.safe(() => this.options.bufferedBytes?.() ?? 0, () => 0) ?? 0;
    if (!ok || buffered > this.highWaterMarkBytes) this.paused = true;
  }

  private pushQueue(event: RunEvent) {
    if (this.closed) return;
    if (this.queue.some((item) => item.seq === event.seq)) return;
    this.queue.push(event);
    if (this.queue.length > this.queueMax) this.fail("overflow", `replay queue exceeded ${this.queueMax}`);
  }

  private pushLive(event: RunEvent) {
    if (this.closed) return;
    if (this.liveBuffer.some((item) => item.seq === event.seq)) return;
    this.liveBuffer.push(event);
    if (this.liveBuffer.length > this.queueMax) this.fail("overflow", `live queue exceeded ${this.queueMax}`);
  }

  private flushQueue() {
    if (this.closed) return;
    const pending = this.queue.sort((a, b) => a.seq - b.seq);
    this.queue = [];
    for (const event of pending) {
      if (this.paused) {
        this.queue.push(event);
        continue;
      }
      this.sendNow(event);
    }
  }

  /** Emits live events captured during replay that are past the replay watermark. */
  private flushLive() {
    if (this.closed) return;
    const pending = this.liveBuffer
      .filter((event) => event.seq > this.replayWatermark && event.seq > this.lastSent)
      .sort((a, b) => a.seq - b.seq);
    this.liveBuffer = [];
    for (const event of pending) {
      if (this.paused) {
        this.liveBuffer.push(event);
        continue;
      }
      this.sendNow(event);
    }
  }

  private fail(reason: EventStreamCloseReason, detail?: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.unsubscribe?.();
    this.queue = [];
    this.liveBuffer = [];
    this.safe(() => this.options.close(reason, detail));
  }

  private safe<T>(run: () => T, onError?: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.options.log?.("event stream callback failed", { error: (error as Error).message });
      return onError ? onError() : undefined;
    }
  }
}
