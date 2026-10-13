"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PRICING_FIELDS, createRateDraft, filterPricingModels, formatRate, getPricingSource, isOpenRouterProvider, isPricingWriteVerified, normalizePricingCatalog, preparePricingSave,
} from "@/shared/utils/pricingEditor";

const ENDPOINT = "/api/pricing/editor";
const LABELS = { input: "Input", output: "Output", cached: "Cached input", reasoning: "Reasoning", cache_creation: "Cache creation" };
const ACTION = "min-h-11 rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed";
const CONTROL = "min-h-11 w-full min-w-0 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-base text-text-main focus-visible:outline-2 focus-visible:outline-primary";

async function readCatalog() {
  const response = await fetch(ENDPOINT, { cache: "no-store" });
  const data = await response.json().catch(() => { throw new Error("The pricing catalog is unavailable. Please retry."); });
  if (!response.ok) throw new Error(data.error || "Could not load pricing. Please retry.");
  return normalizePricingCatalog(data);
}

function SourceBadge({ row }) {
  const source = getPricingSource(row);
  const color = source === "manual" ? "bg-primary/10 text-primary" : source === "imported" ? "bg-blue-500/10 text-blue-700 dark:text-blue-400" : source === "default" ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${color}`}>{source}</span>;
}

export default function PricingPage() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [limit, setLimit] = useState(30);
  const [selected, setSelected] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setModels(await readCatalog()); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    readCatalog().then((rows) => { if (!cancelled) setModels(rows); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const providers = useMemo(() => [...new Map(models.map((row) => [row.provider, row.providerName || row.provider])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [models]);
  const filtered = useMemo(() => filterPricingModels(models, query, provider), [models, query, provider]);
  const manualCount = models.filter((row) => getPricingSource(row) === "manual").length;
  const importTarget = provider !== "all" && models.find((row) => row.provider === provider && isOpenRouterProvider(row));

  const importPrices = async () => {
    if (!importTarget || importing) return;
    setImporting(true);
    setImportError("");
    setNotice("");
    try {
      const response = await fetch("/api/pricing/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: importTarget.provider }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not import OpenRouter prices.");
      // Refresh persisted prices before reporting a completed import.
      setModels(await readCatalog());
      const summary = data.summary || data;
      const counts = Object.entries(summary).filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}: ${value}`).join(" · ");
      setNotice(`Imported OpenRouter prices for ${importTarget.providerName || importTarget.provider}${counts ? ` — ${counts}` : ""}. Manual overrides were kept.`);
    } catch (err) { setImportError(err.message); }
    finally { setImporting(false); }
  };

  return (
    <section className="min-w-0 space-y-6 text-text-main" aria-labelledby="pricing-heading">
      <header className="space-y-2">
        <h1 id="pricing-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">Pricing</h1>
        <p className="max-w-2xl text-sm text-text-muted">Manage cost-tracking rates by provider and model. All five rates are in USD per 1 million tokens.</p>
      </header>
      <div className="rounded-xl border border-border-subtle bg-surface p-4 text-sm space-y-2">
        <p><strong>Manual rates take priority.</strong> Imported prices, then defaults, fill fields without an override. Unknown means no rate is available, not $0.</p>
        <p className="text-text-muted">Select an OpenRouter provider to fetch direct provider prices from its official catalog. No AI or automatic updates. These rates are for gateway cost estimates, not your provider&apos;s invoice.</p>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-4" aria-label="Pricing summary">
        {[["Models", models.length], ["Providers", providers.length], ["Manual", manualCount]].map(([label, count]) => (
          <div key={label} className="min-w-0 rounded-xl border border-border-subtle bg-surface p-3 sm:p-4">
            <p className="text-xs text-text-muted">{label}</p><p className="mt-1 text-xl font-semibold">{loading ? "…" : count}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
        <div><label htmlFor="pricing-search" className="mb-1.5 block text-sm font-medium">Search provider or model</label>
          <input id="pricing-search" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(30); }} className={CONTROL} placeholder="Provider name, model name or ID" />
        </div>
        <div><label htmlFor="pricing-provider" className="mb-1.5 block text-sm font-medium">Provider</label>
          <select id="pricing-provider" value={provider} disabled={importing} onChange={(event) => { setProvider(event.target.value); setLimit(30); setImportError(""); }} className={CONTROL}>
            <option value="all">All providers</option>
            {providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
      </div>
      {importTarget && <div className="space-y-2">
        <button type="button" className={ACTION} disabled={importing || loading || !!error} onClick={importPrices}>{importing ? "Importing OpenRouter prices…" : "Import OpenRouter prices"}</button>
        <p className="text-xs text-text-muted break-words">Target: {importTarget.providerName || importTarget.provider} ({importTarget.provider}). OpenRouter only; manual overrides are not overwritten.</p>
      </div>}
      {importError && <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-600 dark:text-red-400">{importError}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error ? <div role="alert" className="rounded-xl border border-red-500/30 p-4 space-y-3"><p className="text-sm">{error}</p><button className={ACTION} onClick={load}>Retry loading pricing</button></div> : loading ? <p role="status" className="py-8 text-center text-text-muted">Loading pricing catalog…</p> : <>
        <p role="status" className="text-sm text-text-muted">{filtered.length} matching models · custom models included</p>
        {filtered.length === 0 ? <div className="rounded-xl border border-dashed border-border-subtle p-6 text-center text-sm text-text-muted">No models match your search. Try another provider or model.</div> : <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {filtered.slice(0, limit).map((row) => <article key={JSON.stringify([row.provider, row.model])} className="min-w-0 rounded-xl border border-border-subtle bg-surface p-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-muted break-all">{row.providerName || row.provider}</p>
                <h2 className="mt-1 text-base font-semibold break-all">{row.modelName || row.model}</h2>
                {row.modelName && row.modelName !== row.model && <p className="text-xs text-text-muted break-all">{row.model}</p>}
              </div>
              <SourceBadge row={row} />
            </div>
            {row.custom && <p className="text-xs text-text-muted">Custom model</p>}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
              {PRICING_FIELDS.map((field) => <div key={field} className="min-w-0"><dt className="text-xs text-text-muted">{LABELS[field]}</dt><dd className="mt-1 break-all text-sm font-medium tabular-nums">{formatRate(row.pricing?.[field])}</dd></div>)}
            </dl>
            <button type="button" disabled={importing} className={`${ACTION} w-full text-primary`} aria-label={`Edit pricing for ${row.providerName || row.provider} / ${row.model}`} onClick={() => { setNotice(""); setSelected(row); }}>Edit rates</button>
          </article>)}
        </div>}
        {filtered.length > limit && <button className={`${ACTION} w-full`} onClick={() => setLimit((value) => value + 30)}>Show more models ({filtered.length - limit} remaining)</button>}
      </>}
      {selected && <RateEditor row={selected} onClose={() => setSelected(null)} onUpdated={(rows, message) => { setModels(rows); setNotice(message); setSelected(null); }} />}
    </section>
  );
}

function RateEditor({ row, onClose, onUpdated }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(() => createRateDraft(row.manual));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const parsed = preparePricingSave(row.provider, row.model, draft, row.manual);
  const dirty = JSON.stringify(draft) !== JSON.stringify(createRateDraft(row.manual));
  const hasManual = getPricingSource(row) === "manual";

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); };
  }, []);

  const close = () => {
    if (!busy && (!dirty || window.confirm("Discard unsaved pricing changes?"))) onClose();
  };

  const persist = async (reset = false) => {
    if (busy || (!reset && Object.keys(parsed.errors).length)) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ provider: row.provider, model: row.model });
      const response = await fetch(reset ? `/api/pricing?${params}` : "/api/pricing", reset ? { method: "DELETE" } : {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update pricing.");
      // Read the exact model back; a successful HTTP write alone is not confirmation.
      const rows = await readCatalog();
      if (!isPricingWriteVerified(rows, row.provider, row.model, parsed.rates, reset)) {
        throw new Error("Update was sent, but the saved rates did not match. Reload the catalog before retrying.");
      }
      onUpdated(rows, reset ? `Reset ${row.model} to imported prices or defaults.` : `Saved manual rates for ${row.model}.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} aria-labelledby="rate-editor-title" aria-describedby="rate-editor-description" onCancel={(event) => { event.preventDefault(); close(); }} className="fixed inset-0 m-auto w-[calc(100%-24px)] max-w-lg max-h-[calc(100dvh-24px)] overflow-y-auto rounded-2xl border border-border-subtle bg-surface p-0 text-text-main shadow-xl backdrop:bg-black/50">
    <form onSubmit={(event) => { event.preventDefault(); persist(); }} className="min-w-0">
      <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border-subtle bg-surface p-4">
        <div className="min-w-0"><h2 id="rate-editor-title" className="font-semibold">Edit model rates</h2><p className="mt-1 break-all text-xs text-text-muted">{row.providerName || row.provider} / {row.model}</p></div>
        <button type="button" onClick={close} disabled={busy} aria-label="Close pricing editor" className={`${ACTION} px-3`}>✕</button>
      </header>
      <div className="space-y-4 p-4">
        <p id="rate-editor-description" className="text-sm text-text-muted">USD per 1M tokens. Enter a manual override, including 0 for free. Leave blank to use imported prices or defaults, or Unknown if neither exists.</p>
        {PRICING_FIELDS.map((field) => <div key={field}>
          <label htmlFor={`rate-${field}`} className="mb-1.5 block text-sm font-medium">{LABELS[field]} <span className="font-normal text-text-muted">(USD / 1M)</span></label>
          <input id={`rate-${field}`} type="text" inputMode="decimal" autoComplete="off" value={draft[field]} placeholder="No manual override" disabled={busy} onChange={(event) => { setDraft((prev) => ({ ...prev, [field]: event.target.value })); setConfirmReset(false); }} aria-invalid={!!parsed.errors[field]} aria-describedby={`rate-help-${field}`} className={CONTROL} />
          <p id={`rate-help-${field}`} className={`mt-1 text-xs ${parsed.errors[field] ? "text-red-600 dark:text-red-400" : "text-text-muted"}`}>{parsed.errors[field] || `Imported/default: ${formatRate(row.importedPricing?.[field] ?? row.defaults?.[field])} · Current: ${formatRate(row.pricing?.[field])}`}</p>
        </div>)}
        {error && <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {confirmReset && <div role="alert" className="rounded-lg border border-amber-500/40 p-3 space-y-3">
          <p className="text-sm break-words">Remove all manual rates for <strong>{row.model}</strong>? Imported prices or defaults will apply; missing rates stay Unknown. Unsaved changes will be discarded. Other models are not affected.</p>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => persist(true)} disabled={busy} className={`${ACTION} text-red-600 dark:text-red-400`}>Confirm reset model</button><button type="button" onClick={() => setConfirmReset(false)} disabled={busy} className={ACTION}>Keep rates</button></div>
        </div>}
      </div>
      <footer className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-border-subtle bg-surface p-4">
        <button type="button" className={`${ACTION} col-span-2 text-red-600 dark:text-red-400`} disabled={busy || !hasManual} onClick={() => setConfirmReset(true)}>Reset this model to defaults</button>
        <button type="button" className={ACTION} disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className={`${ACTION} border-primary bg-primary text-white hover:bg-primary/90`} disabled={busy || !dirty || !!Object.keys(parsed.errors).length || confirmReset}>{busy ? "Updating…" : "Save rates"}</button>
      </footer>
    </form>
  </dialog>;
}
