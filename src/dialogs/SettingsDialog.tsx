import { useEffect, useState } from "react";
import { Cog } from "lucide-react";
import { api, errMessage, type AppSettings } from "../api";
import { Button, Field, FormGrid, Input, Modal, Select } from "../ui/index";
import { pickDirectory, pickOpenFile, toast } from "../ui";
import { useT } from "../i18n";
import { useSettings } from "../store/settings";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-fg/45 uppercase tracking-wide">{title}</div>
      <div className="rounded-md border border-fg/10 p-3 space-y-3">{children}</div>
    </div>
  );
}

export default function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const s = useSettings((x) => x.s);
  const save = useSettings((x) => x.save);
  const ffmpeg = useSettings((x) => x.ffmpeg);
  const ttls = useSettings((x) => x.ttls);
  const key = useSettings((x) => x.key);
  const probeAll = useSettings((x) => x.probeAll);
  const refreshKey = useSettings((x) => x.refreshKey);

  const [draft, setDraft] = useState<AppSettings>(s);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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
      toast.success(t("金鑰已存入 OS 鑰匙圈"));
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

  return (
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
              <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={key?.present ? "••••••••" : ""} className="flex-1" />
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

        <Section title={t("工具")}>
          <Field label="ffmpeg" hint={ffmpeg?.found ? `${ffmpeg.version} · ${ffmpeg.ffmpeg_path}` : t("找不到 ffmpeg；請安裝或指定 ffmpeg.exe / 其所在資料夾")}>
            <div className="flex gap-2">
              <Input value={draft.ffmpeg_path ?? ""} onChange={(e) => patch({ ffmpeg_path: e.target.value })} placeholder={t("留空＝自動偵測（PATH）")} className="flex-1" spellCheck={false} />
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
          <Field label={t("Claude 模型（claude CLI --model）")} hint={t("留空用 CLI 預設；AI 判讀與助手都用本機 claude 登入身分")}>
            <Select value={draft.claude_model} onChange={(e) => void commit({ claude_model: e.target.value })}>
              <option value="">{t("預設")}</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </Select>
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
            <Field label={t("AI 判讀")}>
              <label className="flex items-center gap-2 h-7 text-sm">
                <input type="checkbox" checked={draft.judge_enabled} onChange={(e) => void commit({ judge_enabled: e.target.checked })} />
                {t("分析後自動用 Claude 判讀自然度")}
              </label>
            </Field>
            <Field label={t("辨識語言")}>
              <Select value={draft.asr_language} onChange={(e) => void commit({ asr_language: e.target.value })}>
                <option value="zh">中文（zh/en 混講）</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="auto">auto</option>
              </Select>
            </Field>
            <Field label={t("辨識模型")}>
              <Select value={draft.asr_model} onChange={(e) => void commit({ asr_model: e.target.value })}>
                <option value="auto">auto（依 VRAM 選）</option>
                <option value="large-v3">large-v3（最準）</option>
                <option value="large-v3-turbo">large-v3-turbo（快）</option>
              </Select>
            </Field>
          </FormGrid>
          <Field label={t("領域詞（hotwords，逗號分隔）")} hint={t("產品名 / 人名 / 術語，提升辨識率")}>
            <Input value={draft.hotwords} onChange={(e) => patch({ hotwords: e.target.value })} onBlur={() => void commit({ hotwords: draft.hotwords })} />
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
      </div>
    </Modal>
  );
}
