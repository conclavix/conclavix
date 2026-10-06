import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  memoryApi,
  MEMORY_PAGE,
  type Memory,
  type MemoryBucket,
  type MemoryFields,
} from '../api/memory';
import { changedFields, groupHits, type MemoryHit } from './logic';

export const SEARCH_DELAY_MS = 300;

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function assertMemoryBucket(memory: Memory, target: MemoryBucket | null): void {
  if (
    !target ||
    memory.scope !== target.scope ||
    (target.scope === 'project' && memory.projectId !== target.projectId) ||
    (target.scope === 'agent' && memory.agentId !== target.agentId)
  ) {
    throw new Error('memory does not belong to the selected bucket');
  }
}

async function persistMemory(
  target: MemoryBucket,
  existing: Memory | null,
  fields: MemoryFields,
): Promise<Memory> {
  if (!existing) return memoryApi.create(target, fields);
  assertMemoryBucket(existing, target);
  const changes = changedFields(existing, fields);
  return Object.keys(changes).length ? memoryApi.update(existing.id, changes) : existing;
}

function createMemoryState() {
  return {
    query: ref(''),
    hits: ref<MemoryHit[]>([]),
    searched: ref(''),
    loading: ref(false),
    error: ref(''),
  };
}

function resetMemoryState(state: ReturnType<typeof createMemoryState>): void {
  state.hits.value = [];
  state.searched.value = '';
  state.loading.value = false;
  state.error.value = '';
}

/**
 * Loads one bucket's memories and keeps them current across search and edits. Responses that
 * arrive after the bucket or query moved on are dropped, so a slow search cannot overwrite a
 * newer one.
 */
export function useMemories(bucket: Ref<MemoryBucket | null>) {
  const state = createMemoryState();
  const { query, hits, searched, loading, error } = state;
  let latest = 0;
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function reload(): Promise<void> {
    clearTimeout(timer);
    const target = bucket.value;
    const text = query.value.trim();
    const request = ++latest;
    if (disposed) return;
    if (!target) {
      resetMemoryState(state);
      return;
    }
    loading.value = true;
    try {
      const found = await memoryApi.list(target, text);
      if (request !== latest) return;
      hits.value = groupHits(found);
      searched.value = text;
      error.value = '';
    } catch (cause) {
      if (request === latest) error.value = errorText(cause);
    } finally {
      if (request === latest) loading.value = false;
    }
  }

  function search(text: string): void {
    query.value = text;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), SEARCH_DELAY_MS);
  }

  /** Creates, or with an existing memory patches only what changed; errors go to the caller. */
  async function save(existing: Memory | null, fields: MemoryFields): Promise<Memory> {
    const target = bucket.value;
    if (disposed || !target) throw new Error('pick a project or agent first');
    const started = generation;
    const saved = await persistMemory(target, existing, fields);
    if (started === generation && !disposed) await reload();
    return saved;
  }

  async function remove(memory: Memory): Promise<void> {
    assertMemoryBucket(memory, disposed ? null : bucket.value);
    const started = generation;
    await memoryApi.remove(memory.id);
    if (started !== generation || disposed) return;
    latest++;
    loading.value = false;
    hits.value = hits.value.filter((hit) => hit.memory.id !== memory.id);
  }

  const bucketKey = computed(() => JSON.stringify(bucket.value));
  watch(
    bucketKey,
    () => {
      generation++;
      resetMemoryState(state);
      void reload();
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    disposed = true;
    latest++;
    clearTimeout(timer);
  });

  return {
    ...state,
    truncated: computed(() => !searched.value && hits.value.length >= MEMORY_PAGE),
    reload,
    search,
    save,
    remove,
    load: memoryApi.get,
  };
}
