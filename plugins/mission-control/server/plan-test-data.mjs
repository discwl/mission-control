// Synthetic proposal shared only by tests and local UI previews.
export const planBrief = {
  goal: "Prevent accidental free subscriptions.",
  before: "A new order can receive a full discount.",
  after: "A new full discount is rejected; ordinary discounts still work. Existing orders keep their current prices.",
  included: ["Prevent new full discounts and verify the behavior."],
  deferred: ["Do not remove discounts from existing orders."],
  scopeChange: "The original request included cleanup. This proposal delivers prevention first and defers cleanup.",
  affected: ["Staff creating new subscriber orders."],
  approach: ["Check the discount before saving a new order.", "Validate the change and get an independent review."],
  successChecks: ["A new full discount is rejected.", "Lower discounts still work and existing orders remain unchanged."],
  risks: ["Existing free subscriptions remain until separate cleanup work is approved."],
  authorization: "Implement and validate prevention, then return for review. Leave cleanup on hold.",
  changesSincePrevious: [],
};
