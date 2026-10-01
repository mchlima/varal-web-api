import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { loadEnvFiles } from './config/load-env.js';

async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  const { PORT } = app.get<Env>(APP_ENV);
  await app.listen(PORT);
  Logger.log(`Varal API listening on port ${PORT}`, 'Bootstrap');
}

void bootstrap();
