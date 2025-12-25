import React from "react";
import { supabase } from "../api/supabaseClient";
import { fetchWbAcceptanceOptions, WbAcceptanceItem } from "../api/wbAcceptanceOptions";
import { fetchWbCategoriesByBarcodeAndNmId } from "../api/wbCategories";
import { syncWbSkus } from "../api/wbSyncSkus";

type ItemRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  barcode: string | null;
  wbSku?: string | null;
  mpCategoryWb?: string | null;
};

type OptionsMap = Record<string, WbAcceptanceItem>;
type CategoryEntry = { subjectName?: string; subjectId?: number; nmId?: number };
type CategoryMap = {
  byBarcode: Record<string, CategoryEntry>;
  byNmId: Record<number, CategoryEntry>;
  byCode: Record<string, CategoryEntry>;
};

type SortKey = "code" | "name" | "category";
type SortDir = "asc" | "desc";

export function WbWarehousesView() {
  const [items, setItems] = React.useState<ItemRow[]>([]);
  const [options, setOptions] = React.useState<OptionsMap>({});
  const [categories, setCategories] = React.useState<CategoryMap>({ byBarcode: {}, byNmId: {}, byCode: {} });
  const [loading, setLoading] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  const [syncingSkus, setSyncingSkus] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [openCell, setOpenCell] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<{ total: number; received: number; errors: number } | null>(null);
  const [syncInfo, setSyncInfo] = React.useState<{
    totalCards?: number;
    matchedByCode?: number;
    matchedByBarcode?: number;
    suppliesTotal?: number;
    suppliesMatched?: number;
    updated?: number;
  } | null>(null);
  const [sortState, setSortState] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "category",
    dir: "asc",
  });

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest(".wbwh-popup")) return;
      if (target && target.closest(".wbwh-cell")) return;
      setOpenCell(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const loadItems = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase
        .from("items")
        .select("id, code, name, category, barcode, wb_sku, mp_category_wb")
        .eq("kind", "product")
        .order("name", { ascending: true });
      if (loadError) throw loadError;
      const rows = (data ?? []).map((row) => ({
        ...row,
        wbSku: (row as any).wb_sku ?? null,
        mpCategoryWb: (row as any).mp_category_wb ?? null,
      })) as ItemRow[];
      setItems(rows);
      return rows;
    } catch (err: any) {
      console.error("load wb items", err);
      setError(err?.message ?? "Не удалось загрузить товары");
      return [] as ItemRow[];
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadItems();
  }, [loadItems]);

  const loadAcceptance = React.useCallback(async (rows?: ItemRow[]) => {
    const source = Array.isArray(rows) ? rows : Array.isArray(items) ? items : [];
    setFetching(true);
    setError(null);
    try {
      const payload = source
        .filter((row) => row.barcode)
        .map((row) => ({ barcode: row.barcode!, quantity: 1 }));
      const res = await fetchWbAcceptanceOptions(payload);
      const mapped: OptionsMap = {};
      for (const row of res.items) {
        mapped[row.barcode] = row;
      }
      setOptions(mapped);
      const errors = res.items.filter((row) => row.isError).length;
      setSummary({ total: payload.length, received: res.items.length, errors });

      const barcodes = payload.map((row) => row.barcode);
      const nmIds = source
        .map((row) => Number(row.wbSku))
        .filter((id) => Number.isFinite(id) && id > 0);
      const vendorCodes = source.map((row) => row.code).filter(Boolean);
      const categoryRes = await fetchWbCategoriesByBarcodeAndNmId(barcodes, nmIds, vendorCodes);
      const catMap: CategoryMap = { byBarcode: {}, byNmId: {}, byCode: {} };
      for (const row of categoryRes.items) {
        if (row.barcode) catMap.byBarcode[row.barcode] = row;
        if (row.nmId) catMap.byNmId[row.nmId] = row;
        if (row.vendorCode) catMap.byCode[row.vendorCode] = row;
      }
      setCategories(catMap);
    } catch (err: any) {
      console.error("load wb acceptance", err);
      setError(err?.message ?? "Не удалось получить доступные склады WB");
    } finally {
      setFetching(false);
    }
  }, [items]);

  const handleSyncSkus = React.useCallback(async () => {
    setSyncingSkus(true);
    setError(null);
    try {
      const res = await syncWbSkus(true);
      setSyncInfo(res ?? null);
      const rows = await loadItems();
      if (rows.length) await loadAcceptance(rows);
    } catch (err: any) {
      console.error("sync wb skus", err);
      setError(err?.message ?? "Не удалось обновить SKU WB");
    } finally {
      setSyncingSkus(false);
    }
  }, [loadItems, loadAcceptance]);

  const toggleCell = (key: string) => {
    setOpenCell((prev) => (prev === key ? null : key));
  };

  const renderList = (barcode: string, mode: "box" | "mono") => {
    const row = options[barcode];
    if (!row) return <span className="wbwh-hint">Нет данных</span>;
    if (row.isError) return <span className="wbwh-hint">Ошибка</span>;
    const list = row.warehouses
      .filter((w) => (mode === "box" ? w.canBox : w.canMonopallet))
      .sort((a, b) => {
        const aIsSc = /сц/i.test(a.name);
        const bIsSc = /сц/i.test(b.name);
        if (aIsSc !== bIsSc) return aIsSc ? 1 : -1;
        return a.name.localeCompare(b.name, "ru");
      });
    if (!list.length) return <span className="wbwh-hint">Нет</span>;
    return (
      <span className="wbwh-count">{list.length}</span>
    );
  };

  const renderPopup = (barcode: string, mode: "box" | "mono") => {
    const row = options[barcode];
    if (!row) return null;
    if (row.isError) return <div className="wbwh-popup">Ошибка: {row.error || "Нет данных"}</div>;
    const list = row.warehouses
      .filter((w) => (mode === "box" ? w.canBox : w.canMonopallet))
      .sort((a, b) => {
        const aIsSc = /сц/i.test(a.name);
        const bIsSc = /сц/i.test(b.name);
        if (aIsSc !== bIsSc) return aIsSc ? 1 : -1;
        return a.name.localeCompare(b.name, "ru");
      });
    if (!list.length) return <div className="wbwh-popup">Нет доступных складов</div>;
    return (
      <div className="wbwh-popup">
        {list.map((w) => (
          <div key={`${w.warehouseId}-${mode}`} className="wbwh-popup__row">
            {w.name || w.warehouseId}
          </div>
        ))}
      </div>
    );
  };

  const getRowCategory = React.useCallback(
    (row: ItemRow) => {
      const barcode = row.barcode ?? "";
      const wbSkuNum = row.wbSku ? Number(row.wbSku) : NaN;
      return (
        (barcode && categories.byBarcode[barcode]?.subjectName) ||
        (row.code ? categories.byCode[row.code]?.subjectName : undefined) ||
        (Number.isFinite(wbSkuNum) ? categories.byNmId[wbSkuNum]?.subjectName : undefined) ||
        row.mpCategoryWb ||
        ""
      );
    },
    [categories],
  );

  const sortedRows = React.useMemo(() => {
    const rows = [...items];
    rows.sort((a, b) => {
      const dir = sortState.dir === "asc" ? 1 : -1;
      if (sortState.key === "code") {
        return dir * String(a.code || "").localeCompare(String(b.code || ""), "ru");
      }
      if (sortState.key === "name") {
        return dir * String(a.name || "").localeCompare(String(b.name || ""), "ru");
      }
      const aCat = getRowCategory(a);
      const bCat = getRowCategory(b);
      return dir * String(aCat).localeCompare(String(bCat), "ru");
    });
    return rows;
  }, [items, sortState, getRowCategory]);

  const handleSort = (key: SortKey) => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: SortKey) => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  return (
    <div className="marketplaces wbwh">
      <header className="page-header">
        <div>
          <h1>Склады WB</h1>
          <p className="subtitle">Доступные склады и типы упаковки по каждому баркоду.</p>
        </div>
        <div className="actions">
          <button className="app-pill app-pill--md" onClick={() => loadAcceptance()} disabled={fetching || loading}>
            {fetching ? "Проверка WB…" : "Проверить WB"}
          </button>
          <button className="app-pill app-pill--md" onClick={handleSyncSkus} disabled={syncingSkus || loading}>
            {syncingSkus ? "Синхр. SKU WB…" : "Синхр. SKU WB"}
          </button>
        </div>
      </header>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}
      {summary && (
        <div className="text-xs text-slate-500 mb-2">
          Получено: {summary.received} из {summary.total}, ошибок: {summary.errors}
        </div>
      )}
      {syncInfo && (
        <div className="text-xs text-slate-500 mb-2">
          WB карточек: {syncInfo.totalCards ?? 0}, найдено по коду: {syncInfo.matchedByCode ?? 0}, по штрихкоду:{" "}
          {syncInfo.matchedByBarcode ?? 0}, поставок: {syncInfo.suppliesTotal ?? 0}, найдено в поставках:{" "}
          {syncInfo.suppliesMatched ?? 0}, обновлено SKU: {syncInfo.updated ?? 0}
        </div>
      )}

      <div className="mp-matrix-wrapper">
        <table className="mp-matrix wbwh-table">
          <thead>
            <tr>
              <th className="sticky-col wbwh-sortable" onClick={() => handleSort("code")}>
                Артикул{sortArrows("code")}
              </th>
              <th className="sticky-col">Баркод</th>
              <th className="wbwh-sortable" onClick={() => handleSort("name")}>
                Наименование{sortArrows("name")}
              </th>
              <th className="wbwh-sortable" onClick={() => handleSort("category")}>
                Категория WB{sortArrows("category")}
              </th>
              <th className="wbwh-col-head">Короб</th>
              <th className="wbwh-col-head">Монопаллет</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const barcode = row.barcode ?? "";
              const category = getRowCategory(row) || "—";
              const boxKey = `${barcode}:box`;
              const monoKey = `${barcode}:mono`;
              return (
                <tr key={row.id}>
                  <td className="mp-matrix__bucket">{row.code || "—"}</td>
                  <td className="mp-matrix__code">{barcode || "—"}</td>
                  <td>{row.name || "—"}</td>
                  <td>{barcode || row.wbSku ? category : "—"}</td>
                  <td className="wbwh-cell" onClick={() => barcode && toggleCell(boxKey)}>
                    {barcode ? renderList(barcode, "box") : <span className="wbwh-hint">Нет</span>}
                    {openCell === boxKey && barcode ? renderPopup(barcode, "box") : null}
                  </td>
                  <td className="wbwh-cell" onClick={() => barcode && toggleCell(monoKey)}>
                    {barcode ? renderList(barcode, "mono") : <span className="wbwh-hint">Нет</span>}
                    {openCell === monoKey && barcode ? renderPopup(barcode, "mono") : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
