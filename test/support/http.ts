import { type ErrorResponse, ErrorResponseSchema } from '../../src/errors/error-response.schema.js';

/** The `error` of a response body, checked against the published ErrorResponse schema. */
export function errorOf(response: { body: unknown }): ErrorResponse['error'] {
  return ErrorResponseSchema.parse(response.body).error;
}
