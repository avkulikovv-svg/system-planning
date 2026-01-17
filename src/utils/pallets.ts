export type PalletLimits = {
  lengthCm: number;
  widthCm: number;
  maxHeightCm: number;
  palletHeightCm: number;
  maxWeightKg: number;
  maxWeightToleranceKg: number;
  maxVolumeM3: number;
  boxesPerRow?: number;
};

export type PalletWarning = {
  itemId: string;
  code: string;
  name: string;
  message: string;
  level: "error" | "warn";
};

export type PalletPlacementInfo = {
  maxBoxes: number | null;
  rowBoxes: number | null;
  orientation: "" | "стоя" | "нормально";
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
  density: number;
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
  boxesPerRow: 0,
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

const normalizeBoxesPerRow = (limits: PalletLimits) => {
  const raw = Math.floor(asNumber(limits.boxesPerRow));
  return raw > 0 ? raw : null;
};

const getLayerMetrics = (dims: [number, number, number], limits: PalletLimits) => {
  const [l, w] = dims;
  const targetRow = normalizeBoxesPerRow(limits);

  const fitL1 = Math.floor(limits.lengthCm / l);
  const fitW1 = Math.floor(limits.widthCm / w);
  const row1 = Math.max(1, targetRow ? Math.min(fitW1, targetRow) : fitW1 || 1);
  const perLayer1 = Math.max(1, fitL1 * row1);

  const fitL2 = Math.floor(limits.lengthCm / w);
  const fitW2 = Math.floor(limits.widthCm / l);
  const row2 = Math.max(1, targetRow ? Math.min(fitW2, targetRow) : fitW2 || 1);
  const perLayer2 = Math.max(1, fitL2 * row2);

  if (perLayer2 > perLayer1) return { perLayer: perLayer2, rowSize: row2 };
  if (perLayer1 > perLayer2) return { perLayer: perLayer1, rowSize: row1 };
  if (targetRow) {
    const diff1 = Math.abs(row1 - targetRow);
    const diff2 = Math.abs(row2 - targetRow);
    if (diff2 < diff1) return { perLayer: perLayer2, rowSize: row2 };
  }
  return row1 >= row2 ? { perLayer: perLayer1, rowSize: row1 } : { perLayer: perLayer2, rowSize: row2 };
};

const buildSizeKey = (dims: [number, number, number]) =>
  dims
    .slice()
    .sort((a, b) => a - b)
    .join("x");

export const computePalletPlacementInfo = (
  l: number,
  w: number,
  h: number,
  perBoxWeightKg: number,
  perBoxVolumeM3: number,
  limits: PalletLimits = DEFAULT_PALLET_LIMITS,
): PalletPlacementInfo => {
  if (l <= 0 || w <= 0 || h <= 0 || perBoxWeightKg <= 0 || perBoxVolumeM3 <= 0) {
    return { maxBoxes: null, rowBoxes: null, orientation: "" };
  }

  const { dims, orientation } = detectOrientation(l, w, h, perBoxWeightKg, perBoxVolumeM3, limits);
  const { perLayer } = getLayerMetrics(dims, limits);
  const availH = limits.maxHeightCm - limits.palletHeightCm;
  const layers = Math.floor(availH / dims[2]);
  const limVol = Math.floor(limits.maxVolumeM3 / perBoxVolumeM3);
  const limKg = Math.floor(limits.maxWeightKg / perBoxWeightKg);
  const maxBoxes = Math.min(limVol, limKg, perLayer * layers);

  return {
    maxBoxes: maxBoxes > 0 ? maxBoxes : null,
    rowBoxes: perLayer > 0 ? perLayer : null,
    orientation,
  };
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
    const { perLayer } = getLayerMetrics([d1, d2, d3], limits);
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
  let h = 0;

  for (const it of items) {
    const [, , ht] = it.dims;
    const { perLayer } = getLayerMetrics(it.dims, limits);
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

const buildQueue = (seed: PalletPart, leftovers: PalletPart[], limits: PalletLimits) => {
  const seedSize = buildSizeKey(seed.dims);
  const isSameDensity = (a: PalletPart) => closeEnough(a.density, seed.density);
  const sameSku = leftovers.filter((x) => x.itemId === seed.itemId);
  const sameSizeDensity = leftovers.filter(
    (x) => x.itemId !== seed.itemId && buildSizeKey(x.dims) === seedSize && isSameDensity(x),
  );
  const sameSizeWeight = leftovers.filter(
    (x) =>
      x.itemId !== seed.itemId &&
      buildSizeKey(x.dims) === seedSize &&
      x.weightClass === seed.weightClass &&
      !isSameDensity(x),
  );
  const sameWeight = leftovers.filter(
    (x) =>
      x.itemId !== seed.itemId &&
      x.weightClass === seed.weightClass &&
      buildSizeKey(x.dims) !== seedSize &&
      isSameDensity(x),
  );
  const other = leftovers.filter((x) => x.itemId !== seed.itemId && x.weightClass !== seed.weightClass);

  const sortByRowFill = (arr: PalletPart[]) =>
    arr.slice().sort((a, b) => {
      const aRow = getLayerMetrics(a.dims, limits).rowSize;
      const bRow = getLayerMetrics(b.dims, limits).rowSize;
      const aRem = aRow > 0 ? a.boxes % aRow : a.boxes;
      const bRem = bRow > 0 ? b.boxes % bRow : b.boxes;
      const aFull = aRow > 0 ? Math.floor(a.boxes / aRow) : 0;
      const bFull = bRow > 0 ? Math.floor(b.boxes / bRow) : 0;
      const aFullRow = aRem === 0;
      const bFullRow = bRem === 0;
      if (aFullRow !== bFullRow) return aFullRow ? -1 : 1;
      if (aRem !== bRem) return aRem - bRem;
      if (aFull !== bFull) return bFull - aFull;
      if (a.boxes !== b.boxes) return b.boxes - a.boxes;
      if (a.density !== b.density) return b.density - a.density;
      return WT_ORDER[a.weightClass] - WT_ORDER[b.weightClass];
    });

  return [
    ...sortByRowFill(sameSku),
    ...sortByRowFill(sameSizeDensity),
    ...sortByRowFill(sameSizeWeight),
    ...sortByRowFill(sameWeight),
    ...sortByRowFill(other),
  ];
};

const fillPallet = (pallet: Pallet, leftovers: PalletPart[], limits: PalletLimits) => {
  if (!pallet.seed) return;
  const queue = buildQueue(pallet.seed, leftovers, limits);
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
      density,
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
