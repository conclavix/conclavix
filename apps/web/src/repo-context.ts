import { DEFAULT_BRANCH } from './code/logic';
import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue';

/** The repository `repo:` image paths in Markdown resolve against. */
export interface RepoContext {
  projectId: string;
  ref: string;
}

const REPO_CONTEXT: InjectionKey<ComputedRef<RepoContext | null>> = Symbol('repo-context');

/** The issue's branch once its workspace exists, otherwise main. */
export function issueRepoContext(
  issue: { projectId?: string | undefined; branch?: string | null | undefined } | null | undefined,
): RepoContext | null {
  return issue?.projectId
    ? { projectId: issue.projectId, ref: issue.branch || DEFAULT_BRANCH }
    : null;
}

/** Make `source` the repository of every Markdown block below the calling component. */
export function provideRepoContext(source: () => RepoContext | null): void {
  provide(REPO_CONTEXT, computed(source));
}

/** The repository provided by an ancestor, or null outside of an issue or run. */
export function useRepoContext(): ComputedRef<RepoContext | null> {
  return inject(
    REPO_CONTEXT,
    computed(() => null),
    false,
  );
}
