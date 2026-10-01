import { isDeepStrictEqual } from 'node:util';

import type { StandardSchemaConversionResult, StandardSchemaConverter } from '@nestjs/swagger';
import { z } from 'zod';

type JsonObject = Record<string, unknown>;

interface Converted {
  schema: JsonObject;
  defs: Record<string, JsonObject>;
}

function isZodSchema(schema: unknown): schema is z.ZodType {
  return schema instanceof z.ZodType;
}

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Converted {
  const {
    $defs,
    $schema: _dialect,
    ...root
  } = z.toJSONSchema(schema, {
    // OpenAPI 3.1 uses JSON Schema 2020-12 as its schema dialect.
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
  }) as JsonObject & { $defs?: Record<string, JsonObject>; $schema?: string };
  return { schema: root, defs: $defs ?? {} };
}

/** Renames `#/$defs/<from>` references to `#/$defs/<to>` anywhere in `value`. */
function renameRefs<T>(value: T, renames: Map<string, string>): T {
  if (renames.size === 0) {
    return value;
  }
  let json = JSON.stringify(value);
  for (const [from, to] of renames) {
    json = json.split(`"#/$defs/${from}"`).join(`"#/$defs/${to}"`);
  }
  return JSON.parse(json) as T;
}

/**
 * Converts zod 4 schemas to OpenAPI 3.1 (JSON Schema 2020-12) for `@nestjs/swagger`.
 *
 * Schemas named with `.meta({ id })` become `components.schemas` entries. When the input
 * shape of a named schema differs from its output shape (defaults, transforms…), the input
 * variant is published as `<id>Input` so it never silently overwrites the output one.
 */
export const zodOpenApiConverter: StandardSchemaConverter = (schema, { schemaType }) => {
  if (!isZodSchema(schema)) {
    return undefined;
  }
  const converted = convert(schema, schemaType);
  const result: StandardSchemaConversionResult = {
    schema: converted.schema,
    components: converted.defs,
  };
  return result;
};

/** Converts a zod schema, publishing a differing input variant of a named schema as `<id>Input`. */
function convert(schema: z.ZodType, schemaType: 'input' | 'output'): Converted {
  const converted = toJsonSchema(schema, schemaType);
  if (schemaType === 'input') {
    const output = toJsonSchema(schema, 'output');
    const renames = new Map<string, string>();
    for (const [id, definition] of Object.entries(converted.defs)) {
      const outputDefinition = output.defs[id];
      if (outputDefinition !== undefined && !isDeepStrictEqual(outputDefinition, definition)) {
        renames.set(id, `${id}Input`);
      }
    }
    converted.schema = renameRefs(converted.schema, renames);
    converted.defs = Object.fromEntries(
      Object.entries(renameRefs(converted.defs, renames)).map(([id, definition]) => [
        renames.get(id) ?? id,
        definition,
      ]),
    );
  }
  return converted;
}

/**
 * Converts a named schema to the `components.schemas` entries it needs (itself plus nested named
 * schemas). With `input`, a differing input shape is named `<id>Input`, as routes publish it.
 */
export function toComponentSchemas(
  schema: z.ZodType,
  io: 'input' | 'output' = 'output',
): Record<string, JsonObject> {
  const id = z.globalRegistry.get(schema)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Contract schemas must be named with .meta({ id })');
  }
  const { defs } = convert(schema, io);
  // Same rewrite @nestjs/swagger applies to route schemas.
  return JSON.parse(
    JSON.stringify(defs).split('"#/$defs/').join('"#/components/schemas/'),
  ) as Record<string, JsonObject>;
}
