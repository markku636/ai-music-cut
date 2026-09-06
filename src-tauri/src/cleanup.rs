//! 修聲濾鏡：底噪 / 隆隆聲 / 齒音。
//!
//! 前端只送**數字**過來（`analysis/cleanup.ts` 的 CleanupSpec），濾鏡字串一律在這裡組。
//! 不讓前端直接送 ffmpeg 濾鏡語法 —— 那等於把任意濾鏡的執行權交出去。
//!
//! **這條鏈必須同時進量測與編碼兩趟**。loudnorm 用的是 `linear=true`：
//! 它照 pass 1 量到的數字算一個固定增益，pass 2 直接套用。如果只在編碼那趟修聲，
//! 量到的是「沒修過」的響度、套用的卻是「修過」的訊號，降噪吃掉的那點能量就會
//! 讓成品整體偏低，而且偏多少看素材，完全不可預期。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CleanupSpec {
    /// 高通截止（Hz）。0 = 不做。
    #[serde(default)]
    pub rumble_hz: f64,
    /// 降噪量（dB）。0 = 不做。
    #[serde(default)]
    pub denoise_db: f64,
    /// 量到的底噪（dBFS），餵給 afftdn 的 nf。
    #[serde(default)]
    pub noise_floor_db: f64,
    /// 齒音抑制 0–1。0 = 不做。
    #[serde(default)]
    pub deess_amount: f64,
}

impl CleanupSpec {
    pub fn is_active(&self) -> bool {
        self.rumble_hz > 0.0 || self.denoise_db > 0.0 || self.deess_amount > 0.0
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// 組出修聲濾鏡鏈；沒有東西要做就回 None。
///
/// 順序有意義：先切掉隆隆聲，降噪器才不會把預算花在 80 Hz 以下那堆低頻上；
/// 齒音放最後，因為它處理的是降噪之後剩下來的高頻。
pub fn cleanup_filter(spec: &CleanupSpec) -> Option<String> {
    if !spec.is_active() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if spec.rumble_hz > 0.0 {
        // poles=2 是溫和的 12 dB/oct；再陡會在截止點附近產生相位起伏，人聲聽得出來
        parts.push(format!("highpass=f={:.0}:poles=2", clamp(spec.rumble_hz, 20.0, 200.0)));
    }
    if spec.denoise_db > 0.0 {
        parts.push(format!(
            "afftdn=nr={:.1}:nf={:.0}:tn=1",
            clamp(spec.denoise_db, 1.0, 30.0),
            clamp(spec.noise_floor_db, -80.0, -20.0)
        ));
    }
    if spec.deess_amount > 0.0 {
        // ffmpeg 的 deesser：i=強度、m=最大衰減、f=處理頻寬、s=o 表示輸出處理後的訊號
        parts.push(format!("deesser=i={:.2}:m=0.5:f=0.5:s=o", clamp(spec.deess_amount, 0.05, 1.0)));
    }
    Some(parts.join(","))
}

/// 把修聲鏈接在既有濾鏡串前面（修聲要先發生，響度才量得準）。
pub fn prepend_cleanup(cleanup: Option<&CleanupSpec>, rest: &str) -> String {
    match cleanup.and_then(cleanup_filter) {
        Some(c) => format!("{c},{rest}"),
        None => rest.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(rumble: f64, denoise: f64, floor: f64, deess: f64) -> CleanupSpec {
        CleanupSpec { rumble_hz: rumble, denoise_db: denoise, noise_floor_db: floor, deess_amount: deess }
    }

    #[test]
    fn inactive_spec_produces_no_filter() {
        assert!(cleanup_filter(&CleanupSpec::default()).is_none());
        assert!(cleanup_filter(&spec(0.0, 0.0, -60.0, 0.0)).is_none());
    }

    #[test]
    fn order_is_highpass_then_denoise_then_deesser() {
        let f = cleanup_filter(&spec(80.0, 12.0, -52.0, 0.3)).unwrap();
        let hp = f.find("highpass").unwrap();
        let dn = f.find("afftdn").unwrap();
        let de = f.find("deesser").unwrap();
        assert!(hp < dn && dn < de, "順序不對：{f}");
    }

    #[test]
    fn each_stage_can_stand_alone() {
        let only_hp = cleanup_filter(&spec(80.0, 0.0, -60.0, 0.0)).unwrap();
        assert_eq!(only_hp, "highpass=f=80:poles=2");
        let only_dn = cleanup_filter(&spec(0.0, 10.0, -50.0, 0.0)).unwrap();
        assert_eq!(only_dn, "afftdn=nr=10.0:nf=-50:tn=1");
        let only_de = cleanup_filter(&spec(0.0, 0.0, -60.0, 0.4)).unwrap();
        assert_eq!(only_de, "deesser=i=0.40:m=0.5:f=0.5:s=o");
    }

    #[test]
    fn values_are_clamped_to_safe_ranges() {
        // 前端傳來離譜的值也不能組出會讓 ffmpeg 拒絕的濾鏡
        let f = cleanup_filter(&spec(9999.0, 999.0, -999.0, 99.0)).unwrap();
        assert!(f.contains("highpass=f=200:"), "{f}");
        assert!(f.contains("nr=30.0:"), "{f}");
        assert!(f.contains("nf=-80:"), "{f}");
        assert!(f.contains("i=1.00:"), "{f}");
    }

    #[test]
    fn prepend_puts_cleanup_before_loudnorm() {
        let s = spec(80.0, 0.0, -60.0, 0.0);
        assert_eq!(prepend_cleanup(Some(&s), "loudnorm=I=-16.0"), "highpass=f=80:poles=2,loudnorm=I=-16.0");
        // 沒有修聲時不可以留下一個開頭的逗號 —— ffmpeg 會直接拒絕整條濾鏡串
        assert_eq!(prepend_cleanup(None, "loudnorm=I=-16.0"), "loudnorm=I=-16.0");
        assert_eq!(prepend_cleanup(Some(&CleanupSpec::default()), "loudnorm=I=-16.0"), "loudnorm=I=-16.0");
    }
}
