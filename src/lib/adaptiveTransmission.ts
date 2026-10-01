export type AdaptiveTransmissionMetrics = {
  renderMs: number;
  decodeSuccessRate?: number;
  droppedRate?: number;
};

export type AdaptiveTransmissionState = {
  intervalMs: number;
  stableSamples: number;
  pressureSamples: number;
};

export type AdaptiveTransmissionConfig = {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  targetRenderMs?: number;
  targetSuccessRate?: number;
  targetDropRate?: number;
};

const DEFAULTS = {
  minIntervalMs: 8,
  maxIntervalMs: 500,
  targetRenderMs: 18,
  targetSuccessRate: 0.82,
  targetDropRate: 0.08,
};

export function createAdaptiveTransmission(initialIntervalMs = 80, config: AdaptiveTransmissionConfig = {}) {
  const limits = { ...DEFAULTS, ...config };
  let state: AdaptiveTransmissionState = {
    intervalMs: Math.min(limits.maxIntervalMs, Math.max(limits.minIntervalMs, Math.round(initialIntervalMs))),
    stableSamples: 0,
    pressureSamples: 0,
  };

  return {
    getState: () => ({ ...state }),

    observe(metrics: AdaptiveTransmissionMetrics) {
      const successRate = metrics.decodeSuccessRate ?? 1;
      const dropRate = metrics.droppedRate ?? 0;
      const renderPressure = metrics.renderMs > limits.targetRenderMs;
      const channelPressure = successRate < limits.targetSuccessRate || dropRate > limits.targetDropRate;

      if (renderPressure || channelPressure) {
        // One bad sample is enough to react, but repeated pressure is
        // deliberately bounded so noisy camera reads cannot ratchet cadence
        // all the way to the maximum interval in a few frames.
        state.pressureSamples += 1;
        const renderFactor = metrics.renderMs > limits.targetRenderMs * 1.8 ? 1.35 : 1.15;
        const channelFactor = channelPressure ? 1.15 : 1;
        const shouldBackOff = state.intervalMs < limits.maxIntervalMs && (
          state.pressureSamples === 1 || state.pressureSamples >= 2
        );
        if (shouldBackOff) {
          const next = Math.ceil(state.intervalMs * Math.max(renderFactor, channelFactor));
          state = {
            intervalMs: Math.min(limits.maxIntervalMs, Math.max(state.intervalMs + 1, next)),
            stableSamples: 0,
            pressureSamples: 0,
          };
          return { ...state, changed: true, direction: 'slower' as const };
        }
        state.stableSamples = 0;
        return { ...state, changed: false, direction: 'stable' as const };
      }

      state.pressureSamples = 0;

      const comfortablyFast = metrics.renderMs < limits.targetRenderMs * 0.65;
      const healthyChannel =
        successRate >= Math.min(0.98, limits.targetSuccessRate + 0.1) &&
        dropRate <= limits.targetDropRate * 0.5;

      if (comfortablyFast && healthyChannel) {
        state.stableSamples += 1;
        if (state.stableSamples >= 3 && state.intervalMs > limits.minIntervalMs) {
          const step = state.intervalMs >= 80 ? 8 : state.intervalMs >= 40 ? 4 : 2;
          state = {
            intervalMs: Math.max(limits.minIntervalMs, state.intervalMs - step),
            stableSamples: 0,
            pressureSamples: 0,
          };
          return { ...state, changed: true, direction: 'faster' as const };
        }
      } else {
        state.stableSamples = 0;
      }

      return { ...state, changed: false, direction: 'stable' as const };
    },

    reset(intervalMs = initialIntervalMs) {
      state = {
        intervalMs: Math.min(limits.maxIntervalMs, Math.max(limits.minIntervalMs, Math.round(intervalMs))),
        stableSamples: 0,
        pressureSamples: 0,
      };
    },
  };
}
