import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { backendErrorToastMessage } from "@/lib/api-errors";
import { useRecoverH3Video } from "@/lib/queries/video";

/** Re-download the video of an already finished RunPod H3 job by its id —
 * for a render whose download failed after the GPU run. */
export function RecoverH3VideoButton({
  project,
  episode,
  beatNum,
}: {
  project: string;
  episode: number;
  beatNum: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState("");
  const recover = useRecoverH3Video(project, episode);

  const submit = async () => {
    const id = jobId.trim();
    if (!id) return;
    try {
      const res = await recover.mutateAsync({ beatNum, jobId: id });
      if (!res.ok) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.video.recoverVideoDone"));
      setJobId("");
      setOpen(false);
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-5 gap-1 rounded-full px-2 text-[11px]"
          />
        }
      >
        <RotateCcw className="size-3" />
        {t("episode.workbench.video.recoverVideo")}
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-3">
        <p className="text-[11px] text-muted-foreground/78">
          {t("episode.workbench.video.recoverVideoHint")}
        </p>
        <Input
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="fafb3f70-56aa-4602-b279-b274fb39d793-e1"
          className="h-8 text-xs"
        />
        <Button
          type="button"
          size="xs"
          disabled={!jobId.trim() || recover.isPending}
          onClick={() => void submit()}
        >
          {recover.isPending && <Loader2 className="size-3 animate-spin" />}
          {t("episode.workbench.video.recoverVideoAction")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
