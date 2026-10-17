import { computed, ref } from 'vue';
import { describeError } from '../issues';

/**
 * Loading state for a view that fires overlapping requests: `guarded` counts running work and
 * keeps its error, `settle` applies a result (or rethrows its error) only while no newer request
 * claimed the same slot, so a slow old answer never overwrites what the user moved on to.
 */
export function useRequests() {
  const pending = ref(0);
  const loading = computed(() => pending.value > 0);
  const error = ref('');
  let sequence = 0;
  const latest = new Map<string, number>();

  async function guarded(work: () => Promise<void>): Promise<void> {
    pending.value += 1;
    error.value = '';
    try {
      await work();
    } catch (cause) {
      error.value = describeError(cause);
    } finally {
      pending.value -= 1;
    }
  }

  async function settle<T>(
    slot: string,
    request: () => Promise<T>,
    apply: (value: T) => void,
  ): Promise<void> {
    const id = ++sequence;
    latest.set(slot, id);
    const current = () => latest.get(slot) === id;
    try {
      const value = await request();
      if (current()) apply(value);
    } catch (cause) {
      if (current()) throw cause;
    }
  }

  return { loading, error, guarded, settle };
}
