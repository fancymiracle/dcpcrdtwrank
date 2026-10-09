// 公會戰排名快照的換算。
//
// 原始資料是 bot 每 30 分鐘存的一筆快照（<伺服器>_data_<yyyyMM>.json.gz）：
//   { "<yyyyMMddHHmm>": [{ i: 索引, r: 名次, d: 累積分數, n: 隊名 }, …] }
// d 是當期累積總分（遞增），所以「這段時間打了多少」一律是兩筆相減。
//
// 這個檔同時被網頁與測試載入，所以不碰 DOM、不依賴任何函式庫。

/** 遊戲的一天從早上 5 點開始 */
export const BATTLE_DAY_START = 5;

/** 'yyyyMMddHHmm' -> { y, m, d, hour, min } */
export function parseStamp(ts) {
    const s = String(ts);
    return {
        y: Number(s.slice(0, 4)), m: Number(s.slice(4, 6)), d: Number(s.slice(6, 8)),
        hour: Number(s.slice(8, 10)), min: Number(s.slice(10, 12))
    };
}

/** 'yyyyMMddHHmm' -> 這筆屬於哪個戰隊戰日（早上 5 點前算前一天），回 'yyyyMMdd' */
export function battleDay(ts) {
    const { y, m, d, hour } = parseStamp(ts);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (hour < BATTLE_DAY_START) date.setUTCDate(date.getUTCDate() - 1);
    const p = n => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
}

/** 顯示用的短時間 'MM/DD HH:mm' */
export function shortTime(ts) {
    const { m, d, hour, min } = parseStamp(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(m)}/${p(d)} ${p(hour)}:${p(min)}`;
}

/**
 * 把整個月檔整理成各戰隊的時間序列。
 * @returns {{stamps: string[], clans: Array<{name, points: Array<{ts, rank, score}>, finalRank, finalScore}>}}
 *   clans 依最終名次排序
 */
export function buildSeries(data) {
    const stamps = Object.keys(data || {}).filter(k => Array.isArray(data[k])).sort();
    const byName = new Map();
    for (const ts of stamps) {
        for (const c of data[ts]) {
            if (!c || !c.n) continue;
            if (!byName.has(c.n)) byName.set(c.n, []);
            byName.get(c.n).push({ ts, rank: Number(c.r), score: Number(c.d) || 0 });
        }
    }
    // 中途掉出前 150 名的隊伍最後一筆是它掉出去之前的名次，不能當成最終名次
    const lastTs = stamps[stamps.length - 1];
    const clans = [...byName.entries()].map(([name, points]) => {
        const last = points[points.length - 1];
        return {
            name, points,
            finalRank: last.ts === lastTs ? last.rank : null,
            lastRank: last.rank,
            finalScore: last.score,
            inFinal: last.ts === lastTs
        };
    });
    clans.sort((a, b) => (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity) || b.finalScore - a.finalScore);
    return { stamps, clans };
}

/** 每個時間點比上一筆多了多少分（第一筆沒有前一筆，不計） */
export function deltaPoints(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
        out.push({ ts: points[i].ts, gain: points[i].score - points[i - 1].score });
    }
    return out;
}

/**
 * 每個戰隊戰日的得分 = 當日最後一筆 - 前一日最後一筆。
 * @returns {Array<{day, total, end}>} end 是當日結束時的累積分數
 */
/** 這一筆距離當天開始（早上 5 點）幾分鐘 */
function minutesIntoDay(ts) {
    const { hour, min } = parseStamp(ts);
    return ((hour - BATTLE_DAY_START + 24) % 24) * 60 + min;
}

export function dailyTotals(points) {
    const firstStamp = new Map(), lastOfDay = new Map();
    for (const p of points) {
        const day = battleDay(p.ts);
        if (!firstStamp.has(day)) firstStamp.set(day, p.ts);
        lastOfDay.set(day, p.score);
    }
    const days = [...lastOfDay.keys()].sort();

    let prev = 0;
    return days.map((day, i) => {
        const end = lastOfDay.get(day);
        // 分數變少 = 下一期開打歸零重算，那天是從 0 開始打的
        const reset = end < prev;
        const baseline = i === 0 || reset ? 0 : prev;
        prev = end;

        // 從 0 起算的那天，如果第一筆快照離 5 點太久，代表前面那段沒收到
        // （bot 當時沒在跑，或這期其實更早就開打了）。算出來的「單日分數」
        // 會把沒收到的那段也算進去，寧可不給。
        if (baseline === 0 && minutesIntoDay(firstStamp.get(day)) > 120) {
            return { day, total: null, end, partial: true };
        }
        return reset ? { day, total: end, end, reset: true } : { day, total: end - baseline, end };
    });
}

/**
 * 真的有在打的日子。
 *
 * 月檔裡也有非戰隊戰期間的快照，那時排名凍結、分數完全不動；
 * 把全部戰隊加起來沒有任何得分的日子濾掉，圖表與表格才不會被一堆空欄塞滿。
 * @param {Array<{points}>} clans buildSeries 的結果
 * @returns {string[]} 'yyyyMMdd'，由舊到新
 */
export function activeDays(clans) {
    const sum = new Map();
    for (const c of clans ?? []) {
        for (const d of dailyTotals(c.points)) {
            if (!(d.total > 0)) continue;
            sum.set(d.day, (sum.get(d.day) ?? 0) + d.total);
        }
    }
    return [...sum.keys()].sort();
}

/** 一天的時段順序：5 點到隔天 4 點 */
export function dayHours() {
    return Array.from({ length: 24 }, (_, i) => (BATTLE_DAY_START + i) % 24);
}

/**
 * 依時段統計增量，看得出一支戰隊都在什麼時間出刀。
 * @returns {Array<{hour, total, samples}>} 從 5 點排到隔天 4 點
 */
export function hourlyPace(points) {
    const sum = new Map(dayHours().map(h => [h, { hour: h, total: 0, samples: 0 }]));
    for (const { ts, gain } of deltaPoints(points)) {
        const slot = sum.get(parseStamp(ts).hour);
        // 負的增量只會來自「下一期開打分數歸零」，不是真的在這個時段打了負分
        if (!slot || gain < 0) continue;
        slot.total += gain;
        slot.samples++;
    }
    return dayHours().map(h => sum.get(h));
}

/** 只留下指定戰隊戰日的快照 */
export function pointsIn(points, days) {
    const set = new Set(days ?? []);
    return (points ?? []).filter(p => set.has(battleDay(p.ts)));
}

/** 'yyyyMMdd' 的前一天 */
function prevDay(day) {
    const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6)));
    d.setUTCDate(d.getUTCDate() - 1);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * 跟開打日連在一起的「資料不完整」日子。
 *
 * 月檔裡非戰隊戰期間也會有零星的不完整日（bot 重啟之類），那些跟這次開打無關，
 * 報出來只是雜訊；只有緊接在開打日之前的那幾天才是「這次漏收的」。
 */
export function adjacentPartialDays(partialDays, days) {
    const first = days?.[0];
    if (!first || !partialDays?.length) return [];
    const set = new Set(partialDays);
    const out = [];
    for (let day = prevDay(first); set.has(day); day = prevDay(day)) out.unshift(day);
    return out;
}

/**
 * 累積分數推回目前在第幾周。
 *
 * 每一周的總分 = 五隻王的血量 × 各自的分數倍率，倍率依階段不同（laps.json 來自 master.db）。
 * 實際上五隻王可以差一周（打掉 23-1 之後就不能再打 24-1），所以這是整體的推估值。
 *
 * @param {number} score 累積分數
 * @param {{phases: Array<{from, to, lapScore}>}} table
 * @returns {{lap: number, progress: number}|null} 對照表不可用時回 null
 */
export function lapOf(score, table) {
    const phases = table?.phases?.filter(p => p.lapScore > 0) ?? [];
    if (!phases.length) return null;

    let acc = 0;
    for (const p of phases) {
        const last = p.to === -1 || p.to == null ? Infinity : p.to;
        for (let lap = p.from; lap <= last; lap++) {
            if (acc + p.lapScore > score) return { lap, progress: (score - acc) / p.lapScore };
            acc += p.lapScore;
            if (lap - p.from > 2000) break;      // 對照表壞掉時不要變成無窮迴圈
        }
    }
    return { lap: Infinity, progress: 1 };
}

/**
 * 已經打完的天數（進行中的那天不算）。
 * 一天到 23:50 收完最後一筆才算結束 —— 刀數推估要靠完整的一天當基準。
 */
export function completedDays(stamps, days) {
    if (!stamps?.length) return 0;
    const list = days ?? [...new Set(stamps.map(battleDay))].sort();
    if (!list.length) return 0;
    const lastDay = list[list.length - 1];
    const lastStamp = [...stamps].reverse().find(t => battleDay(t) === lastDay);
    if (!lastStamp) return list.length;
    const { hour, min } = parseStamp(lastStamp);
    return hour === 23 && min >= 50 ? list.length : list.length - 1;
}

/**
 * 這個月的快照屬於哪一期公會戰（laps.json 來自 master.db，可能還沒有最新一期）。
 * @param {string[]} stamps 快照時間
 * @param {{battles: Array}} laps
 */
export function battleFor(stamps, laps) {
    // 看最後一筆：月檔常常跨到上一期的尾巴（非戰隊戰期間排名凍結），
    // 用第一筆會對到上一期，王血量不同、周目就算錯了
    const last = stamps?.[stamps.length - 1];
    if (!last || !laps?.battles) return null;
    return laps.battles.find(b => b.startStamp && b.endStamp &&
        b.startStamp <= last && last <= b.endStamp) ?? null;
}

/**
 * 推估刀數。
 *
 * 快照只有總分，沒有「這段分數是幾刀打的」，所以只能估：
 * 假設完整的一天會把 90 刀打完，用那天的總分除以 90 當作每刀均分，
 * 再用進行中那天已得的分數反推已用幾刀。
 * 第一天有 1~3 階段、分數偏低，有別天可用時就不拿它當基準。
 * 殘刀、凱留刀都會讓實際刀數比這個估計多。
 *
 * @param {Array<{day, total}>} days dailyTotals 的結果
 * @param {{hitsPerDay?: number, complete?: number}} opts complete = 已經結束的天數
 */
export function hitEstimate(days, { hitsPerDay = 90, complete = Math.max(days.length - 1, 0) } = {}) {
    if (!days?.length) return null;

    const completed = days.slice(0, complete);
    const basisDays = completed.length > 1 ? completed.slice(1) : completed.length ? completed : days.slice(0, 1);
    const totals = basisDays.map(d => d.total).filter(t => t > 0);
    if (!totals.length) return null;

    const perHit = totals.reduce((a, b) => a + b, 0) / (totals.length * hitsPerDay);
    if (!(perHit > 0)) return null;

    const current = days[complete] ?? null;
    const used = current ? current.total / perHit : null;
    return {
        perHit,
        basis: basisDays[basisDays.length - 1].day,
        firstDayOnly: completed.length === 0,
        day: current?.day ?? null,
        used: used == null ? null : Math.round(used * 10) / 10,
        left: used == null ? null : Math.round((hitsPerDay - used) * 10) / 10
    };
}
