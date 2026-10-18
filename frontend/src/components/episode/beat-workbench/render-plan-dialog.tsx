// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { skipToken, useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import {
  backendErrorToastMessage,
  BackendStatusError,
  BillingRuleNotConfiguredError,
  jsonWithBackendError,
} from "@/lib/api-errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { GLASS_ALERT_DIALOG_CONTENT_CLASS } from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { formatCreditCost } from "@/components/credits/credit-visual";
import {
  generationCreditCostQueryKey,
  type GenerationCreditCost,
} from "@/lib/queries/generation-credit-cost";
import {
  useRenderExecute,
  useRenderPlan,
} from "@/lib/queries/render-plan";
import { useRenderSettings } from "@/lib/queries/render-settings";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";
import type {
  PlanEntry,
  RejectedDispatch,
  RenderExecuteResult,
  RenderPlan,
} from "@/types/render-plan";
import type { Task, TaskStatus } from "@/types/task";

const RENDER_REGEN_FEATURE_KEY = "mainline.render_regen";

/** Same set `useTasks` uses to decide its 2s poll cadence (`queries/tasks.ts:59-66`). */
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "submitting",
  "queued",
  "pending",
  "starting",
  "running",
]);

// The copy does not go into `public/locales/*` (outside this slice's ownership); it uses the existing in-repo
// `t(key, { defaultValue })` inline-fallback form (precedent `batch-panel.tsx:570-572`).
// The four reasons must be four genuinely different sentences - whether the user can resolve it themselves depends on
// which gate was hit: the current project, their own tasks, other people's tasks on the same channel, or the whole platform.
const PARTIAL_REASON_COPY: Record<
  RejectedDispatch["reason"],
  { key: string; defaultValue: string }
> = {
  project: {
    key: "episode.renderPlan.partial.reason.project",
    defaultValue: "The current project's concurrency is full: the remaining {{fail}} cells must wait for existing tasks of this project to finish",
  },
  channel: {
    key: "episode.renderPlan.partial.reason.channel",
    defaultValue: "Channel concurrency is full: the remaining {{fail}} cells must wait for tasks on the same channel to free up a slot",
  },
  platform: {
    key: "episode.renderPlan.partial.reason.platform",
    defaultValue: "Platform-wide concurrency is full: the remaining {{fail}} cells must wait for the platform to free up a slot",
  },
  user: {
    key: "episode.renderPlan.partial.reason.user",
    defaultValue: "Your concurrency is full: the remaining {{fail}} cells must wait for your own tasks to finish first",
  },
};

/**
 * The leftover state after one best-effort delivery.
 *
 * `entries` are the **rejected plan entries verbatim** (not recomputed): the backend fanout is ordered
 * and breaks when it hits a gate, so the rejected ones must be the tail of `resolved_grids`, obtained by
 * `slice(task_ids.length)` (TCP-P63; recomputing `selection_scope` in the frontend would duplicate the backend's
 * hash source of truth). `shapeOk` remembers that length assertion - if it does not hold, only report information and do not resubmit.
 */
interface PartialDispatchState {
  /** How many cells were actually submitted this round. */
  ok: number;
  rejected: RejectedDispatch[];
  entries: PlanEntry[];
  /** Task ids submitted this round, used to watch "in flight decreasing" from the existing polling. */
  watchTaskIds: string[];
  /** Whether the **one** automatic resubmit round has been used up (afterwards only the manual "Continue" remains). */
  autoUsed: boolean;
  shapeOk: boolean;
}

interface RenderPlanDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: string;
  episode: number;
  beatIndices: number[];
  aspectMode: string;
  defaultForceOneByOne?: boolean;
  /**
   * Invoked after a successful execute with the per-grid `selected_regen` task
   * ids (one execute fans out into N grid tasks). Track these for completion —
   * the response's umbrella `scope` matches no task row.
   */
  onDispatched: (taskIds: string[]) => void;
}

export function RenderPlanDialog({
  open,
  onOpenChange,
  project,
  episode,
  beatIndices,
  aspectMode,
  defaultForceOneByOne = false,
  onDispatched,
}: RenderPlanDialogProps) {
  const { t } = useTranslation();
  const planMutation = useRenderPlan(project, episode);
  const executeMutation = useRenderExecute(project, episode);
  const renderSettings = useRenderSettings(project);
  const [plan, setPlan] = useState<RenderPlan | null>(null);
  const [staleBanner, setStaleBanner] = useState<"input" | "plan" | null>(null);
  const [partial, setPartial] = useState<PartialDispatchState | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Reuses the **existing** task polling: `skipToken` means this subscription never issues requests itself and only subscribes to the
  // `queryKeys.tasks(project)` cache - which is written by the `useTasks` already mounted on the page
  // (`batch-panel.tsx:392`, which is exactly what renders this dialog). This starts no new timer
  // and does not pull the `queries/tasks.ts` import chain (`@/i18n` / confirm-dialog) in.
  const tasksCache = useQuery({
    queryKey: queryKeys.tasks(project),
    queryFn: skipToken,
  });
  const taskRows = (tasksCache.data as OkResponse<Task[]> | undefined)?.data;
  const renderImageSelection = renderSettings.data?.data.render_image_selection ?? null;
  const renderCostModeKeys = useMemo(
    () => [...new Set((plan?.plan ?? []).map((entry) => entry.mode_key).filter(Boolean))],
    [plan?.plan],
  );
  const renderCostQueries = useQueries({
    queries: renderCostModeKeys.map((modeKey) => ({
      queryKey: generationCreditCostQueryKey("feature", RENDER_REGEN_FEATURE_KEY, {
        surface: "supertale",
        modeKey,
        imageRole: "render",
        params: renderImageSelection ? { image_selection: renderImageSelection } : null,
      }),
      queryFn: () =>
        jsonWithBackendError<OkResponse<GenerationCreditCost>>(
          api.get("api/v1/generation-credit-cost", {
            searchParams: {
              kind: "feature",
              surface: "supertale",
              value: RENDER_REGEN_FEATURE_KEY,
              mode_key: modeKey,
              image_role: "render",
              ...(renderImageSelection
                ? { params: JSON.stringify({ image_selection: renderImageSelection }) }
                : {}),
            },
            throwHttpErrors: false,
          }),
        ),
      enabled: !!renderImageSelection,
      staleTime: 60_000,
    })),
  });

  // Fetch plan when dialog opens or force toggle changes.
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setStaleBanner(null);
    setPartial(null);
    planMutation.mutate(
      {
        beat_indices: beatIndices,
        strategy: "location",
        aspect_mode: aspectMode,
        force_one_by_one: defaultForceOneByOne,
      },
      {
        onSuccess: (res) => {
          if (!res.ok) {
            toast.error(res.error || t("common.error"));
            setPlan(null);
            onOpenChange(false);
            return;
          }
          if (!res.data) {
            toast.error(t("common.error"));
            setPlan(null);
            onOpenChange(false);
            return;
          }
          setPlan(res.data);
          setStaleBanner(null);
        },
        onError: async (err) => {
          const anyErr = err as {
            response?: { status?: number; json?: () => Promise<unknown> };
          };
          const status = anyErr?.response?.status;
          if (status === 400 && anyErr.response?.json) {
            const body = (await anyErr.response.json()) as {
              error?: string;
            };
            const code = body?.error ?? "unknown";
            const msg =
              code === "invalid_beats"
                ? t("episode.renderPlan.errors.invalidBeats")
                : code === "no_beats"
                  ? t("episode.renderPlan.errors.noBeats")
                  : code || t("common.error");
            toast.error(msg);
            onOpenChange(false);
            return;
          }
          if (status === 503) {
            toast.error(t("episode.renderPlan.featureDisabled"));
            onOpenChange(false);
            return;
          }
          toast.error(t("common.error"));
          onOpenChange(false);
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultForceOneByOne, beatIndices, aspectMode, project, episode]);

  /**
   * Digests the result of one execute. `allowAuto` is true only in the **first round** - automatic resubmit is at most one round,
   * after which it always falls back to the manual "Continue" (item 3 of the three things the brief says not to improvise).
   */
  const applyExecuteResult = (data: RenderExecuteResult, allowAuto: boolean) => {
    const taskIds = data.task_ids ?? [];
    const rejected = data.rejected ?? [];
    onDispatched(taskIds);
    if (rejected.length === 0) {
      setPartial(null);
      onOpenChange(false);
      return;
    }
    const grids = data.resolved_grids ?? [];
    const entries = grids.slice(taskIds.length);
    const reasonsKnown = rejected.every((item) =>
      Object.prototype.hasOwnProperty.call(PARTIAL_REASON_COPY, item.reason),
    );
    setPartial({
      ok: taskIds.length,
      rejected,
      entries,
      watchTaskIds: taskIds,
      autoUsed: !allowAuto,
      // If the tail length does not match, the premise "ordered + break" no longer holds, and it is better not to submit:
      // guessing wrong would resubmit cells that are already running (= double billing).
      shapeOk:
        entries.length > 0 &&
        entries.length === rejected.length &&
        reasonsKnown,
    });
  };

  /**
   * Resubmit only the rejected part, in two steps:
   *  1. `/render/plan` with `beat_indices` that is **exactly** the union of the rejected entries' beats, to get a fresh
   *     `input_fingerprint` (one more or one fewer is judged by the backend `_custom_render_plan_error` as
   *     400 `invalid_custom_plan`).
   *  2. `/render/execute` with `custom_plan: true` + the rejected entries verbatim. The `custom_plan`
   *     branch does not regroup, so each cell's `entry_scope` is identical to the rejected one; the recompute branch
   *     would regroup the subset, and the cells would match none of the rejected scopes.
   */
  const redispatch = async (state: PartialDispatchState) => {
    if (!state.shapeOk || retrying) return;
    const beats = [
      ...new Set(state.entries.flatMap((entry) => entry.beat_numbers)),
    ].sort((a, b) => a - b);
    const giveUp = () => setPartial({ ...state, autoUsed: true });
    setRetrying(true);
    try {
      const planRes = await planMutation.mutateAsync({
        beat_indices: beats,
        strategy: "location",
        aspect_mode: aspectMode,
        force_one_by_one: defaultForceOneByOne,
      });
      if (!planRes.ok || !planRes.data) {
        toast.error(t("common.error"));
        giveUp();
        return;
      }
      const res = await executeMutation.mutateAsync({
        plan: state.entries,
        plan_hash: planRes.data.plan_hash,
        input_fingerprint: planRes.data.input_fingerprint,
        strategy: "location",
        aspect_mode: aspectMode,
        beat_indices: beats,
        custom_plan: true,
        force_one_by_one: defaultForceOneByOne,
        image_generation_selection: renderImageSelection ?? undefined,
      });
      if (!res.ok) {
        toast.error(t("common.error"));
        giveUp();
        return;
      }
      applyExecuteResult(res.data, false);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
      giveUp();
    } finally {
      setRetrying(false);
    }
  };

  // Trigger for automatic resubmit: **reuse the existing polling** and see whether the tasks submitted this round have all left the in-flight state.
  useEffect(() => {
    if (!open || retrying) return;
    if (!partial || partial.autoUsed || !partial.shapeOk) return;
    if (partial.watchTaskIds.length === 0 || !taskRows) return;
    const byId = new Map<string, TaskStatus>();
    for (const row of taskRows) {
      if (row.task_id) byId.set(row.task_id, row.status);
    }
    // "Seen at least once" guard: no judgement is made until polling has brought this batch of tasks back. Better not to auto-submit
    // (the user still has "Continue" as a fallback) than to misread "not seen" as "already finished".
    if (!partial.watchTaskIds.every((id) => byId.has(id))) return;
    if (partial.watchTaskIds.some((id) => ACTIVE_TASK_STATUSES.has(byId.get(id)!))) return;
    const snapshot = { ...partial, autoUsed: true };
    setPartial(snapshot);
    void redispatch(snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, retrying, partial, taskRows]);

  const handleConfirm = async () => {
    if (!plan) return;
    try {
      const res = await executeMutation.mutateAsync({
        plan: plan.plan,
        plan_hash: plan.plan_hash,
        input_fingerprint: plan.input_fingerprint,
        strategy: "location",
        aspect_mode: aspectMode,
        beat_indices: beatIndices,
        force_one_by_one: defaultForceOneByOne,
        image_generation_selection: renderImageSelection ?? undefined,
      });
      if (!res.ok) {
        toast.error(t("common.error"));
        return;
      }
      applyExecuteResult(res.data, true);
    } catch (err) {
      const anyErr = err as { response?: { status?: number; json?: () => Promise<unknown> } };
      const status = err instanceof BackendStatusError
        ? err.status
        : anyErr?.response?.status;
      const body = err instanceof BackendStatusError
        ? err.body
        : anyErr?.response?.json
          ? await anyErr.response.json()
          : null;
      if (status === 409 && body && typeof body === "object") {
        const staleBody = body as {
          error: "input_stale" | "plan_stale";
          data: { new_plan: PlanEntry[]; new_plan_hash: string; new_input_fingerprint: string };
        };
        if (
          (staleBody.error === "input_stale" || staleBody.error === "plan_stale") &&
          staleBody.data?.new_plan
        ) {
          setStaleBanner(staleBody.error === "input_stale" ? "input" : "plan");
          setPlan({
            plan: staleBody.data.new_plan,
            plan_hash: staleBody.data.new_plan_hash,
            input_fingerprint: staleBody.data.new_input_fingerprint,
            strategy: "location",
            total_beats: beatIndices.length,
            total_grids: staleBody.data.new_plan.length,
          });
          return;
        }
        toast.error(backendErrorToastMessage(err, t));
      } else if (status === 503) {
        toast.error(t("episode.renderPlan.featureDisabled"));
        onOpenChange(false);
      } else {
        toast.error(backendErrorToastMessage(err, t));
      }
    }
  };

  const loading = planMutation.isPending || executeMutation.isPending;
  const partialReasonLines = useMemo(() => {
    if (!partial) return [];
    const reasons = [...new Set(partial.rejected.map((item) => item.reason))];
    return reasons.map((reason) => {
      const fail = partial.rejected.filter((item) => item.reason === reason).length;
      const copy = PARTIAL_REASON_COPY[reason];
      if (!copy) {
        return t("episode.renderPlan.partial.reason.unknown", {
          defaultValue: "Some tasks have not been submitted yet",
        });
      }
      return t(copy.key, { defaultValue: copy.defaultValue, fail });
    });
  }, [partial, t]);
  const confirmLabel = plan
    ? t("episode.renderPlan.confirm", { grids: plan.total_grids })
    : planMutation.isPending
      ? t("episode.renderPlan.planning")
      : t("episode.renderPlan.unavailable");
  let renderPlanCostDisplay: string | null = null;
  let renderPlanPromotion: GenerationCreditCost["promotion"];
  if (plan) {
    let complete = true;
    let missingRule = false;
    let totalCost = 0;
    let totalOriginalCost = 0;
    const promotions: NonNullable<GenerationCreditCost["promotion"]>[] = [];
    for (const entry of plan.plan) {
      const queryIndex = renderCostModeKeys.indexOf(entry.mode_key);
      const query = renderCostQueries[queryIndex];
      if (query?.error instanceof BillingRuleNotConfiguredError) {
        missingRule = true;
        break;
      }
      const cost = query?.data?.data.cost;
      if (typeof cost !== "number") {
        complete = false;
        break;
      }
      totalCost += cost;
      totalOriginalCost += query?.data?.data.original_cost ?? cost;
      if (query?.data?.data.promotion?.id) {
        promotions.push(query.data.data.promotion);
      }
    }
    const firstPromotion = promotions[0];
    if (
      firstPromotion
      && promotions.length === plan.plan.length
      && promotions.every((item) => item.id === firstPromotion.id)
    ) {
      renderPlanPromotion = firstPromotion;
    }
    renderPlanCostDisplay = missingRule
      ? t("common.billingRuleNotConfiguredShort")
      : complete
        ? totalOriginalCost > totalCost
          ? `${formatCreditCost(totalOriginalCost)}→${formatCreditCost(totalCost)}`
          : formatCreditCost(totalCost)
        : null;
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn("max-w-3xl", GLASS_ALERT_DIALOG_CONTENT_CLASS)}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("episode.renderPlan.title", {
              beats: plan?.total_beats ?? beatIndices.length,
              grids: plan?.total_grids ?? "…",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("episode.renderPlan.subtitle")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {staleBanner && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mr-1 inline size-3" />
            {t(`episode.renderPlan.stale.${staleBanner}`)}
          </div>
        )}

        {partial && (
          <div
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mr-1 inline size-3" />
            {t("episode.renderPlan.partial.summary", {
              defaultValue: "Submitted {{ok}} / rejected {{fail}}",
              ok: partial.ok,
              fail: partial.rejected.length,
            })}
            {partialReasonLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}

        <div className="mt-4 max-h-[45vh] overflow-y-auto">
          {loading && !plan ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !plan ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              {t("episode.renderPlan.unavailable")}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {plan?.plan.map((entry, i) => (
                <PlanCard
                  key={`${entry.mode_key}:${entry.beat_numbers.join("-")}:${i}`}
                  entry={entry}
                />
              ))}
            </div>
          )}
        </div>

        <AlertDialogFooter className="px-4">
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          {partial?.shapeOk && (
            <AlertDialogAction
              variant="outline"
              onClick={() => void redispatch(partial)}
              disabled={retrying || loading}
            >
              {t("episode.renderPlan.partial.continue", { defaultValue: "Continue" })}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant="outline"
            onClick={handleConfirm}
            // After a partial submit, the primary button must be locked: clicking again would replay the whole batch
            // (the first k are still alive -> the dedupe lock cannot stop duplicate billing). Resubmit can only go through "Continue".
            disabled={loading || !plan || !!partial}
            className="relative pr-11 transition-transform active:scale-95"
          >
            {executeMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              confirmLabel
            )}
            <CreditCostInline
              display={renderPlanCostDisplay}
              promotion={renderPlanPromotion}
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlanCard({
  entry,
}: {
  entry: PlanEntry;
}) {
  const { t } = useTranslation();
  const beatsLabel = entry.beat_numbers.length > 1
    ? `B${entry.beat_numbers[0]}-${entry.beat_numbers[entry.beat_numbers.length - 1]}`
    : `B${entry.beat_numbers[0]}`;
  const ironLaw = entry.reasons.includes("iron-law-3-chars");
  const multiScene = entry.location.includes("·") || entry.location.includes(" / ");
  return (
    <div
      className={cn(
        "flex w-[170px] shrink-0 flex-col gap-1 rounded-[6px] border border-white/10 bg-white/[0.05] p-2 text-xs backdrop-blur-sm",
        ironLaw && "border-amber-500/50",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{`${entry.rows}×${entry.cols}`}</span>
        <span className="text-muted-foreground">{beatsLabel}</span>
      </div>
      <div
        className={cn(
          "truncate",
          multiScene ? "text-orange-400" : "text-emerald-400",
        )}
        title={entry.location}
      >
        {entry.location || t("episode.renderPlan.unknownLocation")}
        {entry.padding_count > 0 &&
          ` ${t("episode.renderPlan.paddingCount", { count: entry.padding_count })}`}
      </div>
      {entry.warnings.length > 0 && (
        <div className="text-amber-500">
          <AlertTriangle className="mr-0.5 inline size-2.5" />
          {entry.warnings[0]}
        </div>
      )}
    </div>
  );
}
