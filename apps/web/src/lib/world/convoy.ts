// A convoy's status as the server actually serialises it (serde, externally tagged):
// a unit variant is a bare string, and a seizure is an object naming the captor.
//
//   "in_transit"   "arrived"   {"seized": {"by": "ashen"}}
//
// Every reader goes through `convoyState` so there is exactly one place that knows this.

export type ConvoyStatus = 'in_transit' | 'arrived' | { seized: { by: string } }
export interface ConvoyState { state: 'in_transit' | 'arrived' | 'seized' | 'other'; by?: string }

export function convoyState(status: unknown): ConvoyState {
  if (status === 'in_transit' || status === 'arrived') return { state: status }
  if (status && typeof status === 'object' && 'seized' in status) {
    const by = (status as { seized?: { by?: unknown } }).seized?.by
    return { state: 'seized', by: typeof by === 'string' ? by : undefined }
  }
  return { state: 'other' }
}
