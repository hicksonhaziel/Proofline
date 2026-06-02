import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  formatDate,
  formatDateTime,
  loadLedger,
  loadLatestProof,
  loadProof,
  loadProofs,
  parseReceipt,
  proofCardPath,
  shortId,
  statusTone,
  summarizePayments,
} from "./lib/proofs";
import type { LedgerEntry, PaymentReceipt, ProofPacket } from "./lib/types";

type Route = "live" | "ledger" | "proof" | "payments" | "ace" | "health";
type Filter = "all" | "delivered" | "warning" | "failed" | "payment-skipped" | "high-risk";

interface AppState {
  ledger: LedgerEntry[];
  latest: ProofPacket | null;
  selectedProof: ProofPacket | null;
  proofs: ProofPacket[];
  loading: boolean;
  error: string | null;
}

const initialState: AppState = {
  ledger: [],
  latest: null,
  selectedProof: null,
  proofs: [],
  loading: true,
  error: null,
};

export function App(): ReactElement {
  const [state, setState] = useState<AppState>(initialState);
  const [path, setPath] = useState(window.location.pathname);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const route = useMemo(() => getRoute(path), [path]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        setState((current) => ({ ...current, loading: true, error: null }));
        const ledger = await loadLedger();
        const latest = await loadLatestProof();
        const selectedId = route.proofId ?? latest.proofPacketId;
        const selectedProof = selectedId === latest.proofPacketId ? latest : await loadProof(selectedId);
        const proofs = await loadProofs(ledger);
        if (!cancelled) {
          setState({ ledger, latest, selectedProof, proofs, loading: false, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : "Unable to load dashboard data",
          }));
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [route.proofId]);

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
              <LiveView ledger={state.ledger} latest={state.latest} navigate={navigate} />
            ) : route.name === "ledger" ? (
              <LedgerView ledger={state.ledger} filter={filter} setFilter={setFilter} navigate={navigate} />
            ) : route.name === "payments" ? (
              <PaymentsView ledger={state.ledger} proofs={state.proofs} navigate={navigate} />
            ) : route.name === "ace" ? (
              <AceUsageView ledger={state.ledger} proofs={state.proofs} navigate={navigate} />
            ) : route.name === "health" ? (
              <HealthView ledger={state.ledger} proofs={state.proofs} latest={state.latest} />
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
  if (pathname === "/proofs" || pathname === "/proofs/") return { name: "ledger" };
  const proofMatch = pathname.match(/^\/proofs\/(proof_[a-zA-Z0-9_-]+)\/?$/);
  if (proofMatch?.[1]) return { name: "proof", proofId: proofMatch[1] };
  return { name: "live" };
}

function Header({ route, navigate }: { route: Route; navigate: (href: string) => void }): ReactElement {
  const links: Array<{ href: string; label: string; route: Route }> = [
    { href: "/live", label: "Live Audit Feed", route: "live" },
    { href: "/proofs", label: "Evidence Ledger", route: "ledger" },
    { href: "/payments", label: "Payment Proof", route: "payments" },
    { href: "/ace", label: "Ace Usage", route: "ace" },
    { href: "/health", label: "System Health", route: "health" },
  ];

  return (
    <header className="sticky top-0 z-50 flex h-16 w-full items-center justify-between border-b border-outline-variant bg-surface px-container-padding">
      <div className="flex min-w-0 items-center gap-8">
        <button className="flex items-center gap-3" onClick={() => navigate("/live")} type="button">
          <img className="h-9 w-9 rounded-lg border border-outline-variant object-cover" src="/proofline.png" alt="Proofline" />
          <span className="font-headline-md text-headline-md font-bold text-primary">Proofline</span>
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
    </header>
  );
}

function LiveView({
  ledger,
  latest,
  navigate,
}: {
  ledger: LedgerEntry[];
  latest: ProofPacket;
  navigate: (href: string) => void;
}): ReactElement {
  const latestEntry = ledger.find((entry) => entry.proofPacketId === latest.proofPacketId);
  const payments = summarizePayments(latest.payments);
  const timeline = buildTimeline(latest);

  return (
    <>
      <section className="flex flex-col gap-2">
        <h1 className="font-display-lg text-display-lg text-on-surface">Proofline Live</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Active paid execution evidence for SAP agents and Ace Data Cloud usage.</p>
      </section>

      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="account_tree" label="Total Proofs" value={String(ledger.length)} />
        <StatCard icon="shield" label="Latest Score" value={`${latest.scores?.overall ?? latestEntry?.overallScore ?? 0}/100`} />
        <StatCard icon="payments" label="Ace Settled" value={`$${payments.aceTotal.toFixed(6)}`} />
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
              <Field label="Payment" value={latestEntry?.paymentIntegrity ?? "unknown"} tone={latestEntry?.paymentStatus} />
              <Field label="Sentinel" value={latest.sentinelCheck?.status ?? "unknown"} tone={latest.sentinelCheck?.status} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function LedgerView({
  ledger,
  filter,
  setFilter,
  navigate,
}: {
  ledger: LedgerEntry[];
  filter: Filter;
  setFilter: (filter: Filter) => void;
  navigate: (href: string) => void;
}): ReactElement {
  const filtered = ledger.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "delivered") return entry.verdict === "delivered" || entry.verdict === "passed";
    if (filter === "warning") return entry.verdict === "warning";
    if (filter === "failed") return entry.verdict === "failed";
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
      <FilterBar filter={filter} setFilter={setFilter} />
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {["Proof ID", "Target Agent", "Verdict", "Score", "Payment Status", "Services", "Created Date", "Actions"].map((heading) => (
                  <th key={heading} className="px-4 py-3 text-left font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {filtered.map((entry) => (
                <tr key={entry.proofPacketId} className="border-b border-outline-variant transition-colors hover:bg-surface-container-high">
                  <td className="px-4 py-3">
                    <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${entry.proofPacketId}`)} type="button">
                      {shortId(entry.proofPacketId)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{entry.targetName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={entry.verdict} />
                  </td>
                  <td className="px-4 py-3 text-on-surface">{entry.overallScore ?? 0}/100</td>
                  <td className={`px-4 py-3 ${statusClass(entry.paymentStatus)}`}>{entry.paymentStatus ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{entry.aceServicesUsed?.length ?? 0}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{formatDate(entry.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button className="icon-link" onClick={() => navigate(`/proofs/${entry.proofPacketId}`)} title="View Proof" type="button">
                        <span className="material-symbols-outlined text-[18px]">visibility</span>
                      </button>
                      <a className="icon-link" href={entry.proofJson ?? `/proofs/${entry.proofPacketId}.json`} title="JSON">
                        <span className="material-symbols-outlined text-[18px]">data_object</span>
                      </a>
                      {entry.proofCard ? (
                        <a className="icon-link" href={entry.proofCard} title="Card">
                          <span className="material-symbols-outlined text-[18px]">branding_watermark</span>
                        </a>
                      ) : null}
                    </div>
                  </td>
                </tr>
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
              <Field label="Status" value={proof.signature?.signature ? "Cryptographically Signed" : "Unsigned"} />
            </div>
          </div>

          <Metrics scores={proof.scores} />

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

          <div className="panel-inner bg-[#101215]">
            <h2 className="mb-stack-md border-b border-[#242629] pb-stack-sm font-headline-sm text-headline-sm">Cryptographic Integrity</h2>
            <div className="grid grid-cols-1 gap-stack-md md:grid-cols-3">
              <Field label="Packet Hash" value={proof.signature?.packetHash ?? ledgerEntry?.packetHash} />
              <Field label="Signature" value={proof.signature?.signature} />
              <Field label="Signing Wallet" value={proof.signature?.publicKey ?? proof.auditorAgent?.publicKey} />
            </div>
          </div>
        </div>

        <div className="relative flex flex-col gap-stack-md md:col-span-5 lg:col-span-4">
          <ProofCard proof={proof} ledgerEntry={ledgerEntry} />
          <div className="grid grid-cols-2 gap-3">
            <a className="flex items-center justify-center gap-2 rounded border border-outline-variant px-4 py-3 font-mono-label text-mono-label uppercase text-on-surface transition-all hover:bg-surface-variant" href={`/proofs/${proof.proofPacketId}.json`}>
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
              <Field label="Ace Total" value={`${summary.aceTotal.toFixed(6)} USDC`} tone="settled" />
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
        <StatCard icon="payments" label="Ace USDC" value={summary.aceTotal.toFixed(6)} />
      </section>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-outline-variant bg-surface-container">
                {["Proof", "Provider", "Service", "Method", "Amount", "Status", "Receipt"].map((heading) => (
                  <th key={heading} className="px-4 py-3 font-mono-label text-mono-label font-normal uppercase text-on-surface-variant">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono-data text-mono-data">
              {payments.map(({ proof, payment }) => (
                <tr key={`${proof.proofPacketId}-${payment.paymentId}`} className="border-b border-outline-variant hover:bg-surface-container-high">
                  <td className="px-4 py-3">
                    <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${proof.proofPacketId}`)} type="button">
                      {shortId(proof.proofPacketId)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{payment.provider ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{payment.service ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{payment.method ?? "unknown"}</td>
                  <td className="px-4 py-3 text-on-surface">{payment.amount ?? "0"} {payment.currency ?? ""}</td>
                  <td className={`px-4 py-3 ${statusClass(payment.status)}`}>{payment.status ?? "unknown"}</td>
                  <td className="max-w-[320px] truncate px-4 py-3 text-primary-container">{receiptLabel(payment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel p-stack-md">
        <h2 className="mb-stack-sm font-headline-sm text-headline-sm">Ledger Payment Integrity</h2>
        <div className="grid grid-cols-1 gap-stack-sm md:grid-cols-2">
          {ledger.slice(0, 8).map((entry) => (
            <div key={entry.proofPacketId} className="rounded border border-outline-variant bg-surface p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="data truncate">{entry.targetName}</span>
                <StatusBadge status={entry.paymentStatus} />
              </div>
              <div className="mt-2 font-mono-data text-mono-data text-on-surface-variant">{entry.paymentIntegrity ?? "unknown"}</div>
            </div>
          ))}
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
  const services = new Map<string, { count: number; total: number; status: string }>();
  for (const item of acePayments) {
    const key = item.payment.service ?? "unknown";
    const current = services.get(key) ?? { count: 0, total: 0, status: "unknown" };
    services.set(key, {
      count: current.count + 1,
      total: current.total + Number(item.payment.amount ?? 0),
      status: item.payment.status ?? current.status,
    });
  }
  const total = [...services.values()].reduce((sum, service) => sum + service.total, 0);

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">Ace Usage</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Ace Data Cloud services paid through per-request x402 and used as audit evidence.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="api" label="Distinct Services" value={String(services.size)} />
        <StatCard icon="receipt_long" label="Ace Calls" value={String(acePayments.length)} />
        <StatCard icon="payments" label="Settled USDC" value={total.toFixed(6)} />
        <StatCard icon="assignment_turned_in" label="Proofs With Ace" value={String(ledger.filter((entry) => (entry.aceServicesUsed?.length ?? 0) > 0).length)} />
      </section>
      <section className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
        {[...services.entries()].map(([service, stats]) => (
          <div key={service} className="panel p-stack-md">
            <div className="mb-stack-sm flex items-center justify-between gap-3 border-b border-outline-variant pb-stack-sm">
              <h2 className="truncate font-headline-sm text-headline-sm">{service}</h2>
              <StatusBadge status={stats.status} />
            </div>
            <div className="grid grid-cols-3 gap-stack-md">
              <Field label="Calls" value={String(stats.count)} />
              <Field label="Cost" value={`${stats.total.toFixed(6)} USDC`} tone="settled" />
              <Field label="Why" value={aceServicePurpose(service)} />
            </div>
          </div>
        ))}
      </section>
      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
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
              {acePayments.map(({ proof, payment, receipt }) => (
                <tr key={`${proof.proofPacketId}-${payment.paymentId}`} className="border-b border-outline-variant hover:bg-surface-container-high">
                  <td className="px-4 py-3">
                    <button className="text-primary hover:underline" onClick={() => navigate(`/proofs/${proof.proofPacketId}`)} type="button">
                      {shortId(proof.proofPacketId)}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-on-surface">{payment.service}</td>
                  <td className="px-4 py-3 text-on-surface">{payment.amount} {payment.currency}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{String(receipt?.network ?? "unknown")}</td>
                  <td className="max-w-[360px] truncate px-4 py-3 text-primary-container">{String(receipt?.endpoint ?? "unknown")}</td>
                  <td className={`px-4 py-3 ${statusClass(payment.status)}`}>{payment.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function HealthView({ ledger, proofs, latest }: { ledger: LedgerEntry[]; proofs: ProofPacket[]; latest: ProofPacket }): ReactElement {
  const lastAudit = ledger[0]?.createdAt;
  const failed = ledger.filter((entry) => entry.verdict === "failed").length;
  const queueSignal = proofs.some((proof) => proof.auditStatus === "running") ? "running" : "idle";
  const latestPayments = summarizePayments(latest.payments);

  return (
    <>
      <section>
        <h1 className="mb-2 font-display-lg text-display-lg">System Health</h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant">Runtime state derived from published Proofline artifacts. No fake balances or credits are shown.</p>
      </section>
      <section className="grid grid-cols-1 gap-gutter md:grid-cols-4">
        <StatCard icon="monitor_heart" label="Proofline Status" value="publishing" tone="settled" />
        <StatCard icon="schedule" label="Last Audit" value={formatDateTime(lastAudit)} />
        <StatCard icon="queue" label="Queue Signal" value={queueSignal} />
        <StatCard icon="error" label="Failed Proofs" value={String(failed)} tone={failed > 0 ? "failed" : "settled"} />
      </section>
      <section className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
        <div className="panel p-stack-md">
          <h2 className="mb-stack-md border-b border-outline-variant pb-stack-sm font-headline-sm text-headline-sm">Latest Run</h2>
          <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
            <Field label="Proof ID" value={latest.proofPacketId} />
            <Field label="Audit Job" value={latest.auditJob?.auditJobId} />
            <Field label="Sentinel" value={latest.sentinelCheck?.status} tone={latest.sentinelCheck?.status} />
            <Field label="Ace Settled" value={`${latestPayments.aceTotal.toFixed(6)} USDC`} tone="settled" />
          </div>
        </div>
        <div className="panel p-stack-md">
          <h2 className="mb-stack-md border-b border-outline-variant pb-stack-sm font-headline-sm text-headline-sm">Artifact Sources</h2>
          <div className="grid grid-cols-1 gap-stack-md sm:grid-cols-2">
            <Field label="Ledger" value="/proofs/ledger.json" />
            <Field label="Latest Proof" value="/proofs/latest.json" />
            <Field label="Proof Cards" value="/proofs/*-card.png/svg" />
            <Field label="SAP Agent" value="/agent.json" />
          </div>
        </div>
      </section>
    </>
  );
}

function ProofCard({ proof, ledgerEntry }: { proof: ProofPacket; ledgerEntry?: LedgerEntry }): ReactElement {
  const card = proofCardPath(proof, ledgerEntry);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex min-h-[360px] items-center justify-center overflow-hidden rounded-xl border border-[#242629] bg-[#101215] p-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary-container/10 via-background/0 to-transparent" />
        {card ? (
          <img className="relative z-10 h-auto max-w-full drop-shadow-2xl transition-transform duration-500 ease-out hover:scale-[1.02]" src={card} alt={`Proofline Execution Proof Packet ${proof.proofPacketId}`} />
        ) : (
          <div className="label relative z-10">No proof card</div>
        )}
      </div>
      {card ? (
        <a className="flex w-full items-center justify-center gap-2 rounded bg-primary-container px-4 py-3 font-mono-label text-mono-label uppercase text-on-primary-container transition-all hover:bg-primary" href={card}>
          <span className="material-symbols-outlined text-[18px]">download</span> Download Card
        </a>
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
        {payments.map((payment) => (
          <div key={payment.paymentId} className="flex flex-col gap-2 rounded border border-outline-variant bg-surface-container-low p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="label truncate">{payment.provider ?? "unknown"}</span>
              <span className={`font-mono-label text-mono-label ${statusClass(payment.status)}`}>{payment.status ?? "unknown"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="label">{payment.method ?? "unknown"}</span>
              <span className="data">{payment.amount ?? "0"} {payment.currency ?? ""}</span>
            </div>
            {!compact ? <div className="data truncate text-primary-container">{receiptLabel(payment)}</div> : null}
            {compact ? <div className="data truncate text-primary-container">{payment.service ?? receiptLabel(payment)}</div> : null}
          </div>
        ))}
      </div>
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
    <div className="panel flex h-24 flex-col justify-between p-4">
      <div className="flex items-center gap-2 font-mono-label text-mono-label uppercase text-on-surface-variant">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {label}
      </div>
      <div className={`font-headline-md text-headline-md ${statusClass(tone, "text-on-surface")}`}>{value}</div>
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value?: string | number | null; tone?: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1 overflow-hidden">
      <span className="label">{label}</span>
      <span className={`data truncate ${statusClass(tone, "text-on-surface")}`}>{value === undefined || value === null || value === "" ? "unknown" : String(value)}</span>
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
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono-label text-mono-label ${classes}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status ?? "unknown"}
    </span>
  );
}

function TimelineItem({ icon, label, detail, status }: { icon: string; label: string; detail?: string; status?: string }): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <span className={`material-symbols-outlined material-icon-filled mt-[2px] text-[16px] ${statusClass(status, "text-primary-container")}`}>{icon}</span>
      <div className="min-w-0">
        <div className="font-body-md text-body-md text-on-surface">{label}</div>
        {detail ? <div className="data truncate text-on-surface-variant">{detail}</div> : null}
      </div>
    </div>
  );
}

function buildTimeline(proof: ProofPacket): Array<{ icon: string; label: string; detail?: string; status?: string }> {
  const targetPayment = (proof.payments ?? []).find((payment) => payment.provider !== "ace_data_cloud");
  return [
    { icon: "check_circle", label: "Target selected", detail: proof.targetAgent?.name, status: "settled" },
    { icon: "check_circle", label: `Sentinel preflight: ${proof.sentinelCheck?.status ?? "unknown"}`, detail: proof.sentinelCheck?.checkedAt ? formatDateTime(proof.sentinelCheck.checkedAt) : undefined, status: proof.sentinelCheck?.status },
    { icon: targetPayment?.status === "failed" ? "error" : "check_circle", label: `Target payment: ${targetPayment?.status ?? "not recorded"}`, detail: targetPayment?.service, status: targetPayment?.status },
    { icon: "check_circle", label: `Probe executed: ${proof.probeResult?.status ?? proof.probeResult?.deliveryStatus ?? "unknown"}`, status: proof.probeResult?.status ?? proof.probeResult?.deliveryStatus },
    { icon: "check_circle", label: "Ace analysis", detail: `${proof.aceAnalysis?.servicesUsed?.length ?? 0} services`, status: "settled" },
    { icon: "check_circle", label: "Proof signed", detail: shortId(proof.signature?.packetHash), status: proof.signature?.signature ? "settled" : "warning" },
    { icon: "check_circle", label: "Public artifact published", detail: proof.artifacts?.proofCardPath, status: "settled" },
  ];
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
  if (payment.txHash) return payment.txHash;
  return payment.receipt ?? payment.paymentId;
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
        <div className="h-full w-1/3 animate-pulse bg-primary-container" />
      </div>
    </div>
  );
}
