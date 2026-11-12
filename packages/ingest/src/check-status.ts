import { prisma } from "@lienradar/db";

const resources = await prisma.dataResource.findMany({ orderBy: { key: "asc" } });
console.log(
  resources.map((x) => ({
    key: x.key,
    status: x.status,
    detail: x.detail,
    err: x.lastError,
  })),
);
const jobs = await prisma.scheduledJob.findMany({ orderBy: { key: "asc" } });
console.log(
  "jobs",
  jobs.map((x) => ({ key: x.key, status: x.lastStatus, err: x.lastError, counts: x.lastCounts })),
);
await prisma.$disconnect();
