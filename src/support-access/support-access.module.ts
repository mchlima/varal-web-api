import { Module } from '@nestjs/common';

import { SupportAccessController } from './support-access.controller.js';

/** Support accesses ("entrar como") listed to the owner (RN-02.22). */
@Module({ controllers: [SupportAccessController] })
export class SupportAccessModule {}
