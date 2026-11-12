/**
 * Platform outcome text is a FACT; category is our interpretation.
 * Exact dictionary match only — never substring-guess unfamiliar wording.
 */

export type OutcomeCategory =
  | "redeemed"
  | "bankruptcy"
  | "court_cancel"
  | "plaintiff_cancel"
  | "county_cancel"
  | "procedural_reset"
  | "bidder_default"
  | "unknown";

export type OutcomeDisposition = "gone" | "frozen" | "returning" | "unclear";

export type OutcomeReason = {
  text: string | null;
  category: OutcomeCategory;
  disposition: OutcomeDisposition;
  labelEn: string;
  labelRu: string;
  matched: "exact" | "none";
};

type Known = {
  category: OutcomeCategory;
  disposition: OutcomeDisposition;
  labelEn: string;
  labelRu: string;
};

/** Measured RealAuction wording (legacy calibration). Add only after live observation. */
const KNOWN: Record<string, Known> = {
  "canceled per county": {
    category: "county_cancel",
    disposition: "unclear",
    labelEn: "pulled by county",
    labelRu: "снято округом",
  },
  "canceled per bankruptcy": {
    category: "bankruptcy",
    disposition: "frozen",
    labelEn: "debtor bankruptcy — sale frozen",
    labelRu: "банкротство должника — торги заморожены",
  },
  "canceled per order": {
    category: "court_cancel",
    disposition: "unclear",
    labelEn: "canceled by court order",
    labelRu: "отменено определением суда",
  },
  "judgment vacated/dismissed": {
    category: "court_cancel",
    disposition: "unclear",
    labelEn: "judgment vacated/dismissed",
    labelRu: "решение суда отменено, дело закрыто",
  },
  "canceled per attorney": {
    category: "plaintiff_cancel",
    disposition: "unclear",
    labelEn: "canceled by plaintiff's attorney",
    labelRu: "снято по заявлению юриста взыскателя",
  },
  "bidder walked away": {
    category: "bidder_default",
    disposition: "returning",
    labelEn: "bidder walked away — lot will return",
    labelRu: "победитель отказался платить — лот вернётся на торги",
  },
  "clerk fees not submitted per f.s. 45.035(1)": {
    category: "procedural_reset",
    disposition: "unclear",
    labelEn: "clerk fees not submitted — sale did not complete",
    labelRu: "сборы клерку не внесены — продажа не состоялась",
  },
  "sold in error": {
    category: "procedural_reset",
    disposition: "unclear",
    labelEn: "sold in error",
    labelRu: "площадка признала продажу ошибочной",
  },
  "plaintiff did not verify sale": {
    category: "procedural_reset",
    disposition: "unclear",
    labelEn: "plaintiff did not verify sale",
    labelRu: "истец не подтвердил продажу",
  },
  "pulled by county": {
    category: "county_cancel",
    disposition: "unclear",
    labelEn: "pulled by county",
    labelRu: "снято округом",
  },
  "judgment satisfied": {
    category: "redeemed",
    disposition: "gone",
    labelEn: "judgment satisfied",
    labelRu: "обязательство по решению суда исполнено",
  },
  redeemed: {
    category: "redeemed",
    disposition: "gone",
    labelEn: "redeemed — property leaves the auction",
    labelRu: "должник погасил долг — объекта на торгах больше не будет",
  },
  "auction did not meet county requirements": {
    category: "procedural_reset",
    disposition: "returning",
    labelEn: "did not meet county requirements — will be reset",
    labelRu: "торги не прошли по требованиям округа — назначат заново",
  },
  "auction to be rescheduled": {
    category: "procedural_reset",
    disposition: "returning",
    labelEn: "auction to be rescheduled",
    labelRu: "торги будут перенесены",
  },
  rescheduled: {
    category: "procedural_reset",
    disposition: "returning",
    labelEn: "rescheduled",
    labelRu: "торги перенесены на другую дату",
  },
  "vacated/reset after sale": {
    category: "procedural_reset",
    disposition: "returning",
    labelEn: "vacated/reset after sale",
    labelRu: "результат торгов отменён, назначат заново",
  },
  "proof of publication not received or incorrect": {
    category: "procedural_reset",
    disposition: "returning",
    labelEn: "proof of publication missing/incorrect",
    labelRu: "публикация извещения не получена или неверна — назначат заново",
  },
  other: {
    category: "unknown",
    disposition: "unclear",
    labelEn: "platform said “other” — reason undisclosed",
    labelRu: "площадка указала «прочее» — причина не раскрыта",
  },
};

export const UNKNOWN_LABEL_EN = "reason unknown";
export const UNKNOWN_LABEL_RU = "причина неизвестна";

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function classifyOutcomeReason(raw: string | null | undefined): OutcomeReason {
  const text = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  if (text === null) {
    return {
      text: null,
      category: "unknown",
      disposition: "unclear",
      labelEn: UNKNOWN_LABEL_EN,
      labelRu: UNKNOWN_LABEL_RU,
      matched: "none",
    };
  }
  const hit = KNOWN[key(text)];
  if (!hit) {
    return {
      text,
      category: "unknown",
      disposition: "unclear",
      labelEn: `${UNKNOWN_LABEL_EN}: “${text}”`,
      labelRu: `${UNKNOWN_LABEL_RU}: «${text}»`,
      matched: "none",
    };
  }
  return {
    text,
    category: hit.category,
    disposition: hit.disposition,
    labelEn: hit.labelEn,
    labelRu: hit.labelRu,
    matched: "exact",
  };
}

export const KNOWN_OUTCOME_TEXTS = Object.keys(KNOWN);

/** Exact measured reason required to reverse a same-date SOLD → NOT_SOLD. */
export function isExplicitFailedSaleReason(text: string | null | undefined): boolean {
  const reason = classifyOutcomeReason(text);
  return reason.matched === "exact" && reason.category !== "unknown";
}
