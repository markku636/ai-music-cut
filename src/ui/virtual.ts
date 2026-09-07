// 長清單只畫看得到的那幾列。
//
// 57 分鐘的節目會產生 4560 筆候選，全部鋪進 DOM 是 91200 個節點（其中 13723 個 svg 圖示）——
// 之後每接受一筆候選，React 都得把這 4560 列重新對帳一遍，瀏覽器也得重排這 91200 個節點。
//
// 這裡只負責**算數學**（哪幾列該畫、上下要墊多高），量測與捲動交給 useVirtual。
// 拆開是為了可測：捲到底、捲過頭、清單縮短這些邊界條件在瀏覽器裡很難重現。

export interface VirtualWindow {
  /** 要畫的區間 [start, end)。 */
  start: number;
  end: number;
  /** 上下墊片高度（撐出正確的捲軸長度與位置）。 */
  padTop: number;
  padBottom: number;
  /** 全部列的總高（估計值 + 已量到的實際值）。 */
  totalHeight: number;
}

export interface VirtualInput {
  /** 列數。 */
  count: number;
  /** 已量到的列高（沒量到的用 estimate）。索引即列序。 */
  heights: (number | undefined)[];
  /** 還沒量到的列用這個高度估計。 */
  estimate: number;
  scrollTop: number;
  viewportHeight: number;
  /** 視窗外多畫幾列，捲動時才不會露白。 */
  overscan: number;
}

/**
 * 算出這個捲動位置該畫哪幾列。
 *
 * 列高不固定（有沒有 AI 理由、意見標籤會差一行），所以用「已量到的用實際值、
 * 沒量到的用估計值」累加出位置。使用者捲過的地方會愈來愈準，捲軸也就跟著收斂。
 */
export function windowFor(input: VirtualInput): VirtualWindow {
  const { count, heights, estimate, overscan } = input;
  const est = estimate > 0 ? estimate : 1;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };

  const viewportHeight = Math.max(0, input.viewportHeight);
  const heightAt = (i: number) => {
    const h = heights[i];
    return h != null && h > 0 ? h : est;
  };

  // 視窗還沒量到（第一次繪製）就先畫一批，讓 ResizeObserver 有東西可以量。
  if (viewportHeight <= 0) {
    const end = Math.min(count, overscan * 2 + 1);
    let head = 0;
    for (let i = 0; i < end; i++) head += heightAt(i);
    let total = head;
    for (let i = end; i < count; i++) total += heightAt(i);
    return { start: 0, end, padTop: 0, padBottom: total - head, totalHeight: total };
  }

  // 捲動位置可能超出目前估計的總高（例如清單被篩短了），夾回範圍內再找。
  let totalHeight = 0;
  for (let i = 0; i < count; i++) totalHeight += heightAt(i);
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScroll);

  let start = 0;
  let offset = 0;
  while (start < count - 1 && offset + heightAt(start) <= scrollTop) {
    offset += heightAt(start);
    start += 1;
  }

  let end = start;
  let filled = offset;
  while (end < count && filled < scrollTop + viewportHeight) {
    filled += heightAt(end);
    end += 1;
  }

  // 前後各多畫 overscan 列
  let padTop = offset;
  for (let i = 0; i < overscan && start > 0; i++) {
    start -= 1;
    padTop -= heightAt(start);
  }
  end = Math.min(count, end + overscan);

  let padBottom = 0;
  for (let i = end; i < count; i++) padBottom += heightAt(i);

  return { start, end, padTop: Math.max(0, padTop), padBottom: Math.max(0, padBottom), totalHeight };
}

/**
 * 已量到的列高的平均，拿來當還沒量到的列的估計值。
 * 一列都還沒量到就回 fallback（第一次繪製用）。
 */
export function averageHeight(heights: (number | undefined)[], fallback: number): number {
  let sum = 0;
  let n = 0;
  for (const h of heights) {
    if (h != null && h > 0) {
      sum += h;
      n += 1;
    }
  }
  return n ? sum / n : fallback;
}
