import type { WorkflowStageTarget } from '../generated/prisma/enums.js';
import type { RoutingStation } from './routing.js';

/** RN-03.05: a workflow has from 2 to 8 stages. */
export const MIN_STAGES = 2;
export const MAX_STAGES = 8;

export interface WorkflowStageDraft {
  name: string;
  target: WorkflowStageTarget;
  stationId?: string | null;
}

export const WORKFLOW_ISSUE_CODES = [
  'STAGE_COUNT',
  'NO_FINAL_STAGE',
  'MULTIPLE_FINAL_STAGES',
  'FINAL_STAGE_NOT_LAST',
  'STATION_REQUIRED',
  'STATION_NOT_ALLOWED',
  'STATION_NOT_IN_UNIT',
  'STATION_NOT_QUEUE',
  'DUPLICATE_NAME',
] as const;

export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  /** Position of the stage in the request (0-based), or null for the workflow as a whole. */
  index: number | null;
  message: string;
}

/**
 * Validates a whole workflow before it is saved (spec 03, section 4.2; CA-03.02):
 *
 * - RN-03.05: 2 to 8 stages; the last one is the only one with target `none` (the final stage).
 * - RN-03.06: every non-final stage points to a `queue` station: `fixed_station` names an active
 *   `queue` station of the unit; `product_station` uses the preparation station, which RN-03.08
 *   already requires to be a `queue` station.
 * - Only `fixed_station` names a station; stage names are unique in the workflow (ignoring case).
 *
 * `stations` are the stations of the unit (any state). Returns every problem found, empty if valid.
 */
export function validateWorkflow(
  stages: readonly WorkflowStageDraft[],
  stations: readonly RoutingStation[],
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (stages.length < MIN_STAGES || stages.length > MAX_STAGES) {
    issues.push({
      code: 'STAGE_COUNT',
      index: null,
      message: `O fluxo precisa ter de ${MIN_STAGES} a ${MAX_STAGES} etapas.`,
    });
  }

  const finals = stages.flatMap((stage, index) => (stage.target === 'none' ? [index] : []));
  if (finals.length === 0) {
    issues.push({
      code: 'NO_FINAL_STAGE',
      index: null,
      message: 'O fluxo precisa terminar numa etapa final (destino "nenhuma estação").',
    });
  } else if (finals.length > 1) {
    for (const index of finals.slice(0, -1)) {
      issues.push({
        code: 'MULTIPLE_FINAL_STAGES',
        index,
        message: 'Só a última etapa pode ser final.',
      });
    }
  }
  const lastFinal = finals.at(-1);
  if (lastFinal !== undefined && lastFinal !== stages.length - 1) {
    issues.push({
      code: 'FINAL_STAGE_NOT_LAST',
      index: lastFinal,
      message: 'A etapa final precisa ser a última do fluxo.',
    });
  }

  const byId = new Map(stations.map((station) => [station.id.toLowerCase(), station]));
  const names = new Set<string>();
  stages.forEach((stage, index) => {
    const stationId = stage.stationId ?? null;
    if (stage.target === 'fixed_station') {
      if (stationId === null) {
        issues.push({
          code: 'STATION_REQUIRED',
          index,
          message: 'Escolha a estação em que o item aparece nesta etapa.',
        });
      } else {
        const station = byId.get(stationId.toLowerCase());
        if (!station?.active) {
          issues.push({
            code: 'STATION_NOT_IN_UNIT',
            index,
            message: 'A estação escolhida não existe nesta unidade ou está desativada.',
          });
        } else if (station.kind !== 'queue') {
          issues.push({
            code: 'STATION_NOT_QUEUE',
            index,
            message: 'Etapas que não são finais precisam apontar para uma estação de fila.',
          });
        }
      }
    } else if (stationId !== null) {
      issues.push({
        code: 'STATION_NOT_ALLOWED',
        index,
        message: 'Só etapas com estação fixa escolhem uma estação.',
      });
    }

    const key = stage.name.trim().toLocaleLowerCase('pt-BR');
    if (names.has(key)) {
      issues.push({
        code: 'DUPLICATE_NAME',
        index,
        message: 'Já existe outra etapa com este nome.',
      });
    }
    names.add(key);
  });
  return issues;
}
