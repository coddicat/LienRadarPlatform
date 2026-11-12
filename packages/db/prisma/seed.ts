import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { DATA_RESOURCES, LEGACY_MIAMI_RESOURCE_KEYS, SCHEDULED_JOBS } from "@lienradar/shared";
import { PrismaClient, ResourceHealth } from "@prisma/client";

const prisma = new PrismaClient();

/** Load repo-root `.env` so requiresEnv checks see AUCTION_COM_ENABLED / etc. */
function loadRootEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function main() {
  loadRootEnv();
  // Destructive wipe only when explicitly requested — never on routine registry upserts.
  if (process.env.LR_SEED_WIPE === "1") {
    await prisma.deal.deleteMany();
    await prisma.finalBidDrop.deleteMany();
    await prisma.lotEvent.deleteMany();
    await prisma.bidCeiling.deleteMany();
    await prisma.bidGate.deleteMany();
    await prisma.riskCheck.deleteMany();
    await prisma.mortgageAssessment.deleteMany();
    await prisma.debtItem.deleteMany();
    await prisma.document.deleteMany();
    await prisma.enrichmentLayer.deleteMany();
    await prisma.rawObservation.deleteMany();
    await prisma.lot.deleteMany();
    await prisma.auctionEvent.deleteMany();
    await prisma.property.deleteMany();
    await prisma.ingestRun.deleteMany();
    console.log("LR_SEED_WIPE=1 — operational data cleared");
  }

  const passwordHash = await bcrypt.hash("lienradar", 10);
  await prisma.user.upsert({
    where: { email: "owner@lienradar.local" },
    update: { passwordHash },
    create: {
      email: "owner@lienradar.local",
      name: "LienRadar Owner",
      passwordHash,
      role: "internal",
    },
  });

  for (const r of DATA_RESOURCES) {
    const envMissing = Boolean(r.requiresEnv && !process.env[r.requiresEnv]?.trim());
    await prisma.dataResource.upsert({
      where: { key: r.key },
      update: {
        name: r.name,
        kind: r.kind,
        endpoint: r.endpoint,
        usedByJobs: r.usedByJobs,
        enabled: true,
        // Only stamp NOT_CONFIGURED when the gate env is missing.
        // Do not wipe OK/DEGRADED when env is present (live jobs own runtime status).
        ...(envMissing
          ? {
              status: ResourceHealth.NOT_CONFIGURED,
              detail: `Requires env ${r.requiresEnv}`,
              lastError: null,
            }
          : {}),
      },
      create: {
        key: r.key,
        name: r.name,
        kind: r.kind,
        endpoint: r.endpoint,
        usedByJobs: r.usedByJobs,
        enabled: true,
        status: envMissing ? ResourceHealth.NOT_CONFIGURED : ResourceHealth.NEVER_RUN,
        detail: envMissing ? `Requires env ${r.requiresEnv}` : "Registered; awaiting first probe",
      },
    });
  }

  // Hide pre-rename miami_* duplicates from Admin / Dashboard.
  for (const key of LEGACY_MIAMI_RESOURCE_KEYS) {
    await prisma.dataResource.updateMany({
      where: { key },
      data: {
        enabled: false,
        detail: "Legacy alias — superseded by miami_dade_* resource keys",
      },
    });
  }

  // Permanent honest NOT_CONFIGURED — captcha / Turnstile portals with no free path.
  for (const row of [
    {
      key: "broward_tax_collector",
      detail: "GovHub Turnstile-gated — no free delinquent path",
    },
    {
      key: "monroe_tax_collector",
      detail: "GovHub Turnstile-gated — no free delinquent path",
    },
    {
      key: "broward_clerk",
      detail: "Broward Official Records not free / captcha — no free path proven",
    },
    {
      key: "palm_beach_clerk",
      detail: "Palm Beach OR (erec) reCAPTCHA on every search — no free path",
    },
    {
      key: "monroe_clerk",
      detail: "Monroe Clerk OR not free until proven",
    },
    {
      key: "monroe_pa",
      detail: "No free folio API proven — NOT_CONFIGURED until a public path exists",
    },
  ] as const) {
    await prisma.dataResource.updateMany({
      where: { key: row.key },
      data: {
        status: ResourceHealth.NOT_CONFIGURED,
        detail: row.detail,
        lastError: null,
      },
    });
  }

  for (const j of SCHEDULED_JOBS) {
    await prisma.scheduledJob.upsert({
      where: { key: j.key },
      update: {
        name: j.name,
        cronExpr: j.cronExpr,
        description: j.description,
        timezone: j.timezone,
        enabled: true,
      },
      create: {
        key: j.key,
        name: j.name,
        cronExpr: j.cronExpr,
        description: j.description,
        timezone: j.timezone,
        enabled: true,
      },
    });
  }

  const lotCount = await prisma.lot.count();
  console.log(`Seed complete: owner + resources + jobs. Lots preserved: ${lotCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
