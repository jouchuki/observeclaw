import type { EvaluatorConfig } from "./types.js";

export function validateEvaluators(evaluators: EvaluatorConfig[]): string | null {
	const priorities = evaluators.filter((e) => e.enabled).map((e) => e.priority);
	const seen = new Set<number>();
	for (const p of priorities) {
		if (seen.has(p)) {
			return `Duplicate priority ${p} in routing evaluators. Each enabled evaluator must have a unique priority.`;
		}
		seen.add(p);
	}
	return null;
}
