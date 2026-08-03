// PROTOTYPE — throwaway. Loaded via dynamic import() from bootstrap.js.
import { now } from './platform/clock.js';

export function mount() {
  return { mounted: true, clockValue: now() };
}
