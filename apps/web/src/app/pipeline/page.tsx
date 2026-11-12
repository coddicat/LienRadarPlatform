import { prisma } from "@lienradar/db";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { GatePill, gateNeedsDd } from "@/components/GatePill";
import { Shell } from "@/components/Shell";
import { StatusPill } from "@/components/StatusPill";
import { authOptions } from "@/lib/auth";
import { usd, ymd } from "@/lib/format";
import { getI18n } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const session = await getServerSession(authOptions);
  const { t } = await getI18n();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const deals = userId
    ? await prisma.deal.findMany({
        where: { userId },
        include: { lot: { include: { bidGate: true } } },
        orderBy: { updatedAt: "desc" },
      })
    : [];

  return (
    <Shell active="pipeline" email={session?.user?.email}>
      <div className="page-head">
        <h1>{t("pipeline.title")}</h1>
        <p className="sub">{t("pipeline.subtitle")}</p>
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("pipeline.colStage")}</th>
                <th>{t("common.sale")}</th>
                <th>{t("common.status")}</th>
                <th>{t("common.address")}</th>
                <th>{t("common.maxBid")}</th>
                <th>{t("common.gate")}</th>
                <th>{t("common.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id}>
                  <td><span className="pill info">{t(`dealStatuses.${d.status}`)}</span></td>
                  <td className="mono strong">{ymd(d.lot.saleDate)}</td>
                  <td><StatusPill status={d.lot.status} label={t(`statuses.${d.lot.status}`)} /></td>
                  <td>
                    <Link className="row-title" href={`/lots/${d.lotId}?tab=deal`}>
                      {d.lot.propertyAddress ?? d.lot.caseNumber}
                    </Link>
                    <div className="row-meta mono">{d.lot.caseNumber}</div>
                  </td>
                  <td className="mono">{usd(d.maxBid)}</td>
                  <td>
                    <GatePill
                      hasGate={!!d.lot.bidGate}
                      bidAllowed={d.lot.bidGate?.bidAllowed}
                      needsDd={d.lot.bidGate ? gateNeedsDd(d.lot.bidGate.barriers) : false}
                      allowedLabel={t("common.allowed")}
                      blockedLabel={t("common.blocked")}
                      pendingLabel={t("common.pending")}
                      needsDdLabel={t("common.needsDd")}
                    />
                  </td>
                  <td className="muted">{d.notes ?? d.thesis ?? "—"}</td>
                </tr>
              ))}
              {deals.length === 0 ? <tr><td colSpan={7} className="empty">{t("pipeline.empty")}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
