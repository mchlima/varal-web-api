import type { OpenAPIObject } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineEvent } from './contract-schemas.js';
import { mergeContractSchemas, serializeOpenApiDocument, sortKeysDeep } from './openapi.js';
import { zodOpenApiConverter } from './zod-openapi.converter.js';

// Test-only contract schemas: business enums and events arrive in phase 1.
const SampleStatus = z.enum(['open', 'closed']).meta({ id: 'SampleStatus' });
const EventSampleChanged = defineEvent(
  'EventSampleChanged',
  z.object({ id: z.uuid(), status: SampleStatus }),
);

function emptyDocument(): OpenAPIObject {
  return { openapi: '3.1.0', info: { title: 't', version: '0' }, paths: {} };
}

describe('mergeContractSchemas (RN-01.10)', () => {
  it('adds enums and Event-prefixed payloads to components.schemas, even unused by routes', () => {
    const document = mergeContractSchemas(emptyDocument(), [SampleStatus, EventSampleChanged]);
    expect(document.components?.schemas).toEqual({
      SampleStatus: { type: 'string', enum: ['open', 'closed'] },
      EventSampleChanged: {
        type: 'object',
        properties: {
          id: expect.objectContaining({ type: 'string', format: 'uuid' }) as unknown,
          status: { $ref: '#/components/schemas/SampleStatus' },
        },
        required: ['id', 'status'],
        additionalProperties: false,
      },
    });
  });

  it('rejects schemas without an id', () => {
    expect(() => mergeContractSchemas(emptyDocument(), [z.string()])).toThrow(/\.meta\(\{ id \}\)/);
  });

  it('accepts a schema a route already published with `example` instead of `examples`', () => {
    const Named = z.object({ code: z.string().meta({ examples: ['X'] }) }).meta({ id: 'Named' });
    const document = emptyDocument();
    const fromRoute = {
      type: 'object',
      properties: { code: { type: 'string', example: 'X' } },
      required: ['code'],
      additionalProperties: false,
    };
    document.components = { schemas: { Named: fromRoute } };
    expect(mergeContractSchemas(document, [Named]).components?.schemas?.Named).toEqual(fromRoute);
  });

  it('rejects two different schemas with the same id', () => {
    const other = z.enum(['x']).meta({ id: 'SampleStatus' });
    expect(() => mergeContractSchemas(emptyDocument(), [SampleStatus, other])).toThrow(
      /defined twice/,
    );
  });
});

describe('zodOpenApiConverter', () => {
  it('ignores non-zod schemas', () => {
    expect(zodOpenApiConverter({}, { schemaType: 'input' })).toBeUndefined();
  });

  it('publishes a differing input shape as <id>Input', () => {
    const Body = z.object({ quantity: z.number().default(1) }).meta({ id: 'SampleBody' });
    const input = zodOpenApiConverter(Body, { schemaType: 'input' });
    const output = zodOpenApiConverter(Body, { schemaType: 'output' });
    expect(input?.schema).toEqual({ $ref: '#/$defs/SampleBodyInput' });
    expect(Object.keys(input?.components ?? {})).toEqual(['SampleBodyInput']);
    expect(output?.schema).toEqual({ $ref: '#/$defs/SampleBody' });
  });
});

describe('deterministic output', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(JSON.stringify(sortKeysDeep({ b: 1, a: { d: [3, 1], c: 2 } }))).toBe(
      '{"a":{"c":2,"d":[3,1]},"b":1}',
    );
  });

  it('serializes the same document identically regardless of key order', () => {
    const a = serializeOpenApiDocument({ ...emptyDocument(), paths: { '/b': {}, '/a': {} } });
    const { info, openapi } = emptyDocument();
    const b = serializeOpenApiDocument({ paths: { '/a': {}, '/b': {} }, info, openapi });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });
});
