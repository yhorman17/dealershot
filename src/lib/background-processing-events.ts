export const BACKGROUND_PROCESSING_CHANGED_EVENT = "dealershot:background-processing-changed";

export function announceBackgroundProcessingChange() {
  window.dispatchEvent(new CustomEvent(BACKGROUND_PROCESSING_CHANGED_EVENT));
}
