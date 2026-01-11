export type PalletLimits = {
  lengthCm: number;
  widthCm: number;
  maxHeightCm: number;
  palletHeightCm: number;
  maxWeightKg: number;
  maxWeightToleranceKg: number;
  maxVolumeM3: number;
};

export type PalletWarning = {
  itemId: string;
  code: string;
  name: string;
  message: string;
  level: "error" | "warn";
};

export type SupplyItemInput = {
  itemId: string;
  code: string;
  name: string;
  category?: string | null;
  qty: number;
  unitsPerBox?: number | null;
  unitWeight?: number | null;
  boxLength?: number | null;
  boxWidth?: number | null;
  boxHeight?: number | null;
  boxWeight?: number | null;
  boxVolume?: number | null;
  boxOrientation?: string | null;
};

export type PalletPart = {
  partId: string;
  itemId: string;
  code: string;
  name: string;
  category: string;
  boxes: number;
  perBoxWeightKg: number;
  perBoxVolumeM3: number;
  weightKg: number;
  volumeM3: number;
  dims: [number, number, number];
  orientation: "стоя" | "нормально";
  weightClass: "heavy" | "normal" | "light";
};

export type Pallet = {
  seed?: PalletPart;
  items: PalletPart[];
  weightKg: number;
  volumeM3: number;
  heightCm: number;
};

export type PalletPlan = {
  pallets: Pallet[];
  totalWeightKg: number;
  totalVolumeM3: number;
  warnings: PalletWarning[];
  errors: PalletWarning[];
};

export const DEFAULT_PALLET_LIMITS: PalletLimits = {
  lengthCm: 120,
  widthCm: 80,
  maxHeightCm: 180,
  palletHeightCm: 14,
  maxWeightKg: 510,
  maxWeightToleranceKg: 1,
  maxVolumeM3: 1.728,
};

export const DEFAULT_PALLET_WEIGHT_KG = 20;

const ALPHA = 0.5;
const WT_ORDER: Record<PalletPart["weightClass"], number> = {
  heavy: 0,
  normal: 1,
  light: 2,
};

const asNumber = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const closeEnough = (a: number, b: number, rel = 0.05) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const max = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / max <= rel;
};

export const calcBoxVolumeM3 = (l: number, w: number, h: number) =>
  l > 0 && w > 0 && h > 0 ? (l * w * h) / 1_000_000 : null;

export const calcBoxWeightKg = (unitWeight: number, unitsPerBox: number, boxWeight?: number | null) => {
  if (unitWeight > 0 && unitsPerBox > 0) return unitWeight * unitsPerBox;
  if (boxWeight && boxWeight > 0) return boxWeight;
  return null;
};

const detectOrientation = (
  l: number,
  w: number,
  h: number,
  perBoxWeightKg: number,
  perBoxVolumeM3: number,
  limits: PalletLimits,
) => {
  const availH = limits.maxHeightCm - limits.palletHeightCm;
  const limVol = perBoxVolumeM3 > 0 ? Math.floor(limits.maxVolumeM3 / perBoxVolumeM3) : Number.MAX_SAFE_INTEGER;
  const limKg = perBoxWeightKg > 0 ? Math.floor(limits.maxWeightKg / perBoxWeightKg) : Number.MAX_SAFE_INTEGER;
  const perms: Array<{ dims: [number, number, number]; tag: "нормально" | "стоя" }> = [
    { dims: [l, w, h], tag: "нормально" },
    { dims: [w, l, h], tag: "нормально" },
    { dims: [l, h, w], tag: "стоя" },
    { dims: [h, l, w], tag: "стоя" },
    { dims: [w, h, l], tag: "стоя" },
    { dims: [h, w, l], tag: "стоя" },
  ];

  let bestCnt = 0;
  let bestTag: "нормально" | "стоя" = "нормально";
  let bestDims: [number, number, number] = [l, w, h];

  perms.forEach((p) => {
    const [d1, d2, d3] = p.dims;
    if (p.tag === "стоя" && (h * 2 < l || h * 2 < w)) return;
    const perLayer = Math.max(
      Math.floor(limits.lengthCm / d1) * Math.floor(limits.widthCm / d2),
      Math.floor(limits.lengthCm / d2) * Math.floor(limits.widthCm / d1),
      1,
    );
    const layers = Math.floor(availH / d3);
    const cnt = Math.min(limVol, limKg, perLayer * layers);
    if (cnt > bestCnt) {
      bestCnt = cnt;
      bestTag = p.tag;
      bestDims = [d1, d2, d3];
    }
  });

  return { dims: bestDims, orientation: bestTag };
};

export const computePalletHeightCm = (items: PalletPart[], limits: PalletLimits) => {
  const baseL = limits.lengthCm;
  const baseW = limits.widthCm;
  let h = 0;

  for (const it of items) {
    const [l, w, ht] = it.dims;
    const fit1 = Math.floor(baseL / l) * Math.floor(baseW / w);
    const fit2 = Math.floor(baseL / w) * Math.floor(baseW / l);
    const perLayer = Math.max(fit1, fit2, 1);
    h += Math.ceil(it.boxes / perLayer) * ht;
  }

  return h + limits.palletHeightCm;
};

const canFit = (p: Pallet, item: PalletPart, limits: PalletLimits) => {
  if (p.weightKg + item.weightKg > limits.maxWeightKg + limits.maxWeightToleranceKg) return false;
  if (p.volumeM3 + item.volumeM3 > limits.maxVolumeM3) return false;
  const nextHeight = computePalletHeightCm([...p.items, item], limits);
  if (nextHeight > limits.maxHeightCm) return false;
  return true;
};

const splitIntoPalletParts = (sku: PalletPart, limits: PalletLimits, errors: PalletWarning[]) => {
  const parts: PalletPart[] = [];
  let left = sku.boxes;
  let guard = 0;

  while (left > 0 && guard < 2000) {
    guard += 1;
    let fit = left;
    while (fit > 0) {
      const weight = sku.perBoxWeightKg * fit;
      const volume = sku.perBoxVolumeM3 * fit;
      const virt: PalletPart = {
        ...sku,
        boxes: fit,
        weightKg: weight,
        volumeM3: volume,
      };
      const height = computePalletHeightCm([virt], limits);
      if (
        weight <= limits.maxWeightKg + limits.maxWeightToleranceKg &&
        volume <= limits.maxVolumeM3 &&
        height <= limits.maxHeightCm
      ) {
        break;
      }
      fit -= 1;
    }

    if (fit <= 0) {
      errors.push({
        itemId: sku.itemId,
        code: sku.code,
        name: sku.name,
        message: "Короб не помещается в палету по габаритам/весу.",
        level: "error",
      });
      break;
    }

    parts.push({
      ...sku,
      partId: `${sku.itemId}:${parts.length + 1}:${fit}`,
      boxes: fit,
      weightKg: sku.perBoxWeightKg * fit,
      volumeM3: sku.perBoxVolumeM3 * fit,
    });
    left -= fit;
  }

  return parts;
};

const buildQueue = (seed: PalletPart, leftovers: PalletPart[]) => {
  const sameCat = leftovers.filter((x) => x.category === seed.category);
  const same1 = sameCat.filter((x) => x.weightClass === seed.weightClass);
  const same2 = sameCat.filter((x) => x.weightClass !== seed.weightClass);
  const other = leftovers.filter((x) => x.category !== seed.category);
  const sortByWeight = (arr: PalletPart[]) =>
    arr.slice().sort((a, b) => WT_ORDER[a.weightClass] - WT_ORDER[b.weightClass]);
  return [...sortByWeight(same1), ...sortByWeight(same2), ...sortByWeight(other)];
};

const fillPallet = (pallet: Pallet, leftovers: PalletPart[], limits: PalletLimits) => {
  if (!pallet.seed) return;
  const queue = buildQueue(pallet.seed, leftovers);
  for (const item of queue) {
    if (!leftovers.find((x) => x.partId === item.partId)) continue;
    if (!canFit(pallet, item, limits)) continue;
    pallet.items.push(item);
    pallet.weightKg += item.weightKg;
    pallet.volumeM3 += item.volumeM3;
    leftovers.splice(leftovers.findIndex((x) => x.partId === item.partId), 1);
  }
  pallet.heightCm = computePalletHeightCm(pallet.items, limits);
};

const fillLeftoversPartially = (pallets: Pallet[], leftovers: PalletPart[], limits: PalletLimits) => {
  const snapshot = leftovers.slice();
  for (const item of snapshot) {
    let leftBoxes = item.boxes;
    for (const p of pallets) {
      if (leftBoxes <= 0) break;
      let fit = leftBoxes;
      while (fit > 0) {
        const virt: PalletPart = {
          ...item,
          partId: `${item.partId}-split-${fit}`,
          boxes: fit,
          weightKg: item.perBoxWeightKg * fit,
          volumeM3: item.perBoxVolumeM3 * fit,
        };
        if (canFit(p, virt, limits)) {
          p.items.push(virt);
          p.weightKg += virt.weightKg;
          p.volumeM3 += virt.volumeM3;
          p.heightCm = computePalletHeightCm(p.items, limits);
          leftBoxes -= fit;
          break;
        }
        fit -= 1;
      }
    }
    if (leftBoxes <= 0) {
      const idx = leftovers.findIndex((x) => x.partId === item.partId);
      if (idx >= 0) leftovers.splice(idx, 1);
    } else {
      const idx = leftovers.findIndex((x) => x.partId === item.partId);
      if (idx >= 0) {
        leftovers[idx] = {
          ...item,
          boxes: leftBoxes,
          weightKg: item.perBoxWeightKg * leftBoxes,
          volumeM3: item.perBoxVolumeM3 * leftBoxes,
        };
      }
    }
  }
};

export const distributePallets = (items: SupplyItemInput[], limits: PalletLimits): PalletPlan => {
  const warnings: PalletWarning[] = [];
  const errors: PalletWarning[] = [];
  const parts: PalletPart[] = [];
  const expectedBoxesByItem = new Map<string, number>();

  for (const row of items) {
    const unitsPerBox = asNumber(row.unitsPerBox);
    const l = asNumber(row.boxLength);
    const w = asNumber(row.boxWidth);
    const h = asNumber(row.boxHeight);
    const unitWeight = asNumber(row.unitWeight);
    const perBoxWeight = calcBoxWeightKg(unitWeight, unitsPerBox, row.boxWeight);
    const volumeCalc = calcBoxVolumeM3(l, w, h);
    const volume = volumeCalc ?? (row.boxVolume && row.boxVolume > 0 ? row.boxVolume : null);

    if (!unitsPerBox) {
      errors.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Не указано количество штук в коробке.",
        level: "error",
      });
      continue;
    }
    if (!l || !w || !h) {
      errors.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Не указаны габариты короба.",
        level: "error",
      });
      continue;
    }
    if (!volume) {
      errors.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Не удалось рассчитать объём короба.",
        level: "error",
      });
      continue;
    }
    if (!perBoxWeight) {
      errors.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Не удалось рассчитать вес короба.",
        level: "error",
      });
      continue;
    }

    if (unitWeight <= 0 && row.boxWeight && row.boxWeight > 0) {
      warnings.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Вес короба задан вручную — заполните вес 1 шт.",
        level: "warn",
      });
    }

    if (row.boxVolume && volumeCalc && !closeEnough(row.boxVolume, volumeCalc)) {
      warnings.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Объём короба отличается от расчётного — проверьте данные.",
        level: "warn",
      });
    }
    if (row.boxWeight && unitWeight > 0 && unitsPerBox > 0 && !closeEnough(row.boxWeight, perBoxWeight)) {
      warnings.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Вес короба отличается от расчётного — проверьте данные.",
        level: "warn",
      });
    }

    const { dims, orientation } = detectOrientation(l, w, h, perBoxWeight, volume, limits);
    const oriRaw = String(row.boxOrientation ?? "").toLowerCase();
    if (oriRaw && !oriRaw.includes(orientation)) {
      warnings.push({
        itemId: row.itemId,
        code: row.code,
        name: row.name,
        message: "Ориентация короба отличается от расчётной.",
        level: "warn",
      });
    }

    const density = volume > 0 ? perBoxWeight / volume : 0;
    const weightClass: PalletPart["weightClass"] =
      density >= 200 ? "heavy" : density >= 50 ? "normal" : "light";
    const boxes = Math.ceil(row.qty / unitsPerBox);
    expectedBoxesByItem.set(row.itemId, (expectedBoxesByItem.get(row.itemId) ?? 0) + boxes);
    const skuBase: PalletPart = {
      partId: `${row.itemId}:0`,
      itemId: row.itemId,
      code: row.code,
      name: row.name,
      category: row.category || "прочие",
      boxes,
      perBoxWeightKg: perBoxWeight,
      perBoxVolumeM3: volume,
      weightKg: perBoxWeight * boxes,
      volumeM3: volume * boxes,
      dims,
      orientation,
      weightClass,
    };
    const split = splitIntoPalletParts(skuBase, limits, errors);
    parts.push(...split);
  }

  if (errors.length) {
    return { pallets: [], totalWeightKg: 0, totalVolumeM3: 0, warnings, errors };
  }

  const totalWeightKg = parts.reduce((sum, it) => sum + it.weightKg, 0);
  const totalVolumeM3 = parts.reduce((sum, it) => sum + it.volumeM3, 0);
  if (!parts.length) {
    return { pallets: [], totalWeightKg, totalVolumeM3, warnings, errors };
  }

  const palletsByWeight = Math.ceil(totalWeightKg / limits.maxWeightKg);
  const palletsByVolume = Math.ceil(totalVolumeM3 / limits.maxVolumeM3);
  const K = Math.max(palletsByWeight, palletsByVolume);

  const scored = parts.map((s, idx) => ({
    ...s,
    partId: s.partId || `${s.itemId}:${idx}`,
    score: ALPHA * (s.weightKg / limits.maxWeightKg) + (1 - ALPHA) * (s.volumeM3 / limits.maxVolumeM3),
  }));
  scored.sort((a, b) => b.score - a.score);
  const anchors = scored.slice(0, Math.min(K, scored.length));
  const leftovers = scored.slice(Math.min(K, scored.length));

  const pallets: Pallet[] = anchors.map((a) => ({
    seed: a,
    items: [a],
    weightKg: a.weightKg,
    volumeM3: a.volumeM3,
    heightCm: computePalletHeightCm([a], limits),
  }));

  pallets.forEach((p) => fillPallet(p, leftovers, limits));
  fillLeftoversPartially(pallets, leftovers, limits);

  let guard = 0;
  while (leftovers.length && guard < 2000) {
    guard += 1;
    const seed = leftovers.shift();
    if (!seed) break;
    const newPallet: Pallet = {
      seed,
      items: [seed],
      weightKg: seed.weightKg,
      volumeM3: seed.volumeM3,
      heightCm: computePalletHeightCm([seed], limits),
    };
    fillPallet(newPallet, leftovers, limits);
    fillLeftoversPartially([newPallet], leftovers, limits);
    pallets.push(newPallet);
  }

  const actualBoxesByItem = new Map<string, number>();
  for (const pallet of pallets) {
    for (const item of pallet.items) {
      actualBoxesByItem.set(item.itemId, (actualBoxesByItem.get(item.itemId) ?? 0) + item.boxes);
    }
  }

  for (const [itemId, expected] of expectedBoxesByItem.entries()) {
    const actual = actualBoxesByItem.get(itemId) ?? 0;
    if (actual === expected) continue;
    errors.push({
      itemId,
      code: items.find((x) => x.itemId === itemId)?.code ?? "",
      name: items.find((x) => x.itemId === itemId)?.name ?? "",
      message:
        actual < expected
          ? `Не все коробки распределены: ${actual} из ${expected}.`
          : `Распределено больше коробок, чем нужно: ${actual} вместо ${expected}.`,
      level: "error",
    });
  }

  return { pallets, totalWeightKg, totalVolumeM3, warnings, errors };
};
