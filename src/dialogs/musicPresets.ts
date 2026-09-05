// ACE-Step 的風格提示詞：英文 tag 式效果最好，中文可用但控制較弱。
// 生成（純器樂 BGM）與曲風轉換（audio2audio）共用。

export interface StylePreset {
  label: string;
  prompt: string;
}

/** 生成 BGM 用的常見情境。 */
export const MUSIC_PRESETS: StylePreset[] = [
  { label: "Lo-fi", prompt: "lofi hip hop, warm, mellow, vinyl crackle, soft drums" },
  { label: "Podcast 開場", prompt: "upbeat corporate intro, light percussion, bright synth, clean, energetic" },
  { label: "抒情鋼琴", prompt: "emotional piano ballad, soft strings, cinematic, gentle" },
  { label: "電子", prompt: "electronic dance, punchy kick, arpeggio synth, driving bassline" },
  { label: "爵士咖啡", prompt: "jazz cafe, brushed drums, upright bass, warm rhodes, relaxed swing" },
  { label: "環境", prompt: "ambient pad, airy texture, slow evolving, calm, no drums" },
];

/** 曲風轉換用：描述「換成什麼」，通常是換編制與音色。 */
export const STYLE_PRESETS: StylePreset[] = [
  { label: "Lo-fi 化", prompt: "lofi hip hop remake, warm tape saturation, mellow drums, vinyl crackle" },
  { label: "原聲吉他", prompt: "acoustic guitar arrangement, intimate, fingerpicking, light percussion" },
  { label: "電影感", prompt: "cinematic orchestral, strings and brass, epic build, wide reverb" },
  { label: "電子舞曲", prompt: "edm remix, four on the floor kick, sidechain pump, bright synth lead" },
  { label: "爵士", prompt: "jazz trio arrangement, swung drums, walking upright bass, rhodes piano" },
  { label: "8-bit", prompt: "chiptune 8-bit arrangement, square lead, retro game feel" },
  { label: "純鋼琴", prompt: "solo piano version, soft dynamics, expressive, no drums" },
];
