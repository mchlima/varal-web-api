import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { TenantDb } from '../prisma/prisma.service.js';
import { defineRealtimeEvent } from '../realtime/realtime.contracts.js';
import { RealtimeService } from '../realtime/realtime.service.js';

/*
 * Real-time events of the unit setup (spec 03, section 8), sent to `unit:{unitId}` after the commit.
 */

/** Spec 03, section 8: a product was marked or unmarked as sold out (RN-03.11; CA-03.05). */
export const ProductSoldOutChanged = defineRealtimeEvent(
  'EventProductSoldOutChanged',
  'product.sold_out_changed',
  z.object({ productId: z.uuid(), soldOut: z.boolean() }),
  'Produto marcado ou desmarcado como esgotado (RN-03.11). `version` é a versão do produto: o balcão bloqueia ou libera o produto sem recarregar o cardápio.',
);

/** Spec 03, section 8: any other change in the menu of the unit. */
export const MenuUpdated = defineRealtimeEvent(
  'EventMenuUpdated',
  'menu.updated',
  z.object({ unitId: z.uuid(), version: z.int().min(0) }),
  'Qualquer outra alteração no cardápio da unidade. `version` é a versão do cardápio (`GET /units/{id}/menu`): o app recarrega o cardápio se a versão dele for menor.',
);

/**
 * Proposal (not named in spec 03): settings, stations or workflow of the unit changed. Station
 * changes also make the sockets of the unit reconnect (`session.access_changed`).
 */
export const UnitConfigUpdated = defineRealtimeEvent(
  'EventUnitConfigUpdated',
  'unit.config_updated',
  z.object({ unitId: z.uuid(), version: z.int().min(0) }),
  'Configuração da unidade alterada (nome, tempo de atraso, estações ou fluxo). `version` é a versão da unidade: o app recarrega `GET /auth/me` e, no painel do dono, a configuração.',
);

export const setupEventSchemas: readonly z.ZodType[] = [
  ProductSoldOutChanged.schema,
  MenuUpdated.schema,
  UnitConfigUpdated.schema,
];

/**
 * Bumps the versions of a unit and emits the matching event after the commit. Call it inside the
 * transaction of the change.
 */
@Injectable()
export class SetupEvents {
  constructor(private readonly realtime: RealtimeService) {}

  /** Any menu change except sold-out (`menu.updated`). Returns the new menu version. */
  async menuChanged(db: TenantDb, unitId: string): Promise<number> {
    const unit = await db.unit.update({
      where: { id: unitId },
      data: { menuVersion: { increment: 1 } },
      select: { menuVersion: true },
    });
    this.realtime.emitToUnit(MenuUpdated, {
      unitId,
      version: unit.menuVersion,
      data: { unitId, version: unit.menuVersion },
    });
    return unit.menuVersion;
  }

  /** Settings, stations or workflow (`unit.config_updated`). Returns the new unit version. */
  async configChanged(db: TenantDb, unitId: string): Promise<number> {
    const unit = await db.unit.update({
      where: { id: unitId },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    this.emitConfig(unitId, unit.version);
    return unit.version;
  }

  /** For changes that already incremented `units.version` themselves. */
  emitConfig(unitId: string, version: number): void {
    this.realtime.emitToUnit(UnitConfigUpdated, {
      unitId,
      version,
      data: { unitId, version },
    });
  }

  soldOutChanged(product: { id: string; unitId: string; soldOut: boolean; version: number }): void {
    this.realtime.emitToUnit(ProductSoldOutChanged, {
      unitId: product.unitId,
      version: product.version,
      data: { productId: product.id, soldOut: product.soldOut },
    });
  }
}
