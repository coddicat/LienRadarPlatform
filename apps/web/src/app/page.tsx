import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { GatePill } from "@/components/GatePill";
import { Shell } from "@/components/Shell";
import { StatusPill } from "@/components/StatusPill";
import { authOptions } from "@/lib/auth";
import { countyLabel } from "@/lib/countyLabel";
import { loadDashboardStats } from "@/lib/dashboardStats";
import { floridaTodayUtcDate } from "@/lib/floridaDate";
import { usd, ymd } from "@/lib/format";
import { healthLabel, formatWhen } from "@/lib/labels";
import { getI18n } from "@/lib/i18n";
import { applyMethodToLot, getUserMethodSettings } from "@/lib/methodSettings";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const methodSettings = await getUserMethodSettings(userId);
  const { t } = await getI18n();
  const today = floridaTodayUtcDate();

  const [stats, upcoming, runs, resources, jobs] = await Promise.all([
    loadDashboardStats(userId),
    prisma.lot.findMany({
      where: { saleDate: { gte: today } },
      include: {
        debts: {
          select: { category: true, amountKind: true, searchScoped: true, amount: true },
        },
        mortgages: { select: { rankLevel: true, satisfied: true } },
        risks: { select: { code: true, result: true, blocksBid: true } },
      },
      orderBy: { saleDate: "asc" },
      take: 8,
    }),
    prisma.ingestRun.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
    prisma.dataResource.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, status: true, kind: true },
      take: 24,
    }),
    prisma.scheduledJob.findMany({
      orderBy: { key: "asc" },
      select: { id: true, name: true, description: true, lastStatus: true },
    }),
  ]);

  const { buckets, channels, readyToBid, needsReview, doNotBid, discountOpps, deals } = stats;

  return (
    <Shell active="dashboard" email={session?.user?.email}>
      <div className="page-head">
        <h1>{t("dashboard.title")}</h1>
        <p className="sub">{t("dashboard.subtitle")}</p>
      </div>

      <div className="callout">{t("dashboard.decisionHint")}</div>

      <div className="cards">
        <div className="card">
          <Link href="/lots?bucket=FUTURE">
            <div className="label">{t("dashboard.future")}</div>
            <div className="value">{buckets.FUTURE}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/lots?bucket=CURRENT">
            <div className="label">{t("dashboard.current")}</div>
            <div className="value">{buckets.CURRENT}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/lots?opportunity=discount">
            <div className="label">{t("lots.opportunityDiscount")}</div>
            <div className="value" style={{ color: "var(--ok)" }}>{discountOpps}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/lots?gate=allowed">
            <div className="label">{t("dashboard.readyToBid")}</div>
            <div className="value" style={{ color: "var(--ok)" }}>{readyToBid}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/lots?gate=pending">
            <div className="label">{t("dashboard.needsReview")}</div>
            <div className="value" style={{ color: "var(--warn)" }}>{needsReview}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/lots?gate=blocked">
            <div className="label">{t("dashboard.bidBlocked")}</div>
            <div className="value" style={{ color: "var(--bad)" }}>{doNotBid}</div>
          </Link>
        </div>
        <div className="card">
          <Link href="/pipeline">
            <div className="label">{t("dashboard.deals")}</div>
            <div className="value">{deals}</div>
          </Link>
        </div>
        <div className="card">
          <div className="label">{t("dashboard.taxDeed")}</div>
          <div className="value">{channels.TAX_DEED}</div>
        </div>
        <div className="card">
          <div className="label">{t("dashboard.foreclosure")}</div>
          <div className="value">{channels.FORECLOSURE}</div>
        </div>
      </div>

      <div className="chip-row">
        <span className="muted" style={{ alignSelf: "center", fontWeight: 650 }}>{t("dashboard.quickLinks")}</span>
        <Link className="chip" href="/lots?gate=allowed"><span className="n">{readyToBid}</span> {t("dashboard.linkReady")}</Link>
        <Link className="chip" href="/lots?gate=pending"><span className="n">{needsReview}</span> {t("dashboard.linkReview")}</Link>
        <Link className="chip" href="/lots?bucket=CURRENT"><span className="n">{buckets.CURRENT}</span> {t("dashboard.linkSaleDay")}</Link>
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="panel-title">
            <strong>{t("dashboard.upcoming")}</strong>
            <Link href="/lots">{t("common.viewAll")}</Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("common.sale")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("common.channel")}</th>
                  <th>{t("common.address")}</th>
                  <th>{t("common.money")}</th>
                  <th>{t("common.gate")}</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((lot) => {
                  const method = applyMethodToLot(lot, methodSettings);
                  return (
                  <tr key={lot.id}>
                    <td className="mono strong">{ymd(lot.saleDate)}</td>
                    <td><StatusPill status={lot.status} label={t(`statuses.${lot.status}`)} /></td>
                    <td><span className="pill info">{t(`channels.${lot.channel}`)}</span></td>
                    <td>
                      <Link className="row-title" href={`/lots/${lot.id}`}>
                        {lot.propertyAddress ?? lot.caseNumber}
                      </Link>
                      <div className="row-meta mono">
                        {countyLabel(t, lot.county)} · {lot.caseNumber}
                      </div>
                    </td>
                    <td className="mono">{usd(lot.openingBid ?? lot.judgmentAmount)}</td>
                    <td>
                      <GatePill
                        hasGate
                        bidAllowed={method.bidAllowed}
                        needsDd={method.needsDd}
                        allowedLabel={t("common.allowed")}
                        blockedLabel={t("common.blocked")}
                        pendingLabel={t("common.pending")}
                        needsDdLabel={t("common.needsDd")}
                      />
                    </td>
                  </tr>
                  );
                })}
                {upcoming.length === 0 ? (
                  <tr><td colSpan={6} className="empty">{t("dashboard.noLots")}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <strong>{t("dashboard.systemHealth")}</strong>
            <Link href="/admin">{t("dashboard.adminCron")}</Link>
          </div>
          <div className="panel-pad">
            <p className="sub" style={{ marginBottom: 12 }}>{t("dashboard.systemHealthHint")}</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t("common.resource")}</th><th>{t("common.status")}</th></tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>
                      <span className={`pill ${r.status === "OK" ? "ok" : r.status === "DOWN" ? "bad" : "warn"}`}>
                        {healthLabel(r.status, t)}
                      </span>
                    </td>
                  </tr>
                ))}
                {resources.length === 0 ? <tr><td colSpan={2} className="empty">{t("dashboard.noResources")}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="panel-title" style={{ borderTop: "1px solid var(--line)" }}>
            <strong>{t("dashboard.cronJobs")}</strong>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t("common.job")}</th><th>{t("common.last")}</th></tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="strong">{j.name}</div>
                      <div className="row-meta">{j.description}</div>
                    </td>
                    <td>
                      {j.lastStatus ? (
                        <span className={`pill ${j.lastStatus === "SUCCESS" ? "ok" : j.lastStatus === "FAILED" ? "bad" : "warn"}`}>
                          {healthLabel(j.lastStatus, t)}
                        </span>
                      ) : (
                        <span className="pill warn">{t("common.neverRun")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-title" style={{ borderTop: "1px solid var(--line)" }}>
            <strong>{t("dashboard.recentStages")}</strong>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t("common.stage")}</th><th>{t("common.status")}</th><th>{t("common.started")}</th></tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.stage.replaceAll("_", " ")}</td>
                    <td>
                      <span className={`pill ${run.status === "SUCCESS" ? "ok" : run.status === "FAILED" ? "bad" : "warn"}`}>
                        {healthLabel(run.status, t)}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{formatWhen(run.startedAt)}</td>
                  </tr>
                ))}
                {runs.length === 0 ? <tr><td colSpan={3} className="empty">{t("dashboard.noRuns")}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Shell>
  );
}
