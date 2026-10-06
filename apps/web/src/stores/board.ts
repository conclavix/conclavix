import { computed, type Ref } from 'vue';
import { useLiveStore } from './live';

/** Live issues narrowed to an optional project and a free-text key/title filter, plus agent names. */
export function useBoardIssues(projectId: Ref<string | null>, text: Ref<string | null>) {
  const live = useLiveStore();
  const issues = computed(() => {
    const needle = (text.value ?? '').trim().toLowerCase();
    return Object.values(live.state.issues).filter(
      (issue) =>
        (!projectId.value || issue.projectId === projectId.value) &&
        (!needle || `${issue.key ?? ''} ${issue.title ?? ''}`.toLowerCase().includes(needle)),
    );
  });
  const agentNames = computed(() =>
    Object.fromEntries(Object.values(live.state.agents).map((a) => [a.id, a.name ?? a.id])),
  );
  return { issues, agentNames };
}
