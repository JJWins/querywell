export const TRIAL_QUESTION_LIMIT = 30;

const PLANS = {
  small: {
    code: "starter",
    monthlyUsd: 39,
    questionLimit: 150,
    connectionLimit: 1,
  },
  medium: {
    code: "growth",
    monthlyUsd: 129,
    questionLimit: 400,
    connectionLimit: 1,
  },
  large: {
    code: "scale",
    monthlyUsd: 349,
    questionLimit: 2000,
    connectionLimit: 3,
  },
};

export function planForPath(path) {
  const plan = PLANS[path];
  if (!plan) throw new Error(`Unknown schema path: ${path}`);
  return plan;
}

const LIMIT_BY_CODE = {
  starter: PLANS.small.questionLimit,
  growth: PLANS.medium.questionLimit,
  scale: PLANS.large.questionLimit,
};

export function questionLimitForPlan(planCode) {
  const limit = LIMIT_BY_CODE[String(planCode || "").toLowerCase()];
  return limit == null ? TRIAL_QUESTION_LIMIT : limit;
}
