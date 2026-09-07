import { useEffect, useRef, useState } from "react";
import { useDialogs } from "../store/dialogs";
import { BookMarked, Cog, ScrollText } from "lucide-react";
import { api, errMessage, type AppSettings, type AsrModelSpec } from "../api";
import { Button, Field, FormGrid, Input, Modal, Select } from "../ui/index";
import { pickDirectory, pickOpenFile, toast } from "../ui";
import { useT } from "../i18n";
import { ffmpegSourceLabel } from "../ffmpegSource";
import { useUi, type Density } from "../store/ui";
import { useSettings } from "../store/settings";
import { parseHotwords } from "../analysis/hotwords";
import { formatMb, formatSpeed } from "../analysis/asrFit";
import HotwordsDialog from "./HotwordsDialog";
import LocalAsrSetup from "./LocalAsrSetup";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-fg/45 uppercase tracking-wide">{title}</div>
      <div className="min-w-0 overflow-x-hidden rounded-md border border-fg/10 p-3 space-y-3">{children}</div>
    </div>
  );
}

export type SettingsFocus = "key" | "ffmpeg" | null;

export default function SettingsDialog({
  focus = null,
  onClose,
}: {
  focus?: SettingsFocus;
  onClose: () => void;
}) {
  // 由 DialogHost 掛載：掛著就是開著
  const open = true;
  const onOpenPrompts = () => {
    useDialogs.getState().close("settings");
    useDialogs.getState().open("prompts");
  };
  const t = useT();
  const keyInputRef = useRef<HTMLInputElement>(null);
  const ffmpegInputRef = useRef<HTMLInputElement>(null);
  const [hotwordsOpen, setHotwordsOpen] = useState(false);
  const [highlight, setHighlight] = useState<SettingsFocus>(null);

  // 從 banner / 流程列 / 狀態列進來：等 modal 進場後捲到該欄位、聚焦並高亮 1.5 秒
  useEffect(() => {
    if (!open || !focus) return;
    const el = focus === "key" ? keyInputRef.current : ffmpegInputRef.current;
    const id = window.setTimeout(() => {
      el?.scrollIntoView({ block: "center" });
      el?.focus();
      setHighlight(focus);
    }, 200);
    const off = window.setTimeout(() => setHighlight(null), 1900);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(off);
    };
  }, [open, focus]);
  const s = useSettings((x) => x.s);
  const save = useSettings((x) => x.save);
  const ffmpeg = useSettings((x) => x.ffmpeg);
  const density = useUi((x) => x.density);
  const setDensity = useUi((x) => x.setDensity);
  const ttls = useSettings((x) => x.ttls);
  const key = useSettings((x) => x.key);
  const probeAll = useSettings((x) => x.probeAll);
  const refreshKey = useSettings((x) => x.refreshKey);

  const [draft, setDraft] = useState<AppSettings>(s);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [asrModels, setAsrModels] = useState<AsrModelSpec[]>([]);
  useEffect(() => {
    void api.localAsrModels().then(setAsrModels).catch(() => {});
  }, []);

  useEffect(() => {
    if (open) setDraft(s);
  }, [open, s]);

  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));
  const commit = async (p: Partial<AppSettings>) => {
    patch(p);
    await save(p);
  };

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setBusy("key");
    try {
      await api.ttlsKeySet(apiKey.trim());
      setApiKey(""); // 不留在 React state
      await refreshKey();
      const ok = await api.ttlsKeyVerify().catch(() => null);
      if (ok === true) toast.success(t("金鑰有效，已存入 OS 鑰匙圈"));
      else if (ok === false) toast.error(t("金鑰已存入，但被伺服器拒絕（401）"));
      else toast.success(t("金鑰已存入 OS 鑰匙圈"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy("verify");
    try {
      await save({ ttls_base_url: draft.ttls_base_url });
      await probeAll();
      const ok = await api.ttlsKeyVerify();
      if (ok) toast.success(t("連線與金鑰皆正常"));
      else toast.error(t("金鑰被伺服器拒絕（401）"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const detectFfmpeg = async () => {
    setBusy("ffmpeg");
    try {
      await save({ ffmpeg_path: draft.ffmpeg_path?.trim() || null });
      const r = await api.ffmpegDetect(draft.ffmpeg_path?.trim() || null);
      await probeAll();
      if (r.found) toast.success(`ffmpeg ${r.version}（${r.source}）`);
      else toast.error(t("找不到 ffmpeg"));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const hotwords = parseHotwords(draft.hotwords);
  const hotwordCount = hotwords.length;
  const hotwordPreview = hotwords.slice(0, 4).join("、") + (hotwordCount > 4 ? "…" : "");

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={t("設定")}
      icon={Cog}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("關閉")}
        </Button>
      }
    >
      <div className="space-y-4">
        <Section title={t("伺服器")}>
          <Field label={t("ttls 伺服器網址")} hint={ttls ? (ttls.ok ? `${t("已連線")} · ${ttls.latency_ms ?? "?"} ms` : `${t("未連線")}${ttls.error ? ` · ${ttls.error}` : ""}`) : undefined}>
            <Input value={draft.ttls_base_url} onChange={(e) => patch({ ttls_base_url: e.target.value })} onBlur={() => void commit({ ttls_base_url: draft.ttls_base_url.trim() })} spellCheck={false} />
          </Field>
          <Field
            label="API Key（X-API-Key）"
            hint={key?.present ? t("已儲存於 OS 鑰匙圈（••••{hint}）；不會寫入任何檔案", { hint: key.hint ?? "" }) : t("尚未設定；金鑰只存 OS 鑰匙圈，不進專案檔或設定檔")}
          >
            <div className="flex gap-2">
              <Input
                ref={keyInputRef}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={key?.present ? "••••••••" : t("貼上 ttls 的 X-API-Key")}
                className={`flex-1 transition-shadow ${highlight === "key" ? "ring-2 ring-accent" : ""}`}
              />
              <Button onClick={() => void saveKey()} disabled={!apiKey.trim()} loading={busy === "key"}>
                {t("儲存至鑰匙圈")}
              </Button>
              <Button
                variant="ghost"
                disabled={!key?.present}
                onClick={async () => {
                  await api.ttlsKeyClear();
                  await refreshKey();
                }}
              >
                {t("清除")}
              </Button>
            </div>
          </Field>
          <Button onClick={() => void verify()} loading={busy === "verify"}>
            {t("測試連線")}
          </Button>
        </Section>

        <Section title={t("逐字稿（辨識）")}>
          <FormGrid>
            <Field
              label={t("逐字稿來源")}
              hint={t("預設是本機：用你電腦上的 faster-whisper，不上傳、不需要金鑰，第一次要裝套件與模型（下面一鍵裝）。有 ttls 金鑰的話切過去比較快，而且不佔你的機器。")}
            >
              <Select value={draft.asr_source || "ttls"} onChange={(e) => void commit({ asr_source: e.target.value })}>
                <option value="ttls">{t("ttls 伺服器（上傳）")}</option>
                <option value="local">{t("本機 faster-whisper（不上傳）")}</option>
              </Select>
            </Field>
            {(draft.asr_source || "ttls") === "local" && <LocalAsrSetup />}
            <Field label={t("辨識語言")}>
              <Select value={draft.asr_language} onChange={(e) => void commit({ asr_language: e.target.value })}>
                <option value="zh">中文（zh/en 混講）</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="auto">auto</option>
              </Select>
            </Field>
            {/*
              本機與 ttls 的模型清單**不一樣**：ttls 那邊是伺服器自己挑，本機這邊是把名字
              直接餵給 faster-whisper。所以切到本機時要列本機真的有的那幾個，並標出顯存 ——
              下載大小跟跑不跑得動是兩回事。
            */}
            <Field
              label={t("辨識模型")}
              hint={
                (draft.asr_source || "ttls") === "local"
                  ? t("顯存是 int8 的估計值（這個 App 就是用 int8 跑的）。auto 會依你的顯示卡自己挑。")
                  : undefined
              }
            >
              <Select value={draft.asr_model} onChange={(e) => void commit({ asr_model: e.target.value })}>
                <option value="auto">auto（依 VRAM 選）</option>
                {(draft.asr_source || "ttls") === "local" ? (
                  asrModels.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}（{t("顯存")} {formatMb(m.vram_int8_mb)}{"，"}{formatSpeed(m.speed_x)}）
                    </option>
                  ))
                ) : (
                  <>
                    <option value="large-v3">large-v3（最準）</option>
                    <option value="large-v3-turbo">large-v3-turbo（快）</option>
                  </>
                )}
              </Select>
            </Field>
          </FormGrid>
          <Field label={t("領域詞")} hint={t("人名 / 產品名 / 術語 —— 讓辨識器聽得對。跟「贅字管理」相反：那個決定哪些字要剪掉。")}>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-[12px] text-fg/55" title={draft.hotwords}>
                {hotwordCount ? t("{n} 個詞：{list}", { n: hotwordCount, list: hotwordPreview }) : t("還沒有領域詞")}
              </span>
              <Button variant="ghost" icon={BookMarked} onClick={() => setHotwordsOpen(true)}>
                {t("維護")}
              </Button>
            </div>
          </Field>
        </Section>

        <Section title={t("AI")}>
          <Field
            label={t("結構化產出的後端")}
            hint={t("AI 判讀、審核、節目筆記走哪個 CLI。AI 助手不受影響 —— 它要透過 App 內建的 MCP server 操作剪輯，而 codex 要連上那個 server 得改你自己的 config.toml，所以助手一律走 claude。")}
          >
            <Select value={draft.agent_backend || "claude"} onChange={(e) => void commit({ agent_backend: e.target.value })}>
              <option value="claude">{t("Claude Code（claude CLI）")}</option>
              <option value="codex">{t("Codex（codex CLI）")}</option>
            </Select>
          </Field>
          {(draft.agent_backend || "claude") === "codex" && (
            <div className="rounded-md border border-fg/10 px-3 py-2 text-[11px] text-fg/60 space-y-1">
              <div>{t("codex 走 `codex exec --output-schema`。模型請在 codex 自己的設定裡指定（$CODEX_HOME/config.toml 的 model）。")}</div>
              <div className="text-warning">{t("沒裝的話：npm i -g @openai/codex，然後執行 codex login。")}</div>
            </div>
          )}
          <Field label={t("Claude 模型（claude CLI --model）")} hint={t("AI 判讀與助手都用本機 claude 登入身分；sonnet 速度與品質均衡")}>
            <Select value={draft.claude_model || "sonnet"} onChange={(e) => void commit({ claude_model: e.target.value })}>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </Select>
          </Field>
          <Field
            label={t("AI 判讀角色")}
            hint={t("剪輯提議剪什麼，審核站在相反立場覆核（只覆核判剪的）。兩邊意見相反的會留給你裁決，不會自動剪。")}
          >
            <Select value={draft.judge_roles || "editor+reviewer"} onChange={(e) => void commit({ judge_roles: e.target.value })}>
              <option value="editor+reviewer">{t("剪輯 + 審核（兩個 agent）")}</option>
              <option value="editor">{t("只有剪輯（比較快、比較省）")}</option>
            </Select>
          </Field>
          <Field label={t("審核模型")} hint={t("第二輪覆核用；審核的工作比較單純，haiku 就夠")}>
            <Select
              value={draft.claude_review_model || "haiku"}
              disabled={!(draft.judge_roles || "editor+reviewer").includes("reviewer")}
              onChange={(e) => void commit({ claude_review_model: e.target.value })}
            >
              <option value="haiku">haiku</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus</option>
            </Select>
          </Field>
          <FormGrid>
            <Field label={t("AI 判讀")}>
              <label className="flex items-center gap-2 h-7 text-sm">
                <input type="checkbox" checked={draft.judge_enabled} onChange={(e) => void commit({ judge_enabled: e.target.checked })} />
                {t("允許 AI 判讀（關掉就完全不呼叫 claude，工具列 / 一鍵智慧剪輯 / 批次都不會）")}
              </label>
            </Field>
          </FormGrid>
          <Field label={t("提示詞")} hint={t("剪輯 / 審核 / 節目筆記 / 助手四個角色的系統提示詞，可以直接改。")}>
            <div className="flex">
              <Button variant="ghost" icon={ScrollText} onClick={onOpenPrompts}>
                {t("維護提示詞")}
              </Button>
            </div>
          </Field>
        </Section>

        <Section title={t("分析")}>
          <FormGrid>
            <Field label={t("預設激進度（{n}）", { n: draft.default_aggressiveness })}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.default_aggressiveness}
                onChange={(e) => patch({ default_aggressiveness: Number(e.target.value) })}
                onMouseUp={() => void commit({ default_aggressiveness: draft.default_aggressiveness })}
                className="w-full accent-[rgb(var(--c-accent))]"
              />
            </Field>
          </FormGrid>
        </Section>

        <Section title={t("音訊工具")}>
          <Field
            label="ffmpeg"
            hint={
              ffmpeg?.found
                ? `${ffmpeg.version} · ${ffmpegSourceLabel(ffmpeg.source)} · ${ffmpeg.ffmpeg_path}`
                : t("找不到 ffmpeg；請安裝或指定 ffmpeg.exe / 其所在資料夾")
            }
          >
            <div className="flex gap-2">
              <Input
                ref={ffmpegInputRef}
                value={draft.ffmpeg_path ?? ""}
                onChange={(e) => patch({ ffmpeg_path: e.target.value })}
                placeholder={t("留空＝自動偵測（PATH）")}
                className={`flex-1 transition-shadow ${highlight === "ffmpeg" ? "ring-2 ring-accent" : ""}`}
                spellCheck={false}
              />
              <Button
                variant="ghost"
                onClick={async () => {
                  const p = await pickOpenFile([{ name: "ffmpeg", extensions: ["exe", "*"] }]);
                  if (p) patch({ ffmpeg_path: p });
                }}
              >
                …
              </Button>
              <Button onClick={() => void detectFfmpeg()} loading={busy === "ffmpeg"}>
                {t("偵測")}
              </Button>
            </div>
          </Field>
        </Section>

        <Section title={t("輸出")}>
          <FormGrid>
            <Field label={t("輸出資料夾")} hint={t("留空＝與來源同資料夾")}>
              <div className="flex gap-2">
                <Input value={draft.output_dir ?? ""} readOnly className="flex-1" />
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const d = await pickDirectory();
                    if (d) void commit({ output_dir: d });
                  }}
                >
                  {t("選擇資料夾")}
                </Button>
                {draft.output_dir && (
                  <Button variant="ghost" onClick={() => void commit({ output_dir: null })}>
                    {t("清除")}
                  </Button>
                )}
              </div>
            </Field>
            <Field label={t("目標響度（LUFS）")}>
              <Select value={String(draft.target_lufs)} onChange={(e) => void commit({ target_lufs: Number(e.target.value) })}>
                <option value="-14">-14（Spotify / YouTube）</option>
                <option value="-16">-16（Podcast 立體聲）</option>
                <option value="-19">-19（Podcast 單聲道）</option>
                <option value="-23">-23（EBU R128 廣播）</option>
              </Select>
            </Field>
          </FormGrid>
        </Section>
        <Section title={t("外觀")}>
          <Field label={t("介面密度")} hint={t("大螢幕用「寬鬆」讀起來比較不吃力；筆電用「緊湊」可以多看到幾列")}>
            <Select value={density} onChange={(e) => setDensity(e.target.value as Density)}>
              <option value="compact">{t("緊湊")}</option>
              <option value="normal">{t("標準")}</option>
              <option value="comfortable">{t("寬鬆")}</option>
            </Select>
          </Field>
        </Section>
      </div>
    </Modal>
    {hotwordsOpen && <HotwordsDialog onClose={() => setHotwordsOpen(false)} />}
    </>
  );
}
