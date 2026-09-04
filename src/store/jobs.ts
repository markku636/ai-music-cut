import { create } from "zustand";

export type JobKind = "prepare" | "waveform" | "analyze" | "judge" | "render" | "separate";
/** 分析 job 的穩定階段（UI 的 4 步小清單靠它，不比對 step 字串）。 */
export type JobPhase = "prepare" | "transcribe" | "normalize" | "rules";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface Job {
  id: string;
  kind: JobKind;
  mediaId: string;
  /** 目前步驟（顯示用）。 */
  step: string;
  /** 0–100；null = 不確定進度。 */
  pct: number | null;
  message: string;
  phase?: JobPhase;
  status: JobStatus;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** 由建立者掛上；取消時呼叫。 */
  cancel?: () => void;
}

interface JobsStore {
  jobs: Job[];
  upsert: (j: Partial<Job> & { id: string }) => void;
  remove: (id: string) => void;
  cancel: (id: string) => void;
  clearFinished: () => void;
}

export const useJobs = create<JobsStore>((set, get) => ({
  jobs: [],
  upsert: (j) =>
    set((s) => {
      const i = s.jobs.findIndex((x) => x.id === j.id);
      if (i < 0) {
        const full: Job = {
          kind: "analyze",
          mediaId: "",
          step: "",
          pct: null,
          message: "",
          status: "queued",
          startedAt: Date.now(),
          ...j,
        } as Job;
        return { jobs: [...s.jobs, full] };
      }
      const next = s.jobs.slice();
      next[i] = { ...next[i], ...j };
      return { jobs: next };
    }),
  remove: (id) => set((s) => ({ jobs: s.jobs.filter((x) => x.id !== id) })),
  cancel: (id) => {
    const j = get().jobs.find((x) => x.id === id);
    if (!j) return;
    j.cancel?.();
    get().upsert({ id, status: "canceled", endedAt: Date.now() });
  },
  clearFinished: () => set((s) => ({ jobs: s.jobs.filter((x) => x.status === "queued" || x.status === "running") })),
}));

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
