import type { ActorType } from '../generated/prisma/enums.js';
import type { TenantDb } from '../prisma/prisma.service.js';

function actorKey(type: ActorType, id: string | null): string {
  return `${type}:${id ?? ''}`;
}

/** Names of owners and staff members, to show who did what (reports, cash registers). */
export class ActorNames {
  private readonly names = new Map<string, string>();

  static async load(
    db: TenantDb,
    actors: readonly { type: ActorType; id: string | null }[],
  ): Promise<ActorNames> {
    const result = new ActorNames();
    const ids = (type: ActorType) => [
      ...new Set(actors.flatMap((actor) => (actor.type === type && actor.id ? [actor.id] : []))),
    ];
    const owners = ids('owner');
    const staff = ids('staff');
    const [users, members] = await Promise.all([
      owners.length === 0
        ? []
        : db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true } }),
      staff.length === 0
        ? []
        : db.staffMember.findMany({
            where: { id: { in: staff } },
            select: { id: true, name: true },
          }),
    ]);
    for (const user of users) {
      result.names.set(actorKey('owner', user.id), user.name);
    }
    for (const member of members) {
      result.names.set(actorKey('staff', member.id), member.name);
    }
    return result;
  }

  nameOf(type: ActorType, id: string | null): string | null {
    return this.names.get(actorKey(type, id)) ?? null;
  }

  of(
    type: ActorType,
    id: string | null,
  ): { type: ActorType; id: string | null; name: string | null } {
    return { type, id, name: this.nameOf(type, id) };
  }
}
