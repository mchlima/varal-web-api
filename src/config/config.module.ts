import { Global, Module } from '@nestjs/common';

import { type Env, parseEnv } from './env.js';

/** Injection token for the validated environment ({@link Env}). */
export const APP_ENV = Symbol('APP_ENV');

@Global()
@Module({
  providers: [
    {
      provide: APP_ENV,
      // Fails the boot when the environment is invalid.
      useFactory: (): Env => parseEnv(process.env),
    },
  ],
  exports: [APP_ENV],
})
export class ConfigModule {}
