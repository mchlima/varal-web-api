import { describe, expect, it } from 'vitest';

import type { RoutingStation } from './routing.js';
import { validateWorkflow, type WorkflowStageDraft } from './workflow-rules.js';

const COUNTER = '01922f2c-7a3b-7c00-8000-00000000000a';
const KITCHEN = '01922f2c-7a3b-7c00-8000-00000000000b';
const DELIVERY = '01922f2c-7a3b-7c00-8000-00000000000c';
const CLOSED = '01922f2c-7a3b-7c00-8000-00000000000d';
const OTHER_UNIT = '01922f2c-7a3b-7c00-8000-00000000000e';

const stations: RoutingStation[] = [
  { id: COUNTER, kind: 'counter', active: true },
  { id: KITCHEN, kind: 'queue', active: true },
  { id: DELIVERY, kind: 'queue', active: true },
  { id: CLOSED, kind: 'queue', active: false },
];

/** The default workflow (spec 03, section 4.4). */
const template: WorkflowStageDraft[] = [
  { name: 'Recebido', target: 'product_station' },
  { name: 'Preparando', target: 'product_station' },
  { name: 'Pronto', target: 'fixed_station', stationId: DELIVERY },
  { name: 'Entregue', target: 'none' },
];

const codes = (stages: WorkflowStageDraft[]) =>
  validateWorkflow(stages, stations).map((issue) => [issue.code, issue.index]);

describe('workflow rules (spec 03, section 4.2)', () => {
  it('accepts the default template and a two-stage workflow', () => {
    expect(validateWorkflow(template, stations)).toEqual([]);
    expect(
      codes([
        { name: 'Na fila', target: 'fixed_station', stationId: KITCHEN },
        { name: 'Entregue', target: 'none' },
      ]),
    ).toEqual([]);
  });

  it('RN-03.05: 2 to 8 stages', () => {
    expect(codes([{ name: 'Entregue', target: 'none' }])).toEqual([['STAGE_COUNT', null]]);
    const nine = [
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `Etapa ${index}`,
        target: 'product_station' as const,
      })),
      { name: 'Fim', target: 'none' as const },
    ];
    expect(codes(nine)).toEqual([['STAGE_COUNT', null]]);
  });

  it('CA-03.02: refuses a workflow without a final stage', () => {
    expect(codes(template.slice(0, 3))).toEqual([['NO_FINAL_STAGE', null]]);
  });

  it('CA-03.02: refuses more than one final stage, and a final stage that is not the last', () => {
    expect(
      codes([
        { name: 'Recebido', target: 'product_station' },
        { name: 'Cancelado', target: 'none' },
        { name: 'Entregue', target: 'none' },
      ]),
    ).toEqual([['MULTIPLE_FINAL_STAGES', 1]]);
    expect(
      codes([
        { name: 'Entregue', target: 'none' },
        { name: 'Recebido', target: 'product_station' },
      ]),
    ).toEqual([['FINAL_STAGE_NOT_LAST', 0]]);
  });

  it('CA-03.02 / RN-03.06: refuses a non-final stage pointing to a counter station', () => {
    expect(
      codes([
        { name: 'Recebido', target: 'fixed_station', stationId: COUNTER },
        { name: 'Entregue', target: 'none' },
      ]),
    ).toEqual([['STATION_NOT_QUEUE', 0]]);
  });

  it('fixed_station needs an active station of the unit; other targets name none', () => {
    expect(
      codes([
        { name: 'A', target: 'fixed_station' },
        { name: 'B', target: 'fixed_station', stationId: CLOSED },
        { name: 'C', target: 'fixed_station', stationId: OTHER_UNIT },
        { name: 'D', target: 'product_station', stationId: KITCHEN },
        { name: 'E', target: 'none', stationId: KITCHEN },
      ]),
    ).toEqual([
      ['STATION_REQUIRED', 0],
      ['STATION_NOT_IN_UNIT', 1],
      ['STATION_NOT_IN_UNIT', 2],
      ['STATION_NOT_ALLOWED', 3],
      ['STATION_NOT_ALLOWED', 4],
    ]);
  });

  it('stage names are unique, ignoring case and spaces around', () => {
    expect(
      codes([
        { name: 'Pronto', target: 'product_station' },
        { name: ' pronto ', target: 'product_station' },
        { name: 'Entregue', target: 'none' },
      ]),
    ).toEqual([['DUPLICATE_NAME', 1]]);
  });
});
