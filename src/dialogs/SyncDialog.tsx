// 多麥克風同步對話框：選軌 → 看對齊結果 → 合併成一軌。
//
// 刻意分成兩步（先算再合併）：對齊是猜的，信心低的時候人要有機會先看一眼再決定，
// 而不是按下去就得到一個對不齊的新檔案。
import { Link2, Mic } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import { analyzeMicSync, combineMics, type MicSyncRow } from "../pipeline/syncMics";
import { suggestDrift } from "../pipeline/align";
import { useProject } from "../store/project";
import { Badge, Button, Modal, Spinner } from "../ui/index";
import { toast } from "../ui";
import { formatMs } from "../time";

/** 低於這個信心就要提醒人自己聽一下。 */
const LOW_CONFIDENCE = 0.3;

export default function SyncDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const [picked, setPicked] = useState<string[]>(() => (activeId ? [activeId] : []));
  const [rows, setRows] = useState<MicSyncRow[] | null>(null);
  const [busy, setBusy] = useState<null | "analyze" | "combine">(null);
  const [crosstalkDb, setCrosstalkDb] = useState<number | null>(-12);
  const [drift, setDrift] = useState(false);

  const toggle = (id: string) => {
    setRows(null);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const run = async () => {
    setBusy("analyze");
    try {
      const r = await analyzeMicSync(picked);
      setRows(r);
      const durOf = (id: string) => useProject.getState().media.find((m) => m.id === id)?.probe?.duration_ms ?? 0;
      setDrift(r.slice(1).some((x) => suggestDrift(durOf(r[0].mediaId), durOf(x.mediaId), x.offsetMs)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const combine = async () => {
    if (!rows) return;
    setBusy("combine");
    try {
      const out = await combineMics(rows, crosstalkDb ?? undefined, drift);
      toast.success(t("已合併成一軌：{name}", { name: out.split(/[\\/]/).pop() ?? out }));
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const weak = rows?.some((r) => r.confidence < LOW_CONFIDENCE && r.offsetMs !== 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("多麥克風同步")}
      icon={Mic}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t("取消")}</Button>
          {rows ? (
            <Button variant="primary" onClick={() => void combine()} disabled={busy !== null}>
              {busy === "combine" ? <Spinner /> : <Link2 size={14} />}
              {t("合併成一軌")}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void run()} disabled={picked.length < 2 || busy !== null}>
              {busy === "analyze" ? <Spinner /> : null}
              {t("對齊")}
            </Button>
          )}
        </>
      }
    >
      <p className="text-[12px] text-fg/55 leading-relaxed mb-2">
        {t("一人一軌的錄音各自按下錄影，起點會差好幾秒。這裡用兩軌都聽得到的講話節奏（能量包絡）自動對齊，再併成一軌繼續剪。第一個勾選的是基準軌。")}
      </p>

      <div className="rounded border border-fg/10 divide-y divide-fg/5 max-h-56 overflow-auto">
        {media.length < 2 && <div className="p-3 text-[12px] text-fg/45">{t("媒體清單裡至少要有兩個檔案（把每一支麥的錄音都開起來）。")}</div>}
        {media.map((m) => {
          const idx = picked.indexOf(m.id);
          const row = rows?.find((r) => r.mediaId === m.id);
          return (
            <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-fg/5 cursor-pointer">
              <input type="checkbox" checked={idx >= 0} onChange={() => toggle(m.id)} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-fg/85 truncate">{m.name}</span>
                <span className="block text-[10px] text-fg/40 mono tabular-nums">{formatMs(m.probe?.duration_ms ?? 0, { millis: false })}</span>
              </span>
              {idx === 0 && <Badge tone="neutral">{t("基準")}</Badge>}
              {row && idx > 0 && (
                <span className="text-[11px] mono tabular-nums whitespace-nowrap">
                  <span className={row.confidence < LOW_CONFIDENCE ? "text-amber-400" : "text-fg/70"}>
                    {row.offsetMs > 0 ? "+" : ""}
                    {(row.offsetMs / 1000).toFixed(2)} s
                  </span>
                  <span className="text-fg/35"> · {Math.round(row.confidence * 100)}%</span>
                </span>
              )}
            </label>
          );
        })}
      </div>

      {rows && (
        <div className="mt-3 rounded border border-fg/10 p-2">
          <label className="flex items-center gap-2 text-[12px] text-fg/80 cursor-pointer">
            <input type="checkbox" checked={crosstalkDb !== null} onChange={(e) => setCrosstalkDb(e.target.checked ? -12 : null)} />
            {t("降低串音（別人講話時漏進這支麥的聲音）")}
          </label>
          <p className="mt-1 text-[10px] text-fg/40 leading-relaxed">
            {t("每支麥都收得到別人講話，合起來同一句會聽到兩次 —— 一次清楚、一次糊的。門檻由每一軌自己的能量分布量出來，不是寫死的數字。")}
          </p>
          {crosstalkDb !== null && (
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              {[-6, -12, -18].map((db) => (
                <button
                  key={db}
                  type="button"
                  onClick={() => setCrosstalkDb(db)}
                  className={`h-6 px-2 rounded-sm text-[11px] mono tabular-nums ${crosstalkDb === db ? "bg-accent/15 text-accent" : "text-fg/55 hover:bg-fg/5"}`}
                >
                  {db} dB
                </button>
              ))}
              <span className="text-[10px] text-fg/35">
                {t("套用到 {n} 軌", { n: rows.filter((r) => r.canGate).length })}
                {rows.some((r) => !r.canGate) && t("（{skip} 軌本來就沒有安靜段，跳過）", { skip: rows.filter((r) => !r.canGate).length })}
              </span>
            </div>
          )}
        </div>
      )}

      {rows && (
        <div className="mt-2 text-[11px] leading-relaxed">
          {weak ? (
            <span className="text-amber-400">
              {t("有軌道的信心偏低，可能沒對上（兩軌完全沒有共同的聲音時會這樣）。合併後先聽一下開頭與結尾。")}
            </span>
          ) : (
            <span className="text-fg/50">{t("對齊看起來沒問題。合併會產生一個新的 _synced.wav，原始檔案不會被動到。")}</span>
          )}
        </div>
      )}
    </Modal>
  );
}
