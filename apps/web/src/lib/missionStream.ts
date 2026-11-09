// Streams a live contract's mission events to the server, in order.
//
// Events are numbered here, sent in batches with one request in flight at a time,
// and retried on failure. A retry is safe: the server ignores any sequence number it
// has already applied. Before reporting the result, the page waits for the stream to
// drain, so the server's state includes the extraction.

import type { ProtoEvent } from '@/engine/fps/field'
import { api, type FieldVerdicts } from '@/lib/api'

export class MissionStream {
  private queue: (ProtoEvent & { seq: number })[] = []
  private seq = 0
  private sending = false
  private failures = 0
  /** The server's latest account of the run. */
  last: FieldVerdicts | null = null

  constructor(private session: string) {}

  push(events: ProtoEvent[]) {
    for (const e of events) this.queue.push({ ...e, seq: ++this.seq })
    void this.pump()
  }

  private async pump() {
    if (this.sending || !this.queue.length) return
    this.sending = true
    const batch = this.queue.slice(0, 48)
    try {
      this.last = await api.missionEvents(this.session, batch)
      this.queue.splice(0, batch.length)
      this.failures = 0
    } catch {
      this.failures++
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** this.failures)))
    } finally {
      this.sending = false
    }
    if (this.queue.length) void this.pump()
  }

  /** Wait for everything queued to reach the server (up to `ms`). */
  async flush(ms = 15_000): Promise<boolean> {
    const until = Date.now() + ms
    while ((this.queue.length || this.sending) && Date.now() < until) {
      void this.pump()
      await new Promise((r) => setTimeout(r, 100))
    }
    return !this.queue.length
  }
}
