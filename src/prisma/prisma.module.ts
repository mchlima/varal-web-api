import { Global, Module } from '@nestjs/common';

import { PlatformPrismaService } from './platform-prisma.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PlatformPrismaService, PrismaService],
  exports: [PlatformPrismaService, PrismaService],
})
export class PrismaModule {}
