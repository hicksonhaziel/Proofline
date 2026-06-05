import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { motion } from "framer-motion";
import {
  formatDate,
  formatDateTime,
  loadCommerceSales,
  loadLedger,
  loadLatestProof,
  loadProof,
  loadProofs,
  loadSchedulerHealth,
  parseReceipt,
  proofCardPath,
  publicProofJsonPath,
  shortId,
  statusTone,
  subscribeToLiveChanges,
  summarizePayments,
} from "./lib/proofs";
import type { CommerceSale, LedgerEntry, LiveChangeEvent, PaymentReceipt, ProofPacket } from "./lib/types";
import type { SchedulerHealth } from "./lib/types";

type Route = "live" | "ledger" | "proof" | "payments" | "ace" | "health" | "commerce";
type Filter = "all" | "delivered" | "warning" | "failed" | "reaudit-needed" | "payment-skipped" | "high-risk";

interface TimelineEvent {
  icon: string;
  label: string;
  detail?: string;
  status?: string;
  timestamp?: string;
  href?: string;
}

interface AppState {
  ledger: LedgerEntry[];
  latest: ProofPacket | null;
  selectedProof: ProofPacket | null;
  proofs: ProofPacket[];
  schedulerHealth: SchedulerHealth | null;
  commerceSales: CommerceSale[];
  loading: boolean;
  error: string | null;
}

interface LiveSignal {
  status: "connecting" | "live" | "polling" | "idle";
  transport: "supabase_realtime" | "polling";
  lastEventAt?: string;
  lastEventLabel: string;
}

const initialState: AppState = {
  ledger: [],
  latest: null,
  selectedProof: null,
  proofs: [],
  schedulerHealth: null,
  commerceSales: [],
  loading: true,
  error: null,
};

export function App(): ReactElement {
  const [state, setState] = useState<AppState>(initialState);
  const [path, setPath] = useState(window.location.pathname);
  const [filter, setFilter] = useState<Filter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [liveSignal, setLiveSignal] = useState<LiveSignal>({
    status: "connecting",
    transport: "polling",
    lastEventLabel: "Connecting to live audit feed",
  });
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const route = useMemo(() => getRoute(path), [path]);

  const refreshDashboard = useCallback(
    async ({ showLoading = true }: { showLoading?: boolean } = {}): Promise<void> => {
      try {
        if (showLoading) setState((current) => ({ ...current, loading: true, error: null }));
        const ledger = await loadLedger();
        const latest = await loadLatestProof();
        const selectedId = route.proofId ?? latest.proofPacketId;
        const selectedProof = selectedId === latest.proofPacketId ? latest : await loadProof(selectedId);
        const [proofs, schedulerHealth, commerceSales] = await Promise.all([loadProofs(ledger), loadSchedulerHealth(), loadCommerceSales()]);
        setState({ ledger, latest, selectedProof, proofs, schedulerHealth, commerceSales, loading: false, error: null });
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load dashboard data",
        }));
      }
    },
    [route.proofId],
  );

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      await refreshDashboard();
      if (cancelled) return;
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshDashboard]);

  useEffect(() => {
    if (route.name !== "live") return undefined;

    let disposed = false;
    const scheduleRefresh = (event: LiveChangeEvent | null, transport: LiveSignal["transport"]): void => {
      if (disposed) return;
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      const receivedAt = event?.receivedAt ?? new Date().toISOString();
      setLiveSignal({
        status: event ? "live" : "polling",
        transport,
        lastEventAt: receivedAt,
        lastEventLabel: event ? liveEventLabel(event) : "Polling for latest Proofline activity",
      });
      refreshTimerRef.current = window.setTimeout(() => {
        void refreshDashboard({ showLoading: false });
      }, 350);
    };

    setLiveSignal((current) => ({
      ...current,
      status: "connecting",
      lastEventLabel: "Watching Supabase for new audit events",
    }));

    const unsubscribe = subscribeToLiveChanges((event) => scheduleRefresh(event, "supabase_realtime"));
    if (!unsubscribe) {
      setLiveSignal({
        status: "polling",
        transport: "polling",
        lastEventAt: new Date().toISOString(),
        lastEventLabel: "Realtime unavailable; polling for latest activity",
      });
    }

    const pollingInterval = window.setInterval(() => {
      scheduleRefresh(null, unsubscribe ? "supabase_realtime" : "polling");
    }, 15000);

    return () => {
      disposed = true;
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
      window.clearInterval(pollingInterval);
      unsubscribe?.();
    };
  }, [route.name, refreshDashboard]);

  const selectedLedgerEntry = state.ledger.find((entry) => entry.proofPacketId === state.selectedProof?.proofPacketId);
  const navigate = (href: string): void => {
    window.history.pushState({}, "", href);
    setPath(href);
  };

  return (
    <div className="min-h-screen bg-surface text-on-surface antialiased font-body-md">
      <Header route={route.name} navigate={navigate} />
      <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 px-container-padding py-8">
        {state.error ? <ErrorPanel message={state.error} /> : null}
        {state.loading && !state.latest ? <LoadingPanel /> : null}
        {!state.loading && state.latest ? (
          <>
            {route.name === "live" ? (
              <LiveView ledger={state.ledger} latest={state.latest} schedulerHealth={state.schedulerHealth} liveSignal={liveSignal} navigate={navigate} />
            ) : route.name === "ledger" ? (
              <LedgerView
                ledger={state.ledger}
                filter={filter}
                setFilter={setFilter}
                categoryFilter={categoryFilter}
                setCategoryFilter={setCategoryFilter}
                navigate={navigate}
              />
            ) : route.name === "payments" ? (
              <PaymentsView ledger={state.ledger} proofs={state.proofs} navigate={navigate} />
            ) : route.name === "ace" ? (
              <AceUsageView ledger={state.ledger} proofs={state.proofs} navigate={navigate} />
            ) : route.name === "health" ? (
              <HealthView ledger={state.ledger} proofs={state.proofs} latest={state.latest} schedulerHealth={state.schedulerHealth} />
            ) : route.name === "commerce" ? (
              <CommerceView sales={state.commerceSales} navigate={navigate} />
            ) : state.selectedProof ? (
              <ProofDetailView proof={state.selectedProof} ledgerEntry={selectedLedgerEntry} navigate={navigate} />
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function getRoute(pathname: string): { name: Route; proofId?: string } {
  if (pathname === "/" || pathname === "/live" || pathname === "/live/") return { name: "live" };
  if (pathname === "/payments" || pathname === "/payments/") return { name: "payments" };
  if (pathname === "/ace" || pathname === "/ace/") return { name: "ace" };
  if (pathname === "/health" || pathname === "/health/") return { name: "health" };
  if (pathname === "/commerce" || pathname === "/commerce/") return { name: "commerce" };
  if (pathname === "/proofs" || pathname === "/proofs/") return { name: "ledger" };
  const proofMatch = pathname.match(/^\/proofs\/(proof_[a-zA-Z0-9_-]+)\/?$/);
  if (proofMatch?.[1]) return { name: "proof", proofId: proofMatch[1] };
  return { name: "live" };
}

function Header({ route, navigate }: { route: Route; navigate: (href: string) => void }): ReactElement {
  const links: Array<{ href: string; label: string; route: Route }> = [
    { href: "/live", label: "Live", route: "live" },
    { href: "/proofs", label: "Proofs", route: "ledger" },
    { href: "/payments", label: "Payments", route: "payments" },
    { href: "/ace", label: "Ace Usage", route: "ace" },
    { href: "/health", label: "Health", route: "health" },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-outline-variant bg-surface/95 px-container-padding backdrop-blur">
      <div className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-8">
          <button className="flex min-w-0 items-center gap-3" onClick={() => navigate("/live")} type="button">
            <img className="h-9 w-9 shrink-0 rounded-lg border border-outline-variant object-cover" src="/proofline.png" alt="Proofline" />
            <span className="truncate font-headline-md text-headline-md font-bold text-primary">Proofline</span>
          </button>
          <nav className="hidden h-full items-end gap-6 lg:flex">
            {links.map((link) => (
              <button
                key={link.href}
                className={`pb-[6px] font-body-md text-body-md transition-colors hover:text-primary ${
                  route === link.route || (route === "proof" && link.route === "ledger")
                    ? "border-b-2 border-primary text-primary"
                    : "text-on-surface-variant"
                }`}
                onClick={() => navigate(link.href)}
                type="button"
              >
                {link.label}
              </button>
            ))}
            <a className="pb-[6px] font-body-md text-body-md text-on-surface-variant transition-colors hover:text-primary" href="/agent.json">
              SAP Agent
            </a>
          </nav>
        </div>
        <div className="hidden items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-mono-label text-mono-label text-on-surface-variant md:flex">
          <span className="material-symbols-outlined text-[16px] text-primary">radio_button_checked</span>
          Proofline Live
        </div>
      </div>
      <div className="-mx-container-padding border-t border-outline-variant/70 lg:hidden">
        <nav className="flex gap-2 overflow-x-auto px-container-padding py-2" aria-label="Primary navigation">
          {links.map((link) => {
            const active = route === link.route || (route === "proof" && link.route === "ledger");
            return (
              <button
                key={link.href}
                className={`whitespace-nowrap rounded-lg border px-3 py-2 font-body-sm text-body-sm transition-colors ${
                  active
                    ? "border-primary bg-primary-container text-on-primary-container"
                    : "border-outline-variant bg-surface-container-low text-on-surface-variant"
                }`}
                onClick={() => navigate(link.href)}
                type="button"
              >
                {link.label}
              </button>
            );
          })}
          <a className="whitespace-nowrap rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface-variant" href="/agent.json">
            SAP Agent
          </a>
        </nav>
      </div>
    </header>
  );
}

function LiveView({
  ledger,
  latest,
  schedulerHealth,
  liveSignal,
  navigate,
}: {
  ledger: LedgerEntry[];
  latest: ProofPacket;
  schedulerHealth: SchedulerHealth | null;
  liveSignal: LiveSignal;
  navigate: (href: string) => void;
}): ReactElement {
  const latestEntry = ledger.find((entry) => entry.proofPacketId === latest.proofPacketId);
  const payments = summarizePayments(latest.payments);
  const timeline = buildTimeline(latest);
  const activeDecision = schedulerHealth?.decisions?.find((decision) => decision.status === "selected") ?? schedulerHealth?.decisions?.[0];

  return (
    <>
      <section className="flex flex-col gap-2">
        <h1 className="font-display-lg text-display-lg text-on-surface">Proofline Live</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Active paid execution evidence for SAP agents and Ace Data Cloud usage.</p>
      </section>

      <LiveStatusStrip signal={liveSignal} schedulerHealth={schedulerHealth} latest={latest} activeDecision={activeDecision} />

      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="account_tree" label="Total Proofs" value={String(ledger.length)} />
        <StatCard icon="shield" label="Latest Score" value={`${latest.scores?.overall ?? latestEntry?.overallScore ?? 0}/100`} />
        <StatCard icon="payments" label="Ace Settled" value={`$${payments.aceTotal.toFixed(6)}`} tone={payments.aceTotal > 0 ? "settled" : undefined} />
        <StatCard icon="search_activity" label="Latest Verdict" value={latest.scores?.verdict ?? latestEntry?.verdict ?? "unknown"} tone={latest.scores?.verdict} />
      </section>

      <section className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
        <div className="panel p-stack-md lg:col-span-7">
          <div className="mb-stack-md flex items-center justify-between border-b border-outline-variant pb-stack-sm">
            <h2 className="font-headline-sm text-headline-sm">Live Audit Feed</h2>
            <button className="icon-link flex items-center gap-1 font-mono-label text-mono-label" onClick={() => navigate("/proofs")} type="button">
              Open Ledger <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {timeline.map((event) => (
              <TimelineItem key={event.label} {...event} />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-gutter lg:col-span-5">
          <ProofCard proof={latest} ledgerEntry={latestEntry} />
          <div className="panel p-stack-md">
            <div className="label mb-2">Current Audit Job</div>
            <div className="grid grid-cols-2 gap-stack-md">
              <Field label="Target" value={latest.targetAgent?.name ?? latestEntry?.targetName} />
              <Field label="Tool" value={latest.targetAgent?.toolName ?? latest.targetAgent?.toolId ?? latestEntry?.toolName} />
              <Field label="Payment" value={paymentIntegrityLabel(latestEntry?.paymentIntegrity ?? latestEntry?.paymentStatus)} tone={latestEntry?.paymentStatus} />
              <Field label="Sentinel" value={latest.sentinelCheck?.status ?? "unknown"} tone={latest.sentinelCheck?.status} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function LiveStatusStrip({
  signal,
  schedulerHealth,
  latest,
  activeDecision,
}: {
  signal: LiveSignal;
  schedulerHealth: SchedulerHealth | null;
  latest: ProofPacket;
  activeDecision?: NonNullable<SchedulerHealth["decisions"]>[number];
}): ReactElement {
  const running = schedulerHealth?.status === "running";
  const status = running ? "running" : signal.status === "live" ? "live" : signal.status;
  const latestTarget = activeDecision?.targetName ?? schedulerHealth?.lastAudit?.targetName ?? latest.targetAgent?.name ?? "unknown";
  const lastActivity = signal.lastEventAt ?? schedulerHealth?.updatedAt ?? latest.createdAt;
  const statusLabel =
    status === "running"
      ? "Audit running"
      : status === "live"
        ? "Live update received"
        : status === "connecting"
          ? "Connecting"
          : "Watching for activity";

  return (
    <section className="panel relative overflow-hidden p-stack-md">
      <div className="absolute inset-x-0 top-0 h-px bg-primary-container" />
      <div className="grid grid-cols-1 gap-stack-md lg:grid-cols-[1.2fr_1fr_1fr]">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${status === "running" || status === "live" ? "bg-[#55F08A]" : "bg-primary-container"}`} />
          <div className="min-w-0">
            <div className="font-headline-sm text-headline-sm text-on-surface">{statusLabel}</div>
            <div className="mt-1 truncate font-body-sm text-body-sm text-on-surface-variant">{signal.lastEventLabel}</div>
          </div>
        </div>
        <Field label="Latest Target" value={latestTarget} />
        <Field label="Last Activity" value={formatDateTime(lastActivity)} tone={status === "running" || status === "live" ? "settled" : undefined} />
      </div>
      <div className="mt-stack-md grid grid-cols-1 gap-stack-sm sm:grid-cols-3">
        <Field label="Transport" value={signal.transport === "supabase_realtime" ? "Realtime + fallback" : "Polling"} />
        <Field label="Scheduler" value={schedulerHealth?.status ?? "not published"} tone={schedulerHealth?.status} />
        <Field label="Fallback View" value={`Last proof: ${shortId(latest.proofPacketId)}`} />
      </div>
    </section>
  );
}

function LedgerView({
  ledger,
  filter,
  setFilter,
  categoryFilter,
  setCategoryFilter,
  navigate,
}: {
  ledger: LedgerEntry[];
  filter: Filter;
  setFilter: (filter: Filter) => void;
  categoryFilter: string;
  setCategoryFilter: (category: string) => void;
  navigate: (href: string) => void;
}): ReactElement {
  const categories = [...new Set(ledger.map((entry) => entry.category).filter((category): category is string => Boolean(category)))].sort();
  const filtered = ledger.filter((entry) => {
    const categoryOk = categoryFilter === "all" || entry.category === categoryFilter;
    if (!categoryOk) return false;
    if (filter === "all") return true;
    if (filter === "delivered") return entry.verdict === "delivered" || entry.verdict === "passed";
    if (filter === "warning") return entry.verdict === "warning";
    if (filter === "failed") return entry.verdict === "failed";
    if (filter === "reaudit-needed") return entry.verdict === "failed" || entry.verdict === "warning" || entry.riskLevel === "high";
    if (filter === "payment-skipped") return entry.paymentStatus?.includes("skipped");
    if (filter === "high-risk") return entry.riskLevel === "high";
    return true;
  });

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">Evidence Ledger</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Signed audit records generated by Proofline.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-3">
        <StatCard icon="file_copy" label="Total Proofs" value={String(ledger.length)} />
        <StatCard icon="shield" label="Latest Overall Score" value={`${ledger[0]?.overallScore ?? 0}/100`} />
        <StatCard icon="search_activity" label="Ace Services Used" value={`${new Set(ledger.flatMap((entry) => entry.aceServicesUsed ?? [])).size} active`} />
      </section>
      <div className="flex flex-col gap-stack-sm md:flex-row md:items-center md:justify-between">
        <FilterBar filter={filter} setFilter={setFilter} />
        <label className="flex items-center gap-2 font-mono-label text-mono-label uppercase text-on-surface-variant">
          Category
          <select
            className="rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-body-sm text-body-sm normal-case text-on-surface"
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="all">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] border-collapse text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {[
                  "Proof ID",
                  "Agent",
                  "Tool",
                  "Status",
                  "Verdict",
                  "Score",
                  "Payment",
                  "Last Audit",
                  "Risk",
                  "Category",
                  "Actions",
                ].map((heading) => (
                  <th key={heading} className="px-4 py-3 text-left font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={11}>
                    <EmptyState icon="filter_alt" title="No proofs match this filter" detail="Change the status or category filter to show more evidence records." />
                  </td>
                </tr>
              ) : null}
              {filtered.map((entry, index) => (
                <motion.tr
                  key={entry.proofPacketId}
                  className="border-b border-outline-variant transition-colors hover:bg-surface-container-high"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.035, 0.2), duration: 0.22 }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${entry.proofPacketId}`)} type="button">
                        {shortId(entry.proofPacketId)}
                      </button>
                      <CopyButton value={entry.proofPacketId} label="Copy proof ID" />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{entry.targetName}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{entry.toolName ?? "unknown"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={entry.auditStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={entry.verdict} />
                  </td>
                  <td className="px-4 py-3 text-on-surface">{entry.overallScore ?? 0}/100</td>
                  <td className="px-4 py-3">
                    <div className={`max-w-[220px] truncate ${statusClass(entry.paymentStatus)}`}>{paymentIntegrityLabel(entry.paymentIntegrity ?? entry.paymentStatus)}</div>
                  </td>
                  <td className="px-4 py-3 text-on-surface-variant">{formatDate(entry.createdAt)}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{entry.riskLevel ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{entry.category ?? "unknown"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button className="icon-link" onClick={() => navigate(`/proofs/${entry.proofPacketId}`)} title="View Proof" type="button">
                        <span className="material-symbols-outlined text-[18px]">visibility</span>
                      </button>
                      <a className="icon-link" href={entry.proofJson ?? publicProofJsonPath(entry.proofPacketId)} title="JSON">
                        <span className="material-symbols-outlined text-[18px]">data_object</span>
                      </a>
                      {entry.proofCard ? (
                        <a className="icon-link" href={entry.proofCard} title="Card">
                          <span className="material-symbols-outlined text-[18px]">branding_watermark</span>
                        </a>
                      ) : null}
                    </div>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ProofDetailView({
  proof,
  ledgerEntry,
  navigate,
}: {
  proof: ProofPacket;
  ledgerEntry?: LedgerEntry;
  navigate: (href: string) => void;
}): ReactElement {
  const payments = proof.payments ?? [];
  const summary = summarizePayments(payments);
  const signatureValue = proofSignatureValue(proof);

  return (
    <>
      <section className="flex flex-col justify-between gap-stack-sm md:flex-row md:items-end">
        <div>
          <h1 className="font-display-lg text-display-lg">Proof ID #{shortId(proof.proofPacketId, 14, 6)}</h1>
          <p className="mt-1 font-mono-data text-mono-data text-on-surface-variant">Target: {proof.targetAgent?.name ?? ledgerEntry?.targetName ?? "unknown"}</p>
        </div>
        <button className="icon-link flex items-center gap-1 font-mono-label text-mono-label" onClick={() => navigate("/proofs")} type="button">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span> Evidence Ledger
        </button>
      </section>

      <section className="flex flex-col-reverse gap-gutter md:grid md:grid-cols-12">
        <div className="flex flex-col gap-stack-md md:col-span-7 lg:col-span-8">
          <div className="panel-inner">
            <div className="mb-stack-md flex items-center justify-between border-b border-surface-variant pb-stack-sm">
              <h2 className="font-headline-sm text-headline-sm">Execution Proof Packet</h2>
              <StatusBadge status={proof.scores?.verdict ?? ledgerEntry?.verdict} />
            </div>
            <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
              <Field label="Target" value={proof.targetAgent?.name ?? ledgerEntry?.targetName} />
              <Field label="Score" value={`${proof.scores?.overall ?? ledgerEntry?.overallScore ?? 0} / 100`} tone="good" />
              <Field label="Created" value={formatDate(proof.createdAt)} />
              <Field label="Status" value={signatureValue ? "Cryptographically Signed" : "Unsigned"} />
            </div>
          </div>

          <Metrics scores={proof.scores} />
          <AuditEvidencePanel proof={proof} />

          <div className="grid grid-cols-1 gap-stack-md md:grid-cols-2">
            <div className="panel-inner">
              <h2 className="mb-stack-md border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Verification Timeline</h2>
              <div className="flex flex-col gap-3">
                {buildTimeline(proof).map((event) => (
                  <TimelineItem key={event.label} {...event} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-stack-md">
              <PaymentPanel payments={payments} compact />
              <AcePanel proof={proof} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-stack-md md:grid-cols-2">
            <SentinelPanel proof={proof} />
            <ProbePanel proof={proof} />
          </div>
          {proof.artifacts?.audioPath ? <AudioPanel audioPath={proof.artifacts.audioPath} /> : null}

          <div className="panel-inner bg-[#101215]">
            <h2 className="mb-stack-md border-b border-[#242629] pb-stack-sm font-headline-sm text-headline-sm">Cryptographic Integrity</h2>
            <div className="grid grid-cols-1 gap-stack-md md:grid-cols-3">
              <Field label="Packet Hash" value={proof.signature?.packetHash ?? ledgerEntry?.packetHash} copyValue={proof.signature?.packetHash ?? ledgerEntry?.packetHash} />
              <Field label="Signature" value={signatureValue} copyValue={signatureValue} />
              <Field label="Signing Wallet" value={proof.signature?.publicKey ?? proof.auditorAgent?.publicKey} copyValue={proof.signature?.publicKey ?? proof.auditorAgent?.publicKey} />
            </div>
          </div>
        </div>

        <div className="relative flex flex-col gap-stack-md md:col-span-5 lg:col-span-4">
          <ProofCard proof={proof} ledgerEntry={ledgerEntry} />
          <div className="grid grid-cols-2 gap-3">
            <a className="flex items-center justify-center gap-2 rounded border border-outline-variant px-4 py-3 font-mono-label text-mono-label uppercase text-on-surface transition-all hover:bg-surface-variant" href={publicProofJsonPath(proof.proofPacketId)}>
              <span className="material-symbols-outlined text-[18px]">data_object</span> View JSON
            </a>
            <button className="flex items-center justify-center gap-2 rounded border border-outline-variant px-4 py-3 font-mono-label text-mono-label uppercase text-on-surface transition-all hover:bg-surface-variant" onClick={() => navigate("/proofs")} type="button">
              <span className="material-symbols-outlined text-[18px]">account_tree</span> Ledger
            </button>
          </div>
          <div className="panel p-stack-md">
            <div className="label mb-2">Payment Summary</div>
            <div className="grid grid-cols-2 gap-stack-md">
              <Field label="Total Receipts" value={String(summary.total)} />
              <Field label="Settled" value={String(summary.settled)} tone="settled" />
              <Field label="Failed" value={String(summary.failed)} tone={summary.failed > 0 ? "failed" : "settled"} />
              <Field label="Ace Settled" value={`${summary.aceTotal.toFixed(6)} USDC`} tone="settled" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function PaymentsView({
  ledger,
  proofs,
  navigate,
}: {
  ledger: LedgerEntry[];
  proofs: ProofPacket[];
  navigate: (href: string) => void;
}): ReactElement {
  const payments = proofs.flatMap((proof) => (proof.payments ?? []).map((payment) => ({ proof, payment })));
  const summary = summarizePayments(payments.map((item) => item.payment));

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">Payment Proof</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">x402 and SAP escrow receipts captured by published proof packets.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="receipt_long" label="Receipts" value={String(summary.total)} />
        <StatCard icon="task_alt" label="Settled" value={String(summary.settled)} tone="settled" />
        <StatCard icon="error" label="Failed" value={String(summary.failed)} tone={summary.failed > 0 ? "failed" : "settled"} />
        <StatCard icon="payments" label="Ace Settled" value={summary.aceTotal.toFixed(6)} />
      </section>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {["Proof", "Provider", "Service", "Method", "Amount", "Status", "Transaction", "Receipt"].map((heading) => (
                  <th key={heading} className="px-4 py-3 font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="receipt_long" title="No payment receipts yet" detail="Run an audit cycle or Ace x402 smoke test to publish receipts into the proof ledger." />
                  </td>
                </tr>
              ) : null}
              {payments.map(({ proof, payment }, index) => (
                <motion.tr
                  key={`${proof.proofPacketId}-${payment.paymentId}`}
                  className="border-b border-outline-variant hover:bg-surface-container-high"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.035, 0.2), duration: 0.22 }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${proof.proofPacketId}`)} type="button">
                        {shortId(proof.proofPacketId)}
                      </button>
                      <CopyButton value={proof.proofPacketId} label="Copy proof ID" />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{payment.provider ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{payment.service ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{payment.method ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface">{payment.amount ?? "0"} {payment.currency ?? ""}</td>
                  <td className={`px-4 py-3 ${statusClass(payment.status)}`}>{payment.status ?? "unknown"}</td>
                  <td className="px-4 py-3">
                    <CopyValue value={transactionHash(payment)} empty="none" />
                  </td>
                  <td className="px-4 py-3">
                    <CopyValue value={receiptLabel(payment)} maxWidth="max-w-[320px]" />
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel p-stack-md">
        <h2 className="mb-stack-sm font-headline-sm text-headline-sm">Payment Checks</h2>
        <div className="grid grid-cols-1 gap-stack-sm md:grid-cols-2">
          {ledger.slice(0, 8).map((entry) => (
            <div key={entry.proofPacketId} className="rounded border border-outline-variant bg-surface p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="data truncate">{entry.targetName}</span>
                <StatusBadge status={entry.paymentStatus} />
              </div>
              <div className="mt-2 font-mono-data text-mono-data text-on-surface-variant">{paymentIntegrityLabel(entry.paymentIntegrity ?? entry.paymentStatus)}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function CommerceView({ sales, navigate }: { sales: CommerceSale[]; navigate: (href: string) => void }): ReactElement {
  const total = sales.length;
  const paid = sales.filter((sale) => sale.payment_status === "settled" || sale.payment_status === "pending").length;
  const tools = new Set(sales.map((sale) => sale.tool_id).filter(Boolean)).size;
  const latest = sales[0];

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">Agent Commerce</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Proofline seller activity from purchasable proof and verdict tools.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="point_of_sale" label="Sales Records" value={String(total)} />
        <StatCard icon="payments" label="Payment Captures" value={String(paid)} tone={paid > 0 ? "settled" : "skipped"} />
        <StatCard icon="handyman" label="Tools Sold" value={String(tools)} />
        <StatCard icon="schedule" label="Latest Sale" value={latest ? formatDateTime(latest.created_at) : "none"} />
      </section>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {["Sale", "Tool", "Buyer", "Proof", "Amount", "Payment", "Transaction", "Created"].map((heading) => (
                  <th key={heading} className="px-4 py-3 font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {sales.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="point_of_sale" title="No commerce calls yet" detail="Run the buyer demo to record a proof-query sale in Supabase." />
                  </td>
                </tr>
              ) : null}
              {sales.map((sale) => (
                <tr key={sale.sale_id} className="border-b border-outline-variant hover:bg-surface-container-high">
                  <td className="px-4 py-3 text-primary-container">{shortId(sale.sale_id)}</td>
                  <td className="px-4 py-3 text-on-surface">{sale.tool_id ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{sale.buyer_wallet ?? "unknown"}</td>
                  <td className="px-4 py-3">
                    {sale.proof_packet_id ? (
                      <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${sale.proof_packet_id}`)} type="button">
                        {shortId(sale.proof_packet_id)}
                      </button>
                    ) : (
                      <span className="text-on-surface-variant">none</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-on-surface">{sale.amount ?? "0"} {sale.currency ?? ""}</td>
                  <td className={`px-4 py-3 ${statusClass(sale.payment_status)}`}>{sale.payment_status ?? "unknown"}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-primary-container">{sale.transaction_hash ?? "none"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{formatDateTime(sale.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AceUsageView({
  ledger,
  proofs,
  navigate,
}: {
  ledger: LedgerEntry[];
  proofs: ProofPacket[];
  navigate: (href: string) => void;
}): ReactElement {
  const acePayments = proofs.flatMap((proof) =>
    (proof.payments ?? [])
      .filter((payment) => payment.provider === "ace_data_cloud")
      .map((payment) => ({ proof, payment, receipt: parseReceipt(payment.receipt) })),
  );
  const services = new Map<
    string,
    {
      count: number;
      settledTotal: number;
      quotedTotal: number;
      failedTotal: number;
      status: string;
      latestAt?: string;
    }
  >();
  for (const item of acePayments) {
    const key = item.payment.service ?? "unknown";
    const current = services.get(key) ?? { count: 0, settledTotal: 0, quotedTotal: 0, failedTotal: 0, status: "unknown" };
    const latestAt =
      current.latestAt && item.payment.createdAt && new Date(current.latestAt).getTime() > new Date(item.payment.createdAt).getTime()
        ? current.latestAt
        : item.payment.createdAt ?? current.latestAt;
    const amount = Number(item.payment.amount ?? 0);
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    const status = item.payment.status ?? current.status;
    const isSettled = status === "settled" || status === "confirmed";
    const isFailed = status === "failed";
    services.set(key, {
      count: current.count + 1,
      settledTotal: current.settledTotal + (isSettled ? safeAmount : 0),
      quotedTotal: current.quotedTotal + (!isSettled && !isFailed ? safeAmount : 0),
      failedTotal: current.failedTotal + (isFailed ? safeAmount : 0),
      status,
      latestAt,
    });
  }
  const settledTotal = [...services.values()].reduce((sum, service) => sum + service.settledTotal, 0);
  const quotedTotal = [...services.values()].reduce((sum, service) => sum + service.quotedTotal, 0);

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">Ace Usage</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Ace Data Cloud services paid through per-request x402 and used as audit evidence.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-5">
        <StatCard icon="api" label="Distinct Services" value={String(services.size)} />
        <StatCard icon="receipt_long" label="Ace Calls" value={String(acePayments.length)} />
        <StatCard icon="payments" label="Settled USDC" value={settledTotal.toFixed(6)} tone={settledTotal > 0 ? "settled" : undefined} />
        <StatCard icon="pending_actions" label="Quoted USDC" value={quotedTotal.toFixed(6)} tone={quotedTotal > 0 ? "pending" : undefined} />
        <StatCard icon="assignment_turned_in" label="Proofs With Ace" value={String(ledger.filter((entry) => (entry.aceServicesUsed?.length ?? 0) > 0).length)} />
      </section>
      <section className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
        {[...services.entries()].map(([service, stats]) => (
          <motion.div key={service} className="panel p-stack-md" whileHover={{ y: -2 }} transition={{ duration: 0.18 }}>
            <div className="mb-stack-sm flex items-center justify-between gap-3 border-b border-outline-variant pb-stack-sm">
              <h2 className="truncate font-headline-sm text-headline-sm">{service}</h2>
              <StatusBadge status={stats.status} />
            </div>
            <div className="grid grid-cols-2 gap-stack-md md:grid-cols-5">
              <Field label="Calls" value={String(stats.count)} />
              <Field label="Settled" value={`${stats.settledTotal.toFixed(6)} USDC`} tone={stats.settledTotal > 0 ? "settled" : undefined} />
              <Field label="Quoted" value={`${stats.quotedTotal.toFixed(6)} USDC`} tone={stats.quotedTotal > 0 ? "pending" : undefined} />
              <Field label="Latest" value={stats.status} tone={stats.status} />
              <Field label="Why" value={aceServicePurpose(service)} />
            </div>
          </motion.div>
        ))}
      </section>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {["Proof", "Service", "Amount", "Network", "Endpoint", "Status"].map((heading) => (
                  <th key={heading} className="px-4 py-3 font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {acePayments.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon="api" title="No Ace x402 usage recorded" detail="Run the Ace smoke test or an audit with Ace enabled to publish service receipts." />
                  </td>
                </tr>
              ) : null}
              {acePayments.map(({ proof, payment, receipt }, index) => (
                <motion.tr
                  key={`${proof.proofPacketId}-${payment.paymentId}`}
                  className="border-b border-outline-variant hover:bg-surface-container-high"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index * 0.035, 0.2), duration: 0.22 }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${proof.proofPacketId}`)} type="button">
                        {shortId(proof.proofPacketId)}
                      </button>
                      <CopyButton value={proof.proofPacketId} label="Copy proof ID" />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{payment.service}</td>
                  <td className="px-4 py-3 text-on-surface">{payment.amount} {payment.currency}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{String(receipt?.network ?? "unknown")}</td>
                  <td className="px-4 py-3">
                    <CopyValue value={typeof receipt?.endpoint === "string" ? receipt.endpoint : null} empty="unknown" maxWidth="max-w-[360px]" />
                  </td>
                  <td className={`px-4 py-3 ${statusClass(payment.status)}`}>{payment.status}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function HealthView({
  ledger,
  proofs,
  latest,
  schedulerHealth,
}: {
  ledger: LedgerEntry[];
  proofs: ProofPacket[];
  latest: ProofPacket;
  schedulerHealth: SchedulerHealth | null;
}): ReactElement {
  const lastAudit = ledger[0]?.createdAt;
  const failed = ledger.filter((entry) => entry.verdict === "failed").length;
  const queueSignal = schedulerHealth?.status ?? (proofs.some((proof) => proof.auditStatus === "running") ? "running" : "idle");
  const latestPayments = summarizePayments(latest.payments);
  const activeJobs = schedulerHealth?.queue?.eligible ?? proofs.filter((proof) => proof.auditStatus === "running").length;
  const schedulerStatus = schedulerHealth?.status ?? "not published";
  const lastSchedulerRun = schedulerHealth?.updatedAt ?? lastAudit;
  const decisions = schedulerHealth?.decisions ?? [];

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">System Health</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Runtime state derived from published Proofline artifacts. No fake balances or credits are shown.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="monitor_heart" label="Scheduler Status" value={schedulerStatus} tone={schedulerStatus} />
        <StatCard icon="schedule" label="Last Scheduler Run" value={formatDateTime(lastSchedulerRun)} />
        <StatCard icon="queue" label="Queue Length" value={String(activeJobs)} tone={queueSignal} />
        <StatCard icon="error" label="Failed Proofs" value={String(failed)} tone={failed > 0 ? "failed" : "settled"} />
      </section>
      <section className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
        <div className="panel p-stack-md">
          <h2 className="mb-stack-md border-b border-outline-variant pb-stack-sm font-headline-sm text-headline-sm">Latest Run</h2>
          <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
            <Field label="Proof ID" value={latest.proofPacketId} copyValue={latest.proofPacketId} />
            <Field label="Audit Job" value={latest.auditJob?.auditJobId} copyValue={latest.auditJob?.auditJobId} />
            <Field label="Sentinel" value={latest.sentinelCheck?.status} tone={latest.sentinelCheck?.status} />
            <Field label="Ace Settled" value={`${latestPayments.aceTotal.toFixed(6)} USDC`} tone="settled" />
            <Field label="Payment Mode" value={schedulerHealth?.paymentMode ?? "not published"} />
            <Field label="Scheduler Mode" value={schedulerHealth?.mode ?? "not published"} />
          </div>
        </div>
        <div className="panel p-stack-md">
          <h2 className="mb-stack-md border-b border-outline-variant pb-stack-sm font-headline-sm text-headline-sm">Automation Controls</h2>
          <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
            <Field label="Per Audit Cap" value={`${schedulerHealth?.budgets?.maxSpendPerAuditUsdc ?? "not published"} USDC`} />
            <Field label="Hourly Spend" value={`${(schedulerHealth?.budgets?.spentLastHourUsdc ?? 0).toFixed(6)} USDC`} />
            <Field label="Daily Spend" value={`${(schedulerHealth?.budgets?.spentLastDayUsdc ?? 0).toFixed(6)} USDC`} />
            <Field label="Allow Paid" value={schedulerHealth?.allowPaid === undefined ? "not published" : schedulerHealth.allowPaid ? "yes" : "no"} />
            <Field label="Failed Retry Cap" value={schedulerHealth?.retryPolicy?.maxFailedPaymentRetries === undefined ? "not published" : String(schedulerHealth.retryPolicy.maxFailedPaymentRetries)} />
            <Field label="Retry Window" value={schedulerHealth?.retryPolicy?.failedPaymentRetryWindowHours === undefined ? "not published" : `${schedulerHealth.retryPolicy.failedPaymentRetryWindowHours}h`} />
          </div>
        </div>
      </section>
      <section className="panel p-stack-md">
        <h2 className="mb-stack-md border-b border-outline-variant pb-stack-sm font-headline-sm text-headline-sm">Scheduler Decisions</h2>
        {decisions.length === 0 ? (
          <div className="data text-on-surface-variant">No scheduler decisions published.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left font-body-md text-body-md">
              <thead>
                <tr className="border-b border-outline-variant text-on-surface-variant">
                  <th className="px-4 py-3 font-mono-label text-mono-label uppercase">Target</th>
                  <th className="px-4 py-3 font-mono-label text-mono-label uppercase">Status</th>
                  <th className="px-4 py-3 font-mono-label text-mono-label uppercase">Reason</th>
                  <th className="px-4 py-3 font-mono-label text-mono-label uppercase">Job</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision, index) => (
                  <motion.tr
                    key={`${decision.auditJobId ?? decision.targetAgentId ?? "decision"}-${index}`}
                    className="border-b border-outline-variant"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(index * 0.035, 0.2), duration: 0.22 }}
                  >
                    <td className="px-4 py-3 text-on-surface">{decision.targetName ?? "unknown"}</td>
                    <td className={`px-4 py-3 ${statusClass(decision.status)}`}>{decision.status ?? "unknown"}</td>
                    <td className="px-4 py-3 text-on-surface-variant" title={decision.reason ?? "unknown"}>{shortReason(decision.reason)}</td>
                    <td className="px-4 py-3 font-mono-label text-mono-label text-primary-container">
                      <CopyValue value={decision.auditJobId} empty="unknown" />
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ProofCard({ proof, ledgerEntry }: { proof: ProofPacket; ledgerEntry?: LedgerEntry }): ReactElement {
  const card = proofCardPath(proof, ledgerEntry);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex min-h-[320px] items-center justify-center overflow-hidden rounded-xl border border-[#242629] bg-[#101215] p-4 sm:min-h-[360px]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary-container/10 via-background/0 to-transparent" />
        {card ? (
          <img className="relative z-10 h-auto max-h-[520px] max-w-full rounded-lg object-contain drop-shadow-2xl transition-transform duration-500 ease-out hover:scale-[1.02]" src={card} alt={`Proofline Execution Proof Packet ${proof.proofPacketId}`} />
        ) : (
          <EmptyState icon="branding_watermark" title="No proof card" detail="This proof still has JSON evidence and signature data." compact />
        )}
      </div>
      {card ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <a className="flex w-full items-center justify-center gap-2 rounded bg-primary-container px-4 py-3 font-mono-label text-mono-label uppercase text-on-primary-container transition-all hover:bg-primary" href={card}>
            <span className="material-symbols-outlined text-[18px]">download</span> Card
          </a>
          <ShareXButton proof={proof} cardUrl={card} />
        </div>
      ) : null}
    </div>
  );
}

function PaymentPanel({ payments, compact = false }: { payments: PaymentReceipt[]; compact?: boolean }): ReactElement {
  return (
    <div className="panel-inner">
      <h2 className="mb-stack-sm border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Payment Ledger</h2>
      <div className="flex max-h-[520px] flex-col gap-2 overflow-auto pr-1">
        {payments.length === 0 ? <div className="data text-on-surface-variant">No payment receipts.</div> : null}
        {payments.map((payment, index) => (
          <motion.div
            key={payment.paymentId}
            className="flex flex-col gap-2 rounded border border-outline-variant bg-surface-container-low p-3"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index * 0.04, 0.2), duration: 0.2 }}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="label truncate">{payment.provider ?? "unknown"}</span>
              <span className={`font-mono-label text-mono-label ${statusClass(payment.status)}`}>{payment.status ?? "unknown"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="label">{payment.method ?? "unknown"}</span>
              <span className="data">{payment.amount ?? "0"} {payment.currency ?? ""}</span>
            </div>
            {!compact ? <CopyValue value={receiptLabel(payment)} maxWidth="max-w-full" /> : null}
            {compact ? <CopyValue value={transactionHash(payment) ?? payment.service ?? receiptLabel(payment)} maxWidth="max-w-full" /> : null}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function AuditEvidencePanel({ proof }: { proof: ProofPacket }): ReactElement {
  const riskFlags = proof.riskFlags ?? proof.aceAnalysis?.riskFlags ?? [];
  return (
    <div className="panel-inner">
      <div className="mb-stack-md flex items-center justify-between border-b border-surface-variant pb-stack-sm">
        <h2 className="font-headline-sm text-headline-sm">Audit Summary</h2>
        <StatusBadge status={proof.scores?.verdict} />
      </div>
      <p className="font-body-md text-body-md text-on-surface-variant">
        {proof.aceAnalysis?.summary ?? "No natural-language audit summary was recorded for this proof."}
      </p>
      <div className="mt-stack-md flex flex-wrap gap-2">
        {riskFlags.length === 0 ? (
          <span className="rounded border border-outline-variant bg-surface-dim px-2 py-1 font-mono-label text-mono-label text-on-surface-variant">
            no risk flags
          </span>
        ) : (
          riskFlags.map((flag) => (
            <span key={flag} className="rounded border border-error-container bg-error-container/20 px-2 py-1 font-mono-label text-mono-label text-error">
              {flag}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function SentinelPanel({ proof }: { proof: ProofPacket }): ReactElement {
  const warnings = proof.sentinelCheck?.warnings ?? [];
  const reasons = proof.sentinelCheck?.reasons ?? [];
  return (
    <div className="panel-inner">
      <h2 className="mb-stack-md border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Sentinel Result</h2>
      <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
        <Field label="Status" value={proof.sentinelCheck?.status} tone={proof.sentinelCheck?.status} />
        <Field label="Checked" value={formatDateTime(proof.sentinelCheck?.checkedAt)} />
      </div>
      <EvidenceList title="Warnings" items={warnings} empty="No Sentinel warnings recorded." />
      <EvidenceList title="Reasons" items={reasons} empty="No Sentinel block reasons recorded." />
    </div>
  );
}

function ProbePanel({ proof }: { proof: ProofPacket }): ReactElement {
  const request = proof.probeResult?.request as
    | {
        method?: string;
        url?: string;
        paid?: boolean;
        purpose?: string;
        probeTypes?: string[];
      }
    | undefined;
  const outputPreview = proof.probeResult?.outputPreview ?? proof.probeResult?.raw;
  return (
    <div className="panel-inner">
      <h2 className="mb-stack-md border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Probe Execution</h2>
      <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
        <Field label="Status" value={proof.probeResult?.status ?? proof.probeResult?.deliveryStatus} tone={proof.probeResult?.status ?? proof.probeResult?.deliveryStatus} />
        <Field label="Paid Probe" value={request?.paid === undefined ? "unknown" : request.paid ? "yes" : "no"} />
        <Field label="Method" value={request?.method} />
        <Field label="Completed" value={formatDateTime(proof.probeResult?.completedAt)} />
      </div>
      <div className="mt-stack-md">
        <Field label="Request URL" value={request?.url} copyValue={request?.url} />
      </div>
      {request?.probeTypes?.length ? <EvidenceList title="Probe Types" items={request.probeTypes} empty="No probe types recorded." /> : null}
      <PreviewBlock title="Output Preview" value={outputPreview ?? proof.probeResult?.error ?? "No output preview recorded."} />
    </div>
  );
}

function AudioPanel({ audioPath }: { audioPath: string }): ReactElement {
  return (
    <div className="panel-inner">
      <h2 className="mb-stack-md border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Audio Recap</h2>
      <audio className="w-full" controls src={audioPath} />
    </div>
  );
}

function AcePanel({ proof }: { proof: ProofPacket }): ReactElement {
  const services = proof.aceAnalysis?.servicesUsed ?? [];
  return (
    <div className="panel-inner">
      <h2 className="mb-stack-sm border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Ace Usage Metrics</h2>
      <div className="flex flex-wrap gap-2">
        {services.length === 0 ? <span className="data text-on-surface-variant">No Ace services recorded.</span> : null}
        {services.map((service) => (
          <span key={service} className="flex items-center gap-1 rounded border border-outline-variant bg-surface-dim px-2 py-1 font-mono-label text-mono-label text-on-surface-variant">
            {service} <span className="text-on-surface">used</span>
          </span>
        ))}
      </div>
      {proof.aceAnalysis?.summary ? <p className="mt-stack-sm font-body-sm text-body-sm text-on-surface-variant">{proof.aceAnalysis.summary}</p> : null}
    </div>
  );
}

function Metrics({ scores }: { scores?: ProofPacket["scores"] }): ReactElement {
  const items = [
    ["Reliability", scores?.reliability ?? 0],
    ["Capability", scores?.capabilityMatch ?? 0],
    ["Payment Integrity", scores?.paymentIntegrity ?? 0],
    ["Public Footprint", scores?.publicFootprint ?? 0],
    ["Safety", scores?.safety ?? 0],
  ] as const;

  return (
    <div className="panel-inner">
      <h2 className="mb-stack-md border-b border-surface-variant pb-stack-sm font-headline-sm text-headline-sm">Metrics Breakdown</h2>
      <div className="flex flex-col gap-3">
        {items.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <div className="flex w-full items-center justify-between">
              <span className="label">{label}</span>
              <span className="data">{value}</span>
            </div>
            <div className="h-unit w-full overflow-hidden rounded-full bg-surface-variant">
              <div className="h-full bg-primary-container" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterBar({ filter, setFilter }: { filter: Filter; setFilter: (filter: Filter) => void }): ReactElement {
  const filters: Array<{ value: Filter; label: string }> = [
    { value: "all", label: "All" },
    { value: "delivered", label: "Delivered" },
    { value: "warning", label: "Warning" },
    { value: "failed", label: "Failed" },
    { value: "payment-skipped", label: "Payment Skipped" },
    { value: "high-risk", label: "High Risk" },
  ];
  return (
    <section className="flex flex-wrap gap-2" aria-label="Ledger filters">
      {filters.map((item) => (
        <button
          key={item.value}
          className={`rounded-lg border border-outline-variant px-3 py-1.5 font-body-sm text-body-sm transition-colors hover:bg-surface-container-low ${
            filter === item.value ? "bg-surface-container-high text-on-surface" : "bg-surface text-on-surface-variant"
          }`}
          onClick={() => setFilter(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </section>
  );
}

function StatCard({ icon, label, value, tone }: { icon: string; label: string; value: string; tone?: string }): ReactElement {
  return (
    <motion.div className="panel flex h-24 flex-col justify-between p-4" whileHover={{ y: -2 }} transition={{ duration: 0.18 }}>
      <div className="flex items-center gap-2 font-mono-label text-mono-label uppercase text-on-surface-variant">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {label}
      </div>
      <div className={`font-headline-md text-headline-md ${statusClass(tone, "text-on-surface")}`}>{value}</div>
    </motion.div>
  );
}

function Field({ label, value, tone, copyValue }: { label: string; value?: string | number | null; tone?: string; copyValue?: string | null }): ReactElement {
  const displayValue = value === undefined || value === null || value === "" ? "unknown" : String(value);
  return (
    <div className="flex min-w-0 flex-col gap-1 overflow-hidden">
      <span className="label">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`data truncate ${statusClass(tone, "text-on-surface")}`} title={displayValue}>{displayValue}</span>
        {copyValue ? <CopyButton value={copyValue} label={`Copy ${label}`} /> : null}
      </span>
    </div>
  );
}

function CopyButton({ value, label = "Copy" }: { value?: string | null; label?: string }): ReactElement | null {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-outline-variant text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      title={copied ? "Copied" : label}
      type="button"
    >
      <span className="material-symbols-outlined text-[15px]">{copied ? "done" : "content_copy"}</span>
    </button>
  );
}

function CopyValue({ value, empty = "none", maxWidth = "max-w-[220px]" }: { value?: string | null; empty?: string; maxWidth?: string }): ReactElement {
  if (!value) return <span className="text-on-surface-variant">{empty}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`${maxWidth} truncate text-primary-container`} title={value}>{shortId(value, 14, 8)}</span>
      <CopyButton value={value} />
    </span>
  );
}

function ShareXButton({ proof, cardUrl }: { proof: ProofPacket; cardUrl?: string | null }): ReactElement {
  const shareUrl = absoluteUrl(`/proofs/${proof.proofPacketId}`);
  const text = `Proofline audited ${proof.targetAgent?.name ?? "an SAP agent"}: ${proof.scores?.verdict ?? "verdict"} (${proof.scores?.overall ?? 0}/100). ${cardUrl ? "Proof card included." : "Signed proof packet included."}`;
  const href = `https://twitter.com/intent/tweet?${new URLSearchParams({ text, url: shareUrl }).toString()}`;
  return (
    <a
      className="flex w-full items-center justify-center gap-2 rounded border border-outline-variant px-4 py-3 font-mono-label text-mono-label uppercase text-on-surface transition-all hover:border-primary hover:text-primary"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <span className="material-symbols-outlined text-[18px]">ios_share</span> Share on X
    </a>
  );
}

function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

function EvidenceList({ title, items, empty }: { title: string; items: string[]; empty: string }): ReactElement {
  return (
    <div className="mt-stack-md">
      <div className="label mb-2">{title}</div>
      <div className="flex flex-wrap gap-2">
        {items.length === 0 ? (
          <span className="rounded border border-outline-variant bg-surface-dim px-2 py-1 font-mono-data text-mono-data text-on-surface-variant">
            {empty}
          </span>
        ) : (
          items.map((item) => (
            <span key={item} className="rounded border border-outline-variant bg-surface-dim px-2 py-1 font-mono-data text-mono-data text-on-surface-variant">
              {item}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function PreviewBlock({ title, value }: { title: string; value: unknown }): ReactElement {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="mt-stack-md">
      <div className="label mb-2">{title}</div>
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded border border-[#242629] bg-surface-container-lowest p-3 font-mono-data text-mono-data text-on-surface-variant">
        {text}
      </pre>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }): ReactElement {
  const tone = statusTone(status);
  const classes =
    tone === "good"
      ? "bg-[#55F08A]/10 text-[#55F08A]"
      : tone === "warn"
        ? "bg-[#f6d372]/10 text-[#f6d372]"
        : tone === "bad"
          ? "bg-error-container/30 text-error"
          : "bg-surface-container-high text-on-surface-variant";
  return (
    <span className={`inline-flex max-w-[180px] items-center gap-1.5 rounded-full px-2 py-0.5 font-mono-label text-mono-label ${classes}`} title={status ?? "unknown"}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="truncate">{status ?? "unknown"}</span>
    </span>
  );
}

function TimelineItem({ icon, label, detail, status, timestamp, href }: TimelineEvent): ReactElement {
  const content = (
    <>
      <span className={`material-symbols-outlined material-icon-filled mt-[2px] text-[16px] ${statusClass(status, "text-primary-container")}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-body-md text-body-md text-on-surface">{label}</div>
          {timestamp ? <div className="font-mono-label text-mono-label uppercase text-on-surface-variant">{formatDateTime(timestamp)}</div> : null}
        </div>
        {detail ? <div className="data truncate text-on-surface-variant">{detail}</div> : null}
      </div>
    </>
  );

  return (
    <a className="flex items-start gap-2 rounded border border-transparent p-1 transition-colors hover:border-outline-variant hover:bg-surface-container" href={href ?? "#"}>
      {content}
    </a>
  );
}

function buildTimeline(proof: ProofPacket): TimelineEvent[] {
  const targetPayment = (proof.payments ?? []).find((payment) => payment.provider !== "ace_data_cloud");
  const firstAcePayment = (proof.payments ?? []).find((payment) => payment.provider === "ace_data_cloud");
  const signatureValue = proofSignatureValue(proof);
  const card = proofCardPath(proof);
  return [
    {
      icon: "travel_explore",
      label: "Discovery selected target",
      detail: `${proof.targetAgent?.name ?? "unknown"} / ${proof.targetAgent?.toolName ?? proof.targetAgent?.toolId ?? "unknown"}`,
      status: "settled",
      timestamp: proof.auditJob?.createdAt ?? proof.createdAt,
      href: `/proofs/${proof.proofPacketId}`,
    },
    {
      icon: "health_and_safety",
      label: `Sentinel preflight: ${proof.sentinelCheck?.status ?? "unknown"}`,
      detail: proof.targetAgent?.endpoint,
      status: proof.sentinelCheck?.status,
      timestamp: proof.sentinelCheck?.checkedAt,
      href: `/proofs/${proof.proofPacketId}`,
    },
    {
      icon: targetPayment?.status === "failed" ? "error" : "payments",
      label: `Payment event: ${targetPayment?.status ?? "not recorded"}`,
      detail: targetPayment ? `${targetPayment.service ?? "target"} / ${targetPayment.amount ?? "0"} ${targetPayment.currency ?? ""}` : "No target payment receipt",
      status: targetPayment?.status,
      timestamp: targetPayment?.createdAt,
      href: "/payments",
    },
    {
      icon: "terminal",
      label: `Probe execution: ${proof.probeResult?.status ?? proof.probeResult?.deliveryStatus ?? "unknown"}`,
      detail: proof.probeResult?.request?.url,
      status: proof.probeResult?.status ?? proof.probeResult?.deliveryStatus,
      timestamp: proof.probeResult?.completedAt,
      href: `/proofs/${proof.proofPacketId}`,
    },
    {
      icon: "api",
      label: "Ace analysis",
      detail: `${proof.aceAnalysis?.servicesUsed?.length ?? 0} services / ${firstAcePayment?.status ?? "not recorded"}`,
      status: firstAcePayment?.status ?? "settled",
      timestamp: firstAcePayment?.createdAt ?? proof.createdAt,
      href: "/ace",
    },
    {
      icon: "signature",
      label: "Proof Packet signed",
      detail: shortId(proof.signature?.packetHash),
      status: signatureValue ? "settled" : "warning",
      timestamp: proof.signature?.signedAt,
      href: publicProofJsonPath(proof.proofPacketId),
    },
    {
      icon: "published_with_changes",
      label: "Public artifact published",
      detail: card ?? publicProofJsonPath(proof.proofPacketId),
      status: "settled",
      timestamp: proof.createdAt,
      href: card ?? publicProofJsonPath(proof.proofPacketId),
    },
  ];
}

function proofSignatureValue(proof: ProofPacket): string | undefined {
  return proof.signature?.signatureBase64 ?? proof.signature?.signature;
}

function liveEventLabel(event: LiveChangeEvent): string {
  const action = event.eventType === "INSERT" ? "new" : event.eventType === "UPDATE" ? "updated" : event.eventType.toLowerCase();
  if (event.table === "scheduler_runs") return `Scheduler ${action} run state`;
  if (event.table === "audit_jobs") return `Audit job ${action}`;
  if (event.table === "payment_receipts") return `Payment receipt ${action}`;
  if (event.table === "proof_packets") return `Proof packet ${action}`;
  if (event.table === "audit_runs") return `Audit run ${action}`;
  if (event.table === "realtime") return "Supabase Realtime connected";
  return `Live event received from ${event.table}`;
}

function paymentIntegrityLabel(value?: string | null): string {
  if (!value) return "unknown";
  const normalized = value.toLowerCase();
  if (normalized.includes("transaction_hash_present")) return "tx hash present";
  if (normalized.includes("no_transaction_hash")) return "no tx hash";
  if (normalized.includes("ace_x402_settled_target_skipped")) return "Ace settled; target skipped";
  if (normalized.includes("ace_settled_target_skipped")) return "Ace settled; target skipped";
  if (normalized.includes("skipped_no_spend")) return "skipped, no spend";
  return value.replaceAll("_", " ");
}

function shortReason(value?: string | null): string {
  if (!value) return "unknown";
  if (value.includes("generic non-Ace x402")) return "non-Ace x402 guarded";
  if (value.includes("SAP escrow automation")) return "escrow route guarded";
  if (value.includes("re-audit window")) return "recently audited";
  if (value.includes("per-audit budget")) return "over audit budget";
  if (value.includes("hourly spend")) return "over hourly budget";
  if (value.includes("daily spend")) return "over daily budget";
  if (value.includes("max jobs per cycle")) return "cycle limit reached";
  if (value.length > 56) return `${value.slice(0, 53)}...`;
  return value;
}

function aceServicePurpose(service: string): string {
  if (service.includes("serp")) return "public footprint";
  if (service.includes("chat")) return "audit verdict";
  if (service.includes("translate")) return "localized recap";
  if (service.includes("image")) return "proof card";
  if (service.includes("audio")) return "audio recap";
  return "audit evidence";
}

function receiptLabel(payment: PaymentReceipt): string {
  const parsed = parseReceipt(payment.receipt);
  if (parsed?.endpoint) return String(parsed.endpoint);
  const tx = transactionHash(payment);
  if (tx) return tx;
  return payment.receipt ?? payment.paymentId;
}

function transactionHash(payment: PaymentReceipt): string | null {
  const parsed = parseReceipt(payment.receipt);
  const fromReceipt = parsed?.transactionHash ?? parsed?.txHash ?? parsed?.tx_hash;
  if (typeof fromReceipt === "string" && fromReceipt.length > 0) return fromReceipt;
  if (payment.transactionHash) return payment.transactionHash;
  if (payment.txHash) return payment.txHash;
  return null;
}

function statusClass(status?: string, fallback = "text-on-surface-variant"): string {
  const tone = statusTone(status);
  if (tone === "good") return "text-[#55F08A]";
  if (tone === "warn") return "text-[#f6d372]";
  if (tone === "bad") return "text-error";
  return fallback;
}

function ErrorPanel({ message }: { message: string }): ReactElement {
  return (
    <div className="rounded-lg border border-error-container bg-error-container/20 p-stack-md text-error">
      <div className="font-headline-sm text-headline-sm">Dashboard data failed to load</div>
      <div className="mt-1 font-mono-data text-mono-data">{message}</div>
    </div>
  );
}

function LoadingPanel(): ReactElement {
  return (
    <div className="panel p-stack-md">
      <div className="label">Loading Proofline Live</div>
      <div className="mt-2 h-unit w-full overflow-hidden rounded-full bg-surface-variant">
        <motion.div
          className="h-full w-1/3 rounded-full bg-primary-container"
          initial={{ x: "-100%" }}
          animate={{ x: ["-100%", "320%"] }}
          transition={{ duration: 1.25, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </div>
  );
}

function EmptyState({ icon, title, detail, compact = false }: { icon: string; title: string; detail: string; compact?: boolean }): ReactElement {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? "p-4" : "p-8"}`}>
      <span className="material-symbols-outlined text-[28px] text-primary-container">{icon}</span>
      <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
      <p className="max-w-[520px] font-body-sm text-body-sm text-on-surface-variant">{detail}</p>
    </div>
  );
}
