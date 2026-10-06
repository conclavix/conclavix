import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** A reactive clock that ticks every second while the component is mounted. */
export function useNow(): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => (now.value = Date.now()), 1000);
  });
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
