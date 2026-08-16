import { aggregateDistribution, prophetEventBrier } from "./event-core.js";

const PRIOR_STRENGTH = 5;
const PRIOR_BRIER = 0.25;

/**
 * Select the best two-model combination for each deterministic aggregation
 * method. Model weights are reconstructed strictly from resolutions that
 * precede the event being scored, so the performance-weighted method does not
 * learn from its target outcome.
 *
 * @param {{
 *   events: ReadonlyArray<{
 *     id: string,
 *     resolvedAt: string,
 *     resolvedOutcome: string,
 *     outcomeKeys: string[],
 *     eligible: boolean,
 *     forecasts: Record<string, Record<string, number>>
 *   }>,
 *   methods: ReadonlyArray<{id: string, aggregateMethod: string}>,
 *   participants?: ReadonlyArray<{id: unknown, name: unknown, organization: unknown, color: unknown}>
 * }} input
 * @returns {Array<{
 *   methodId: string,
 *   firstId: string,
 *   secondId: string,
 *   losses: number[],
 *   brier: number,
 *   modelPair: Array<{id: string, name: string, organization: string, color: string}>,
 *   pairCount: number,
 *   modelCount: number
 * }>}
 */
export function buildBestPairStandings({ events, methods, participants = [] }) {
  const orderedEvents = [...events].sort((left, right) => {
    const dateOrder = Date.parse(left.resolvedAt || 0) - Date.parse(right.resolvedAt || 0);
    return dateOrder || String(left.id).localeCompare(String(right.id));
  });
  const participantMeta = new Map(participants.map((participant) => [String(participant.id), participant]));
  const modelIds = [...new Set(orderedEvents.flatMap((event) => Object.keys(event.forecasts || {})))].sort();
  const priorByModel = new Map();
  const weightsByEvent = new Map();

  for (const event of orderedEvents) {
    const weights = {};
    for (const modelId of Object.keys(event.forecasts || {})) {
      const prior = priorByModel.get(modelId) || { loss: 0, count: 0 };
      const shrunkBrier = (prior.loss + PRIOR_STRENGTH * PRIOR_BRIER) / (prior.count + PRIOR_STRENGTH);
      weights[modelId] = 1 / Math.max(0.04, shrunkBrier);
    }
    weightsByEvent.set(String(event.id), weights);

    for (const [modelId, probabilities] of Object.entries(event.forecasts || {})) {
      const prior = priorByModel.get(modelId) || { loss: 0, count: 0 };
      prior.loss += prophetEventBrier(probabilities, event.resolvedOutcome, event.outcomeKeys);
      prior.count += 1;
      priorByModel.set(modelId, prior);
    }
  }

  const candidatesByMethod = new Map(methods.map((method) => [method.id, []]));
  let pairCount = 0;
  for (let firstIndex = 0; firstIndex < modelIds.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < modelIds.length; secondIndex += 1) {
      const firstId = modelIds[firstIndex];
      const secondId = modelIds[secondIndex];
      const commonEvents = orderedEvents.filter((event) => (
        event.eligible && event.forecasts?.[firstId] && event.forecasts?.[secondId]
      ));
      if (!commonEvents.length) continue;
      pairCount += 1;

      for (const method of methods) {
        const losses = commonEvents.map((event) => {
          const eventWeights = weightsByEvent.get(String(event.id)) || {};
          const aggregate = aggregateDistribution(
            [event.forecasts[firstId], event.forecasts[secondId]],
            event.outcomeKeys,
            method.aggregateMethod,
            [eventWeights[firstId] || 1, eventWeights[secondId] || 1],
          );
          return prophetEventBrier(aggregate, event.resolvedOutcome, event.outcomeKeys);
        });
        candidatesByMethod.get(method.id).push({
          methodId: method.id,
          firstId,
          secondId,
          losses,
          brier: mean(losses),
        });
      }
    }
  }

  return methods.flatMap((method) => {
    const candidates = candidatesByMethod.get(method.id) || [];
    candidates.sort((left, right) => (
      left.brier - right.brier
      || right.losses.length - left.losses.length
      || left.firstId.localeCompare(right.firstId)
      || left.secondId.localeCompare(right.secondId)
    ));
    const best = candidates[0];
    if (!best) return [];
    return [{
      ...best,
      modelPair: [best.firstId, best.secondId].map((id) => {
        const participant = participantMeta.get(id);
        return {
          id,
          name: String(participant?.name || id),
          organization: String(participant?.organization || "Independent"),
          color: String(participant?.color || "#7c4dff"),
        };
      }),
      pairCount,
      modelCount: modelIds.length,
    }];
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
